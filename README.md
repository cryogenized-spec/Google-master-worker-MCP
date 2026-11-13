# Google Master Worker MCP

**Status (13 Nov 2026):** Three Google Master Workers are deployed on Cloudflare; OAuth, encrypted D1 Google vault and the 23-granted-scope personal-account connection are verified. **M21 is currently live with 24 operational Google reads** (Tasks, Drive, Calendar, Gmail and Contacts have all passed real read-only calls). M22 increases coverage to 101 reads; M23 adds 90 exact-action owner-approved mutation operations plus an approval-proposal tool. **M22/M23 code must be deployed together after database migration and validation; neither has been deployed to production.**

A personal, TypeScript-first Google Workspace integration platform intended to serve ChatGPT via remote MCP, ELF//SHELL Ayarime and CiRYVA Android via reusable typed HTTPS interfaces. Modules are portable and centrally routed; client apps do not need to implement Google REST logic individually.

## Implemented

- **M22 comprehensive read catalogue:** 76 fixed GET endpoints plus one bounded Calendar freeBusy query extend M19's 24 operations to **101 typed, read-only remote MCP tools** across Tasks, Apps Script, Drive, Docs, Sheets, Slides, Calendar, Gmail, Contacts, Forms and Meet. M23 extends the existing nine core mutations with 81 more named operations, encrypted D1 proposal storage, private Google-verified owner review and atomic one-use approval. When enabled, there are **101 read + 90 mutation + one prepare = 192 named operations**.
- Shared TypeScript operation registry, strict input/output schemas, per-account Google scope checks, bounded REST transport and redacted errors.
- Deployed Cloudflare Workers: resource-scoped MCP OAuth authorization, protected MCP gateway and private Workspace Setup; mutations are disabled by default and require independent approval when enabled.
- Google operator authentication by verified Google OIDC subject, per-client browser consent, protected OAuth tokens and separated Google Workspace authorization.
- Encrypted Google OAuth vault built on D1-compatible SQL and AES-256-GCM, with one-time authorization state and versioned token refresh.
- Protected MCP session provider that **can read** an independently authorized D1 vault **only when explicitly enabled** and invoked by an OAuth-verified client. The generated configuration still disables both reads and writes by default; M21's deployed version has its read gate enabled.
- An authenticated typed `/v1/capabilities` and `/v1/operations/{name}` API shared by MCP, TypeScript and Android. Reads work without write opt-in; M23 protected writes require the explicit Worker gate and one-use owner approval. Actual Firefox/Android app integration remains future work.
- Cloudflare `workers.dev` staging in active use: Auth and MCP production URLs enabled with OAuth protection, private Setup production URL behind Cloudflare Access; preview URLs disabled. Google API read gate is active in M21 production; M23 write gate remains off until controlled rollout.
- Safe CLI-generated, private Cloudflare binding configurations for an operator-owned domain, KV namespace, shared D1 database, two rate limiters and the default-entrypoint RPC binding; no public routes or secrets generated.
- M13 read-only Cloudflare inventory checker using pinned Wrangler: verifies actual account membership, KV namespace and D1 vault identity without creating or deploying resources.
- Required OAuth and setup Worker rate-limit bindings, with early HTTP 429 rejection and safe denial on missing Cloudflare configuration. Cloudflare WAF remains a deployment prerequisite.
- Owner-only private browser setup Worker in active use: Google OIDC login, CSRF-bound browser session, one-session 23-scope personal Gmail Workspace consent, encrypted D1 vault and secure provider revocation/disconnect.
- Node 26 tests, GitHub Actions CI, Wrangler dry-run checks and locally simulated Cloudflare Worker OAuth acceptance tests. Secret *values* are never committed.

## Development

Use **Node.js 26** and the pinned compatible stable dependencies in `package.json`:

```sh
npm ci
npm test
npm run test:runtime
```

Use `npm run cloudflare:inspect -- --account-id YOUR_ACCOUNT_ID` after generating your private Wrangler configurations and logging in through Wrangler. See [M13 account inventory checks](docs/M13-ACCOUNT-INVENTORY.md) for exact prerequisites.

See `docs/DEPENDENCIES.md` for the dependency policy. The npm-generated `package-lock.json` is committed, and CI uses `npm ci` for reproducible builds.

## Current architecture and remaining work

The auth Worker issues scoped OAuth tokens to approved MCP clients. The protected MCP Worker validates them over an internal Service Binding, derives an opaque client identity, and exposes read-only Google operations. The Google token vault is a *second*, independent authorization boundary. Having an MCP token alone does not grant access to Google.

**Validated live:** Google Tasks, Drive, Calendar, Gmail and Contacts read operations. **Awaiting M23 deployment/acceptance:** owner-approved write path, D1 approval migration, and provider-specific mutation field tests. Actual Ayarime/CiRYVA UI integration and binary upload/streaming support remain future work.

For the M23 single-release write suite, D1 migration and owner-approval workflow, see [M23 writes and approvals](docs/M23-WRITES-AND-APPROVALS.md) and [release script](scripts/release-m23.sh). For the single-batch read catalogue and API acceptance boundaries, see [M22 comprehensive Google reads](docs/M22-COMPREHENSIVE-READS.md). For broad API expansion and rollout, see [M19 broad Workspace service catalogue](docs/M19-BROAD-WORKSPACE-API.md) and [M18 personal Gmail scope compatibility](docs/M18-CONSUMER-OAUTH.md). For exact earlier rollout and security requirements, see [M13 read-only account inventory](docs/M13-ACCOUNT-INVENTORY.md), [M12 optional workers.dev staging](docs/M12-WORKERS-DEV-STAGING.md), [M11 local Worker authentication checks](docs/M11-RUNTIME-ACCEPTANCE.md), [M10 first-party client integration](docs/M10-CLIENT-API.md), [the M9 Cloudflare config generator](docs/M9-CLOUDFLARE-CONFIG.md), [the M8 deployment preflight](docs/M8-DEPLOYMENT-PREFLIGHT.md), [the M7 browser OAuth setup runbook](docs/M7-BROWSER-LINK.md), [the updated vault/session deployment notes](docs/M6-WORKSPACE-SESSION.md), [client OAuth notes](docs/M5-CLIENT-OAUTH.md), [encrypted vault notes](docs/M4-OAUTH-VAULT.md), and [roadmap](docs/ROADMAP.md).

The outdated M3 development bearer gateway is not suitable for public deployment. The protected MCP, Setup and Auth production routes were activated deliberately by the operator; do not use ordinary `wrangler deploy` with the route-free generated config as that may disable them. Keep Setup behind Cloudflare Access. The read gate is live; the M23 write gate must be enabled only after the migration, approval UI and deny-by-default tests are verified.

## License

MPL-2.0, matching the source project license for reused Tasks functionality. See [LICENSE](LICENSE).
