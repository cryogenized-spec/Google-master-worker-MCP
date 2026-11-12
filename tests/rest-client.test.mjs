import test from "node:test";
import assert from "node:assert/strict";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";
import { registerGoogleTasks } from "../dist/packages/google-tasks/src/index.js";
import { registerAppsScript } from "../dist/packages/google-apps-script/src/index.js";
import { registerWorkspaceServices } from "../dist/packages/google-workspace/src/index.js";
import {
  handleReadOnlyApi, readOperationCatalogue, corsOrigin, corsResponse,
  restPreflight
} from "../dist/packages/rest-adapter/src/index.js";
import {
  GoogleMasterReadClient, GoogleMasterClientError
} from "../dist/packages/client-sdk/src/index.js";

const ORIGIN="https://mcp.example.test", RESOURCE=ORIGIN+"/mcp";
const principal={authenticated:true,accountId:"default",clientId:"mcp_"+"a".repeat(48)};
const access="FAKE_TEST_GOOGLE_ACCESS_TOKEN_012345";
let googleRequests;
function registryWithFakeGoogle({scopes=["https://www.googleapis.com/auth/tasks.readonly"]}={}) {
  googleRequests=0;
  const session={async get(){return {accessToken:access,scopes,expiresAt:Date.now()+100_000};}};
  const registry=new OperationRegistry(session);
  registerGoogleTasks(registry,new GoogleJsonClient(
    "https://tasks.googleapis.com","/tasks/v1/",async(url,opts)=>{
      googleRequests++;
      assert.equal(new URL(url).origin,"https://tasks.googleapis.com");
      assert.equal(opts.headers.Authorization,"Bearer "+access);
      return Response.json({items:[{id:"list-01",title:"Workshop",updated:"2026-11-10T12:00:00.000Z"}]});
    }
  ));
  registerAppsScript(registry,new GoogleJsonClient(
    "https://script.googleapis.com","/v1/",async()=>{throw Error("SCRIPT API MUST NOT BE CALLED");}
  ));
  registerWorkspaceServices(registry);
  return registry;
}
function post(path,body="{}",extra={}) {
  return new Request(ORIGIN+path,{
    method:"POST",headers:{"Content-Type":"application/json",...extra},body
  });
}

test("REST capability catalogue exposes broad read-only Google Workspace operations",async()=>{
  const registry=registryWithFakeGoogle();
  const response=await handleReadOnlyApi(
    new Request(ORIGIN+"/v1/capabilities"),registry,principal
  );
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.operations.length,24);
  assert(result.operations.some(o=>o.name==="docs_get_document"));
  assert(result.operations.some(o=>o.name==="contacts_list_connections"));
  assert(result.operations.every(x=>x.risk==="read"));
  assert(!result.operations.some(x=>/create|update|delete/.test(x.name)));
  assert.deepEqual(result.operations,readOperationCatalogue(registry));
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal(googleRequests,0);
});

test("REST read invokes the same scoped, Zod-validated Google operation as MCP",async()=>{
  const registry=registryWithFakeGoogle();
  const result=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists","{}"),registry,principal
  );
  assert.equal(result.status,200);
  const payload=await result.json();
  assert.equal(payload.result.items[0].title,"Workshop");
  assert.equal(googleRequests,1);
  assert(!JSON.stringify(payload).includes(access));
});

test("REST rejects ALL writes before Google I/O even with existing Google write scope",async()=>{
  const registry=registryWithFakeGoogle({
    scopes:["https://www.googleapis.com/auth/tasks"]
  });
  for(const name of ["tasks_create_task","script_update_sources","script_create_project","script_create_version"]){
    const result=await handleReadOnlyApi(
      post("/v1/operations/"+name,JSON.stringify({title:"NEVER WRITE"})),registry,principal
    );
    assert.equal(result.status,404,name);
    assert.deepEqual(await result.json(),{error:"UNKNOWN_OPERATION"});
  }
  assert.equal(googleRequests,0);
});

