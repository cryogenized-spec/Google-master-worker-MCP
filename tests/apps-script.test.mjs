import test from "node:test";
import assert from "node:assert/strict";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";
import { SCRIPT_READ, SCRIPT_WRITE, registerAppsScript, fingerprintContent } from "../dist/packages/google-apps-script/src/index.js";

const principal = { authenticated: true, clientId: "local_dev", accountId: "default" };
const session = scopes => ({ async get() {
  return { accessToken: "FAKE_TOKEN_DO_NOT_LEAK", scopes, expiresAt: Date.now() + 300000 };
}});
const okay = data => new Response(JSON.stringify(data), { status: 200 });
const manifest = { name: "appsscript", type: "JSON", source: '{"timeZone":"Africa/Johannesburg"}' };
const oldFile = { name: "Code", type: "SERVER_JS", source: 'function greet() {return "hi";}' };
const projectContent = { scriptId: "s123", files: [manifest, oldFile] };
const registry = (scopes, handler, gate) => {
  const r = new OperationRegistry(session(scopes), gate);
  registerAppsScript(r, new GoogleJsonClient("https://script.googleapis.com", "/v1/", handler));
  return r;
};

test("Apps Script module provides explicit operations without generic HTTP or scripts.run", () => {
  const r = registry([SCRIPT_READ], async () => okay({}));
  assert.deepEqual(r.catalogue().map(x => x.name).sort(), [
    "script_create_project", "script_create_version", "script_get_content",
    "script_get_project", "script_list_deployments", "script_list_versions",
    "script_update_sources"
  ]);
  assert(!r.catalogue().some(x => x.name.includes("_run") || x.name === "google_request"));
});

test("script metadata/content reads require read scope, preserve manifest, produce stable digest", async () => {
  const urls = [];
  const r = registry([SCRIPT_READ], async (url, opts) => {
    urls.push(url);
    assert.equal(opts.method, "GET");
    if (String(url).endsWith("/content")) return okay(projectContent);
    return okay({ scriptId: "s123", title: "Example", parentId: "sheet", createTime: "2026",
      updateTime: "2026" });
  });
  const metadata = await r.execute("script_get_project", { scriptId: "s123" }, principal);
  const content = await r.execute("script_get_content", { scriptId: "s123" }, principal);
  assert.equal(metadata.title, "Example");
  assert.equal(content.files.length, 2);
  assert.equal(content.files[0].name, "appsscript");
  assert.equal(content.fingerprint.length, 64);
  assert.equal(content.fingerprint, await fingerprintContent([...projectContent.files].reverse()));
  assert(urls.every(url => new URL(url).origin === "https://script.googleapis.com"));
});

test("project creation and version creation require independent approval and write scope", async () => {
  let writes = 0, approved = 0;
  const mock = async (url, opts) => {
    writes++;
    assert.equal(opts.method, "POST");
    return String(url).endsWith("/versions")
      ? okay({ versionNumber: 3, description: "Review" })
      : okay({ scriptId: "new123", title: "New script" });
  };
  const allow = { async consume(action) {
    approved++;
    assert.equal(action.clientId, "local_dev");
    assert(["script_create_project", "script_create_version"].includes(action.operation));
  }};
  const readOnly = registry([SCRIPT_READ], mock, allow);
  await assert.rejects(readOnly.execute("script_create_project",
    { title: "New script" }, principal), /GOOGLE_SCOPE_MISSING/);
  const noApproval = registry([SCRIPT_WRITE], mock);
  await assert.rejects(noApproval.execute("script_create_project",
    { title: "New script" }, principal), /WRITE_APPROVAL_REQUIRED/);
  assert.equal(writes, 0);
  const r = registry([SCRIPT_WRITE], mock, allow);
  const created = await r.execute("script_create_project", { title: "New script" }, principal);
  const version = await r.execute("script_create_version", {
    scriptId: "new123", description: "Review"
  }, principal);
  assert.equal(created.scriptId, "new123");
  assert.equal(version.versionNumber, 3);
  assert.equal(writes, 2);
  assert.equal(approved, 2);
});

test("source update preserves existing files and rejects stale content", async () => {
  let current = projectContent, writes = 0, approvals = 0;
  const mock = async (url, options) => {
    if (options.method === "PUT") {
      writes++;
      current = { scriptId: "s123", files: JSON.parse(options.body).files };
      return okay(current);
    }
    return okay(current);
  };
  const gate = { async consume() { approvals++; } };
  const r = registry([SCRIPT_WRITE], mock, gate);
  const old = await r.execute("script_get_content", { scriptId: "s123" }, principal);
  const changes = [{ name: "Extra", type: "SERVER_JS", source: "function hello() {return 42;}" }];
  const changed = await r.execute("script_update_sources", {
    scriptId: "s123", expectedFingerprint: old.fingerprint, changes
  }, principal);
  assert.equal(changed.verified, true);
  assert.deepEqual(changed.changed, ["Extra"]);
  assert.equal(current.files.length, 3);
  assert(current.files.some(x => x.name === "appsscript"));
  assert(current.files.some(x => x.name === "Code" && x.source === oldFile.source));
  assert.equal(approvals, 1); assert.equal(writes, 1);
  await assert.rejects(r.execute("script_update_sources", {
    scriptId: "s123", expectedFingerprint: old.fingerprint,
    changes: [{ name: "Code", type: "SERVER_JS", source: "changed" }]
  }, principal), /CONTENT_CHANGED_REVIEW_REQUIRED/);
  assert.equal(writes, 1);
});

test("invalid source changes, missing manifest and page results fail safely", async () => {
  const approvals = { async consume() {} };
  const bad = registry([SCRIPT_WRITE], async () =>
    okay({ scriptId: "s123", files: [{ ...oldFile }] }), approvals);
  await assert.rejects(bad.execute("script_get_content", { scriptId: "s123" }, principal),
    /GOOGLE_MANIFEST_MISSING/);
  const r = registry([SCRIPT_WRITE], async (url, options) => {
    if (new URL(url).pathname.endsWith("/versions")) {
      return okay({ versions: [{ versionNumber: 2, description: "v2" }], nextPageToken: "NEXT" });
    }
    if (new URL(url).pathname.endsWith("/deployments")) {
      return okay({ deployments: [{ deploymentId: "dep1", deploymentConfig: {
        description: "API executable" } }] });
    }
    return okay(projectContent);
  }, approvals);
  const content = await r.execute("script_get_content", { scriptId: "s123" }, principal);
  await assert.rejects(r.execute("script_update_sources", {
    scriptId: "s123", expectedFingerprint: content.fingerprint,
    changes: [{ name: "appsscript", type: "SERVER_JS", source: "bad" }]
  }, principal), /INVALID_SOURCE_CHANGE/);
  const versions = await r.execute("script_list_versions", { scriptId: "s123" }, principal);
  const deployments = await r.execute("script_list_deployments", { scriptId: "s123" }, principal);
  assert.equal(versions.versions[0].versionNumber, 2);
  assert.equal(versions.nextPageToken, "NEXT");
  assert.equal(deployments.deployments[0].deploymentId, "dep1");
});
