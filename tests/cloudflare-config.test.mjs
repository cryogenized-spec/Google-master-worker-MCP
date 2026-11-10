import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildConfigs, verifyConfigs, OUTPUT_FILES } from "../scripts/prepare-cloudflare.mjs";

const sample = Object.freeze({
  // Test fixture only. Not a real domain or resource registration.
  zone:"fictional-owned-zone.co.za",
  kvId:"abcdef0123456789abcdef0123456789",
  d1Id:"01234567-89ab-cdef-0123-456789abcdef",
  dbName:"google-master-vault",
  authRateId:"11013",
  setupRateId:"11014"
});

function clone(x) { return JSON.parse(JSON.stringify(x)); }

test("builds strict private configs with shared D1, KV, two rate limits and default RPC binding",()=>{
  const {auth,mcp,setup}=buildConfigs(sample);
  assert.equal(verifyConfigs({auth,mcp,setup}),true);
  assert.equal(auth.name,"google-master-auth");
  assert.equal(mcp.name,"google-master-mcp");
  assert.equal(setup.name,"google-master-workspace-setup");
  for(const config of [auth,mcp,setup]){
    assert.equal(config.workers_dev,false);
    assert.equal(config.preview_urls,false);
    assert.equal(config.routes,undefined);
    assert.equal(config.route,undefined);
    assert.equal(config.account_id,undefined);
    assert.equal(config.observability.enabled,false);
  }
  assert.deepEqual(mcp.services,[{binding:"AUTH_SERVER",service:auth.name}]);
  assert.equal("entrypoint" in mcp.services[0],false,
    "RPC to the default WorkerEntrypoint must omit entrypoint");
  assert.equal(auth.vars.AUTH_ISSUER,"https://auth.fictional-owned-zone.co.za");
  assert.equal(auth.vars.MCP_RESOURCE_URL,"https://mcp.fictional-owned-zone.co.za/mcp");
  assert.equal(setup.vars.SETUP_ORIGIN,"https://setup.fictional-owned-zone.co.za");
  assert.equal(mcp.vars.GOOGLE_WORKSPACE_REDIRECT_URI,
    "https://setup.fictional-owned-zone.co.za/oauth/google/callback");
  assert.equal(mcp.vars.GMW_WORKSPACE_READS_ENABLED,"false");
  assert.equal(auth.kv_namespaces[0].binding,"OAUTH_KV");
  assert.equal(auth.kv_namespaces[0].id,sample.kvId);
  assert.deepEqual(mcp.d1_databases,setup.d1_databases);
  assert.equal(setup.d1_databases[0].migrations_dir,"migrations");
  assert.equal(auth.ratelimits[0].simple.period,60);
  assert.equal(auth.ratelimits[0].simple.limit,30);
  assert.equal(setup.ratelimits[0].simple.limit,12);
  const source=JSON.stringify({auth,mcp,setup});
  for(const tokenName of ["GMW_TOKEN_ENC_KEY","GOOGLE_LOGIN_CLIENT_SECRET",
      "GOOGLE_WORKSPACE_CLIENT_SECRET","GMW_ALLOWED_GOOGLE_SUB"]) {
    assert(!source.includes(tokenName));
  }
});

test("rejects invalid ownership roots, unsafe IDs, and duplicate throttling namespaces",()=>{
  for(const zone of [
    "example.com","example.net","local.test","app.invalid",
    "localhost","bad..site.co.za","https://site.co.za",
    "MySite.co.za","127.0.0.1","site.co.za:443","wild*.site.co.za"
  ]){
    assert.throws(()=>buildConfigs({...sample,zone}),/Invalid or missing --zone/);
  }
  assert.throws(()=>buildConfigs({...sample,kvId:"none"}),/--kv-id/);
  assert.throws(()=>buildConfigs({...sample,d1Id:"not-a-uuid"}),/--d1-id/);
  assert.throws(()=>buildConfigs({...sample,dbName:"-bad"}),/--db-name/);
  assert.throws(()=>buildConfigs({...sample,authRateId:"0"}),/--auth-rate-id/);
  assert.throws(()=>buildConfigs({...sample,setupRateId:"11013"}),/distinct namespace/);
});

