# Google Master Worker MCP

**Status:** M11 Cloudflare-local authentication and routing acceptance in development (no live deployment). **No production Worker deployment, Google account connection or Google Workspace API access has been activated.**

A personal, TypeScript-first Google Workspace integration platform intended to serve ChatGPT via remote MCP, ELF//SHELL Ayarime and CiRYVA Android via reusable typed HTTPS interfaces. Modules are portable and centrally routed; client apps do not need to implement Google REST logic individually.

## Implemented

- **Eleven typed Google operations**: four Google Tasks tools and seven Apps Script project-lifecycle tools. The remote protected MCP deliberately publishes only the **seven read-only** operations. Write operations remain confined to the local development adapter with separate human approval.
- Shared TypeScript operation registry, strict input/output schemas, per-account Google scope checks, bounded REST transport and redacted errors.
- Cloudflare Worker gateway development prototype plus a split, resource-scoped MCP OAuth authorization Worker and read-only protected MCP Worker.
- Google operator authentication by verified Google OIDC subject, per-client browser consent, protected OAuth tokens and separated Google Workspace authorization.
- Encrypted Google OAuth vault built on D1-compatible SQL and AES-256-GCM, with one-time authorization state and versioned token refresh.
- Protected MCP session provider that **can read** an independently authorized D1 vault **only when explicitly enabled** and invoked by an OAuth-verified client. It remains disconnected by default.
- An authenticated, strictly read-only `/v1/capabilities` and `/v1/operations/{name}` interface on the protected MCP Worker, sharing the existing OAuth resource audience, Google credential vault, and policy engine. Includes a portable Firefox TypeScript client and standalone Android transport reference; neither actual application is wired yet.
- Safe CLI-generated, private Cloudflare binding configurations for an operator-owned domain, KV namespace, shared D1 database, two rate limiters and the default-entrypoint RPC binding; no public routes or secrets generated.
- Required OAuth and setup Worker rate-limit bindings, with early HTTP 429 rejection and safe denial on missing Cloudflare configuration. Cloudflare WAF remains a deployment prerequisite.
- M7 owner-only private browser setup Worker: Google OIDC login, CSRF-bound browser session, read-only Workspace OAuth consent, one-use cookie-bound callback, and provider revocation plus disconnect. No live routes or secrets are configured.
- Node 26 tests, GitHub Actions CI, Wrangler dry-run bundle checks and locally simulated Cloudflare Worker OAuth acceptance tests. No public Worker routes or production secrets are committed.

## Development

Use **Node.js 26** and the pinned compatible stable dependencies in `package.json`:

```sh
npm ci
npm test
npm run test:runtime
```

See `docs/DEPENDENCIES.md` for the dependency policy. The npm-generated `package-lock.json` is committed, and CI uses `npm ci` for reproducible builds.

## Current architecture and remaining work

The auth Worker issues scoped OAuth tokens to approved MCP clients. The protected MCP Worker validates them over an internal Service Binding, derives an opaque client identity, and exposes read-only Google operations. The Google token vault is a *second*, independent authorization boundary. Having an MCP token alone does not grant access to Google.

**Not yet completed:** real Cloudflare KV/D1/bindings/secrets, live Google OAuth and account-link acceptance, remote mutation approvals, full application coverage, actual Ayarime/CiRYVA OAuth login and UI wiring, and live end-to-end acceptance.

For exact rollout and security requirements, see [M11 local Worker authentication checks](docs/M11-RUNTIME-ACCEPTANCE.md), [M10 first-party client integration](docs/M10-CLIENT-API.md), [the M9 Cloudflare config generator](docs/M9-CLOUDFLARE-CONFIG.md), [the M8 deployment preflight](docs/M8-DEPLOYMENT-PREFLIGHT.md), [the M7 browser OAuth setup runbook](docs/M7-BROWSER-LINK.md), [the updated vault/session deployment notes](docs/M6-WORKSPACE-SESSION.md), [client OAuth notes](docs/M5-CLIENT-OAUTH.md), [encrypted vault notes](docs/M4-OAUTH-VAULT.md), and [roadmap](docs/ROADMAP.md).

The outdated M3 development bearer gateway is not suitable for public deployment. The protected MCP, setup and auth Workers have `workers_dev=false` with no live routes; do not expose them before authorization flow review and operator configuration.

## License

MPL-2.0, matching the source project license for reused Tasks functionality. See [LICENSE](LICENSE).
