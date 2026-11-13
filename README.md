# Google Master Worker MCP

**Status (12 Nov 2026):** The three Google Master Workers are live on Cloudflare, OAuth discovery and client authentication work, and an owner-authorized 23-scope Google Workspace personal-account connection is encrypted in D1. **The live Google read gate is disabled pending a deliberate rollout; PR #20 introduces the broad 24-read-tool catalogue but is not live until separately deployed.**

A personal, TypeScript-first Google Workspace integration platform intended to serve ChatGPT via remote MCP, ELF//SHELL Ayarime and CiRYVA Android via reusable typed HTTPS interfaces. Modules are portable and centrally routed; client apps do not need to implement Google REST logic individually.

## Implemented

- **M22 comprehensive read catalogue:** 76 fixed GET endpoints plus one bounded Calendar freeBusy query extend M19's 24 operations to **101 typed, read-only remote MCP tools** across Tasks, Apps Script, Drive, Docs, Sheets, Slides, Calendar, Gmail, Contacts, Forms and Meet. Five selected typed write/external operations remain registered only in the core and are not remotely callable without independent action approval.
- Shared TypeScript operation registry, strict input/output schemas, per-account Google scope checks, bounded REST transport and redacted errors.
- Cloudflare Worker gateway development prototype plus a split, resource-scoped MCP OAuth authorization Worker and read-only protected MCP Worker.
- Google operator authentication by verified Google OIDC subject, per-client browser consent, protected OAuth tokens and separated Google Workspace authorization.
- Encrypted Google OAuth vault built on D1-compatible SQL and AES-256-GCM, with one-time authorization state and versioned token refresh.
- Protected MCP session provider that **can read** an independently authorized D1 vault **only when explicitly enabled** and invoked by an OAuth-verified client. It remains disconnected by default.
- An authenticated, strictly read-only `/v1/capabilities` and `/v1/operations/{name}` interface on the protected MCP Worker, sharing the existing OAuth resource audience, Google credential vault, and policy engine. Includes a portable Firefox TypeScript client and standalone Android transport reference; neither actual application is wired yet.
- Cloudflare `workers.dev` staging in active use: Auth and MCP production URLs enabled with OAuth protection, private Setup production URL behind Cloudflare Access; preview URLs disabled. Google API read gate stays disabled.
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

**Not yet completed:** first live end-to-end Google API read after deliberate activation of the encrypted vault session, independently auditable remote mutation approvals, exhaustive Google API operation coverage and actual Ayarime/CiRYVA OAuth/UI integration. Google account connection and live Cloudflare infrastructure are already established.

For the single-batch read catalogue and API acceptance boundaries, see [M22 comprehensive Google reads](docs/M22-COMPREHENSIVE-READS.md). For broad API expansion and rollout, see [M19 broad Workspace service catalogue](docs/M19-BROAD-WORKSPACE-API.md) and [M18 personal Gmail scope compatibility](docs/M18-CONSUMER-OAUTH.md). For exact earlier rollout and security requirements, see [M13 read-only account inventory](docs/M13-ACCOUNT-INVENTORY.md), [M12 optional workers.dev staging](docs/M12-WORKERS-DEV-STAGING.md), [M11 local Worker authentication checks](docs/M11-RUNTIME-ACCEPTANCE.md), [M10 first-party client integration](docs/M10-CLIENT-API.md), [the M9 Cloudflare config generator](docs/M9-CLOUDFLARE-CONFIG.md), [the M8 deployment preflight](docs/M8-DEPLOYMENT-PREFLIGHT.md), [the M7 browser OAuth setup runbook](docs/M7-BROWSER-LINK.md), [the updated vault/session deployment notes](docs/M6-WORKSPACE-SESSION.md), [client OAuth notes](docs/M5-CLIENT-OAUTH.md), [encrypted vault notes](docs/M4-OAUTH-VAULT.md), and [roadmap](docs/ROADMAP.md).

The outdated M3 development bearer gateway is not suitable for public deployment. The protected MCP, Setup and Auth production routes were activated deliberately by the operator; do not use ordinary `wrangler deploy` with the route-free generated config as that may disable them. Keep Setup behind Cloudflare Access, read gate off until operator approval.

## License

MPL-2.0, matching the source project license for reused Tasks functionality. See [LICENSE](LICENSE).
