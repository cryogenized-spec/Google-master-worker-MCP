import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { encodeBase64Url } from "../dist/packages/google-auth/src/crypto.js";
import { GoogleOAuthStore } from "../dist/packages/google-auth/src/store.js";
import { createSetupApp } from "../dist/apps/workspace-setup/src/index.js";
import { WORKSPACE_SCOPES, PERSONAL_WORKSPACE_SCOPES } from "../dist/packages/google-auth/src/scopes.js";

const ORIGIN="https://setup.example.test";
const SUBJECT="123456789012345678901";
const SCOPE="https://www.googleapis.com/auth/tasks.readonly";
const SCRIPT="https://www.googleapis.com/auth/script.projects.readonly";
const key=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const migration1=readFileSync(new URL("../migrations/0001_google_oauth_vault.sql",import.meta.url),"utf8");
const migration2=readFileSync(new URL("../migrations/0002_owner_browser_sessions.sql",import.meta.url),"utf8");

function fixture() {
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(migration1); sqlite.exec(migration2);
  const DB={prepare(sql) {
    const statement=sqlite.prepare(sql);
    return {bind(...values) {
      return {
        async first() { return statement.get(...values) ?? null; },
        async run() { return statement.run(...values); }
      };
    }};
  }};
  return {sqlite,DB,vault:new GoogleOAuthStore(DB),close(){sqlite.close();}};
}
function environment(DB) {
  return {
    DB, SETUP_ORIGIN:ORIGIN,
    SETUP_RATE_LIMITER:{ async limit(){ return {success:true}; } },
    GOOGLE_LOGIN_CLIENT_ID:"test-login-client.apps.googleusercontent.com",
    GOOGLE_LOGIN_CLIENT_SECRET:"TEST_LOGIN_SECRET_LONG_STRING",
    GOOGLE_WORKSPACE_CLIENT_ID:"test-workspace-client.apps.googleusercontent.com",
    GOOGLE_WORKSPACE_CLIENT_SECRET:"TEST_WORKSPACE_SECRET_LONG_STRING",
    GOOGLE_WORKSPACE_REDIRECT_URI:ORIGIN+"/oauth/google/callback",
    GMW_TOKEN_ENC_KEY:key,
    GMW_ALLOWED_GOOGLE_SUB:SUBJECT
  };
}
class BrowserJar {
  cookies=new Map();
  learn(response) {
    for(const c of response.headers.getSetCookie()){
      const pair=c.split(";")[0];
      const pos=pair.indexOf("=");
      const name=pair.slice(0,pos),value=pair.slice(pos+1);
      if(c.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name,value);
    }
    return response;
  }
  cookieHeader() {
    return [...this.cookies].map(([name,value])=>name+"="+value).join("; ");
  }
  request(path,init={}) {
    return new Request(ORIGIN+path,{
      ...init,headers:{
        ...(this.cookies.size ? {Cookie:this.cookieHeader()} : {}),
        ...(init.headers||{})
      }
    });
  }
  post(path,csrf,scopes=[],headers={}) {
    const form=new URLSearchParams();
    form.set("csrf",csrf);
    for(const scope of scopes)form.append("scope",scope);
    return this.request(path,{method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded",
        Origin:ORIGIN,...headers},
      body:form.toString()});
  }
}
function googleMock(overrides={}) {
  const calls={login:0,workspace:0,identity:0,revoke:0};
  const fetchImpl=async(url,options)=>{
    if(url==="https://oauth2.googleapis.com/token"){
      assert.equal(options.redirect, "manual");
      assert.equal(options.credentials,"omit");
      const form=new URLSearchParams(options.body);
      if(form.get("code")==="owner-login-code"){
        calls.login++;
        assert.equal(form.get("redirect_uri"),ORIGIN+"/google/callback");
        return Response.json({access_token:"TEST_OWNER_LOGIN_ACCESS_TOKEN",
          token_type:"Bearer",expires_in:3600});
      }
      if(form.get("code")==="workspace-code"){
        calls.workspace++;
        assert.equal(form.get("redirect_uri"),ORIGIN+"/oauth/google/callback");
        assert.match(form.get("code_verifier"),/^[A-Za-z0-9_-]{43,128}$/);
        return Response.json({access_token:"TEST_WORKSPACE_ACCESS_TOKEN",
          refresh_token:"TEST_WORKSPACE_REFRESH_TOKEN",
          token_type:"Bearer",expires_in:3600,
          scope:SCOPE+" openid email"});
      }
      throw Error("Unexpected token exchange");
    }
    if(url==="https://openidconnect.googleapis.com/v1/userinfo"){
      calls.identity++;
      const accessToken=options.headers.Authorization.split(" ")[1];
      if(accessToken!=="TEST_OWNER_LOGIN_ACCESS_TOKEN" &&
         accessToken!=="TEST_WORKSPACE_ACCESS_TOKEN"){
        throw Error("Wrong temporary token");
      }
      return Response.json({sub:accessToken==="TEST_WORKSPACE_ACCESS_TOKEN"
        ? (overrides.workspaceSubject??SUBJECT) : (overrides.operatorSubject??SUBJECT),
        email:"owner@example.test",email_verified:true});
    }
    if(url==="https://oauth2.googleapis.com/revoke"){
      calls.revoke++;
      const params=new URLSearchParams(options.body);
      assert.equal(params.get("token"),"TEST_WORKSPACE_REFRESH_TOKEN");
      return new Response(null,{status:overrides.revokeStatus??200});
    }
    throw Error("Unexpected external URL "+url);
  };
  return {calls,fetchImpl};
}
async function login(app,env,jar){
  const start=jar.learn(await app.fetch(jar.request("/setup/login"),env));
  assert.equal(start.status,303);
  const uri=new URL(start.headers.get("Location"));
  assert.equal(uri.origin,"https://accounts.google.com");
  assert.equal(uri.searchParams.get("scope"),"openid email");
  assert.equal(uri.searchParams.get("code_challenge_method"),"S256");
  const state=uri.searchParams.get("state");
  const back=jar.learn(await app.fetch(
    jar.request("/google/callback?state="+encodeURIComponent(state)+"&code=owner-login-code"),env));
  return {state,start,back};
}
function csrfFrom(page) {
  const match=page.match(/name="csrf" value="([^"]+)"/);
  assert(match,"Missing CSRF form token");
  return match[1];
}
async function connect(app,env,jar,scope=SCOPE){
  const page=await app.fetch(jar.request("/setup"),env);
  assert.equal(page.status,200);
  const csrf=csrfFrom(await page.text());
  const start=jar.learn(await app.fetch(jar.post(
    "/setup/google/connect",csrf,[scope]),env));
  assert.equal(start.status,303);
  const auth=new URL(start.headers.get("Location"));
  assert.equal(auth.origin,"https://accounts.google.com");
  assert(auth.searchParams.get("scope").includes("openid email"));
  assert(auth.searchParams.get("scope").includes(scope));
  const state=auth.searchParams.get("state");
  const back=jar.learn(await app.fetch(jar.request(
    "/oauth/google/callback?state="+encodeURIComponent(state)+"&code=workspace-code"),env));
  return {state,back,csrf};
}

