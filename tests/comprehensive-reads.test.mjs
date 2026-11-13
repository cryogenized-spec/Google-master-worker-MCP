import test from "node:test";
import assert from "node:assert/strict";
import { OperationRegistry } from "../dist/packages/core/src/index.js";
import { GoogleJsonClient } from "../dist/packages/google-http/src/index.js";
import { registerGoogleReadCatalogue, READ_SPECS } from
  "../dist/packages/google-read-catalogue/src/index.js";
import { PERSONAL_WORKSPACE_SCOPES } from "../dist/packages/google-auth/src/scopes.js";

const token="FAKE_GOOGLE_ACCESS_TOKEN_NEVER_LOG_123";
const scopes=[...PERSONAL_WORKSPACE_SCOPES];
const principal={authenticated:true,accountId:"default",clientId:"mcp_"+"a".repeat(48)};
const endpoints={
  tasks:["https://tasks.googleapis.com","/tasks/v1/"],
  script:["https://script.googleapis.com","/v1/"],
  drive:["https://www.googleapis.com","/drive/v3/"],
  calendar:["https://www.googleapis.com","/calendar/v3/"],
  docs:["https://docs.googleapis.com","/v1/"],
  sheets:["https://sheets.googleapis.com","/v4/"],
  slides:["https://slides.googleapis.com","/v1/"],
  gmail:["https://gmail.googleapis.com","/gmail/v1/"],
  people:["https://people.googleapis.com","/v1/"],
  forms:["https://forms.googleapis.com","/v1/"],
  meet:["https://meet.googleapis.com","/v2/"]
};
const session={async get(){return {accessToken:token,scopes,expiresAt:Date.now()+120000};}};

function mockCatalogue(route){
  const requests=[];
  const transports={};
  for(const [service,[origin,prefix]] of Object.entries(endpoints)){
    transports[service]=new GoogleJsonClient(origin,prefix,async (url,init)=>{
      requests.push({service,url,init});
      assert.equal(new URL(url).origin,origin);
      assert.equal(init.headers.Authorization,"Bearer "+token);
      assert.equal(init.redirect,"manual");
      assert.equal(init.cache,"no-store");
      assert.equal(init.credentials,"omit");
      return Response.json(route(service,url,init));
    });
  }
  const registry=new OperationRegistry(session);
  registerGoogleReadCatalogue(registry,transports);
  return {registry,requests};
}
function argumentsFor(spec){
  const args={};
  for(const m of spec.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)){
    args[m[1]]=m[1]==="calendarId"?"primary":"known-id";
  }
  if(spec.options?.scriptId)args.scriptId="script-123";
  if(spec.options?.startHistoryId)args.startHistoryId="123456";
  if(spec.options?.query)args.query="Test";
  if(spec.options?.ranges)args.ranges="Sheet1!A1:B2";
  if(spec.options?.pageToken)args.pageToken="page-token";
  return args;
}

test("M22 defines 70 fixed list/detail routes plus one bounded read-only freeBusy query",()=>{
  assert.equal(READ_SPECS.length,70);
  const names=READ_SPECS.map(s=>s.name);
  assert.equal(new Set(names).size,names.length);
  assert(!names.includes("google_request"));
  assert(READ_SPECS.every(spec=>spec.path.startsWith("/") &&
    !spec.path.includes("..") && !spec.path.includes("?") &&
    !spec.path.includes("https:") && !spec.name.endsWith("_delete")));
  const granted=new Set(scopes);
  assert(READ_SPECS.every(spec=>spec.scopes.some(scope=>granted.has(scope))),
    "every read path must be permitted by at least one existing personal grant");
  const {registry}=mockCatalogue(()=>({}));
  assert.equal(registry.catalogue().length,71);
  assert(registry.catalogue().every(op=>op.risk==="read"));
});

