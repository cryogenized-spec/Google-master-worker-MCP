# M13 — Verify Cloudflare account and bound resources before activation

**Status:** local read-only verification, no Cloudflare deployment or live Google OAuth connection. This milestone follows M12's generated route-free staging configurations.

## Problem addressed

`prepare-cloudflare.mjs` already checks the shape and consistency of your planned Worker bindings. A syntactically valid 32-character KV ID or D1 UUID, however, could still belong to a different Cloudflare account, be mistyped, or point at the wrong database. M13 adds `scripts/check-cloudflare-account.mjs` to verify real account membership and resources using the currently installed Wrangler. The command makes **only three remote read requests** through the local, pinned Wrangler: `whoami --json`, `kv namespace list`, and `d1 list --json`.

It checks that:

- `--account-id` exactly matches an account reported by Wrangler's authenticated membership list;
- the configured `OAUTH_KV` namespace ID is present in that account;
- the configured D1 database has **both** the exact UUID and name from the generated configuration;
- the generated configs remain unexposed (`workers_dev=false`, no routes or previews) and protected MCP Google reads remain disabled.

The script **does not** create/delete resources, deploy Workers, set credentials, read KV keys or D1 records, migrate the database, connect Google or enable network endpoints. It never logs the raw output of a failed Wrangler command. It does not attempt to prove ownership of a custom domain or verify Cloudflare Access/WAF, Google OAuth credentials, migrations, namespace-ID uniqueness, or policies.

## Running on the operator's Linux Mint machine

Use Node 26 and the committed lockfile (no globally installed Wrangler required):

```bash
git switch main
git pull --ff-only
npm ci
npx wrangler login
npx wrangler whoami --json
```

Inspect the `accounts` list **locally** and select the intended account's 32-character ID. Do not share tokens, OAuth client secrets or the full `whoami` output in chat.

If you have not created the required KV namespace and D1 database yet, follow the manual resource-creation and configuration procedure in [M12](M12-WORKERS-DEV-STAGING.md) first. `cloudflare:prepare` must already have created the three ignored `.wrangler-deploy.*.jsonc` files from the actual resource IDs and the intended account's verified hostname or owned zone; verify those configs before inspection:

```bash
npm run cloudflare:verify
npm run cloudflare:inspect -- --account-id YOUR_ACTUAL_32_HEX_ACCOUNT_ID
```

The account ID is an identifier, **not a credential**. The inspector uses `CLOUDFLARE_ACCOUNT_ID` **only for the spawned read-only Wrangler commands** so multi-account logins cannot accidentally inspect another account. It requires JSON output and refuses missing account membership, missing resources, mismatched names or unexpected Wrangler output rather than guessing.

A passing result only means that the **account, KV and D1 binding inventory** matched at that moment; it does not mean the deployment is safe or operational. Complete D1 migration review, secrets setup, access restrictions, OAuth callbacks and first disposable read-only Google Tasks acceptance separately. Do not turn on `workers_dev`, routes, or `GMW_WORKSPACE_READS_ENABLED` because this check passed.

## Developer verification

The `tests/cloudflare-account.test.mjs` suite provides synthetic account/resource inventories, wrong-account and wrong-resource rejection, locked-down routing checks, command allowlisting and JSON error redaction. These tests do not contact Cloudflare. The regular CI build and test pipeline runs the new test alongside existing project tests and local runtime acceptance checks.

## Cloudflare sources

- [Wrangler `whoami --json`](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Wrangler KV namespace list](https://developers.cloudflare.com/kv/reference/kv-commands/)
- [Wrangler D1 list](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