test("validator detects route activation, unexpected service entrypoint, token vars and mismatched binding",()=>{
  const pristine=buildConfigs(sample);
  function rejectWith(edit,pattern) {
    const configs=clone(pristine);
    edit(configs);
    assert.throws(()=>verifyConfigs(configs),pattern);
  }
  rejectWith(x=>{x.setup.routes=[{pattern:"setup.example.com/*"}]},/nonpublic/);
  rejectWith(x=>{x.auth.preview_urls=true},/nonpublic/);
  rejectWith(x=>{x.mcp.workers_dev=true},/nonpublic/);
  rejectWith(x=>{x.mcp.services[0].entrypoint="AuthServer"},/default WorkerEntrypoint/);
  rejectWith(x=>{x.mcp.d1_databases[0].database_id="44444444-4444-4444-4444-444444444444"},/same D1/);
  rejectWith(x=>{x.setup.ratelimits[0].namespace_id=sample.authRateId},/Rate limiting/);
  rejectWith(x=>{x.mcp.vars.GMW_WORKSPACE_READS_ENABLED="true"},/callback|disabled-read|OAuth origins/i);
  rejectWith(x=>{x.auth.vars.REFRESH_TOKEN="fake"},/credential/);
  rejectWith(x=>{x.setup.vars.SETUP_ORIGIN="https://unrelated.org"},/OAuth origins/);
});