test("All 70 registered Google read descriptors execute in bounded mock API paths",async()=>{
  let current=null;
  const {registry,requests}=mockCatalogue((service,url)=>{
    assert.equal(service,current.service);
    assert(!url.includes("token="+token));
    if(current.listKey)return {
      [current.listKey]:[{id:"test-id",name:"Test",metadata:{nested:"yes"}}],
      nextPageToken:"next-example"
    };
    return {name:"test-resource",id:"example-id",flag:true};
  });
  for(const spec of READ_SPECS){
    current=spec;
    const args=argumentsFor(spec);
    const result=await registry.execute(spec.name,args,principal);
    if(spec.listKey){
      assert.equal(result.items.length,1,spec.name);
      assert.equal(result.items[0].id,"test-id",spec.name);
      assert.equal(result.nextPageToken,"next-example",spec.name);
      assert.equal(result.partial,true,spec.name);
    } else {
      assert.equal(result.item.name,"test-resource",spec.name);
      assert.equal(result.truncated,false,spec.name);
    }
    assert(!JSON.stringify(result).includes(token));
  }
  assert.equal(requests.length,70);
});

test("Calendar freeBusy issues a fixed read-only POST with bounded typed inputs",async()=>{
  const {registry,requests}=mockCatalogue((_service,_url,_init)=>({
    timeMin:"2026-11-16T08:00:00+02:00",
    calendars:{"primary":{busy:[{start:"2026-11-16T09:00:00+02:00",
      end:"2026-11-16T09:30:00+02:00"}]}}
  }));
  const input={calendarIds:["primary"],
    timeMin:"2026-11-16T08:00:00+02:00",
    timeMax:"2026-11-16T17:00:00+02:00",
    timeZone:"Africa/Johannesburg"};
  const output=await registry.execute("calendar_query_freebusy",input,principal);
  assert.equal(output.item.calendars.primary.busy.length,1);
  assert.equal(requests.length,1);
  assert.equal(new URL(requests[0].url).pathname,"/calendar/v3/freeBusy");
  assert.equal(requests[0].init.method,"POST");
  assert.deepEqual(JSON.parse(requests[0].init.body),{
    timeMin:input.timeMin,timeMax:input.timeMax,
    timeZone:input.timeZone,items:[{id:"primary"}]});
});

test("Inputs cannot select arbitrary URL, control scope, or bypass narrow parameter names",async()=>{
  let called=0;
  const {registry}=mockCatalogue(()=>{called++;return {}});
  for(const args of [
    {fileId:"../private"},
    {fileId:"slash/escape"},
    {fileId:"known",accessToken:"forged"},
    {fileId:"known",url:"https://untrusted.invalid/"},
  ]){
    await assert.rejects(registry.execute("drive_list_file_comments",args,principal),
      /INVALID_ARGUMENTS/);
  }
  await assert.rejects(registry.execute("calendar_query_freebusy",{
    calendarIds:["primary"],timeMin:"not-iso",timeMax:"still-not-iso"
  },principal),/INVALID_ARGUMENTS/);
  assert.equal(called,0);
});

test("Missing scopes cannot read provider data; large response values are truncated",async()=>{
  let calls=0;
  const {registry:base}=mockCatalogue((_svc)=>{calls++;return {
    user:{description:"x".repeat(120000)},secret:"z".repeat(9000)
  }});
  const a=await base.execute("drive_get_about",{},principal);
  assert.equal(a.truncated,true);
  assert(a.item.user.description.length<=32768);
  const under=new OperationRegistry({async get(){
    return {accessToken:token,scopes:["https://www.googleapis.com/auth/tasks"],
      expiresAt:Date.now()+60000};
  }});
  const fallback=new GoogleJsonClient("https://www.googleapis.com","/drive/v3/",
    async()=>{calls++;return Response.json({});});
  registerGoogleReadCatalogue(under,{drive:fallback});
  await assert.rejects(under.execute("drive_get_about",{},principal),
    /GOOGLE_SCOPE_MISSING/);
  assert.equal(calls,1);
});
