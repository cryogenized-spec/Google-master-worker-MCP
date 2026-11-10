import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { OperationRegistry, OperationError, publicError } from "../dist/packages/core/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";
import { TASKS_READ, TASKS_WRITE, registerGoogleTasks, createTaskInput } from "../dist/packages/google-tasks/src/index.js";
import { createFileApprovalGate, issueLocalApproval } from "../dist/apps/local-mcp/src/approvals.js";

const principal = { authenticated: true, clientId: "local_dev", accountId: "default" };
const sessionStore = (scopes = [TASKS_READ], account = "default") => ({
  async get(requestedAccount, clientId) {
    assert.equal(clientId, "local_dev");
    return requestedAccount === account
      ? { accessToken: "FAKE_TOKEN_DO_NOT_LEAK", scopes, expiresAt: Date.now() + 300000 }
      : null;
  }
});
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" }
});
const http = fetchImpl => new GoogleJsonClient("https://tasks.googleapis.com", "/tasks/v1/", fetchImpl);
const registry = (sessions, fetchImpl, approvals) => {
  const r = new OperationRegistry(sessions, approvals);
  registerGoogleTasks(r, http(fetchImpl));
  return r;
};

test("M1 offers precisely four dedicated Google Tasks tools", () => {
  const reg = registry(sessionStore(), async () => response({ items: [] }));
  assert.deepEqual(reg.catalogue().map(x => x.name).sort(),
    ["tasks_create_task", "tasks_get_task", "tasks_list_tasklists", "tasks_list_tasks"]);
  assert.equal(reg.catalogue().find(x => x.name === "tasks_create_task").risk, "write");
});

test("Tasks read uses fixed Google host, bounded projection, and per-account scope", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.match(options.headers.Authorization, /^Bearer /);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    if (String(url).includes("/users/@me/lists")) return response({
      items: [{ id: "l1", title: "Workshop", updated: "2026-11-10",
        privateSecret: "DO_NOT_RETURN" }], nextPageToken: "next"
    });
    if (String(url).endsWith("/tasks/t1")) return response({
      id: "t1", title: "One", notes: "Inspect", due: "2026-11-11T00:00:00Z",
      privateSecret: "DO_NOT_RETURN"
    });
    return response({ items: [{ id: "t1", title: "One", status: "needsAction",
      due: "2026-11-11T00:00:00Z", privateSecret: "DO_NOT_RETURN" }] });
  };
  const reg = registry(sessionStore(), fetchImpl);
  const lists = await reg.execute("tasks_list_tasklists", { maxResults: 3 }, principal);
  const tasks = await reg.execute("tasks_list_tasks", { tasklistId: "l1", maxResults: 12 }, principal);
  const task = await reg.execute("tasks_get_task", { tasklistId: "l1", taskId: "t1" }, principal);
  assert.equal(lists.partial, true);
  assert.equal(lists.items[0].title, "Workshop");
  assert.equal(tasks.items[0].scheduledDate, "2026-11-11");
  assert.equal(task.task.notes, "Inspect");
  assert.equal(calls.length, 3);
  assert(calls.every(call => new URL(call.url).origin === "https://tasks.googleapis.com"));
  assert.equal(new URL(calls[0].url).searchParams.get("maxResults"), "3");
  assert.equal(new URL(calls[1].url).searchParams.get("showCompleted"), "false");
  assert(!JSON.stringify({ lists, tasks, task }).includes("DO_NOT_RETURN"));
  assert(!JSON.stringify({ lists, tasks, task }).includes("FAKE_TOKEN"));
});

test("write demands Google scope and independently consumable approval", async () => {
  let writes = 0, approvals = 0;
  const action = { tasklistId: "l1", title: "Example", notes: "", scheduledDate: "2026-11-12" };
  const fetchImpl = async (_, options) => {
    writes++;
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), {
      title: "Example", due: "2026-11-12T00:00:00.000Z"
    });
    return response({ id: "new", title: "Example" });
  };
  const gate = { async consume(grant) {
    approvals++;
    assert.equal(grant.clientId, "local_dev");
    assert.equal(grant.accountId, "default");
    assert.equal(grant.operation, "tasks_create_task");
    assert.deepEqual(grant.input, action);
  }};
  await assert.rejects(registry(sessionStore([TASKS_READ]), fetchImpl, gate)
    .execute("tasks_create_task", action, principal), /GOOGLE_SCOPE_MISSING/);
  await assert.rejects(registry(sessionStore([TASKS_WRITE]), fetchImpl)
    .execute("tasks_create_task", action, principal), /WRITE_APPROVAL_REQUIRED/);
  assert.equal(writes, 0);
  const result = await registry(sessionStore([TASKS_WRITE]), fetchImpl, gate)
    .execute("tasks_create_task", action, principal);
  assert.equal(result.created, true);
  assert.equal(result.task.id, "new");
  assert.equal(approvals, 1);
  assert.equal(writes, 1);
});

