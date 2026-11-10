import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../dist/apps/worker/src/index.js";

const goodToken = "dev-test-token-abcdefghijklmnopqrstuvwxyz012345";
const devEnv = { GMW_DEV_AUTH_ENABLED: "true", GMW_DEV_BEARER_TOKEN: goodToken };
const base = "http://localhost:8787";
const request = (path, method = "GET", opts = {}) => new Request(base + path, {
  method, ...opts
});
const bearer = { Authorization: "Bearer " + goodToken };
const sessions = {
  async get(account, client) {
    assert.equal(account, "default");
    assert.equal(client, "local_dev_http");
    return { accessToken: "FAKE_TEST_GOOGLE_TOKEN_123456",
      expiresAt: Date.now() + 60000,
      scopes: ["https://www.googleapis.com/auth/tasks.readonly"] };
  }
};

test("health endpoint is public but returns no sensitive configuration", async () => {
  const reply = await createGateway().fetch(request("/healthz"), {});
  assert.equal(reply.status, 200);
  const result = await reply.json();
  assert.equal(result.state, "development");
  assert(!JSON.stringify(result).includes("token"));
});

test("gateway fails closed without configured dev identity or secret", async () => {
  const worker = createGateway();
  const locked = await worker.fetch(request("/v1/capabilities"), {});
  assert.equal(locked.status, 503);
  assert.deepEqual(await locked.json(), { error: "GATEWAY_NOT_CONFIGURED" });
  const missing = await worker.fetch(request("/v1/capabilities"), devEnv);
  assert.equal(missing.status, 401);
  const wrong = await worker.fetch(request("/v1/capabilities", "GET", {
    headers: { Authorization: "Bearer wrong-token" }
  }), devEnv);
  assert.equal(wrong.status, 401);
  const short = await worker.fetch(request("/v1/capabilities", "GET", {
    headers: { Authorization: "Bearer 123" }
  }), { GMW_DEV_AUTH_ENABLED: "true", GMW_DEV_BEARER_TOKEN: "123" });
  assert.equal(short.status, 503);
});

test("authenticated capabilities list namespaced operations without credentials", async () => {
  const worker = createGateway();
  const reply = await worker.fetch(request("/v1/capabilities", "GET", {
    headers: bearer
  }), devEnv);
  assert.equal(reply.status, 200);
  const payload = await reply.json();
  assert.equal(payload.operations.length, 11);
  assert(payload.operations.some(x => x.name === "script_update_sources" && x.risk === "destructive"));
  assert(!JSON.stringify(payload).includes(goodToken));
});

test("typed read calls use only injected trusted account and fixed Google API", async () => {
  const urls = [];
  const worker = createGateway({
    sessions,
    googleFetch: async (url, opts) => {
      urls.push(url);
      assert.equal(opts.method, "GET");
      assert.equal(opts.headers.Authorization, "Bearer FAKE_TEST_GOOGLE_TOKEN_123456");
      return new Response(JSON.stringify({ items: [{ id: "a", title: "Today" }] }), {
        status: 200
      });
    }
  });
  const reply = await worker.fetch(request("/v1/operations/tasks_list_tasklists", "POST", {
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 5 })
  }), devEnv);
  assert.equal(reply.status, 200);
  const data = await reply.json();
  assert.equal(data.result.items[0].title, "Today");
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).origin, "https://tasks.googleapis.com");
  assert(!JSON.stringify(data).includes("FAKE_TEST_GOOGLE_TOKEN"));
});

test("no Google OAuth broker means no live Google access by default", async () => {
  const worker = createGateway();
  const reply = await worker.fetch(request("/v1/operations/tasks_list_tasklists", "POST", {
    headers: { ...bearer, "Content-Type": "application/json" },
    body: "{}"
  }), devEnv);
  assert.equal(reply.status, 503);
  assert.deepEqual(await reply.json(), { error: "GOOGLE_SESSION_NOT_CONFIGURED" });
});

test("writes remain denied even when synthetic token has a Google write scope", async () => {
  let hits = 0;
  const worker = createGateway({
    sessions: { async get() {
      return { accessToken: "FAKE_TEST_GOOGLE_TOKEN_123456",
        expiresAt: Date.now() + 60000,
        scopes: ["https://www.googleapis.com/auth/tasks"] };
    }},
    googleFetch: async () => { hits++; throw new Error("MUST_NOT_CALL_GOOGLE"); }
  });
  const reply = await worker.fetch(request("/v1/operations/tasks_create_task", "POST", {
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ tasklistId: "a", title: "Unapproved" })
  }), devEnv);
  assert.equal(reply.status, 403);
  assert.deepEqual(await reply.json(), { error: "WRITE_APPROVAL_REQUIRED" });
  assert.equal(hits, 0);
});

test("cross-origin browser requests are rejected, bad inputs are bounded", async () => {
  const worker = createGateway();
  const foreign = await worker.fetch(request("/v1/capabilities", "GET", {
    headers: { ...bearer, Origin: "https://untrusted.invalid" }
  }), devEnv);
  assert.equal(foreign.status, 403);
  const huge = await worker.fetch(request("/v1/operations/tasks_list_tasklists", "POST", {
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "X".repeat(40000) })
  }), devEnv);
  assert.equal(huge.status, 400);
  const invalid = await worker.fetch(request("/v1/operations/tasks_list_tasklists", "POST", {
    headers: { ...bearer, "Content-Type": "application/json" },
    body: "{"
  }), devEnv);
  assert.equal(invalid.status, 400);
});

test("MCP transport is reachable only after gateway authentication", async () => {
  const worker = createGateway();
  const unauth = await worker.fetch(request("/mcp", "POST", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
  }), devEnv);
  assert.equal(unauth.status, 401);
  const reply = await worker.fetch(request("/mcp", "POST", {
    headers: {
      ...bearer,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28"
    },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "initialize", id: 1,
      params: { protocolVersion: "2026-07-28", capabilities: {},
        clientInfo: { name: "gateway-test", version: "0.0.1" } }
    })
  }), devEnv);
  assert.equal(reply.status, 200);
  const text = await reply.text();
  assert(text.includes("serverInfo") || text.includes("google-master-worker"), text.slice(0, 300));
});
