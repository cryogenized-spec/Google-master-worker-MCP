import test from "node:test";
import assert from "node:assert/strict";
import {OperationRegistry} from "../dist/packages/core/src/index.js";
import {GoogleJsonClient} from "../dist/packages/google-http/src/index.js";
import {registerGoogleTasks} from "../dist/packages/google-tasks/src/index.js";
import {registerAppsScript} from "../dist/packages/google-apps-script/src/index.js";
import {registerWorkspaceServices} from "../dist/packages/google-workspace/src/index.js";
import {registerGoogleReadCatalogue} from "../dist/packages/google-read-catalogue/src/index.js";
import {registerGoogleWriteCatalogue,WRITE_SPECS} from "../dist/packages/google-write-catalogue/src/index.js";
import {PERSONAL_WORKSPACE_SCOPES} from "../dist/packages/google-auth/src/scopes.js";
import {handleReadOnlyApi} from "../dist/packages/rest-adapter/src/index.js";
import {GoogleMasterWriteClient} from "../dist/packages/client-sdk/src/index.js";

const token="FAKE_GOOGLE_ACCESS_TOKEN_PRIVATE";
const principal={authenticated:true,accountId:"default",clientId:"mcp_"+"a".repeat(48)};
const scopes=[...PERSONAL_WORKSPACE_SCOPES];
const origins={
  tasks:["https://tasks.googleapis.com","/tasks/v1/"],
  script:["https://script.googleapis.com","/v1/"],
  drive:["https://www.googleapis.com","/drive/v3/"],
  docs:["https://docs.googleapis.com","/v1/"],
  sheets:["https://sheets.googleapis.com","/v4/"],
  slides:["https://slides.googleapis.com","/v1/"],
  calendar:["https://www.googleapis.com","/calendar/v3/"],
  gmail:["https://gmail.googleapis.com","/gmail/v1/"],
  people:["https://people.googleapis.com","/v1/"],
  forms:["https://forms.googleapis.com","/v1/"],
  meet:["https://meet.googleapis.com","/v2/"]
};
function fixture({direct=true,grants=scopes,all=false}={}) {
  const requests=[];
  const transports={};
  for(const [service,[origin,prefix]] of Object.entries(origins)){
    transports[service]=new GoogleJsonClient(origin,prefix,async(url,init)=>{
      requests.push({service,url,init});
      assert.equal(new URL(url).origin,origin);
      assert.equal(init.headers.Authorization,"Bearer "+token);
      assert.equal(init.redirect,"manual");
      assert.equal(init.cache,"no-store");
      assert.equal(init.credentials,"omit");
      return init.method==="DELETE"
        ? new Response(null,{status:204})
        : Response.json({id:"test-id",name:"test-name",updatedCells:2});
    });
  }
  const session={async get(){
    return {accessToken:token,scopes:grants,expiresAt:Date.now()+60000};
  }};
  const registry=new OperationRegistry(session,direct?"direct":undefined);
  if(all){
    registerGoogleTasks(registry,transports.tasks);
    registerAppsScript(registry,transports.script);
    registerWorkspaceServices(registry,transports);
    registerGoogleReadCatalogue(registry,transports);
  }
  registerGoogleWriteCatalogue(registry,transports);
  return {registry,requests};
}

test("M24 exposes 90 named writes + 101 reads with no approval middleman",()=>{
  const {registry}=fixture({all:true});
  const catalog=registry.catalogue();
  assert.equal(catalog.length,191);
  assert.equal(catalog.filter(x=>x.risk==="read").length,101);
  assert.equal(catalog.filter(x=>["write","destructive","external"].includes(x.risk)).length,90);
  assert(!catalog.some(x=>x.name==="write_prepare_action"));
  assert.equal(WRITE_SPECS.length,81);
  assert.equal(new Set(WRITE_SPECS.map(x=>x.name)).size,81);
  assert(WRITE_SPECS.every(x=>x.path.startsWith("/") &&
    !x.path.includes("https:") && !x.path.includes("?") && !x.path.includes("..") &&
    x.scope.some(s=>scopes.includes(s))));
});

test("Legacy local registry remains closed to writes unless explicitly configured",async()=>{
  const {registry,requests}=fixture({direct:false});
  await assert.rejects(registry.execute("drive_copy_file",{
    fileId:"file1",name:"Not copied"
  },principal),/WRITE_APPROVAL_REQUIRED/);
  assert.equal(requests.length,0);
});

test("Authorized direct write is a single Google call without proposals or D1",async()=>{
  const {registry,requests}=fixture();
  const input={fileId:"f1",name:"Copy once"};
  const result=await registry.execute("drive_copy_file",input,principal);
  assert.equal(result.result.id,"test-id");
  assert.equal(requests.length,1);
  assert.equal(new URL(requests[0].url).pathname,"/drive/v3/files/f1/copy");
  assert.equal(requests[0].init.method,"POST");
  assert.deepEqual(JSON.parse(requests[0].init.body),{name:"Copy once"});
  // Direct mode is not an idempotency service: another explicit request is
  // another write, not an implicit retry or an approval replay.
  await registry.execute("drive_copy_file",input,principal);
  assert.equal(requests.length,2);
});

