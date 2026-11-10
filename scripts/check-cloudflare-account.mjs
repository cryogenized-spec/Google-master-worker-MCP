#!/usr/bin/env node
/**
 * M13: read-only account and resource inventory check. This script performs
 * exactly three Wrangler read commands. It never provisions or deploys.
 * Requires the pinned local Wrangler package and Node 26 in normal use.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OUTPUT_FILES, verifyConfigs } from "./prepare-cloudflare.mjs";

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const KV_ID = /^[a-f0-9]{32}$/i;
const D1_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export const READ_COMMANDS = Object.freeze([
  Object.freeze(["whoami", "--json"]),
  Object.freeze(["kv", "namespace", "list"]),
  Object.freeze(["d1", "list", "--json"])
]);

export function verifyLiveInventory({accountId, configs, whoami, kvNamespaces, databases}) {
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
    throw new Error("Provide the 32-character account ID of the intended Cloudflare account.");
  }
  verifyConfigs(configs);
  if (whoami?.loggedIn !== true || !Array.isArray(whoami.accounts) ||
      !whoami.accounts.some(account => typeof account?.id === "string" &&
        account.id.toLowerCase() === accountId.toLowerCase())) {
    throw new Error("Wrangler has not confirmed membership in the specified account. Stop; check login and account ID.");
  }
  if (!Array.isArray(kvNamespaces) || !Array.isArray(databases)) {
    throw new Error("Expected structured KV and D1 inventory; refusing an incomplete check.");
  }
  const configuredKv = configs.auth.kv_namespaces[0].id;
  const configuredDb = configs.setup.d1_databases[0];
  if (!KV_ID.test(configuredKv) ||
      !kvNamespaces.some(ns => typeof ns?.id === "string" &&
        ns.id.toLowerCase() === configuredKv.toLowerCase())) {
    throw new Error("The configured OAUTH_KV namespace is absent from this Cloudflare account.");
  }
  if (!D1_ID.test(configuredDb.database_id) ||
      !databases.some(db => typeof db?.uuid === "string" &&
        db.uuid.toLowerCase() === configuredDb.database_id.toLowerCase() &&
        db?.name === configuredDb.database_name)) {
    throw new Error("The configured D1 vault UUID and name do not match a database in this account.");
  }
  return Object.freeze({
    accountVerified: true,
    kvVerified: true,
    d1Verified: true,
    routesDisabled: true,
    googleReadsDisabled: true
  });
}

function parseJsonOutput(output, label) {
  if (typeof output !== "string" || output.length > 2_000_000) {
    throw new Error(label + " returned missing or oversized output.");
  }
  try { return JSON.parse(output); }
  catch { throw new Error(label + " did not return JSON; check the pinned Wrangler version."); }
}

export function readGeneratedConfigs(root = process.cwd()) {
  try {
    const configs = Object.fromEntries(Object.entries(OUTPUT_FILES).map(
      ([role, name]) => [role, JSON.parse(readFileSync(resolve(root, name), "utf8"))]
    ));
    verifyConfigs(configs);
    return configs;
  } catch {
    throw new Error("Private deployment configs missing or invalid; first run cloudflare:prepare and cloudflare:verify.");
  }
}

function localWrangler(args, {root, accountId}) {
  // Use precisely the pinned local executable: never npx-download another version.
  const executable = resolve(root, "node_modules/.bin/wrangler");
  const result = spawnSync(executable, args, {
    cwd:root,
    env:{...process.env, CLOUDFLARE_ACCOUNT_ID:accountId, WRANGLER_SEND_METRICS:"false"},
    encoding:"utf8", timeout:20_000, maxBuffer:2_000_000,
    shell:false, windowsHide:true
  });
  if (result.error || result.status !== 0) {
    // Never print Wrangler stdout/stderr; errors can contain account information.
    throw new Error("Read-only Wrangler " + args[0] + " check failed. Verify local npm ci, login and network access.");
  }
  return result.stdout;
}

export function inspectCloudflare({accountId, root = process.cwd(), runner = localWrangler}) {
  if (!ACCOUNT_ID.test(accountId ?? "")) {
    throw new Error("--account-id must be a 32-character Cloudflare account ID.");
  }
  const configs = readGeneratedConfigs(root);
  const [whoami, kvNamespaces, databases] = READ_COMMANDS.map((command, index) =>
    parseJsonOutput(runner([...command], {root,accountId}), ["whoami", "KV", "D1"][index])
  );
  return verifyLiveInventory({accountId, configs, whoami, kvNamespaces, databases});
}

function cli(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("Read-only Cloudflare account/resource validation (no deployments).\n" +
      "npm run cloudflare:inspect -- --account-id <YOUR_32_HEX_ACCOUNT_ID>\n" +
      "Requires private .wrangler-deploy.*.jsonc files and authenticated local Wrangler.\n");
    return;
  }
  if (args.length !== 2 || args[0] !== "--account-id") {
    throw new Error("Usage: npm run cloudflare:inspect -- --account-id <32_HEX_ACCOUNT_ID>");
  }
  const result = inspectCloudflare({accountId:args[1]});
  if (result.accountVerified && result.kvVerified && result.d1Verified) {
    process.stdout.write("PASS: Cloudflare account membership, KV namespace and D1 vault name/UUID match.\n"+
      "No routes enabled, no Google reads enabled, no resources changed.\n"+
      "This does not verify OAuth credentials, database migrations, WAF or deployment safety.\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write("Cloudflare inspection refused: " + error.message + "\n");
    process.exitCode = 1;
  }
}
