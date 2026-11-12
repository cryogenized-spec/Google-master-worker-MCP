import test from "node:test";
import assert from "node:assert/strict";
import { verifyGoogleLogin, validLoginConfig } from "../dist/packages/client-oauth/src/google-identity.js";
import { escapeHtml, renderConsent } from "../dist/packages/client-oauth/src/html.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { registerGoogleTasks } from "../dist/packages/google-tasks/src/index.js";
import { registerAppsScript } from "../dist/packages/google-apps-script/src/index.js";
import { registerWorkspaceServices } from "../dist/packages/google-workspace/src/index.js";
import { createMcpServer } from "../dist/packages/mcp-adapter/src/index.js";

const login = {
  clientId: "1234567890-example.apps.googleusercontent.com",
  clientSecret: "FAKE_OPERATOR_LOGIN_SECRET_1234",
  callback: "https://auth.example.test/google/callback",
  allowedSubject: "123456789012345678901"
};

test("Operator OIDC login exchanges code with PKCE and validates Google's stable subject", async () => {
  const seen = [];
  const reply = async (url, options) => {
    seen.push({url,options});
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method,"POST");
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get("grant_type"),"authorization_code");
      assert.equal(fields.get("code_verifier"),"A".repeat(64));
      assert.equal(fields.get("redirect_uri"),login.callback);
      return Response.json({
        access_token:"FAKE_GOOGLE_LOGIN_TOKEN_12345",
        token_type:"Bearer", expires_in:3600
      });
    }
    assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal(options.headers.Authorization,"Bearer FAKE_GOOGLE_LOGIN_TOKEN_12345");
    return Response.json({
      sub:login.allowedSubject,email:"owner@example.test",email_verified:true
    });
  };
  const user = await verifyGoogleLogin("temp-code", "A".repeat(64),login,reply);
  assert.deepEqual(user,{userId:"owner",accountId:"default"});
  assert.equal(seen.length,2);
  assert(!JSON.stringify(user).includes("GOOGLE_LOGIN_TOKEN"));
});

test("Operator OIDC login fails closed for wrong identity, unverified email and provider failures", async () => {
  const fake = async (url) => url.endsWith("/token")
    ? Response.json({access_token:"FAKE_LONG_TOKEN_123",token_type:"Bearer"})
    : Response.json({sub:"1111111111",email:"unknown@example.test",email_verified:true});
  await assert.rejects(verifyGoogleLogin("code","A".repeat(64),login,fake),
    /IDENTITY_OPERATOR_NOT_ALLOWED/);
  const unver = async url => url.endsWith("/token")
    ? Response.json({access_token:"FAKE_LONG_TOKEN_123",token_type:"Bearer"})
    : Response.json({sub:login.allowedSubject,email:"owner@example.test",email_verified:false});
  await assert.rejects(verifyGoogleLogin("code","A".repeat(64),login,unver),
    /IDENTITY_OPERATOR_NOT_ALLOWED/);
  const unavailable = async () => {throw Error("LEAK_THIS_UPSTREAM_INTERNAL");};
  const error = await verifyGoogleLogin("code","A".repeat(64),login,unavailable)
    .then(()=>null,err=>err);
  assert.equal(error.message, "IDENTITY_PROVIDER_UNAVAILABLE");
  assert(!error.message.includes("LEAK_THIS_UPSTREAM_INTERNAL"));
  assert.equal(validLoginConfig({...login,callback:"http://evil.invalid/google/callback"}),false);
  assert.equal(validLoginConfig({...login,allowedSubject:"owner@example.test"}),false);
  await assert.rejects(verifyGoogleLogin("code","short",login,fake),
    /IDENTITY_LOGIN_INVALID/);
});

test("Google operator login refuses HTTP redirects without following a Location", async () => {
  const redirect = () => new Response(null, {
    status: 302, headers: { Location: "https://untrusted.example.test/steal" }
  });
  let firstCalls = 0;
  await assert.rejects(verifyGoogleLogin("code", "A".repeat(64), login,
    async (_url, init) => {
      firstCalls++;
      assert.equal(init.redirect, "manual");
      return redirect();
    }), /IDENTITY_LOGIN_DENIED/);
  assert.equal(firstCalls, 1);

  let secondCalls = 0;
  await assert.rejects(verifyGoogleLogin("code", "A".repeat(64), login,
    async (url, init) => {
      secondCalls++;
      assert.equal(init.redirect, "manual");
      return url.endsWith("/token")
        ? Response.json({access_token:"FAKE_LONG_TOKEN_123", token_type:"Bearer"})
        : redirect();
    }), /IDENTITY_LOGIN_DENIED/);
  assert.equal(secondCalls, 2);
});

test("consent HTML escapes hostile client names, domains, handles and scopes", () => {
  const markup = renderConsent({
    clientName:'<script>alert("bad")</script>',
    clientDomain:"<img src=x>",
    redirectHost:"evil.example.test",
    redirectIsLoopback:false,
    scope:['mcp:read','<bad>']
  }, '"><script>oops</script>');
  assert(!markup.includes('<script>alert'));
  assert(!markup.includes('<img src=x>'));
  assert(!markup.includes('"><script>oops</script>'));
  assert(markup.includes("&#60;script&#62;"));
  assert(markup.includes('evil.example.test'));
  assert.equal(escapeHtml("&<>"),"&#38;&#60;&#62;");
});


test("remote MCP adapter exposes broad read tools but no mutations", async () => {
  const registry = new OperationRegistry({ async get() { return null; } });
  registerGoogleTasks(registry);
  registerAppsScript(registry);
  registerWorkspaceServices(registry);
  const handler = createMcpHandler(() => createMcpServer(registry, async () => ({
    authenticated:true, clientId:"verified_mcp_client", accountId:"default"
  }), {readOnly:true}), {legacy:"stateless"});
  const request = new Request("http://localhost:8787/mcp", {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      Accept:"application/json, text/event-stream",
      "MCP-Protocol-Version":"2026-07-28",
      "Mcp-Method":"tools/list"
    },
    body: JSON.stringify({
      jsonrpc:"2.0", id:1, method:"tools/list",
      params:{_meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{name:"read-only-test",version:"1.0"}
      }}
    })
  });
  const response = await handler.fetch(request);
  const contents = await response.text();
  assert.equal(response.status,200,contents);
  const names = JSON.parse(contents).result.tools.map(x=>x.name);
  assert.equal(names.length,24);
  assert(names.includes("drive_list_files"));
  assert(names.includes("gmail_list_messages"));
  assert(names.includes("calendar_list_events"));
  assert(names.includes("forms_list_responses"));
  assert(names.includes("script_get_project"));
  assert(names.includes("tasks_list_tasks"));
  assert(!names.some(name=>name.includes("_create") || name.includes("_update")));
});
