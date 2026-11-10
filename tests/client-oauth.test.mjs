import test from "node:test";
import assert from "node:assert/strict";
import { verifyGoogleLogin, validLoginConfig } from "../dist/packages/client-oauth/src/google-identity.js";
import { escapeHtml, renderConsent } from "../dist/packages/client-oauth/src/html.js";
import protectedWorker from "../dist/apps/protected-mcp/src/index.js";

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
    assert.equal(options.redirect,"error");
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

const resource="https://mcp.example.test/mcp",issuer="https://auth.example.test";
const props={accountId:"default",userId:"owner"};
function envFor(validateToken) {
  return { MCP_RESOURCE_URL:resource, AUTH_ISSUER:issuer,
    AUTH_SERVER:{validateToken}};
}
const mcpRequest = (token) => new Request(resource, {
  method:"POST",
  headers:{
    Authorization:"Bearer "+token,
    "Content-Type":"application/json",
    "Accept":"application/json, text/event-stream",
    "MCP-Protocol-Version":"2026-07-28",
    "Mcp-Method":"tools/list"
  },
  body:JSON.stringify({
    jsonrpc:"2.0", method:"tools/list", id:1,
    params:{_meta:{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientCapabilities":{},
      "io.modelcontextprotocol/clientInfo":{name:"oauth-test",version:"0.0.1"}
    }}
  })
});

test("Protected MCP fails closed without authorization binding and issuer metadata", async () => {
  const bad = await protectedWorker.fetch(new Request(resource), {
    MCP_RESOURCE_URL:resource, AUTH_ISSUER:issuer
  }, {});
  assert.equal(bad.status,503);
  const mismatch=await protectedWorker.fetch(new Request("https://another.invalid/mcp"),
    envFor(async()=>null),{});
  assert.equal(mismatch.status,503);
  const health = await protectedWorker.fetch(new Request("https://mcp.example.test/healthz"),
    {},{});
  assert.equal(health.status,200);
});

test("Protected MCP advertises OAuth metadata and denies missing/invalid tokens", async () => {
  const env=envFor(async()=>null);
  const metadata=await protectedWorker.fetch(
    new Request("https://mcp.example.test/.well-known/oauth-protected-resource/mcp"),
    env,{});
  assert.equal(metadata.status,200);
  const obj=await metadata.json();
  assert.equal(obj.resource,resource);
  assert.deepEqual(obj.authorization_servers,[issuer]);
  const noToken=await protectedWorker.fetch(new Request(resource),env,{});
  assert.equal(noToken.status,401);
  assert(noToken.headers.get("WWW-Authenticate").includes("Bearer"));
  const invalid=await protectedWorker.fetch(mcpRequest("wrong-token"),env,{});
  assert.equal(invalid.status,401);
});

test("Protected MCP serves only read tools after OAuth validation and never Google data", async () => {
  let checks=0;
  const env=envFor(async (askedResource, token)=>{
    checks++;
    assert.equal(askedResource,resource);
    if(token!=="valid-token") return null;
    return {props,audience:resource,scope:["mcp:read"],clientId:"trusted-app",
      userId:"owner",expiresAt:Math.floor(Date.now()/1000)+300};
  });
  const response=await protectedWorker.fetch(mcpRequest("valid-token"),env,{});
  const body=await response.text();
  assert.equal(response.status,200,body);
  const decoded=JSON.parse(body);
  const tools=decoded.result.tools;
  assert.equal(tools.length,7);
  assert(tools.every(tool=>!tool.name.includes("create") && !tool.name.includes("update")));
  assert(tools.some(tool=>tool.name==="script_get_content"));
  assert.equal(checks,1);
});

test("Protected MCP rejects wrong audience and untrusted operator even with good token", async () => {
  const wrongAudience = envFor(async()=>({
    props,audience:"https://other.example.test/mcp",scope:["mcp:read"],
    userId:"owner",clientId:"trusted-app"
  }));
  assert.equal((await protectedWorker.fetch(mcpRequest("valid-token"),wrongAudience,{})).status,401);
  const wrongSubject=envFor(async()=>({
    props:{accountId:"default",userId:"another"},
    audience:resource,scope:["mcp:read"],userId:"another",clientId:"trusted-app"
  }));
  const result=await protectedWorker.fetch(mcpRequest("valid-token"),wrongSubject,{});
  assert.equal(result.status,403);
});