test("setup is closed without a real origin, D1 and both OAuth client registrations",async()=>{
  const f=fixture();try{
    const app=createSetupApp();
    assert.equal((await app.fetch(new Request(ORIGIN+"/setup"),{})).status,503);
    assert.equal((await app.fetch(new Request(ORIGIN+"/setup"),
      environment(undefined))).status,503);
    assert.equal((await app.fetch(new Request(ORIGIN+"/setup"),
      {...environment(f.DB),SETUP_ORIGIN:"http://unsafe.test"})).status,503);
    assert.equal((await app.fetch(new Request("https://wrong.example.test/setup"),
      environment(f.DB))).status,503);
  }finally{f.close();}
});

test("browser OAuth login and Workspace consent bind to one verified session, never expose tokens",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB);
  const jar=new BrowserJar();
  assert.equal((await app.fetch(jar.request("/setup"),env)).status,303);
  const signedIn=await login(app,env,jar);
  assert.equal(signedIn.back.status,303);
  assert.equal(signedIn.back.headers.get("Location"),ORIGIN+"/setup");
  assert(jar.cookies.has("__Host-gmw_owner"));
  assert(jar.cookies.has("__Host-gmw_csrf"));
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM google_owner_sessions").get().n,1);
  const link=await connect(app,env,jar);
  assert.equal(link.back.status,303);
  assert.equal(link.back.headers.get("Location"),ORIGIN+"/setup?status=connected");
  assert.equal(mock.calls.login,1);
  assert.equal(mock.calls.workspace,1);
  assert.equal(mock.calls.identity,2);
  const stored=await f.vault.load("default");
  assert(stored);
  assert(!stored.tokens_enc.includes("TEST_WORKSPACE_REFRESH_TOKEN"));
  assert.deepEqual(JSON.parse(stored.scopes_json),[SCOPE]);
  const rendered=await app.fetch(jar.request("/setup"),env);
  const html=await rendered.text();
  assert.equal(rendered.status,200);
  assert(html.includes("Connected"));
  assert(!html.includes("TEST_WORKSPACE_ACCESS_TOKEN"));
  assert(!html.includes("TEST_WORKSPACE_REFRESH_TOKEN"));
  assert(!JSON.stringify([...jar.cookies]).includes("TEST_WORKSPACE"));
  assert.equal((await app.fetch(jar.request(
    "/oauth/google/callback?state="+link.state+"&code=workspace-code"),env)).status,403);
  // Disconnect is separately CSRF-authorized and revokes provider grant first.
  const csrf=csrfFrom(html);
  const disconnect=jar.learn(await app.fetch(jar.post("/setup/disconnect",csrf),env));
  assert.equal(disconnect.status,303);
  assert.equal(mock.calls.revoke,1);
  assert.equal(await f.vault.load("default"),null);
  const logout=jar.learn(await app.fetch(jar.post("/setup/logout",csrf),env));
  assert.equal(logout.status,303);
  assert(!jar.cookies.has("__Host-gmw_owner"));
  assert.equal((await app.fetch(jar.request("/setup"),env)).status,303);
});