test("REST enforces JSON, bounded input, schema validation, exact path and verbs",async()=>{
  const registry=registryWithFakeGoogle();
  const wrongType=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists","{}",{"Content-Type":"text/plain"}),registry,principal
  );
  assert.equal(wrongType.status,415);
  const invalid=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists","{"),registry,principal
  );
  assert.deepEqual(await invalid.json(),{error:"INVALID_JSON_BODY"});
  const strict=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists",'{"unexpected":42}'),registry,principal
  );
  assert.deepEqual(await strict.json(),{error:"INVALID_ARGUMENTS"});
  const tooBig=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists",
      JSON.stringify({payload:"a".repeat(40_000)})),registry,principal
  );
  assert.equal(tooBig.status,400);
  assert.deepEqual(await tooBig.json(),{error:"INPUT_TOO_LARGE"});
  const getOperation=await handleReadOnlyApi(
    new Request(ORIGIN+"/v1/operations/tasks_list_tasklists"),registry,principal
  );
  assert.equal(getOperation.status,405);
  const wrong=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists/"),registry,principal
  );
  assert.equal(wrong.status,404);
  assert.equal(googleRequests,0);
});

test("REST CORS preflight is strict and never accepts wildcard/unknown browser origins",async()=>{
  const allowed="https://workspace.example.test,moz-extension://abcd1234-0000-1111-2222-333333333333";
  const preflight=(origin,method="POST",headers="authorization, content-type",path="/v1/operations/tasks_list_tasks")=>
    new Request(ORIGIN+path,{method:"OPTIONS",headers:{
      Origin:origin,"Access-Control-Request-Method":method,
      "Access-Control-Request-Headers":headers
    }});
  const good=restPreflight(preflight("https://workspace.example.test"),allowed);
  assert.equal(good.status,204);
  assert.equal(good.headers.get("Access-Control-Allow-Origin"),"https://workspace.example.test");
  assert.equal(good.headers.get("Access-Control-Allow-Credentials"),null);
  assert.equal(restPreflight(preflight("https://evil.test"),allowed).status,403);
  assert.equal(restPreflight(preflight("null"),allowed).status,403);
  assert.equal(restPreflight(preflight("https://workspace.example.test","DELETE"),allowed).status,403);
  assert.equal(restPreflight(preflight("https://workspace.example.test","POST","x-elevated-role"),allowed).status,403);
  assert.equal(restPreflight(preflight("https://workspace.example.test","POST","authorization, content-type","/v1/operations/tasks_create_task"),allowed).status,204);
  // Preflight is not a grant; an authenticated protected route still denies
  // the actual write tool as UNKNOWN_OPERATION.
  const isolated=post("/v1/operations/tasks_list_tasklists","{}",{Origin:"https://evil.test"});
  assert.equal(corsOrigin(isolated,allowed),false);
  assert.equal(corsOrigin(post("/v1/operations/tasks_list_tasklists"),allowed),null);
  assert.equal(corsOrigin(post("/v1/operations/tasks_list_tasklists","{}",{Origin:"moz-extension://abcd1234-0000-1111-2222-333333333333"}),allowed),
    "moz-extension://abcd1234-0000-1111-2222-333333333333");
  const response=corsResponse(Response.json({ok:true}),"https://workspace.example.test");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"https://workspace.example.test");
});

