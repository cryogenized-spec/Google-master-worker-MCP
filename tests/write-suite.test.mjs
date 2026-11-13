import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {OperationRegistry,OperationError} from "../dist/packages/core/src/index.js";
import {GoogleJsonClient} from "../dist/packages/google-http/src/index.js";
import {registerGoogleWriteCatalogue,WRITE_SPECS} from
  "../dist/packages/google-write-catalogue/src/index.js";
import {D1WriteApprovals,registerWriteApprovalPreparation} from
  "../dist/packages/google-approvals/src/index.js";
import {PERSONAL_WORKSPACE_SCOPES} from "../dist/packages/google-auth/src/scopes.js";
import {encodeBase64Url} from "../dist/packages/google-auth/src/crypto.js";

const token="FAKE_GOOGLE_TOKEN_NEVER_REVEAL";
const clientId="mcp_"+"b".repeat(48);
const principal={authenticated:true,accountId:"default",clientId};
const session={async get(){return {
  accessToken:token,scopes:PERSONAL_WORKSPACE_SCOPES,expiresAt:Date.now()+60_000
}}};
const origin="https://google-master-workspace-setup.cryogenized.workers.dev";
const key=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const sql=readFileSync(new URL("../migrations/0004_write_approvals.sql",import.meta.url),"utf8");
function fixture(clock=()=>Date.now()){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(sql);
  const db={prepare(query){
    const stmt=sqlite.prepare(query);
    return {bind(...params){
      return {
        async first(){return stmt.get(...params)??null;},
        async run(){return stmt.run(...params);}
      };
    }};
  }};
  const store=new D1WriteApprovals(db,key,clock);
  return {sqlite,db,store,close(){sqlite.close();}};
}
function mock(overrides={},approval){
  const requests=[];
  const serviceClient=(hostname,prefix)=>
    new GoogleJsonClient(hostname,prefix,async(url,init)=>{
      requests.push({url,init});
      assert.equal(init.headers.Authorization,"Bearer "+token);
      assert.equal(init.redirect,"manual");
      assert.equal(init.credentials,"omit");
      assert.equal(init.cache,"no-store");
      return init.method==="DELETE"?new Response(null,{status:204}):
        Response.json({id:"created-id",name:"test",updatedCells:2});
    });
  const transports={
    tasks:serviceClient("https://tasks.googleapis.com","/tasks/v1/"),
    script:serviceClient("https://script.googleapis.com","/v1/"),
    drive:serviceClient("https://www.googleapis.com","/drive/v3/"),
    docs:serviceClient("https://docs.googleapis.com","/v1/"),
    sheets:serviceClient("https://sheets.googleapis.com","/v4/"),
    slides:serviceClient("https://slides.googleapis.com","/v1/"),
    calendar:serviceClient("https://www.googleapis.com","/calendar/v3/"),
    gmail:serviceClient("https://gmail.googleapis.com","/gmail/v1/"),
    people:serviceClient("https://people.googleapis.com","/v1/"),
    forms:serviceClient("https://forms.googleapis.com","/v1/"),
    meet:serviceClient("https://meet.googleapis.com","/v2/")
  };
  const registry=new OperationRegistry(session,approval);
  registerGoogleWriteCatalogue(registry,transports);
  return {registry,requests,...overrides};
}

test("M23 installs 81 distinct named Google writes without a generic arbitrary URL/HTTP proxy",()=>{
  const {registry}=mock();
  const names=WRITE_SPECS.map(x=>x.name);
  assert.equal(WRITE_SPECS.length,81);
  assert.equal(new Set(names).size,81);
  assert.equal(registry.catalogue().length,81);
  assert(WRITE_SPECS.every(x=>x.path.startsWith("/")&&
    !x.path.includes("https:")&&!x.path.includes("?")&&!x.path.includes("..") &&
    x.scope.some(s=>PERSONAL_WORKSPACE_SCOPES.includes(s))));
  assert(WRITE_SPECS.every(x=>["write","external","destructive"].includes(x.risk)));
});

test("Without independent owner approval, NO provider mutation executes",async()=>{
  const {registry,requests}=mock();
  await assert.rejects(registry.execute("gmail_delete_message",{messageId:"msg123"},principal),
    /WRITE_APPROVAL_REQUIRED/);
  await assert.rejects(registry.execute("drive_create_permission",{
    fileId:"f1",type:"anyone",role:"writer"
  },principal),/WRITE_APPROVAL_REQUIRED/);
  assert.equal(requests.length,0);
});