test("Direct execution still rejects missing Google grant and unauthorized client",async()=>{
  const {registry,requests}=fixture({grants:["https://www.googleapis.com/auth/tasks"]});
  await assert.rejects(registry.execute("gmail_create_label",{
    name:"Test label"
  },principal),/GOOGLE_SCOPE_MISSING/);
  await assert.rejects(registry.execute("drive_copy_file",{
    fileId:"f1",name:"Blocked"
  },{...principal,authenticated:false}),/CLIENT_UNAUTHORIZED/);
  assert.equal(requests.length,0);
});

test("Strict schemas prevent arbitrary HTTP URL, client token or traversal",async()=>{
  const {registry,requests}=fixture();
  const inputs=[
    {fileId:"../private",name:"No"},
    {fileId:"f1",name:"No",url:"https://evil.invalid/"},
    {fileId:"f1",name:"No",approved:true},
    {fileId:"f1",name:"No",accessToken:"forged"},
    {fileId:"f1",name:""}
  ];
  for(const input of inputs){
    await assert.rejects(registry.execute("drive_copy_file",input,principal),
      /INVALID_ARGUMENTS/);
  }
  assert.equal(requests.length,0);
});

test("Representative direct writes across all eleven Google services use fixed routes",async()=>{
  const {registry,requests}=fixture();
  const cases=[
    ["tasks_create_tasklist",{title:"Temp list"},"POST","/tasks/v1/users/@me/lists"],
    ["script_create_deployment",{scriptId:"script1",versionNumber:2},"POST","/v1/projects/script1/deployments"],
    ["drive_create_permission",{fileId:"file1",type:"anyone",role:"reader"},"POST","/drive/v3/files/file1/permissions"],
    ["docs_batch_update",{documentId:"doc1",requests:[{insertText:{location:{index:1},text:"Hi"}}]},"POST","/v1/documents/doc1:batchUpdate"],
    ["sheets_append_values",{spreadsheetId:"sheet1",range:"Tab1!A1:B2",values:[["One",1]]},"POST","/v4/spreadsheets/sheet1/values/Tab1!A1%3AB2:append"],
    ["slides_create_presentation",{title:"Temp slides"},"POST","/v1/presentations"],
    ["calendar_patch_event",{calendarId:"primary",eventId:"event1",summary:"Updated"},"PATCH","/calendar/v3/calendars/primary/events/event1"],
    ["gmail_modify_message",{messageId:"msg123",addLabelIds:["STARRED"]},"POST","/gmail/v1/users/me/messages/msg123/modify"],
    ["contacts_create_contact",{givenName:"Ana",emailAddress:"ana@example.test"},"POST","/v1/people:createContact"],
    ["forms_batch_update",{formId:"form1",requests:[{createItem:{item:{title:"Q"},location:{index:0}}}]},"POST","/v1/forms/form1:batchUpdate"],
    ["meet_create_space",{},"POST","/v2/spaces"],
  ];
  for(const [name,input,method,path] of cases){
    const before=requests.length;
    await registry.execute(name,input,principal);
    assert.equal(requests.length,before+1,name);
    const last=requests.at(-1);
    assert.equal(last.init.method,method,name);
    assert.equal(new URL(last.url).pathname,path,name);
  }
});

test("Direct destructive Google DELETE handles successful empty 204 without error",async()=>{
  const {registry,requests}=fixture();
  const result=await registry.execute("drive_delete_file",{fileId:"test-disposable"},principal);
  assert.deepEqual(result.result,{});
  assert.equal(requests.length,1);
  assert.equal(requests[0].init.method,"DELETE");
});

test("Portable HTTPS write client executes in one request and never prepares approval",async()=>{
  const {registry,requests}=fixture({all:true});
  let restCalls=0;
  const client=new GoogleMasterWriteClient({
    resourceUrl:"https://mcp.example.test/mcp",
    getAccessToken:async()=> "FAKE_OAUTH_WRITE_CLIENT_TOKEN",
    transport:async(url,init)=>{
      restCalls++;
      assert.equal(init.headers.Authorization,"Bearer FAKE_OAUTH_WRITE_CLIENT_TOKEN");
      return handleReadOnlyApi(new Request(url,init),registry,principal,
        {writesEnabled:true});
    }
  });
  const available=await client.writeCapabilities();
  assert.equal(available.length,90);
  const result=await client.callWrite("drive_copy_file",{fileId:"f1",name:"Direct"});
  assert.equal(result.result.id,"test-id");
  assert.equal(restCalls,2); // one capabilities GET + one mutation POST
  assert.equal(requests.length,1);
  assert.equal(typeof client.prepareWrite,"undefined");
  assert.equal(typeof client.executeApproved,"undefined");
});
