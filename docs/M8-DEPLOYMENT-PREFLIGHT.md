# M8 — Cloudflare deployment preflight

**Status:** implemented and merged into main; account-specific deployment preparation only. No Cloudflare account, domain, KV, D1, OAuth client or live Google data has been changed.

## What's included

1. Required per-route Cloudflare **Rate Limiting bindings** for the two user-facing OAuth Workers (operator setup and MCP authorization). Missing/erroring bindings fail closed; excess login/authorization traffic is rejected with HTTP 429 before creating state or contacting Google. The protected MCP Worker continues to validate client OAuth over a private Worker Service Binding.
2. Automated coverage for rate-limiter denial, missing binding and provider failure.
3. Dependency lockfile bootstrap for this isolated feature branch. After a genuine npm-generated `package-lock.json` has been checked in, CI switches to `npm ci` to verify exact dependency resolution. Never fabricate lockfile integrity hashes or hand-edit resolved URLs.
4. A pre-deployment checklist and a short Bash + browser workflow. **None of the live steps is performed by GitHub Actions.**

### Rate limiter requirements

In `wrangler.setup.jsonc`, **before you deploy**, add one Worker Rate Limiting binding with a unique positive integer namespace identifier you control:

```jsonc
"ratelimits": [
  {
    "name": "SETUP_RATE_LIMITER",
    "namespace_id": "10011",
    "simple": { "limit": 12, "period": 60 }
  }
]
```

In `wrangler.auth.jsonc`, configure a **different** namespace ID:

```jsonc
"ratelimits": [
  {
    "name": "AUTH_RATE_LIMITER",
    "namespace_id": "10012",
    "simple": { "limit": 30, "period": 60 }
  }
]
```

The numeric values shown are **examples**, not discovered resources or claims about your Cloudflare account. Choose identifiers unused by any other rate-limiting bindings in that account. The code uses Cloudflare's authoritative `CF-Connecting-IP` header, when available, and otherwise groups requests under one `unknown` key (no untrusted query or user-supplied key material). The route is part of the key. Per-IP limits can affect users sharing a NAT; this is acceptable for the single-operator private setup page but should be reviewed for the more general MCP authorization flow.

**Cloudflare's Worker rate-limiting API is approximate and per-datacenter**; do **not** treat it as strict global brute-force prevention. Also configure Cloudflare WAF rules and, preferably, isolate the private setup hostname behind a restricted access policy. Make sure any Cloudflare Access configuration permits the browser OAuth redirects after login. WAF and rate-limit settings in the dashboard are additional account configuration, *not* automatically created by this repository.

Relevant official documentation: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ and https://developers.cloudflare.com/waf/custom-rules/

### Remaining Cloudflare bindings and domain-specific values

- `wrangler.auth.jsonc`: `OAUTH_KV` KV namespace, **AUTH_RATE_LIMITER**, OAuth issuer HTTPS route, Google login OAuth credentials, known permitted operator Google `sub`.
- `wrangler.protected-mcp.jsonc`: `AUTH_SERVER` **internal Service Binding** to the auth Worker and D1 `DB` binding, exact MCP resource URI, Google API OAuth client configuration and the separately enabled read-only vault session.
- `wrangler.setup.jsonc`: private HTTPS route, `DB` D1 binding, **SETUP_RATE_LIMITER**, exact setup origin and Google OAuth clients, matching Google `sub`, AES-256-GCM key as Cloudflare secret.
- D1 vault must have both reviewed `0001` and `0002` migrations applied *to the intended database*, with encrypted token backups and key recovery plan.
- No automatic deployment, no public `workers.dev` routes, no uploaded secret values. Review any `wrangler config` edits for accidental public exposure.

### Tonight: local terminal + browser

On Linux Mint, use Node 26 (verify with `node -v`). Clone the current branch or the merged `main`. After the generated lockfile is committed:

```bash
node --version
npm ci
npm test

# This opens a browser for Cloudflare login.
npx wrangler login
npx wrangler whoami

# Bundling only, no live deployment:
npx wrangler deploy --dry-run -c wrangler.auth.jsonc
npx wrangler deploy --dry-run -c wrangler.protected-mcp.jsonc
npx wrangler deploy --dry-run -c wrangler.setup.jsonc
```

Google's **actual OAuth consent is completed in the browser** after Cloudflare hostnames and the two Google Cloud Web OAuth clients have been configured. No credential values, authorization codes or refresh tokens should be pasted into chat or into logged shell commands.

For account-specific setup, first verify the intended Cloudflare zone/domain and Google Cloud project. Only after explicit operational approval, create named KV/D1 resources, configure secret bindings, apply production D1 migrations and deploy private Workers. Never run remote D1 migration or deploy commands against an unspecified account.

## Build and release gates

- TypeScript compile, all tests, and dry-runs for four Workers pass on Node 26.
- `package-lock.json` is **generated by npm** and committed; `npm ci` passes from a clean checkout.
- No GitHub Actions workflow has deployment credentials or calls `wrangler deploy` without `--dry-run`.
- No arbitrary Google HTTP proxy or write operations are exposed by the protected MCP Worker.
- Cloudflare configured rate-limit bindings, custom WAF rules, worker-to-worker OAuth validation, target route and ownership reviewed.
- Google consent grants initially restricted to read-only Tasks and read-only Apps Script.
- A test account and a disposable Google Tasks list are used for first live end-to-end acceptance.
