import test from "node:test";
import assert from "node:assert/strict";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";
import { registerWorkspaceServices } from "../dist/packages/google-workspace/src/index.js";
import { PERSONAL_WORKSPACE_SCOPES } from "../dist/packages/google-auth/src/scopes.js";

const principal={authenticated:true,accountId:"default",clientId:"mcp_"+"a".repeat(48)};
const googleToken="FAKE_VALID_TEST_GOOGLE_TOKEN_123456";
const session={async get(){
  return {accessToken:googleToken,expiresAt:Date.now()+60_000,
    scopes:PERSONAL_WORKSPACE_SCOPES};
}};
const fake=(origin,prefix,route,received)=>
  new GoogleJsonClient(origin,prefix,async(url,options)=>{
    received.push({url,options});
    assert.equal(options.headers.Authorization,"Bearer "+googleToken);
    assert.equal(options.redirect,"manual");
    assert.equal(new URL(url).origin,origin);
    return Response.json(route(new URL(url),options));
  });

test("M19 registry covers all personal Google Workspace categories without a generic API proxy",()=>{
  const r=new OperationRegistry(session);
  registerWorkspaceServices(r);
  const meta=r.catalogue();
  assert.equal(meta.length,22);
  assert.equal(meta.filter(m=>m.risk==="read").length,17);
  assert.equal(meta.filter(m=>m.risk!=="read").length,5);
  assert(meta.some(m=>m.name==="gmail_send_message" && m.risk==="external"));
  assert(meta.some(m=>m.name==="calendar_create_event" && m.risk==="write"));
  assert(!meta.some(m=>/proxy|arbitrary|run_script/.test(m.name)));
  assert(meta.every(m=>m.inputSchema && m.description));
});

test("Drive and Gmail reads project bounded metadata, never echo OAuth credentials",async()=>{
  const requests=[];
  const r=new OperationRegistry(session);
  registerWorkspaceServices(r,{
    drive:fake("https://www.googleapis.com","/drive/v3/",(url)=>{
      assert.equal(url.pathname,"/drive/v3/files");
      assert.equal(url.searchParams.get("pageSize"),"2");
      assert.equal(url.searchParams.get("q"),"name contains 'Invoice'");
      return {nextPageToken:"page-next",files:[
        {id:"f1",name:"Invoice 100",mimeType:"application/pdf",description:"Example file",
          owners:[{displayName:"Owner",emailAddress:"owner@example.test"}]},
        {id:"f2",name:"Invoice 101",mimeType:"application/pdf"}]};
    },requests),
    gmail:fake("https://gmail.googleapis.com","/gmail/v1/",(url)=>{
      assert.equal(url.pathname,"/gmail/v1/users/me/messages");
      assert.equal(url.searchParams.get("q"),"is:unread");
      return {messages:[{id:"m1",threadId:"t1"}]};
    },requests)
  });
  const files=await r.execute("drive_list_files",
    {query:"name contains 'Invoice'",pageSize:2},principal);
  assert.equal(files.items.length,2);
  assert.equal(files.nextPageToken,"page-next");
  assert.equal(files.items[0].name,"Invoice 100");
  const mail=await r.execute("gmail_list_messages",
    {query:"is:unread",pageSize:3},principal);
  assert.deepEqual(mail.items,[{id:"m1",threadId:"t1"}]);
  assert.equal(requests.length,2);
  assert(!JSON.stringify(files).includes(googleToken));
  assert(!JSON.stringify(mail).includes(googleToken));
});

test("M19 blocks writes before any Google I/O unless independently approved",async()=>{
  let calls=0;
  const r=new OperationRegistry(session);
  registerWorkspaceServices(r,{
    drive:new GoogleJsonClient("https://www.googleapis.com","/drive/v3/",async()=>{
      calls++; throw Error("WRITE MUST NOT REACH GOOGLE");
    }),
    gmail:new GoogleJsonClient("https://gmail.googleapis.com","/gmail/v1/",async()=>{
      calls++; throw Error("WRITE MUST NOT REACH GOOGLE");
    })
  });
  await assert.rejects(r.execute("drive_create_folder",{name:"Not created"},principal),
    /WRITE_APPROVAL_REQUIRED/);
  await assert.rejects(r.execute("gmail_send_message",
    {rawBase64Url:"A".repeat(30)},principal),/WRITE_APPROVAL_REQUIRED/);
  assert.equal(calls,0);
});

test("non-granted scope and invalid arguments fail closed before a provider request",async()=>{
  let calls=0;
  const underScoped=new OperationRegistry({async get(){
    return {accessToken:googleToken,expiresAt:Date.now()+60_000,
      scopes:["https://www.googleapis.com/auth/tasks"]};
  }});
  registerWorkspaceServices(underScoped,{
    gmail:new GoogleJsonClient("https://gmail.googleapis.com","/gmail/v1/",async()=>{
      calls++;return Response.json({messages:[]});
    })
  });
  await assert.rejects(underScoped.execute("gmail_list_messages",{},principal),
    /GOOGLE_SCOPE_MISSING/);
  await assert.rejects(underScoped.execute("gmail_get_message",
    {messageId:"../foo"},principal),/INVALID_ARGUMENTS/);
  assert.equal(calls,0);
});

test("Google HTTP is pinned to fixed provider origins and rejects redirects",async()=>{
  let calls=0;
  const r=new OperationRegistry(session);
  registerWorkspaceServices(r,{
    drive:new GoogleJsonClient("https://www.googleapis.com","/drive/v3/",
      async(url,options)=>{
        calls++;
        assert.equal(options.redirect,"manual");
        assert.equal(new URL(url).hostname,"www.googleapis.com");
        return new Response(null,{status:302,headers:{Location:"https://untrusted.invalid"}});
      })
  });
  await assert.rejects(r.execute("drive_list_files",{},principal),
    /GOOGLE_REQUEST_REJECTED/);
  assert.equal(calls,1);
});