test("operator setup offers one broad personal consent and an explicitly advanced Workspace request",async t=>{
  const f=fixture(); t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB),jar=new BrowserJar();
  const signedIn=await login(app,env,jar);
  assert.equal(signedIn.start.headers.get("Referrer-Policy"),"no-referrer");
  assert.equal(signedIn.back.headers.get("Referrer-Policy"),"no-referrer");
  const page=await app.fetch(jar.request("/setup"),env);
  // Real HTML form navigation needs the browser to send a non-null Origin.
  // no-referrer forces Origin:null for a form POST despite being same-site.
  assert.equal(page.headers.get("Referrer-Policy"),"same-origin");
  const html=await page.text();
  const forms=[...html.matchAll(/<form method="post" action="\/setup\/google\/connect">([\s\S]*?)<\/form>/g)]
    .map(match=>match[1]);
  assert.equal(forms.length,2);
  const listed=[...forms[0].matchAll(/name="scope" value="([^"]+)"/g)].map(m=>m[1]);
  const advanced=[...forms[1].matchAll(/name="scope" value="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(listed,PERSONAL_WORKSPACE_SCOPES);
  assert.deepEqual(advanced,WORKSPACE_SCOPES);
  assert(!listed.includes("https://www.googleapis.com/auth/keep"));
  assert(!listed.includes("https://www.googleapis.com/auth/ediscovery"));
  assert(!listed.includes("https://www.googleapis.com/auth/admin.directory.user"));
  assert(html.includes("Authorize broad personal Gmail bundle"));
  const csrf=csrfFrom(html);
  assert(new URLSearchParams([["csrf",csrf],...listed.map(s=>["scope",s])]).toString().length<4096);
  const start=await app.fetch(jar.post("/setup/google/connect",csrf,listed),env);
  assert.equal(start.status,303);
  const scopes=new URL(start.headers.get("Location")).searchParams.get("scope").split(" ");
  assert.deepEqual(new Set(scopes),new Set([...PERSONAL_WORKSPACE_SCOPES,"openid","email"]));
  const startedAdvanced=await app.fetch(jar.post("/setup/google/connect",csrf,advanced),env);
  assert.equal(startedAdvanced.status,303);
  const full=new URL(startedAdvanced.headers.get("Location")).searchParams.get("scope").split(" ");
  assert.deepEqual(new Set(full),new Set([...WORKSPACE_SCOPES,"openid","email"]));
  assert.equal(mock.calls.workspace,0);
});

test("missing session, cross-origin form, wrong CSRF and duplicate scope all block linking",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB);
  const jar=new BrowserJar();
  assert.equal((await app.fetch(jar.post("/setup/google/connect","fake",[SCOPE]),env)).status,403);
  await login(app,env,jar);
  const page=await app.fetch(jar.request("/setup"),env);
  const csrf=csrfFrom(await page.text());
  assert.equal((await app.fetch(jar.post("/setup/google/connect","wrong",[SCOPE]),env)).status,403);
  assert.equal((await app.fetch(jar.post("/setup/google/connect",csrf,[SCOPE],
    {Origin:"https://attacker.invalid"}),env)).status,403);
  assert.equal((await app.fetch(jar.post("/setup/google/connect",csrf,[SCOPE],
    {Origin:"null"}),env)).status,403);
  assert.equal((await app.fetch(jar.post("/setup/google/connect",csrf,[SCOPE,SCOPE]),env)).status,403);
  assert.equal((await app.fetch(jar.post("/setup/google/connect",csrf,
    ["https://www.googleapis.com/auth/gmail.readonly"]),env)).status,403);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM google_owner_link_pending").get().n,0);
  assert.equal(mock.calls.workspace,0);
});

