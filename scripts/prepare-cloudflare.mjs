#!/usr/bin/env node
/**
 * Prepare binding-complete, route-free Wrangler configurations for an
 * independently verified Cloudflare account. This script never calls
 * Wrangler, mutates cloud resources, or accepts credentials.
 *
 * Run from the repository root with Node 26.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUT_FILES = Object.freeze({
  auth: ".wrangler-deploy.auth.jsonc",
  mcp: ".wrangler-deploy.mcp.jsonc",
  setup: ".wrangler-deploy.setup.jsonc"
});

const UPPER_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const KV_ID = /^[a-f0-9]{32}$/i;
const D1_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function required(value, name, predicate) {
  if (typeof value !== "string" || !predicate(value)) {
    throw new Error("Invalid or missing " + name + ". No files were written.");
  }
  return value;
}
function validateZone(value) {
  const zone = required(value, "--zone", text => {
    if (!text || text !== text.toLowerCase() ||
        text.length > 253 || text.includes("://") ||
        text.startsWith(".") || text.endsWith(".")) return false;
    // Workers.dev is an account-assigned host, not a custom zone.
    // Its hostname layout is worker.account.workers.dev, not auth.account...
    if (text.endsWith(".workers.dev")) return false;
    const labels = text.split(".");
    if (labels.length < 2) return false;
    if (labels.some(label => !DOMAIN_LABEL.test(label))) return false;
    if (labels.at(-1).length < 2) return false;
    return !["example.com", "example.net", "example.org"].includes(text) &&
      !["test","invalid","localhost","example"].includes(labels.at(-1));
  });
  return zone;
}
function validateWorkersSubdomain(value) {
  return required(value, "--workers-subdomain", text =>
    DOMAIN_LABEL.test(text) && text.length <= 63 &&
    text !== "example" && text !== "workers" &&
    text !== "localhost" && text !== "test" &&
    text.toLowerCase() === text && !text.includes(".")
  );
}
function positiveIntegerString(value) {
  return /^[1-9][0-9]{0,9}$/.test(value ?? "") &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) <= 2147483647;
}
function derived(root) {
  return {
    authOrigin: "https://auth." + root,
    mcpResource: "https://mcp." + root + "/mcp",
    setupOrigin: "https://setup." + root,
    setupRedirect: "https://setup." + root + "/oauth/google/callback"
  };
}
function derivedWorkers(subdomain) {
  const suffix = "." + subdomain + ".workers.dev";
  return {
    authOrigin: "https://google-master-auth" + suffix,
    mcpResource: "https://google-master-mcp" + suffix + "/mcp",
    setupOrigin: "https://google-master-workspace-setup" + suffix,
    setupRedirect: "https://google-master-workspace-setup" + suffix +
      "/oauth/google/callback"
  };
}
function common(name, main, flags = ["nodejs_compat"]) {
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name, main, compatibility_date: "2026-11-10",
    compatibility_flags: flags,
    workers_dev: false, preview_urls: false,
    observability: { enabled: false }
  };
}
function limiter(name, namespaceId, limit) {
  return [{name, namespace_id: namespaceId, simple:{limit,period:60}}];
}
export function buildConfigs(raw) {
  if (raw.zone !== undefined && raw.workersSubdomain !== undefined) {
    throw new Error("Use either --zone or --workers-subdomain, not both.");
  }
  const urls = raw.workersSubdomain !== undefined
    ? derivedWorkers(validateWorkersSubdomain(raw.workersSubdomain))
    : derived(validateZone(raw.zone));
  const kvId = required(raw.kvId, "--kv-id", s => KV_ID.test(s));
  const d1Id = required(raw.d1Id, "--d1-id", s => D1_ID.test(s));
  const dbName = required(raw.dbName, "--db-name", s => UPPER_NAME.test(s));
  const authRateId = required(raw.authRateId, "--auth-rate-id", positiveIntegerString);
  const setupRateId = required(raw.setupRateId, "--setup-rate-id", positiveIntegerString);
  if (authRateId === setupRateId) {
    throw new Error("OAuth and setup rate limits must use distinct namespace IDs.");
  }
  const database = [{
    binding: "DB", database_name: dbName, database_id: d1Id.toLowerCase(),
    migrations_dir: "migrations"
  }];
  const auth = {
    ...common("google-master-auth", "apps/auth-server/src/index.ts",
      ["nodejs_compat", "global_fetch_strictly_public"]),
    vars: {AUTH_ISSUER: urls.authOrigin, MCP_RESOURCE_URL: urls.mcpResource},
    kv_namespaces: [{binding:"OAUTH_KV",id:kvId.toLowerCase()}],
    ratelimits: limiter("AUTH_RATE_LIMITER",authRateId,30)
  };
  const mcp = {
    ...common("google-master-mcp", "apps/protected-mcp/src/index.ts"),
    vars: {
      AUTH_ISSUER: urls.authOrigin,
      MCP_RESOURCE_URL: urls.mcpResource,
      GOOGLE_WORKSPACE_REDIRECT_URI: urls.setupRedirect,
      GMW_WORKSPACE_READS_ENABLED:"false",
      GMW_ALLOWED_BROWSER_ORIGINS:""
    },
    // The authorization Worker exports *default* class AuthServer.
    // Cloudflare RPC selects the default export only when entrypoint is omitted.
    services: [{binding:"AUTH_SERVER",service:"google-master-auth"}],
    d1_databases: structuredClone(database)
  };
  const setup = {
    ...common("google-master-workspace-setup","apps/workspace-setup/src/index.ts"),
    vars: {SETUP_ORIGIN:urls.setupOrigin, GOOGLE_WORKSPACE_REDIRECT_URI:urls.setupRedirect},
    d1_databases: structuredClone(database),
    ratelimits: limiter("SETUP_RATE_LIMITER",setupRateId,12)
  };
  const configs = {auth,mcp,setup};
  verifyConfigs(configs);
  return configs;
}

export function verifyConfigs(configs) {
  if (!configs || typeof configs !== "object") throw Error("Invalid config set");
  const {auth,mcp,setup} = configs;
  for (const [role,config] of Object.entries({auth,mcp,setup})) {
    if (!config || config.workers_dev !== false ||
        config.preview_urls !== false ||
        "routes" in config || "route" in config ||
        "triggers" in config || "account_id" in config) {
      throw new Error(role + " is not a route-free, nonpublic staging configuration.");
    }
    if (!config.main?.startsWith("apps/") || !config.name?.startsWith("google-master-")) {
      throw new Error("Unexpected " + role + " Worker entrypoint.");
    }
    const publicVars = config.vars ?? {};
    for (const [name,value] of Object.entries(publicVars)) {
      if (/secret|token|password|key|sub$/i.test(name) ||
          typeof value !== "string" || value.length > 512) {
        throw new Error("Potential credential or invalid public variable: " + name);
      }
    }
  }
  if (auth.name !== "google-master-auth" ||
      mcp.name !== "google-master-mcp" ||
      setup.name !== "google-master-workspace-setup" ||
      auth.main !== "apps/auth-server/src/index.ts" ||
      mcp.main !== "apps/protected-mcp/src/index.ts" ||
      setup.main !== "apps/workspace-setup/src/index.ts") {
    throw new Error("Worker routing targets changed unexpectedly.");
  }
  if (auth.kv_namespaces?.length !== 1 ||
      auth.kv_namespaces[0].binding !== "OAUTH_KV" ||
      !KV_ID.test(auth.kv_namespaces[0].id)) {
    throw new Error("OAuth KV binding missing or invalid.");
  }
  const shared = [mcp, setup].map(config => config.d1_databases);
  if (shared.some(items =>
    items?.length !== 1 || items[0].binding !== "DB" ||
    !D1_ID.test(items[0].database_id) ||
    !UPPER_NAME.test(items[0].database_name) ||
    items[0].migrations_dir !== "migrations"
  ) ||
    JSON.stringify(shared[0]) !== JSON.stringify(shared[1])) {
    throw new Error("Protected MCP and Setup must use the same D1 vault database.");
  }
  if (mcp.services?.length !== 1 ||
      mcp.services[0].binding !== "AUTH_SERVER" ||
      mcp.services[0].service !== auth.name ||
      "entrypoint" in mcp.services[0]) {
    throw new Error("Invalid default WorkerEntrypoint service binding.");
  }
  if (auth.ratelimits?.length !== 1 || setup.ratelimits?.length !== 1 ||
      auth.ratelimits[0].name !== "AUTH_RATE_LIMITER" ||
      setup.ratelimits[0].name !== "SETUP_RATE_LIMITER" ||
      !positiveIntegerString(auth.ratelimits[0].namespace_id) ||
      !positiveIntegerString(setup.ratelimits[0].namespace_id) ||
      auth.ratelimits[0].namespace_id === setup.ratelimits[0].namespace_id ||
      auth.ratelimits[0].simple.limit !== 30 ||
      setup.ratelimits[0].simple.limit !== 12 ||
      auth.ratelimits[0].simple.period !== 60 ||
      setup.ratelimits[0].simple.period !== 60) {
    throw new Error("Rate limiting not safely configured.");
  }
  const authOrigin = auth.vars.AUTH_ISSUER;
  const mcpResource = auth.vars.MCP_RESOURCE_URL;
  const setupOrigin = setup.vars.SETUP_ORIGIN;
  try {
    const workersMatch = /^https:\/\/google-master-auth\.([a-z0-9-]+)\.workers\.dev$/.exec(authOrigin);
    const urls = workersMatch
      ? derivedWorkers(validateWorkersSubdomain(workersMatch[1]))
      : derived(validateZone(new URL(authOrigin).hostname.replace(/^auth\./,"")));
    if (authOrigin !== urls.authOrigin || mcpResource !== urls.mcpResource ||
        mcp.vars.AUTH_ISSUER !== urls.authOrigin ||
        mcp.vars.MCP_RESOURCE_URL !== urls.mcpResource ||
        setupOrigin !== urls.setupOrigin ||
        setup.vars.GOOGLE_WORKSPACE_REDIRECT_URI !== urls.setupRedirect ||
        mcp.vars.GOOGLE_WORKSPACE_REDIRECT_URI !== urls.setupRedirect ||
        mcp.vars.GMW_WORKSPACE_READS_ENABLED !== "false") {
      throw Error("URI mismatch");
    }
  } catch {
    throw new Error("OAuth origins, redirect URIs or disabled-read flag do not match.");
  }
  return true;
}

function optionsFromArgv(argv) {
  const choices = new Map([
    ["--zone","zone"],["--workers-subdomain","workersSubdomain"],
    ["--kv-id","kvId"],["--d1-id","d1Id"],
    ["--db-name","dbName"],["--auth-rate-id","authRateId"],
    ["--setup-rate-id","setupRateId"]
  ]);
  if (argv.length === 1 && argv[0] === "--verify") return {verify:true};
  if (argv.includes("--help") || argv.includes("-h")) return {help:true};
  if (argv.length !== 12) {
    throw Error("Provide all six named arguments; see --help.");
  }
  const result = {};
  for (let i=0;i<argv.length;i+=2) {
    const name = choices.get(argv[i]);
    if (!name || name in result || !argv[i+1] || argv[i+1].startsWith("--")) {
      throw Error("Unknown or repeated argument: " + argv[i]);
    }
    result[name] = argv[i+1];
  }
  if (("zone" in result) === ("workersSubdomain" in result)) {
    throw Error("Choose exactly one: --zone or --workers-subdomain.");
  }
  return result;
}
function main(argv) {
  const args = optionsFromArgv(argv);
  const filepaths = Object.fromEntries(
    Object.entries(OUTPUT_FILES).map(([role,name])=>[role,resolve(name)])
  );
  if (args.help) {
    process.stdout.write(
      "Prepare NONPUBLIC Cloudflare configs. No Cloudflare operations.\n"+
      "node scripts/prepare-cloudflare.mjs \\\n"+
      "  (--zone <YOUR-OWNED-ZONE> OR --workers-subdomain <ACCOUNT-SUBDOMAIN>) \\\n"+
      "  --kv-id <32-hex-chars> \\\n"+
      "  --d1-id <D1-UUID> --db-name <D1-NAME> \\\n"+
      "  --auth-rate-id <UNIQUE-INTEGER> --setup-rate-id <OTHER-UNIQUE-INTEGER>\n"+
      "node scripts/prepare-cloudflare.mjs --verify\n"
    );
    return;
  }
  if (args.verify) {
    const current = Object.fromEntries(Object.entries(filepaths).map(
      ([role,path])=>[role,JSON.parse(readFileSync(path,"utf8"))]
    ));
    verifyConfigs(current);
    process.stdout.write("Verified three private, route-free Wrangler configs. No deployment.\n");
    return;
  }
  const configs = buildConfigs(args);
  const created=[];
  try {
    for (const [role, path] of Object.entries(filepaths)) {
      writeFileSync(path,JSON.stringify(configs[role],null,2)+"\n",
        {encoding:"utf8",mode:0o600,flag:"wx"});
      created.push(path);
    }
  } catch (error) {
    // Do not delete a pre-existing file. Newly created configs stay available
    // for inspection if a later file already exists; never overwrite input.
    throw new Error("Failed while writing local private files; inspect new files. "+error.code);
  }
  const vars=configs.auth.vars;
  process.stdout.write(
    "Created THREE local private configs; no network calls or deployments.\n"+
    "OAuth issuer: "+vars.AUTH_ISSUER+"\n"+
    "MCP resource: "+vars.MCP_RESOURCE_URL+"\n"+
    "Operator setup: "+configs.setup.vars.SETUP_ORIGIN+"\n"+
    "Workspace callback: "+configs.setup.vars.GOOGLE_WORKSPACE_REDIRECT_URI+"\n"+
    "Routes: NONE. workers_dev=false. preview_urls=false. Reads: DISABLED.\n"+
    "Do not deploy yet. Follow docs/M12-WORKERS-DEV-STAGING.md\n"
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write("Cloudflare configuration refused: "+error.message+"\n");
    process.exitCode=1;
  }
}
