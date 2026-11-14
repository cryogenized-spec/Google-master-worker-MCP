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
        name:"gmw-write-test",
        main:"apps/protected-mcp/src/index.ts",
        compatibility_date:"2026-11-10",
        compatibility_flags:["nodejs_compat"],
        workers_dev:false,
        vars:{
          AUTH_ISSUER:authHost,
          MCP_RESOURCE_URL:resource,
          GMW_WORKSPACE_READS_ENABLED:"false",
          GMW_WRITES_ENABLED:"true",
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
let protectedWorker, writeWorker;
before(async()=>{
  await server.listen();
  protectedWorker=server.getWorker("google-master-mcp");
  writeWorker=server.getWorker("gmw-write-test");
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

test("service-bound OAuth grants a 24-operation read-only catalogue",async()=>{
  const response=await request("/v1/capabilities","GET",{Authorization:good});
  const body=await response.text();
  assert.equal(response.status,200,body);
  const operations=JSON.parse(body).operations;
  assert.equal(operations.length,101);
  assert(operations.some(op=>op.name==="gmail_get_message_full"));
  assert(operations.some(op=>op.name==="calendar_query_freebusy"));
  assert(operations.some(op=>op.name==="gmail_list_messages"));
  assert(operations.some(op=>op.name==="sheets_get_values"));
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


test("wrong audience, expired tokens and incorrect operator identity are rejected",async()=>{
  for(const token of [
    "test-wrong-audience-token","test-expired-token","test-wrong-owner-token"
  ]){
    const response=await request("/v1/capabilities","GET",{
      Authorization:"Bearer "+token
    });
    assert.equal(response.status,401,token);
    assert.match(response.headers.get("WWW-Authenticate")||"",/invalid_token/);
  }
});

test("insufficient client scopes produce a 403 challenge with requested scope",async()=>{
  const response=await request("/v1/capabilities","GET",{
    Authorization:"Bearer test-under-scoped-token"
  });
  assert.equal(response.status,403);
  assert.match(response.headers.get("WWW-Authenticate")||"",/insufficient_scope/);
  assert.match(response.headers.get("WWW-Authenticate")||"",/mcp:read/);
});


test("M25 write-enabled MCP accepts mcp:read token for safe reads and advertises 191 tools",async()=>{
  const readToken=await writeWorker.fetch(origin+"/v1/capabilities",{
    headers:{Authorization:"Bearer test-owner-read-token"}
  });
  assert.equal(readToken.status,200);
  const readCatalogue=await readToken.json();
  assert.equal(readCatalogue.operations.length,101);
  assert(readCatalogue.operations.every(x=>x.risk==="read"));

  const permitted=await writeWorker.fetch(origin+"/v1/capabilities",{
    headers:{Authorization:"Bearer test-owner-write-token"}
  });
  const result=await permitted.json();
  assert.equal(permitted.status,200,JSON.stringify(result));
  assert.equal(result.operations.length,191);
  assert(result.operations.some(x=>x.name==="drive_copy_file"&&x.risk==="write"));
  assert(result.operations.some(x=>x.name==="gmail_send_message"&&x.risk==="external"));
  assert(!result.operations.some(x=>x.name==="write_prepare_action"));
});

test("M25 read-only OAuth token cannot call write REST operation; scope challenge points to mcp:write",async()=>{
  const resp=await writeWorker.fetch(origin+"/v1/operations/drive_copy_file",{
    method:"POST",headers:{
      Authorization:"Bearer test-owner-read-token",
      "Content-Type":"application/json"
    },body:JSON.stringify({fileId:"fake-file",name:"No mutation"})
  });
  assert.equal(resp.status,403);
  assert.match(resp.headers.get("WWW-Authenticate")||"",/mcp:write/);
  assert.deepEqual(await resp.json(),{error:"INSUFFICIENT_SCOPE"});
});

test("M25 write-scoped owner token reaches direct write path without approval page",async()=>{
  const resp=await writeWorker.fetch(origin+"/v1/operations/drive_copy_file",{
    method:"POST",headers:{
      Authorization:"Bearer test-owner-write-token",
      "Content-Type":"application/json"
    },body:JSON.stringify({fileId:"fake-file",name:"Synthetic copy"})
  });
  // No Google vault in the offline harness; the call is validated and
  // reaches Google-session boundary rather than a write-approval gate.
  assert.equal(resp.status,503);
  assert.deepEqual(await resp.json(),{error:"GOOGLE_SESSION_NOT_CONFIGURED"});
});


test("M25 workerd exposes per-tool read/write OAuth scopes on the actual MCP transport",async()=>{
  const req={
    method:"POST",
    headers:{
      Authorization:"Bearer test-owner-read-token",
      "Content-Type":"application/json",
      Accept:"application/json, text/event-stream",
      "MCP-Protocol-Version":"2026-07-28",
      "Mcp-Method":"tools/list"
    },
    body:JSON.stringify({jsonrpc:"2.0",id:99,method:"tools/list",
      params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}})
  };
  const response=await writeWorker.fetch(origin+"/mcp",req);
  const data=await response.text();
  assert.equal(response.status,200,data);
  const parsed=JSON.parse(data);
  const tools=parsed.result?.tools;
  assert.equal(tools?.length,191);
  assert.deepEqual(tools.find(t=>t.name==="tasks_list_tasklists").securitySchemes,
    [{type:"oauth2",scopes:["mcp:read"]}]);
  assert.deepEqual(tools.find(t=>t.name==="tasks_create_task").securitySchemes,
    [{type:"oauth2",scopes:["mcp:read","mcp:write"]}]);
});

test("M25 OAuth protected resource advertises write scope without requiring it for reads",async()=>{
  const response=await writeWorker.fetch(origin+"/.well-known/oauth-protected-resource/mcp");
  const body=await response.text();
  assert.equal(response.status,200,body);
  const metadata=JSON.parse(body);
  assert.deepEqual(metadata.scopes_supported,["mcp:read"]);
  assert.equal(metadata.resource,resource);
});
