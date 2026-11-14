# Codex independent fault-finding review — Google Master MCP

This pull request is an **audit request**, not a feature change. Please inspect the **entire `main` codebase**, not merely this documentation diff. Keep production code unchanged until findings are verified and explicitly prioritized.

Repository: `cryogenized-spec/Google-master-worker-MCP`. Current system: three Cloudflare Workers for OAuth issuer, protected MCP and Google account setup; independent encrypted D1 Google vault; 101 read tools and 90 directly executable write tools across eleven Google services; remote MCP plus HTTPS clients. The end-to-end task create/get/delete test passed on 14 November 2026.

## Areas where faults are most likely to matter

1. **Authentication and escalation** — OAuth authorization-code flow, PKCE, client registration, `mcp:read` → `mcp:write` consent upgrade, refresh tokens, issuer/audience and identity verification, resource metadata, client ID isolation and impersonation.
2. **Direct write safety** — prove every mutation genuinely requires the correct *client* write grant and *Google* provider scope across REST and MCP transports; verify no unapproved write path, permissive operation risk, request forgery, unintended sharing, accidental irreversible deletion or duplicate sends.
3. **Per-client token/vault boundaries** — D1 encryption, refresh concurrency, owner account linkage, Google subject checks, stale and revoked credentials, secret disclosure in logs, HTTP errors or tool outputs, replay/CSRF/OAuth state handling.
4. **Google API correctness** — audit all 90 write operation schemas, HTTP verbs, resource paths, URL encoding, required/optional fields, response parsers, consumer vs Workspace scopes and quotas. Flag endpoints whose success is only simulated in tests.
5. **Operational reliability** — token expiration and renewed authorization, Cloudflare Worker bindings and deployment scripts, MCP tool schema/metadata compatibility, 204 handling, pagination, quota/429/backoff, partial failures, timeouts, non-idempotent retry/data-loss risks and misleading success responses.
6. **MCP interface and portability** — ensure 191-tool discovery works after refresh, tool securitySchemes are valid, correct `mcp/www_authenticate` challenges, Android/TypeScript client parity, no local Git checkout dependency on runtime.
7. **Regression tests** — identify security-critical missing negative tests, real-workerd vs mock differences, hidden write routes, stale test descriptions, and any unsafe defaults.

## Expected review output

Prioritized findings **P0/P1/P2/P3**, each with exact file and line, a reproducible failure scenario and technical reason, user/data impact, whether it occurs in live production, and a proposed minimal fix with a regression test. Separate *confirmed defect* from *unverified risk*, and report no issues for areas genuinely checked.

**Read-only review:** Do not make Google writes, transmit real messages, change Cloudflare configuration, rotate or expose credentials, commit code, or merge this PR. Do not publish secrets. If more tests are needed, prescribe them with synthetic fixtures. Return the findings on the PR conversation or via the connected Codex review system.
