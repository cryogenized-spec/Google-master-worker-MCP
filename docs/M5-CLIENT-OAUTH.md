# M5a — OAuth 2.1 client authorization (private preview)

**No deployment and no live Google Workspace access.** Both Workers remain disabled until their runtime bindings, Google operator sign-in credentials, and private domains are explicitly provisioned.

## Split Workers, current Cloudflare library

We use the **current stable `@cloudflare/workers-oauth-provider` v1.2.4** split design, not deprecated MCP OAuth wrappers.

- `apps/auth-server` is the OAuth authorization server. It presents a per-client, non-frameable consent page with the client's name, verified/self-reported domain, exact redirect hostname and requested scopes. Its **Google OIDC sign-in** runs *after* consent through `beginUpstream`/`finishUpstream` and PKCE. It never accepts a hardcoded user. A successful Google userinfo lookup must have `email_verified=true` and a stable Google subject (`sub`) equal to the operator's securely configured allowlisted subject.
- `apps/protected-mcp` is the MCP resource server. It accepts **only access tokens validated for its own exact resource URL** by the authorization Worker's internal Service Binding, checks `mcp:read` and operator identity, and exposes only seven read-only Tasks and Apps Script tool definitions. It does not accept the static M3 development bearer token or Google OAuth access tokens as MCP client credentials.
- Google **operator sign-in** is separate from Google **Workspace API permissions**. The M4 encrypted credential vault has not yet been connected to a verified operator session. All real Google operations return `GOOGLE_SESSION_NOT_CONFIGURED`, and all mutations are absent from MCP discovery.
- The original development Worker in `apps/worker` is unchanged; it should remain offline after production authentication becomes available. Do not put `GMW_DEV_BEARER_TOKEN` on public Internet endpoints.

The authorization Worker uses Cloudflare's standard authorization endpoints, OAuth discovery, token rotation/revocation and Client ID Metadata Documents (CIMD). Optional DCR supports legacy clients. Every client, including ChatGPT, needs an explicit operator consent. CIMD outbound fetches require `global_fetch_strictly_public`; the configuration includes this flag. No browser consent is bypassed.

## Required deployment preparation — not executed

1. Choose real HTTPS issuer and MCP resource hostnames, register them with Cloudflare, and keep both `workers_dev=false`.
2. Provision a **private KV namespace** for `OAUTH_KV` on the auth Worker. Use its actual ID in `wrangler.auth.jsonc`; it intentionally ships with no KV binding so it fails closed until configured.
3. Register a Google Cloud Web OAuth client **only for human operator sign-in**. Its authorized redirect URI must be `https://<auth-host>/google/callback` (exact). Grant only OpenID `openid email` for sign-in. Supply the client ID and secret to the auth Worker via Wrangler secrets, never GitHub.
4. Configure `AUTH_ISSUER` (HTTPS origin), `MCP_RESOURCE_URL` (exact HTTPS `/mcp` URL), and `GMW_ALLOWED_GOOGLE_SUB` (the stable numeric Google subject of the permitted operator, **not** an email address). These are mandatory; missing any field fails closed.
5. Add the internal `AUTH_SERVER` Service Binding from MCP Worker to the auth Worker's exported `AuthServer` entrypoint. Never make `validateToken` a publicly reachable URL.
6. Deploy the authorization Worker first, then the resource Worker, *only after* source review, consent tests and configuration validation. Do not enable auto-deploy in this PR.

The checked-in `wrangler.auth.jsonc` and `wrangler.protected-mcp.jsonc` deliberately have no public routes, KV binding, or Service Binding. CI uses `wrangler deploy --dry-run`; this is **packaging validation**, not credentialed deployment.

## Threat boundaries

- An MCP client cannot invent a user, choose a Google account, or send an OAuth scope as a tool argument.
- Google sub comparison, userinfo access and PKCE are verified server-side; the user must explicitly grant the MCP client access on a browser-bound consent page **before** upstream sign-in.
- On valid authorization, the protected Worker still cannot read Google data without a distinct M4 vault link. This avoids accidental token confusion between the client-facing OAuth and Workspace API OAuth.
- No arbitrary Google REST proxy, write tool, approval issuer or client-provided credential route is exposed.
- Native CiRYVA and Firefox typed HTTPS API integration will require separate client-session work; this PR only establishes authenticated remote MCP protocol and consent boundaries.

## References

- Cloudflare split OAuth 1.x: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Current provider: https://www.npmjs.com/package/@cloudflare/workers-oauth-provider
- Upstream sign-in: https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md
- Consent helpers: https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md
- Resource servers: https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md