test("Exact-action approval request is encrypted, reviewed, consumed once and binds client/action/input",async t=>{
  const f=fixture();t.after(f.close);
  const {registry,requests}=mock({},f.store);
  registerWriteApprovalPreparation(registry,f.store,origin);
  const input={fileId:"file123",name:"Report - approved"};
  const requested=await registry.execute("write_prepare_action",{
    operation:"drive_copy_file",input
  },principal);
  assert.equal(requested.operation,"drive_copy_file");
  assert.equal(requested.risk,"write");
  assert.match(requested.approvalUrl,/https:\/\/google-master-workspace-setup/);
  const data=f.sqlite.prepare("SELECT input_enc FROM google_write_approvals WHERE id=?")
    .get(requested.requestId);
  assert(!data.input_enc.includes("Report - approved"));
  const preview=await f.store.preview(requested.requestId);
  assert.deepEqual(preview.input,input);
  assert.equal(preview.clientId,principal.clientId);
  await assert.rejects(registry.execute("drive_copy_file",input,principal),
    /WRITE_APPROVAL_REQUIRED/);
  await f.store.decide(requested.requestId,"approve");
  await assert.rejects(registry.execute("drive_copy_file",{
    fileId:"file123",name:"Report - secretly modified"
  },principal),/WRITE_APPROVAL_REQUIRED/);
  assert.equal(requests.length,0);
  await assert.rejects(registry.execute("drive_copy_file",input,{
    ...principal,clientId:"mcp_"+"c".repeat(48)
  }),/WRITE_APPROVAL_REQUIRED/);
  const result=await registry.execute("drive_copy_file",input,principal);
  assert.equal(result.result.id,"created-id");
  assert.equal(requests.length,1);
  await assert.rejects(registry.execute("drive_copy_file",input,principal),
    /WRITE_APPROVAL_REQUIRED/);
  assert.equal(f.sqlite.prepare("SELECT status FROM google_write_approvals WHERE id=?")
    .get(requested.requestId).status,"consumed");
});

test("Owner rejection blocks permanently and never triggers Google I/O",async t=>{
  const f=fixture();t.after(f.close);
  const {registry,requests}=mock({},f.store);
  registerWriteApprovalPreparation(registry,f.store,origin);
  const input={messageId:"m1"};
  const r=await registry.execute("write_prepare_action",{
    operation:"gmail_delete_message",input
  },principal);
  await f.store.decide(r.requestId,"reject");
  await assert.rejects(registry.execute("gmail_delete_message",input,principal),
    /WRITE_APPROVAL_REQUIRED/);
  await assert.rejects(f.store.decide(r.requestId,"approve"),
    /APPROVAL_EXPIRED_OR_ALREADY_DECIDED/);
  assert.equal(requests.length,0);
});

test("Approval request rejects invalid target/fields, scopes or forged direct grants",async t=>{
  const f=fixture();t.after(f.close);
  const {registry,requests}=mock({},f.store);
  registerWriteApprovalPreparation(registry,f.store,origin);
  await assert.rejects(registry.execute("write_prepare_action",{
    operation:"fake_arbitrary_http",input:{url:"https://example.test"}
  },principal),/UNKNOWN_WRITE_OPERATION/);
  await assert.rejects(registry.execute("write_prepare_action",{
    operation:"gmail_delete_message",input:{messageId:"a",approved:true}
  },principal),/INVALID_ARGUMENTS/);
  await assert.rejects(registry.execute("write_prepare_action",{
    operation:"gmail_delete_message",input:{messageId:"../etc"}
  },principal),/INVALID_ARGUMENTS/);
  assert.equal(requests.length,0);
});

test("Owner-approved destructive DELETE accepts Google 204 without provider JSON",async t=>{
  const f=fixture();t.after(f.close);
  const {registry,requests}=mock({},f.store);
  registerWriteApprovalPreparation(registry,f.store,origin);
  const input={messageId:"m1"};
  const requested=await registry.execute("write_prepare_action",{
    operation:"gmail_delete_message",input
  },principal);
  await f.store.decide(requested.requestId,"approve");
  const result=await registry.execute("gmail_delete_message",input,principal);
  assert.deepEqual(result.result,{});
  assert.equal(requests.length,1);
  assert.equal(requests[0].init.method,"DELETE");
});