test("portable TypeScript client uses the typed HTTPS API without leaking a bearer token",async()=>{
  const registry=registryWithFakeGoogle();
  let calls=0;
  const client=new GoogleMasterReadClient({
    resourceUrl:RESOURCE,
    getAccessToken:async()=> "FAKE_OAUTH_CLIENT_ACCESS_TOKEN_456789",
    transport:async(url,init)=>{
      calls++;
      assert.equal(new URL(url).origin,ORIGIN);
      assert.equal(init.headers.Authorization,"Bearer FAKE_OAUTH_CLIENT_ACCESS_TOKEN_456789");
      assert.equal(init.credentials,"omit");
      assert.equal(init.redirect,"error");
      assert.equal(init.cache,"no-store");
      return handleReadOnlyApi(new Request(url,init),registry,principal);
    }
  });
  const catalog=await client.capabilities();
  assert.equal(catalog.length,24);
  const output=await client.call("tasks_list_tasklists",{maxResults:5});
  assert.equal(output.items[0].title,"Workshop");
  assert.equal(calls,2);
  assert.equal(googleRequests,1);
  await assert.rejects(client.call("tasks_create_task",{}),{code:"UNKNOWN_OPERATION"});
  assert.equal(calls,2);
});

test("portable SDK forbids HTTP, unsafe resource URLs, bad token and redirect/malformed response",async()=>{
  for(const url of [
    "http://mcp.example.test/mcp","https://u:p@mcp.example.test/mcp",
    "https://mcp.example.test/mcp?token=abc","https://mcp.example.test/v1",
    "https://mcp.example.test/mcp#danger"
  ]){
    assert.throws(()=>new GoogleMasterReadClient({
      resourceUrl:url,getAccessToken:async()=>"fake-token-12345"
    }),{code:"INVALID_RESOURCE_URL"});
  }
  const badToken=new GoogleMasterReadClient({
    resourceUrl:RESOURCE,getAccessToken:async()=>"bad token",
    transport:async()=>{throw Error("MUST_NOT_SEND");}
  });
  await assert.rejects(badToken.capabilities(),{code:"CLIENT_TOKEN_INVALID"});
  const remote=new GoogleMasterReadClient({
    resourceUrl:RESOURCE,getAccessToken:async()=>"long-opaque-test-token",
    transport:async()=>Response.json({error:"GOOGLE_SESSION_NOT_CONFIGURED"},{status:503})
  });
  await assert.rejects(remote.call("tasks_list_tasklists"),{
    code:"GOOGLE_SESSION_NOT_CONFIGURED",status:503
  });
  const invalid=new GoogleMasterReadClient({
    resourceUrl:RESOURCE,getAccessToken:async()=>"long-opaque-test-token",
    transport:async()=>new Response("BAD_PROVIDER_RESPONSE",{status:200})
  });
  await assert.rejects(invalid.capabilities(),{code:"REMOTE_RESPONSE_INVALID"});
  const offline=new GoogleMasterReadClient({
    resourceUrl:RESOURCE,getAccessToken:async()=>"long-opaque-test-token",
    transport:async()=>{throw Error("INTERNAL SECRET MUST NOT LEAK");}
  });
  await assert.rejects(offline.capabilities(),{
    code:"REMOTE_UNAVAILABLE"
  });
});

test("client recognizes plain-text OAuth 401/403 without leaking the server body",async()=>{
  const token="FAKE_AUTH_TOKEN_1234567890";
  for(const [status,expected] of [[401,"CLIENT_UNAUTHORIZED"],[403,"CLIENT_FORBIDDEN"]]){
    const client=new GoogleMasterReadClient({
      resourceUrl:RESOURCE,
      getAccessToken:async()=>token,
      transport:async()=>new Response("Secret provider details are not JSON",
        {status,headers:{"Content-Type":"text/plain"}})
    });
    await assert.rejects(client.capabilities(),{code:expected,status});
  }
});

test("REST under-scoped Google credentials fail without requesting provider data",async()=>{
  const registry=registryWithFakeGoogle({scopes:[
    "https://www.googleapis.com/auth/script.projects.readonly"
  ]});
  const response=await handleReadOnlyApi(
    post("/v1/operations/tasks_list_tasklists","{}"),registry,principal
  );
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:"GOOGLE_SCOPE_MISSING"});
  assert.equal(googleRequests,0);
});
