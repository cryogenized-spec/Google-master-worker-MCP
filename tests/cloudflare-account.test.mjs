import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildConfigs, OUTPUT_FILES} from "../scripts/prepare-cloudflare.mjs";
import {READ_COMMANDS, inspectCloudflare, verifyLiveInventory} from "../scripts/check-cloudflare-account.mjs";

const accountId = "a".repeat(32);
const kvId = "b".repeat(32);
const d1Id = "01234567-89ab-cdef-0123-456789abcdef";
const configs = buildConfigs({
  workersSubdomain:"private-testing", kvId, d1Id,
  dbName:"google-master-vault",authRateId:"310001",setupRateId:"310002"
});
const inventory = {
  accountId, configs,
  whoami:{loggedIn:true,accounts:[{id:accountId,name:"intended-account"}]},
  kvNamespaces:[{id:kvId,title:"google-master-oauth"}],
  databases:[{uuid:d1Id,name:"google-master-vault"}]
};

test("accepts read-only inventory only when account membership and both resources match",()=>{
  const check=verifyLiveInventory(inventory);
  assert.equal(check.accountVerified,true);
  assert.equal(check.kvVerified,true);
  assert.equal(check.d1Verified,true);
  assert.equal(check.googleReadsDisabled,true);
});

test("refuses absent or wrong Cloudflare identity",()=>{
  for(const whoami of [
    {loggedIn:false,accounts:[]},
    {loggedIn:true,accounts:[]},
    {loggedIn:true,accounts:[{id:"c".repeat(32)}]},
    {loggedIn:true,accounts:null}
  ]) assert.throws(()=>verifyLiveInventory({...inventory,whoami}),/membership/);
  assert.throws(()=>verifyLiveInventory({...inventory,accountId:"wrong"}),/account ID/);
});

test("refuses wrong KV ID, wrong D1 name and wrong D1 UUID",()=>{
  assert.throws(()=>verifyLiveInventory({...inventory,kvNamespaces:[]}),/OAUTH_KV/);
  assert.throws(()=>verifyLiveInventory({...inventory,databases:[{uuid:d1Id,name:"other"}]}),/D1 vault/);
  assert.throws(()=>verifyLiveInventory({...inventory,databases:[{uuid:"d".repeat(8)+"-89ab-cdef-0123-456789abcdef",name:"google-master-vault"}]}),/D1 vault/);
});

test("refuses malformed inventory or prematurely opened Worker routes/Google reads",()=>{
  assert.throws(()=>verifyLiveInventory({...inventory,databases:{}}),/structured/);
  const unsafe=structuredClone(configs); unsafe.mcp.workers_dev=true;
  assert.throws(()=>verifyLiveInventory({...inventory,configs:unsafe}),/nonpublic/);
  const unsafe2=structuredClone(configs); unsafe2.mcp.vars.GMW_WORKSPACE_READS_ENABLED="true";
  assert.throws(()=>verifyLiveInventory({...inventory,configs:unsafe2}),/disabled-read/);
});

test("CLI orchestrator invokes only exact, known read-only Wrangler commands",t=>{
  const dir=mkdtempSync(join(tmpdir(),"gmw-account-inventory-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const [role,name] of Object.entries(OUTPUT_FILES)) {
    writeFileSync(join(dir,name),JSON.stringify(configs[role]));
  }
  const output=[inventory.whoami,inventory.kvNamespaces,inventory.databases];
  const calls=[];
  const result=inspectCloudflare({accountId,root:dir,runner:(args,meta)=>{
    calls.push(args);
    assert.equal(meta.accountId,accountId);
    return JSON.stringify(output[calls.length-1]);
  }});
  assert.equal(result.accountVerified,true);
  assert.deepEqual(calls,READ_COMMANDS.map(x=>[...x]));
});

test("CLI orchestrator rejects any non-JSON output without spilling it",t=>{
  const dir=mkdtempSync(join(tmpdir(),"gmw-account-inventory-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const [role,name] of Object.entries(OUTPUT_FILES)) writeFileSync(join(dir,name),JSON.stringify(configs[role]));
  assert.throws(()=>inspectCloudflare({accountId,root:dir,runner:()=>"TOKEN_NOT_TO_BE_PRINTED"}),
    error=>error.message.includes("did not return JSON") && !error.message.includes("TOKEN_NOT_TO_BE_PRINTED"));
});
