import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "wrangler";

const origin="https://mcp.example.test";
const resource=origin+"/mcp";
const authHost="https://auth.example.test";
const good="Bearer test-owner-read-token";
const explicit="https://trusted-client.example.test";

/**
 * Cloudflare's supported, non-deprecated Wrangler harness runs actual Worker
 * bundles and RPC bindings in locally simulated workerd, not Node's ESM loader.
 * No real Cloudflare credentials, Google API calls or D1 resources exist.
 */
const server=createTestHarness({
  workers:[
    {
      config:{
        name:"google-master-mcp",
        main:"apps/protected-mcp/src/index.ts",
        compatibility_date:"2026-11-10",
        compatibility_flags:["nodejs_compat"],
        workers_dev:false,
        vars:{
          AUTH_ISSUER:authHost,
          MCP_RESOURCE_URL:resource,
          GMW_WORKSPACE_READS_ENABLED:"false",
          GMW_ALLOWED_BROWSER_ORIGINS:explicit
        },
        services:[{binding:"AUTH_SERVER",service:"gmw-test-auth"}]
      }
    },
    {
      config:{
        name:"gmw-test-auth",
        main:"tests/fixtures/oauth-test-auth-worker.ts",
        compatibility_date:"2026-11-10",
        compatibility_flags:["nodejs_compat"],
        workers_dev:false
      }
    }
  ]
});
let protectedWorker;
before(async()=>{
  await server.listen();
  protectedWorker=server.getWorker("google-master-mcp");
},{timeout:60000});
after(async()=>{await server.close();},{timeout:60000});

function request(path,method="GET",headers={},body){
  return protectedWorker.fetch(origin+path,{method,headers,body});
}

test("health discloses no secrets or connection details",async()=>{
  const response=await request("/healthz");
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:"locked",googleConnection:false});
});

test("client with no OAuth bearer token receives resource 401",async()=>{
  const response=await request("/v1/capabilities");
  assert.equal(response.status,401);
  assert.match(response.headers.get("WWW-Authenticate")||"",/Bearer/i);
});

test("invalid token and guessed write URLs fail closed before Google",async()=>{
  const invalid=await request("/v1/capabilities","GET",{
    Authorization:"Bearer fake-unknown-token"
  });
  assert.equal(invalid.status,401);
  const write=await request("/v1/operations/tasks_create_task","POST",{
    Authorization:good,"Content-Type":"application/json"
  },JSON.stringify({tasklistId:"one",title:"no writes"}));
  assert.equal(write.status,404);
  assert.deepEqual(await write.json(),{error:"UNKNOWN_OPERATION"});
});

test("service-bound OAuth grants a seven-operation read-only catalogue",async()=>{
  const response=await request("/v1/capabilities","GET",{Authorization:good});
  const body=await response.text();
  assert.equal(response.status,200,body);
  const operations=JSON.parse(body).operations;
  assert.equal(operations.length,7);
  assert(operations.every(op=>op.risk==="read"));
  assert(operations.some(op=>op.name==="tasks_list_tasklists"));
  assert(!body.includes("test-owner-read-token"));
});

test("valid client OAuth cannot access Google when vault reads disabled",async()=>{
  const response=await request("/v1/operations/tasks_list_tasklists","POST",{
    Authorization:good,"Content-Type":"application/json"
  },"{}");
  const body=await response.text();
  assert.equal(response.status,503,body);
  assert.deepEqual(JSON.parse(body),{error:"GOOGLE_SESSION_NOT_CONFIGURED"});
});

test("preflight allows exact listed origin, rejects foreign origins, no wildcard",async()=>{
  const okay=await request("/v1/capabilities","OPTIONS",{
    Origin:explicit,
    "Access-Control-Request-Method":"GET",
    "Access-Control-Request-Headers":"authorization"
  });
  assert.equal(okay.status,204);
  assert.equal(okay.headers.get("Access-Control-Allow-Origin"),explicit);
  assert.equal(okay.headers.get("Access-Control-Allow-Credentials"),null);
  const denied=await request("/v1/capabilities","OPTIONS",{
    Origin:"https://attacker.example.test",
    "Access-Control-Request-Method":"GET",
    "Access-Control-Request-Headers":"authorization"
  });
  assert.equal(denied.status,403);
  const hostile=await request("/v1/capabilities","GET",{
    Origin:"https://attacker.example.test",Authorization:good
  });
  assert.equal(hostile.status,403);
});

test("allowlisted browser receives CORS headers on OAuth rejection and success",async()=>{
  const bad=await request("/v1/capabilities","GET",{
    Origin:explicit,Authorization:"Bearer invalid"
  });
  assert.equal(bad.status,401);
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"),explicit);
  const goodResponse=await request("/v1/capabilities","GET",{
    Origin:explicit,Authorization:good
  });
  assert.equal(goodResponse.status,200);
  assert.equal(goodResponse.headers.get("Access-Control-Allow-Origin"),explicit);
});

test("MCP route rejects absent OAuth and remains distinct from direct HTTPS routes",async()=>{
  const response=await request("/mcp","POST",{
    "Content-Type":"application/json",
    Accept:"application/json, text/event-stream",
    "MCP-Protocol-Version":"2026-07-28",
    "Mcp-Method":"tools/list"
  },JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",
    params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}));
  assert.equal(response.status,401);
});
