import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { GoogleOAuthBroker } from "../dist/packages/google-auth/src/index.js";
import { encodeBase64Url } from "../dist/packages/google-auth/src/crypto.js";
import { GoogleOAuthStore } from "../dist/packages/google-auth/src/store.js";
import { createWorkspaceReadSessionStore, scopedMcpClientId } from
  "../dist/packages/google-auth/src/worker-session.js";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { registerGoogleTasks } from "../dist/packages/google-tasks/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";

const SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
const SUBJECT = "123456789012345678901";
const key = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const principal = { authenticated: true, clientId: "bootstrap_cli", accountId: "default" };
const config = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "EXAMPLE_FAKE_GOOGLE_SECRET_12345",
  redirectUri: "https://example.test/oauth/google/callback",
  encryptionKeyBase64Url: key,
  allowedSubject: SUBJECT
};
const fakeToken = "TEST_GOOGLE_ACCESS_TOKEN_LONG_STRING";
const migration = readFileSync(new URL("../migrations/0001_google_oauth_vault.sql", import.meta.url), "utf8");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const DB = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() { return stmt.get(...params) ?? null; },
            async run() { return stmt.run(...params); }
          };
        }
      };
    }
  };
  const store = new GoogleOAuthStore(DB);
  return { sqlite, DB, store, close() { sqlite.close(); } };
}

const googleExchange = async (url, options) => {
  if (url === "https://oauth2.googleapis.com/token") {
    assert.equal(options.method, "POST");
    return Response.json({
      access_token: fakeToken, refresh_token: "TEST_GOOGLE_REFRESH_TOKEN_LONG_STRING",
      scope: SCOPE + " openid email", token_type: "Bearer", expires_in: 3600
    });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    assert.equal(options.headers.Authorization, "Bearer " + fakeToken);
    return Response.json({
      sub: SUBJECT, email_verified: true, email: "owner@example.test"
    });
  }
  throw Error("Unexpected destination");
};

async function connectTestAccount(f) {
  const broker = new GoogleOAuthBroker(f.store, config, googleExchange);
  const { authorizationUrl } = await broker.begin(principal, [SCOPE]);
  const state = new URL(authorizationUrl).searchParams.get("state");
  await broker.complete(state, "FAKE_AUTH_CODE");
}

function environment(DB, enabled = "true") {
  return {
    DB, GMW_WORKSPACE_READS_ENABLED: enabled,
    GOOGLE_WORKSPACE_CLIENT_ID: config.clientId,
    GOOGLE_WORKSPACE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_WORKSPACE_REDIRECT_URI: config.redirectUri,
    GMW_TOKEN_ENC_KEY: config.encryptionKeyBase64Url,
    GMW_ALLOWED_GOOGLE_SUB: config.allowedSubject
  };
}

test("An authorized Workspace vault is still unavailable by default", async t => {
  const f = fixture(); t.after(f.close);
  await connectTestAccount(f);
  const opaque = await scopedMcpClientId("https://chatgpt.example.test/client.json");
  const disabled = createWorkspaceReadSessionStore(environment(f.DB, "false"), googleExchange);
  assert.equal(await disabled.get("default", opaque), null);
  assert.equal(await createWorkspaceReadSessionStore(environment(f.DB, ""), googleExchange)
    .get("default", opaque), null);
  assert.equal(await createWorkspaceReadSessionStore(environment(f.DB, "TRUE"), googleExchange)
    .get("default", opaque), null);
  const registry = new OperationRegistry(disabled);
  registerGoogleTasks(registry, new GoogleJsonClient(
    "https://tasks.googleapis.com", "/tasks/v1/",
    async () => { throw Error("Google must not be called"); }
  ));
  await assert.rejects(
    registry.execute("tasks_list_tasklists", {}, {
      authenticated: true, accountId: "default", clientId: opaque
    }), /GOOGLE_SESSION_NOT_CONFIGURED/
  );
});

test("Missing D1 or credentials fail closed even with opt-in", async () => {
  assert.throws(() => createWorkspaceReadSessionStore({
    GMW_WORKSPACE_READS_ENABLED: "true"
  }), /WORKSPACE_VAULT_NOT_CONFIGURED/);
  assert.throws(() => createWorkspaceReadSessionStore({
    ...environment(undefined), GOOGLE_WORKSPACE_CLIENT_SECRET: ""
  }), /WORKSPACE_VAULT_NOT_CONFIGURED/);
});

test("Real vault session can supply a read-only Tasks operation only for the verified client", async t => {
  const f = fixture(); t.after(f.close);
  await connectTestAccount(f);
  const clientId = await scopedMcpClientId("https://chatgpt.example.test/client.json");
  const store = createWorkspaceReadSessionStore(environment(f.DB), googleExchange);
  const actual = await store.get("default", clientId);
  assert.equal(actual.accessToken, fakeToken);
  assert.deepEqual(actual.scopes, [SCOPE]);
  assert.equal(actual.accessToken === "TEST_GOOGLE_REFRESH_TOKEN_LONG_STRING", false);

  await assert.rejects(store.get("another_account",clientId), /CLIENT_UNAUTHORIZED/);
  await assert.rejects(store.get("default","malicious_client"), /CLIENT_UNAUTHORIZED/);

  let requests = 0;
  const client = new GoogleJsonClient("https://tasks.googleapis.com", "/tasks/v1/",
    async (url, options) => {
      requests++;
      assert.equal(new URL(url).origin, "https://tasks.googleapis.com");
      assert.equal(options.headers.Authorization, "Bearer " + fakeToken);
      return Response.json({ items: [{ id: "one", title: "Test task" }] });
    });
  const operations = new OperationRegistry(store);
  registerGoogleTasks(operations, client);
  const result = await operations.execute("tasks_list_tasklists", {}, {
    authenticated: true, accountId: "default", clientId
  });
  assert.equal(requests, 1);
  assert.equal(result.items[0].title, "Test task");
  assert(!JSON.stringify(result).includes(fakeToken));
  assert(!JSON.stringify(result).includes("REFRESH_TOKEN"));
});

test("OAuth client identifiers are opaque, deterministic, bounded and distinct", async () => {
  const a = await scopedMcpClientId("https://chatgpt.example.test/client.json");
  const b = await scopedMcpClientId("https://chatgpt.example.test/client.json");
  const c = await scopedMcpClientId("ciRYVA_android_public_client");
  assert.match(a, /^mcp_[a-f0-9]{48}$/);
  assert.equal(a,b);
  assert.notEqual(a,c);
  assert(!a.includes("chatgpt.example.test"));
  await assert.rejects(scopedMcpClientId(""), /CLIENT_UNAUTHORIZED/);
  await assert.rejects(scopedMcpClientId("X".repeat(2049)), /CLIENT_UNAUTHORIZED/);
});
