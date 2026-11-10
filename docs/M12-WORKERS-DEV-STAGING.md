# M12 — Optional workers.dev staging hostnames

**Status:** configuration-only implementation. No live Cloudflare account connected; no KV/D1 resources created; no Worker activated; no Google account linked.

## Why this option exists

Cloudflare gives each Workers account an account subdomain such as \`myaccount.workers.dev\`. Each deployed Worker can be addressed as \`<worker-name>.myaccount.workers.dev\` after its \`workers_dev\` route is explicitly enabled. This is suitable for limited non-production experiments, potentially avoiding the need to purchase or configure a custom zone initially.

An existing ClickUp Serviteur staging record previously reported the account subdomain \`cryogenized.workers.dev\`. **That record is historical**, not a current Cloudflare account verification, and this repository **does not hardcode it**. Confirm it using the intended authenticated Cloudflare account before using it.

This milestone extends the existing **nonpublic** Wrangler configuration generator with an exclusive \`--workers-subdomain\` option. Custom owned domains via \`--zone\` continue working exactly as before.

## Generate staging URL configuration

After logging in to the intended Cloudflare account, collect a real \`OAUTH_KV\` namespace ID, a dedicated D1 vault UUID/name and two unused numeric rate-limit namespaces. Then run locally:

\`\`\`bash
npm ci
npx wrangler whoami
npx wrangler kv namespace list
npx wrangler d1 list --json

node scripts/prepare-cloudflare.mjs \
  --workers-subdomain YOUR_ACCOUNT_SUBDOMAIN \
  --kv-id YOUR_REAL_KV_32_HEX_ID \
  --d1-id YOUR_REAL_D1_UUID \
  --db-name google-master-vault \
  --auth-rate-id YOUR_UNUSED_INTEGER \
  --setup-rate-id YOUR_OTHER_UNUSED_INTEGER

node scripts/prepare-cloudflare.mjs --verify
\`\`\`

\`YOUR_ACCOUNT_SUBDOMAIN\` means the single label **before** \`.workers.dev\`. For example, if the verified Cloudflare account owns \`myaccount.workers.dev\`, pass \`myaccount\`, not \`myaccount.workers.dev\`. The tool refuses both \`--zone\` and \`--workers-subdomain\` together. Placeholder IDs will be rejected where invalid, and valid-looking inputs are only checked for syntax and consistency—not ownership.

The resulting local, Git-ignored \`.wrangler-deploy.*.jsonc\` files carry:

| Service | Planned URL (example account \`myaccount\`) |
| --- | --- |
| Client OAuth issuer | \`https://google-master-auth.myaccount.workers.dev\` |
| Protected MCP resource | \`https://google-master-mcp.myaccount.workers.dev/mcp\` |
| Operator setup | \`https://google-master-workspace-setup.myaccount.workers.dev\` |
| Operator OAuth callback | \`https://google-master-workspace-setup.myaccount.workers.dev/google/callback\` |
| Google Workspace callback | \`https://google-master-workspace-setup.myaccount.workers.dev/oauth/google/callback\` |

**Important:** Every generated Worker continues to declare \`workers_dev=false\`, \`preview_urls=false\`, no custom routes, and \`GMW_WORKSPACE_READS_ENABLED=false\`. These planned URLs will **not work yet**, even if a version is uploaded, until the operator separately configures and deliberately enables its endpoint. The generator does not offer an automatic public activation switch.

## OAuth and public exposure cautions

- Google Cloud validates **exact authorized redirect URIs** and may apply domain-ownership or app-verification restrictions. A \`workers.dev\` hostname is not automatically a guaranteed acceptable Google OAuth production domain. Verify with a separate Google Cloud **test** OAuth client before relying on it; use a verified custom domain if Google requires it. Google production app policies require an appropriate verified homepage and privacy policy.
- Once \`workers_dev=true\` is deliberately set and deployed, Cloudflare's \`workers.dev\` URLs are publicly reachable by default. Configure Cloudflare Access and any required authorization/WAF protections first. Validate that Access configuration does not block the intended Google OAuth browser callbacks.
- Do not stage fake OAuth clients with real account data. Do not use the old M3 static bearer gateway on the public Internet.
- The D1 database, OAuth KV, real secrets and two distinct rate limiters still need correct account-bound configuration. Missing secrets or bindings must fail closed.
- Do not enable the protected Worker's Google reads or remote mutation tools during staging. The first live acceptance should use a disposable Google Tasks list.
- \`wrangler secret put\` can trigger deployment. Prefer explicitly staged version-secret commands, followed by a separate operator-reviewed activation.

## Verification

The existing \`tests/cloudflare-config.test.mjs\` now tests both custom-zone and \`workers.dev\` derivations, safe local file permissions, strict mutual exclusion, mismatched D1/callback failure, and prevention of premature public routing. GitHub CI still compiles all four Workers and runs local workerd OAuth tests.

Cloudflare documentation:
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/workers/configuration/secrets/

Google OAuth policies:
- https://developers.google.com/identity/protocols/oauth2/policies
- https://developers.google.com/identity/protocols/oauth2/web-server

**This changes local configuration validation, not the live deployment.** A domain and resource review is still required before production activation.
