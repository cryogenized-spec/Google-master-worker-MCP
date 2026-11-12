import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { OperationError } from "../dist/packages/core/src/index.js";
import {
  importVaultKey, seal, unseal, encodeBase64Url
} from "../dist/packages/google-auth/src/crypto.js";
import { GoogleOAuthStore } from "../dist/packages/google-auth/src/store.js";
import {
  GoogleOAuthBroker
} from "../dist/packages/google-auth/src/index.js";
import { PERSONAL_WORKSPACE_SCOPES } from "../dist/packages/google-auth/src/scopes.js";
import { WORKSPACE_SCOPES } from "../dist/packages/google-auth/src/scopes.js";

const requested = "https://www.googleapis.com/auth/tasks.readonly";
const write = "https://www.googleapis.com/auth/tasks";
const principal = { authenticated: true, accountId: "default", clientId: "trusted_client" };
const secretKey = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const config = {
  clientId: "test-id.apps.googleusercontent.com",
  clientSecret: "FAKE_CLIENT_SECRET_NOT_FOR_PRODUCTION",
  redirectUri: "https://worker.example.test/oauth/google/callback",
  encryptionKeyBase64Url: secretKey,
  allowedSubject: "123456789012345678901"
};
const identityUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const identityReply = (sub = config.allowedSubject, emailVerified = true) => Response.json({
  sub, email: "owner@example.test", email_verified: emailVerified
});
const migration = readFileSync(new URL("../migrations/0001_google_oauth_vault.sql", import.meta.url), "utf8");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() { return statement.run(...values); }
          };
        }
      };
    }
  };
  return { sqlite, store: new GoogleOAuthStore(db), close() { sqlite.close(); } };
}
function tokenReply(accessToken = "FAKE_ACCESS_TOKEN_THAT_IS_LONG", opts = {}) {
  return new Response(JSON.stringify({
    access_token: accessToken,
    ...(opts.refreshToken === false ? {} :
      { refresh_token: opts.refreshToken ?? "FAKE_REFRESH_TOKEN_THAT_IS_LONG" }),
    expires_in: opts.expiresIn ?? 3600,
    scope: opts.scope ?? requested + " openid email",
    token_type: "Bearer"
  }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
}

test("AES-256-GCM seals data and rejects tampering, swapped account and wrong key", async () => {
  const key = await importVaultKey(secretKey);
  const encrypted = await seal(key, "connection:default", { secret: "DO_NOT_LEAK" });
  assert(!encrypted.includes("DO_NOT_LEAK"));
  assert.deepEqual(await unseal(key, "connection:default", encrypted),
    { secret: "DO_NOT_LEAK" });
  await assert.rejects(unseal(key, "connection:other", encrypted), /CREDENTIAL_UNREADABLE/);
  await assert.rejects(unseal(key, "connection:default", encrypted.slice(0, -1) + "Z"),
    /CREDENTIAL_UNREADABLE/);
  const wrongKey = await importVaultKey(
    encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  await assert.rejects(unseal(wrongKey, "connection:default", encrypted),
    /CREDENTIAL_UNREADABLE/);
  await assert.rejects(importVaultKey("not-a-32-byte-key"), /ENCRYPTION_NOT_CONFIGURED/);
});

test("authorization URL has PKCE S256 + offline consent; D1 stores no raw state/verifier", async t => {
  const f = fixture(); t.after(f.close);
  const broker = new GoogleOAuthBroker(f.store, config, async () => {
    throw Error("Not called before redirect");
  });
  const result = await broker.begin(principal, [requested]);
  const auth = new URL(result.authorizationUrl);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("scope"), requested + " openid email");
  const state = auth.searchParams.get("state");
  assert.equal(state.length, 43);
  assert.equal(auth.searchParams.get("code_challenge").length, 43);
  const pending = f.sqlite.prepare("SELECT * FROM google_oauth_pending").get();
  assert.equal(pending.account_id, principal.accountId);
  assert.equal(pending.client_id, principal.clientId);
  assert.notEqual(pending.state_hash, state);
  assert(!JSON.stringify(pending).includes(state));
  assert(!pending.verifier_enc.includes("FAKE_CLIENT_SECRET"));
  assert.equal(result.expiresAt > Date.now(), true);
});


test("one-session authorization supports the entire registered Workspace scope bundle", async t => {
  const f = fixture(); t.after(f.close);
  let tokenExchanges = 0;
  const broker = new GoogleOAuthBroker(f.store, config, async url => {
    if (url === identityUrl) return identityReply();
    tokenExchanges++;
    return tokenReply("FAKE_ACCESS_TOKEN_THAT_IS_LONG", {
      scope: [...WORKSPACE_SCOPES, "openid", "email"].join(" ")
    });
  });
  assert(WORKSPACE_SCOPES.length >= 35);
  assert.equal(new Set(WORKSPACE_SCOPES).size, WORKSPACE_SCOPES.length);
  const started = await broker.begin(principal, WORKSPACE_SCOPES);
  const url = new URL(started.authorizationUrl);
  const requestedScopes = url.searchParams.get("scope").split(" ");
  assert.deepEqual(new Set(requestedScopes), new Set([...WORKSPACE_SCOPES, "openid", "email"]));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  const state = url.searchParams.get("state");
  const completed = await broker.complete(state, "fake-code");
  assert.deepEqual(completed.scopes, [...WORKSPACE_SCOPES].sort());
  assert.equal(tokenExchanges, 1);
  const stored = await f.store.load("default");
  assert.deepEqual(JSON.parse(stored.scopes_json), [...WORKSPACE_SCOPES].sort());
  assert(!stored.tokens_enc.includes("FAKE_ACCESS_TOKEN"));
});

test("callback consumes state once, exchanges code with PKCE, encrypts tokens, exposes only safe metadata", async t => {
  const f = fixture(); t.after(f.close);
  let exchanges = 0;
  const broker = new GoogleOAuthBroker(f.store, config, async (url, options) => {
    if (url === identityUrl) {
      assert.equal(options.headers.Authorization, "Bearer FAKE_ACCESS_TOKEN_THAT_IS_LONG");
      return identityReply();
    }
    exchanges++;
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    const data = new URLSearchParams(options.body);
    assert.equal(data.get("grant_type"), "authorization_code");
    assert.equal(data.get("client_id"), config.clientId);
    assert.equal(data.get("client_secret"), config.clientSecret);
    assert.equal(data.get("redirect_uri"), config.redirectUri);
    assert.match(data.get("code_verifier"), /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(data.get("code"), "disposable-test-code");
    return tokenReply();
  });
  const { authorizationUrl } = await broker.begin(principal, [requested]);
  const state = new URL(authorizationUrl).searchParams.get("state");
  const completed = await broker.complete(state, "disposable-test-code");
  assert.deepEqual(completed.scopes, [requested]);
  assert.equal(completed.accountId, "default");
  assert.equal(completed.connected, true);
  assert(!JSON.stringify(completed).includes("FAKE_"));
  assert.equal(exchanges, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM google_oauth_pending").get().count, 0);
  const stored = f.sqlite.prepare("SELECT * FROM google_oauth_connections").get();
  assert(!stored.tokens_enc.includes("FAKE_ACCESS_TOKEN"));
  assert(!stored.tokens_enc.includes("FAKE_REFRESH_TOKEN"));
  const session = await broker.get("default", "trusted_client");
  assert.equal(session.accessToken, "FAKE_ACCESS_TOKEN_THAT_IS_LONG");
  assert.deepEqual(session.scopes, [requested]); // OIDC identity scopes are never tool grants
  assert.deepEqual(session.scopes, [requested]); // OIDC identity scopes are never tool grants
  await assert.rejects(broker.complete(state, "disposable-test-code"),
    /GOOGLE_OAUTH_STATE_EXPIRED_OR_USED/);
  await assert.rejects(broker.begin(principal, [requested]),
    /GOOGLE_ACCOUNT_ALREADY_CONNECTED/);
  assert.equal(await broker.disconnectLocal("default"), true);
  assert.equal(await broker.get("default", "trusted_client"), null);
  assert.equal(await broker.disconnectLocal("default"), false);
});

test("callback cannot redeem expired state, unknown scope or a replayed state", async t => {
  const f = fixture(); t.after(f.close);
  let current = 1000000;
  let httpCalls = 0;
  const broker = new GoogleOAuthBroker(f.store, config, async () => {
    httpCalls++;
    return tokenReply();
  }, () => current);
  await assert.rejects(broker.begin(principal, ["https://www.googleapis.com/auth/unsupported.scope"]),
    /GOOGLE_SCOPES_INVALID/);
  await assert.rejects(broker.begin({ ...principal, authenticated: false }, [requested]),
    /CLIENT_UNAUTHORIZED/);
  const { authorizationUrl } = await broker.begin(principal, [requested]);
  const state = new URL(authorizationUrl).searchParams.get("state");
  current += 600001;
  await assert.rejects(broker.complete(state, "test-code"),
    /GOOGLE_OAUTH_STATE_EXPIRED_OR_USED/);
  assert.equal(httpCalls, 0);
  await assert.rejects(broker.complete("invalid", "test-code"),
    /GOOGLE_OAUTH_CALLBACK_INVALID/);
});

test("Workspace token exchange rejects provider redirects without saving credentials", async t => {
  const f=fixture(); t.after(f.close);
  let requests=0;
  const broker=new GoogleOAuthBroker(f.store,config,async (url,options)=>{
    requests++;
    assert.equal(url,"https://oauth2.googleapis.com/token");
    assert.equal(options.redirect,"manual");
    return new Response(null,{status:302,headers:{
      Location:"https://untrusted.example.test/steal"
    }});
  });
  const flow=await broker.begin(principal,[requested]);
  await assert.rejects(broker.complete(
    new URL(flow.authorizationUrl).searchParams.get("state"),"disposable-code"
  ),/GOOGLE_OAUTH_TOKEN_REJECTED/);
  assert.equal(requests,1);
  assert.equal(await f.store.load("default"),null);
});

test("missing refresh token and unexpected provider scopes never create a connection", async t => {
  const f = fixture(); t.after(f.close);
  let next = tokenReply("FAKE_ACCESS_TOKEN_THAT_IS_LONG", { refreshToken: false });
  const broker = new GoogleOAuthBroker(f.store, config, async () => next);
  const first = await broker.begin(principal, [requested]);
  await assert.rejects(
    broker.complete(new URL(first.authorizationUrl).searchParams.get("state"), "code-a"),
    /GOOGLE_REFRESH_TOKEN_MISSING/
  );
  assert.equal(await f.store.load("default"), null);
  next = tokenReply("FAKE_ACCESS_TOKEN_THAT_IS_LONG", { scope: write + " openid email" });
  const second = await broker.begin(principal, [requested]);
  await assert.rejects(
    broker.complete(new URL(second.authorizationUrl).searchParams.get("state"), "code-b"),
    /GOOGLE_SCOPES_INVALID/
  );
  assert.equal(await f.store.load("default"), null);
});

test("personal Workspace bundle stores only actual user-approved scope subset", async t => {
  const f=fixture(); t.after(f.close);
  const approved=[requested,"https://www.googleapis.com/auth/drive"];
  const broker=new GoogleOAuthBroker(f.store,config,async url =>
    url===identityUrl ? identityReply() : tokenReply(undefined,{
      scope:[...approved,"openid","email"].join(" ")
    }));
  assert.equal(PERSONAL_WORKSPACE_SCOPES.length,23);
  const started=await broker.begin(principal,PERSONAL_WORKSPACE_SCOPES);
  const proposed=new URL(started.authorizationUrl).searchParams.get("scope").split(" ");
  assert.deepEqual(new Set(proposed),new Set([...PERSONAL_WORKSPACE_SCOPES,"openid","email"]));
  const state=new URL(started.authorizationUrl).searchParams.get("state");
  const saved=await broker.complete(state,"code");
  assert.deepEqual(saved.scopes,[...approved].sort());
  assert.deepEqual(JSON.parse((await f.store.load("default")).scopes_json),[...approved].sort());
});

test("granular consent with no Workspace permission does not create a connection", async t => {
  const f=fixture(); t.after(f.close);
  const broker=new GoogleOAuthBroker(f.store,config,async url =>
    url===identityUrl ? identityReply() : tokenReply(undefined,{
      scope:"openid email"
    }));
  const started=await broker.begin(principal,PERSONAL_WORKSPACE_SCOPES);
  await assert.rejects(broker.complete(
    new URL(started.authorizationUrl).searchParams.get("state"),"temporary-code"
  ),/GOOGLE_SCOPES_INVALID/);
  assert.equal(await f.store.load("default"),null);
});

test("expired access token refreshes through Google endpoint, preserves refresh token, increments version", async t => {
  const f = fixture(); t.after(f.close);
  let clock = 1000000;
  let refreshes = 0;
  const broker = new GoogleOAuthBroker(f.store, config, async (_url, opts) => {
    if (_url === identityUrl) return identityReply();
    const fields = new URLSearchParams(opts.body);
    if (fields.get("grant_type") === "authorization_code") {
      return tokenReply("FAKE_INITIAL_ACCESS_TOKEN", { expiresIn: 90 });
    }
    refreshes++;
    assert.equal(fields.get("grant_type"), "refresh_token");
    assert.equal(fields.get("refresh_token"), "FAKE_REFRESH_TOKEN_THAT_IS_LONG");
    return tokenReply("FAKE_ROTATED_ACCESS_TOKEN", {
      expiresIn: 3600, refreshToken: false
    });
  }, () => clock);
  const started = await broker.begin(principal, [requested]);
  await broker.complete(new URL(started.authorizationUrl).searchParams.get("state"), "code");
  const before = await broker.get("default", "trusted_client");
  assert.equal(before.accessToken, "FAKE_INITIAL_ACCESS_TOKEN");
  clock += 60_000;
  const after = await broker.get("default", "trusted_client");
  assert.equal(after.accessToken, "FAKE_ROTATED_ACCESS_TOKEN");
  assert.equal(refreshes, 1);
  assert.equal((await f.store.load("default")).version, 2);
  const again = await broker.get("default", "trusted_client");
  assert.equal(again.accessToken, "FAKE_ROTATED_ACCESS_TOKEN");
  assert.equal(refreshes, 1);
});

test("concurrent update cannot overwrite a newer credential version", async t => {
  const f = fixture(); t.after(f.close);
  await f.store.connectNew({
    account_id: "default", tokens_enc: "g1.mock.encrypted",
    scopes_json: JSON.stringify([requested]), access_expires_at: 1000
  }, 0);
  const initial = await f.store.load("default");
  const update = { account_id: "default", tokens_enc: "g1.different.encrypted",
    scopes_json: JSON.stringify([requested]), access_expires_at: 2000 };
  assert.equal(await f.store.compareAndSetTokens(update, initial.version, 200), true);
  assert.equal(await f.store.compareAndSetTokens(update, initial.version, 201), false);
  assert.equal((await f.store.load("default")).version, 2);
});

test("tampered stored ciphertext fails closed and errors never reveal provider secrets", async t => {
  const f = fixture(); t.after(f.close);
  const broker = new GoogleOAuthBroker(f.store, config,
    async url => url === identityUrl ? identityReply() : tokenReply());
  const flow = await broker.begin(principal, [requested]);
  await broker.complete(new URL(flow.authorizationUrl).searchParams.get("state"), "code");
  f.sqlite.prepare("UPDATE google_oauth_connections SET tokens_enc = ? WHERE account_id='default'")
    .run("g1.ABC.not-valid");
  await assert.rejects(broker.get("default", "trusted_client"), /CREDENTIAL_UNREADABLE/);
  assert(!JSON.stringify(await f.store.load("default")).includes("FAKE_ACCESS_TOKEN"));
});


test("Workspace OAuth rejects a different signed-in Google subject before saving credentials", async t => {
  const f = fixture(); t.after(f.close);
  let userInfoCalls = 0;
  const broker = new GoogleOAuthBroker(f.store, config, async url => {
    if (url === identityUrl) {
      userInfoCalls++;
      return identityReply("109999999999999999999");
    }
    return tokenReply();
  });
  const flow = await broker.begin(principal, [requested]);
  const state = new URL(flow.authorizationUrl).searchParams.get("state");
  await assert.rejects(broker.complete(state, "code"), /GOOGLE_IDENTITY_MISMATCH/);
  assert.equal(userInfoCalls, 1);
  assert.equal(await f.store.load("default"), null);
  await assert.rejects(broker.complete(state, "code"), /GOOGLE_OAUTH_STATE_EXPIRED_OR_USED/);
});

test("Workspace OAuth rejects unverified identity and missing OIDC scopes", async t => {
  const f = fixture(); t.after(f.close);
  let tokenScope = requested + " openid email";
  let verified = false;
  const broker = new GoogleOAuthBroker(f.store, config, async url => {
    if (url === identityUrl) return identityReply(config.allowedSubject, verified);
    return tokenReply("FAKE_ACCESS_TOKEN_THAT_IS_LONG", {scope: tokenScope});
  });
  const flow1 = await broker.begin(principal, [requested]);
  await assert.rejects(broker.complete(new URL(flow1.authorizationUrl).searchParams.get("state"),"code"),
    /GOOGLE_IDENTITY_MISMATCH/);
  assert.equal(await f.store.load("default"), null);
  tokenScope = requested;
  verified = true;
  const flow2 = await broker.begin(principal, [requested]);
  await assert.rejects(broker.complete(new URL(flow2.authorizationUrl).searchParams.get("state"),"code"),
    /GOOGLE_IDENTITY_SCOPES_DENIED/);
  assert.equal(await f.store.load("default"), null);
});

test("Workspace OAuth refuses unrelated provider scope escalation, userinfo outage and broken config", async t => {
  const f = fixture(); t.after(f.close);
  const unexpected = new GoogleOAuthBroker(f.store, config, async url =>
    url === identityUrl ? identityReply() :
      tokenReply("FAKE_ACCESS_TOKEN_THAT_IS_LONG",
        {scope: requested + " openid email https://www.googleapis.com/auth/drive"}));
  const flow = await unexpected.begin(principal,[requested]);
  await assert.rejects(unexpected.complete(new URL(flow.authorizationUrl).searchParams.get("state"),"code"),
    /GOOGLE_SCOPES_INVALID/);
  assert.equal(await f.store.load("default"),null);
  const down = new GoogleOAuthBroker(f.store, config, async url => {
    if (url === identityUrl) throw Error("PROVIDER_SECRET_ERROR");
    return tokenReply();
  });
  const flow2=await down.begin(principal,[requested]);
  await assert.rejects(down.complete(new URL(flow2.authorizationUrl).searchParams.get("state"),"code"),
    /GOOGLE_IDENTITY_UNAVAILABLE/);
  assert.equal(await f.store.load("default"),null);
  assert.throws(() => new GoogleOAuthBroker(f.store,{...config,allowedSubject:"wrong@email.com"}),
    /GOOGLE_OAUTH_NOT_CONFIGURED/);
});