test("Approval expiry and queue limits fail closed",async t=>{
  let now=100_000;
  const f=fixture(()=>now);t.after(f.close);
  const input={fileId:"f1",name:"Test"};
  const action={...principal,operation:"drive_copy_file",input};
  const created=await f.store.request(action,"write");
  now+=25*60_000;
  await assert.rejects(f.store.preview(created.id),/APPROVAL_EXPIRED/);
  await assert.rejects(f.store.decide(created.id,"approve"),
    /APPROVAL_EXPIRED_OR_ALREADY_DECIDED/);
  await assert.rejects(f.store.consume(action),/WRITE_APPROVAL_REQUIRED/);
});


test("Representative Google mutation routes use correct verbs, colon action suffixes and scoped bodies",async t=>{
  const f=fixture();t.after(f.close);
  const {registry,requests}=mock({},f.store);
  registerWriteApprovalPreparation(registry,f.store,origin);
  const cases=[
    ["docs_batch_update",{documentId:"doc1",requests:[{insertText:{location:{index:1},text:"Hello"}}]},
      "POST","/v1/documents/doc1:batchUpdate"],
    ["sheets_append_values",{spreadsheetId:"sheet1",range:"Tab1!A1:B2",
      values:[["One",1]]},"POST","/v4/spreadsheets/sheet1/values/Tab1!A1%3AB2:append"],
    ["sheets_clear_values",{spreadsheetId:"sheet1",range:"Tab1!A1:B2"},
      "POST","/v4/spreadsheets/sheet1/values/Tab1!A1%3AB2:clear"],
    ["forms_batch_update",{formId:"form1",requests:[{createItem:{item:{title:"Q"},location:{index:0}}}]},
      "POST","/v1/forms/form1:batchUpdate"],
    ["contacts_create_contact",{givenName:"Ana",emailAddress:"ana@example.test"},
      "POST","/v1/people:createContact"],
    ["meet_patch_member",{spaceId:"space1",memberId:"member2",role:"COHOST"},
      "PATCH","/v2/spaces/space1/members/member2"],
    ["gmail_modify_message",{messageId:"msg123",addLabelIds:["STARRED"]},
      "POST","/gmail/v1/users/me/messages/msg123/modify"],
    ["script_create_deployment",{scriptId:"script1",versionNumber:2},
      "POST","/v1/projects/script1/deployments"],
    ["script_update_deployment",{scriptId:"script1",deploymentId:"deploy1",versionNumber:3},
      "PUT","/v1/projects/script1/deployments/deploy1"],
    ["drive_create_permission",{fileId:"file1",type:"anyone",role:"reader"},
      "POST","/drive/v3/files/file1/permissions"],
    ["calendar_patch_event",{calendarId:"primary",eventId:"event1",summary:"Moved"},
      "PATCH","/calendar/v3/calendars/primary/events/event1"],
  ];
  for(const [name,input,verb,expectedPath] of cases){
    const before=requests.length;
    const proposal=await registry.execute("write_prepare_action",{
      operation:name,input
    },principal);
    await f.store.decide(proposal.requestId,"approve");
    const result=await registry.execute(name,input,principal);
    assert(result.result&&typeof result.result==="object",name);
    assert.equal(requests.length,before+1,name);
    const last=requests.at(-1);
    assert.equal(last.init.method,verb,name);
    assert.equal(new URL(last.url).pathname,expectedPath,name);
    assert(!last.url.includes(token));
  }
  const script=requests.find(req=>new URL(req.url).pathname.endsWith("/deployments"));
  assert.equal(JSON.parse(script.init.body).manifestFileName,"appsscript");
  const member=requests.find(req=>new URL(req.url).pathname.includes("members/member2"));
  assert.equal(JSON.parse(member.init.body).name,"spaces/space1/members/member2");
  const perm=requests.find(req=>new URL(req.url).pathname.includes("files/file1/permissions"));
  assert(!new URL(perm.url).searchParams.has("sendNotificationEmail"),
    "public anonymous Drive sharing cannot send email notifications");
});