test("Google Workspace identity mismatch prevents vault insertion even after owner login",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock({workspaceSubject:"98765432109876543210"});
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB);
  const jar=new BrowserJar();
  await login(app,env,jar);
  const link=await connect(app,env,jar);
  assert.equal(link.back.status,403);
  assert.equal(await f.vault.load("default"),null);
});

test("login callback state without browser cookie is rejected and pending state remains unused",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB),jar=new BrowserJar();
  const start=jar.learn(await app.fetch(jar.request("/setup/login"),env));
  const state=new URL(start.headers.get("Location")).searchParams.get("state");
  const unrelated=new BrowserJar();
  assert.equal((await app.fetch(unrelated.request(
    "/google/callback?state="+state+"&code=owner-login-code"),env)).status,403);
  assert.equal(mock.calls.login,0);
  const legit=jar.learn(await app.fetch(
    jar.request("/google/callback?state="+state+"&code=owner-login-code"),env));
  assert.equal(legit.status,303);
  const replay=await app.fetch(
    jar.request("/google/callback?state="+state+"&code=owner-login-code"),env);
  assert.equal(replay.status,403);
  assert.equal(mock.calls.login,1);
});

test("expired browser authorization state and expired owner sessions fail closed",async t=>{
  const f=fixture();t.after(f.close);
  let clock=1_800_000_000_000;
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl,now:()=>clock});
  const env=environment(f.DB),jar=new BrowserJar();
  const start=jar.learn(await app.fetch(jar.request("/setup/login"),env));
  const state=new URL(start.headers.get("Location")).searchParams.get("state");
  clock+=600001;
  assert.equal((await app.fetch(jar.request(
    "/google/callback?state="+state+"&code=owner-login-code"),env)).status,403);
  assert.equal(mock.calls.login,0);
  const jar2=new BrowserJar();
  await login(app,env,jar2);
  clock+=3600001;
  assert.equal((await app.fetch(jar2.request("/setup"),env)).status,303);
});

test("provider revocation failure retains the encrypted vault credentials",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock({revokeStatus:503});
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB),jar=new BrowserJar();
  await login(app,env,jar);
  const linked=await connect(app,env,jar);
  assert.equal(linked.back.status,303);
  const page=await app.fetch(jar.request("/setup"),env);
  const csrf=csrfFrom(await page.text());
  const res=await app.fetch(jar.post("/setup/disconnect",csrf),env);
  assert.equal(res.status,403);
  assert(await f.vault.load("default"));
  assert.equal(mock.calls.revoke,1);
});


test("setup login is throttled before creating OAuth state or contacting Google",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB);
  const seen=[];
  env.SETUP_RATE_LIMITER={async limit({key}) {
    seen.push(key); return {success:false};
  }};
  const jar=new BrowserJar();
  const request=jar.request("/setup/login",{
    headers:{"CF-Connecting-IP":"198.51.100.47"}
  });
  const response=await app.fetch(request,env);
  assert.equal(response.status,429);
  assert.equal(response.headers.get("Retry-After"),"60");
  assert.deepEqual(seen,["/setup/login:198.51.100.47"]);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM google_owner_login_pending").get().n,0);
  assert.equal(mock.calls.login,0);
});
test("setup requires limiter binding and fails closed if the binding errors",async t=>{
  const f=fixture();t.after(f.close);
  const mock=googleMock();
  const app=createSetupApp({googleFetch:mock.fetchImpl});
  const env=environment(f.DB);
  delete env.SETUP_RATE_LIMITER;
  const jar=new BrowserJar();
  assert.equal((await app.fetch(jar.request("/setup/login"),env)).status,503);
  env.SETUP_RATE_LIMITER={async limit(){throw Error("PROVIDER_INTERNAL_SECRET");}};
  const result=await app.fetch(jar.request("/setup/login"),env);
  assert.equal(result.status,503);
  assert(!(await result.text()).includes("PROVIDER_INTERNAL_SECRET"));
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM google_owner_login_pending").get().n,0);
});
