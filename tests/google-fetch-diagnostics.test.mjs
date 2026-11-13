import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGoogleFetchFailure, GoogleJsonClient
} from "../dist/packages/google-http/src/index.js";

const token="FAKE_PROTECTED_ACCESS_TOKEN_NEVER_SHOW";

test("classifies Cloudflare request compatibility problems without exposing upstream exception text",()=>{
  const examples=[
    [new TypeError("Unsupported cache mode: default"),"GOOGLE_FETCH_CACHE_UNSUPPORTED"],
    [new Error("The 'cache' field on 'RequestInitializerDict' is not implemented."),
      "GOOGLE_FETCH_CACHE_UNSUPPORTED"],
    [new TypeError("RequestInit.redirect is not implemented on this runtime"),
      "GOOGLE_FETCH_REDIRECT_UNSUPPORTED"],
    [new Error("Can't perform I/O outside a request context"),
      "GOOGLE_FETCH_CONTEXT_UNAVAILABLE"],
    [new TypeError("a private diagnostic containing "+token),
      "GOOGLE_FETCH_TYPE_ERROR"],
    [new DOMException("The operation timed out", "TimeoutError"),
      "GOOGLE_FETCH_TIMEOUT"],
    [new DOMException("Request aborted", "AbortError"),
      "GOOGLE_FETCH_TIMEOUT"],
    [new Error("Provider internals "+token), "GOOGLE_NETWORK_UNAVAILABLE"],
    ["unexpected error text", "GOOGLE_NETWORK_UNAVAILABLE"]
  ];
  for(const [err,code] of examples){
    const actual=classifyGoogleFetchFailure(err);
    assert.equal(actual,code);
    assert(!actual.includes(token));
    assert.match(actual,/^GOOGLE_[A-Z_]+$/);
  }
});

test("GoogleJsonClient leaves security-sensitive fetch settings unchanged while classifying exceptions",async()=>{
  const samples=[
    [new TypeError("Unsupported cache mode: default"),"GOOGLE_FETCH_CACHE_UNSUPPORTED"],
    [new TypeError("private URL https://google.invalid/?token="+token),"GOOGLE_FETCH_TYPE_ERROR"]
  ];
  for(const [failure,expected] of samples){
    const client=new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/",
      async (url,init)=>{
        assert.equal(url,"https://tasks.googleapis.com/tasks/v1/users/@me/lists");
        assert.equal(init.redirect,"manual");
        assert.equal(init.cache,"no-store");
        assert.equal(init.credentials,"omit");
        assert.equal(init.headers.Authorization,"Bearer "+token);
        throw failure;
      });
    const err=await client.json({
      path:"/tasks/v1/users/@me/lists",accessToken:token
    }).then(()=>null,error=>error);
    assert.equal(err.code,expected);
    assert(!String(err).includes(token));
    assert(!String(err).includes("google.invalid"));
  }
});

test("non-2xx Google HTTP responses are not mistaken for network exceptions",async()=>{
  const client=new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/",
    async()=>new Response(null,{status:403}));
  await assert.rejects(client.json({
    path:"/tasks/v1/users/@me/lists",accessToken:token
  }),{code:"GOOGLE_FORBIDDEN"});
});

test("Google API transport must not bind an arbitrary client object as fetch receiver",async()=>{
  let called=0;
  async function contextSensitiveTransport(url, init) {
    // Cloudflare's runtime fetch is a Web API function, not a method on
    // GoogleJsonClient. This was not covered by the existing arrow mocks.
    assert.equal(this,undefined,"fetch must be invoked without client receiver");
    called++;
    assert.equal(url,"https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    assert.equal(init.redirect,"manual");
    assert.equal(init.cache,"no-store");
    assert.equal(init.credentials,"omit");
    assert.equal(init.headers.Authorization,"Bearer "+token);
    return Response.json({items:[{id:"test",title:"Works"}]});
  }
  const client=new GoogleJsonClient(
    "https://tasks.googleapis.com","/tasks/v1/",contextSensitiveTransport
  );
  const result=await client.json({
    path:"/tasks/v1/users/@me/lists",accessToken:token
  });
  assert.equal(called,1);
  assert.equal(result.items[0].title,"Works");
});