test("CLI creates nonpublic local files owner-private, verifies them, and never overwrites",t=>{
  const dir=mkdtempSync(join(tmpdir(),"gmw-cloudflare-test-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=resolve("scripts/prepare-cloudflare.mjs");
  const argv=Object.entries({
    "--zone":sample.zone,
    "--kv-id":sample.kvId,
    "--d1-id":sample.d1Id,
    "--db-name":sample.dbName,
    "--auth-rate-id":sample.authRateId,
    "--setup-rate-id":sample.setupRateId
  }).flat();
  const first=spawnSync(process.execPath,[script,...argv],{cwd:dir,encoding:"utf8"});
  assert.equal(first.status,0,first.stderr);
  assert(first.stdout.includes("Routes: NONE"));
  for(const file of Object.values(OUTPUT_FILES)){
    const local=join(dir,file);
    const obj=JSON.parse(readFileSync(local,"utf8"));
    assert.equal(obj.workers_dev,false);
    assert.equal(statSync(local).mode & 0o077,0);
  }
  const verified=spawnSync(process.execPath,[script,"--verify"],{
    cwd:dir,encoding:"utf8"
  });
  assert.equal(verified.status,0,verified.stderr);
  // Creation is deliberately not idempotent: existing operator configs must
  // never be silently overwritten by a second CLI invocation.
  const second=spawnSync(process.execPath,[script,...argv],{
    cwd:dir,encoding:"utf8"
  });
  assert.notEqual(second.status,0);
  assert(second.stderr.includes("Failed while writing local private files"));
  assert.equal(JSON.parse(readFileSync(join(dir,OUTPUT_FILES.mcp),"utf8"))
    .vars.GMW_WORKSPACE_READS_ENABLED,"false");
});

test("CLI refuses incomplete arguments and never creates files",t=>{
  const dir=mkdtempSync(join(tmpdir(),"gmw-cloudflare-invalid-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const run=spawnSync(process.execPath,[
    resolve("scripts/prepare-cloudflare.mjs"),"--zone","example.com"
  ],{cwd:dir,encoding:"utf8"});
  assert.notEqual(run.status,0);
  for(const file of Object.values(OUTPUT_FILES)){
    assert.throws(()=>statSync(join(dir,file)),{code:"ENOENT"});
  }
});


test("workers.dev staging uses exact account-assigned Worker hostnames, no public routes",()=>{
  const {zone,...rest}=sample;
  const configs=buildConfigs({...rest,workersSubdomain:"sample-staging"});
  const {auth,mcp,setup}=configs;
  assert.equal(verifyConfigs(configs),true);
  assert.equal(auth.vars.AUTH_ISSUER,"https://google-master-auth.sample-staging.workers.dev");
  assert.equal(auth.vars.MCP_RESOURCE_URL,"https://google-master-mcp.sample-staging.workers.dev/mcp");
  assert.equal(setup.vars.SETUP_ORIGIN,
    "https://google-master-workspace-setup.sample-staging.workers.dev");
  assert.equal(setup.vars.GOOGLE_WORKSPACE_REDIRECT_URI,
    "https://google-master-workspace-setup.sample-staging.workers.dev/oauth/google/callback");
  assert.equal(mcp.vars.GOOGLE_WORKSPACE_REDIRECT_URI,
    setup.vars.GOOGLE_WORKSPACE_REDIRECT_URI);
  assert.deepEqual(mcp.services,[{binding:"AUTH_SERVER",service:auth.name}]);
  assert.deepEqual(mcp.d1_databases,setup.d1_databases);
  for(const item of Object.values(configs)){
    assert.equal(item.workers_dev,false);
    assert.equal(item.preview_urls,false);
    assert.equal(item.routes,undefined);
    assert.equal(item.route,undefined);
  }
  assert.equal(mcp.vars.GMW_WORKSPACE_READS_ENABLED,"false");
  assert.equal(mcp.vars.GMW_ALLOWED_BROWSER_ORIGINS,"");
});

test("workers.dev staging refuses inappropriate subdomains, confused modes and activated routes",()=>{
  const {zone,...rest}=sample;
  for(const subdomain of [
    "workers.dev","myaccount.workers.dev","HTTPS://WORKERS.DEV",
    "MyAccount","bad..label","bad_label","-myaccount","example",
    "a".repeat(64),"127.0.0.1","","test"
  ]) {
    assert.throws(()=>buildConfigs({...rest,workersSubdomain:subdomain}),
      /Invalid or missing --workers-subdomain/);
  }
  assert.throws(()=>buildConfigs({...sample,zone:"myaccount.workers.dev"}),
    /Invalid or missing --zone/);
  assert.throws(()=>buildConfigs({...sample,workersSubdomain:"myaccount"}),
    /either --zone or --workers-subdomain/);
  const configs=buildConfigs({...rest,workersSubdomain:"sample-staging"});
  const activated=clone(configs);
  activated.auth.workers_dev=true;
  assert.throws(()=>verifyConfigs(activated),/nonpublic/);
  const mismatch=clone(configs);
  mismatch.setup.vars.SETUP_ORIGIN="https://setup.example.com";
  assert.throws(()=>verifyConfigs(mismatch),/OAuth origins/);
});

test("CLI workers.dev mode creates the same protected files and validates without Cloudflare",t=>{
  const dir=mkdtempSync(join(tmpdir(),"gmw-workerdev-test-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=resolve("scripts/prepare-cloudflare.mjs");
  const {zone,...rest}=sample;
  const args=[
    "--workers-subdomain","sample-staging",
    "--kv-id",rest.kvId,
    "--d1-id",rest.d1Id,
    "--db-name",rest.dbName,
    "--auth-rate-id",rest.authRateId,
    "--setup-rate-id",rest.setupRateId
  ];
  const response=spawnSync(process.execPath,[script,...args],{
    cwd:dir,encoding:"utf8"
  });
  assert.equal(response.status,0,response.stderr);
  assert(response.stdout.includes("google-master-mcp.sample-staging.workers.dev/mcp"));
  assert(response.stdout.includes("workers_dev=false"));
  for(const file of Object.values(OUTPUT_FILES)){
    const path=join(dir,file);
    assert.equal(statSync(path).mode & 0o077,0);
  }
  const verify=spawnSync(process.execPath,[script,"--verify"],{
    cwd:dir,encoding:"utf8"
  });
  assert.equal(verify.status,0,verify.stderr);
});