test("invalid client, IDs, guessed account and stale token fail closed", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ items: [] }); };
  const reg = registry(sessionStore(), fetchImpl);
  await assert.rejects(reg.execute("tasks_list_tasks", { tasklistId: "bad\nid" }, principal),
    /INVALID_ARGUMENTS/);
  await assert.rejects(reg.execute("tasks_list_tasks",
    { tasklistId: "l1", accountId: "someone_else" }, principal), /INVALID_ARGUMENTS/);
  await assert.rejects(reg.execute("tasks_list_tasklists", {},
    { ...principal, authenticated: false }), /CLIENT_UNAUTHORIZED/);
  await assert.rejects(reg.execute("tasks_list_tasklists", {},
    { ...principal, accountId: "another_account" }), /GOOGLE_SESSION_NOT_CONFIGURED/);
  assert.equal(calls, 0);
  const expired = registry({ async get() {
    return { accessToken: "FAKE_TOKEN_DO_NOT_LEAK", scopes: [TASKS_READ], expiresAt: 1 };
  }}, fetchImpl);
  await assert.rejects(expired.execute("tasks_list_tasklists", {}, principal), /GOOGLE_SESSION_EXPIRED/);
  assert.equal(calls, 0);
  assert.deepEqual(publicError(new Error("accessToken SECRET")), { error: "OPERATION_FAILED" });
});

test("Google HTTP keeps provider errors private and blocks URL escapes / oversized bodies", async () => {
  const client = http(async () => response({ detail: "SECRET_PROVIDER_BODY" }, 403));
  await assert.rejects(client.json({ path: "/tasks/v1/users/@me/lists",
    accessToken: "secret-access-token" }), /GOOGLE_FORBIDDEN/);
  await assert.rejects(client.json({ path: "//evil.example/tasks/v1/",
    accessToken: "secret-access-token" }), /GOOGLE_DESTINATION_REJECTED/);
  await assert.rejects(client.json({ path: "/tasks/v1/../token",
    accessToken: "secret-access-token" }), /GOOGLE_DESTINATION_REJECTED/);
  const huge = http(async () => new Response(JSON.stringify({ data: "x".repeat(262145) })));
  await assert.rejects(huge.json({ path: "/tasks/v1/users/@me/lists",
    accessToken: "secret-access-token" }), /GOOGLE_RESPONSE_TOO_LARGE/);
});

test("local approval is exact, one-use, expiry-bounded and cannot be overwritten live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gmw-approval-parent-"));
  const privateDir = join(dir, "private");
  const input = createTaskInput.parse({ tasklistId: "l1", title: "  Safe task  " });
  const action = { ...principal, operation: "tasks_create_task", input };
  try {
    await issueLocalApproval(action, { directory: privateDir, now: 1000 });
    await assert.rejects(issueLocalApproval(action, { directory: privateDir, now: 5000 }),
      /WRITE_APPROVAL_ALREADY_ACTIVE/);
    const gate = createFileApprovalGate({ directory: privateDir, now: () => 1500 });
    await assert.rejects(gate.consume({ ...action, input: { ...input, title: "Changed" } }),
      /WRITE_APPROVAL_REQUIRED/);
    await gate.consume(action);
    await assert.rejects(gate.consume(action), /WRITE_APPROVAL_REQUIRED/);
    await issueLocalApproval(action, { directory: privateDir, now: 2000 });
    await assert.rejects(createFileApprovalGate({ directory: privateDir, now: () => 122001 })
      .consume(action), /WRITE_APPROVAL_EXPIRED_OR_MISMATCHED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP stdio handshake discovers tools; unconfigured create cannot write", async t => {
  const child = spawn(process.execPath, ["dist/apps/local-mcp/src/stdio.js"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: { ...process.env, GMW_GOOGLE_ACCESS_TOKEN: "", GMW_GOOGLE_SCOPES: "" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  const waiting = new Map();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString().slice(0, 1000); });
  child.on("exit", (code) => {
    for (const callback of waiting.values()) callback({ error: { message: "CHILD_EXIT", code, stderr } });
    waiting.clear();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const response = JSON.parse(line);
    const done = waiting.get(response.id);
    if (done) { waiting.delete(response.id); done(response); }
  });
  let serial = 0;
  const ask = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => reject(Error("MCP_TIMEOUT " + method + " " + stderr)), 12000);
    waiting.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await ask("initialize", {
    protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "gmw-m1-test", version: "0.1.0" }
  });
  assert(init.result, JSON.stringify(init));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await ask("tools/list");
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(),
    ["tasks_create_task", "tasks_get_task", "tasks_list_tasklists", "tasks_list_tasks"]);
  const denial = await ask("tools/call", {
    name: "tasks_create_task", arguments: { tasklistId: "l1", title: "Never create" }
  });
  assert.equal(denial.result.isError, true);
  assert(!JSON.stringify(denial).includes("accessToken"));
  child.stdin.end();
});
