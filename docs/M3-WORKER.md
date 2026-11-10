# M3 — Cloudflare gateway skeleton (private development only)

**Status:** authenticated *development* transport and typed routes. **Not** a production OAuth provider, not deployed, and not currently usable from ChatGPT or CiRYVA.

The core now has one shared registry for Tasks and Apps Script, available through:

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Public, static development health, no secrets or personal data |
| `GET /v1/capabilities` | Authenticated list of 11 operations and risk categories |
| `POST /v1/operations/{name}` | Authenticated typed operation invocation; Google calls fail closed without real OAuth |
| `/mcp` | Authenticated remote MCP Streamable HTTP using the current SDK v2 stateless handler |

No app-specific modules are embedded in the HTTP transport. The gateway uses exactly the same operation registry, input/output schemas, Google REST adapters and approval policy as local MCP.

## Deliberate safeguards

The only authentication presently implemented is a **local-development static bearer gate** that requires BOTH nonempty Worker secrets `GMW_DEV_AUTH_ENABLED=true` and a strong `GMW_DEV_BEARER_TOKEN` of at least 32 characters. **Do not deploy with this gate open on the public Internet.** It is an interim development protocol fixture, not a secure OAuth flow for remote ChatGPT or browser and Android clients. It is not a substitute for Cloudflare Access or OAuth 2.1.

A real remote account/session broker is **not** implemented. By default, the Worker returns `GOOGLE_SESSION_NOT_CONFIGURED` for every Google operation; Google credentials are not read from environment variables. Mutations still require out-of-band, one-use approvals, and the remote Worker has no approval issuer or gate, so **all writes fail closed**. No user-provided headers, payloads or tool fields can set a privileged principal/account.

Browser requests with nonmatching `Origin` are denied, and no CORS permissions are granted. The current proof is for controlled CLI/Node development only. Subsequent browser integration requires a real authenticated browser session and explicit origin policy. Request bodies are capped. Errors, tokens and provider contents aren't logged.

`wrangler.jsonc` intentionally sets `workers_dev=false`, so accidentally deploying does not produce a public `workers.dev` endpoint. Production routes, secrets, D1 bindings, Google OAuth client credentials, revocation and encrypted durable token storage have not been configured.

## Local development only

Requires Node 26 and current stable dependencies; see `docs/DEPENDENCIES.md`.

```sh
npm install
npm test
npm run dev:worker
```

The gateway starts locked. To test authenticated operations, set a sufficiently long random bearer secret in your local `.dev.vars` file (ignored by Git) rather than in source or shell history:

```text
GMW_DEV_AUTH_ENABLED=true
GMW_DEV_BEARER_TOKEN=<locally-generated-random-token-32-plus-characters>
```

For basic testing, send a bearer header to `/v1/capabilities` and expect 11 operations. The MCP endpoint requires a real Streamable HTTP client, not a browser address bar. All actual Google access still returns `GOOGLE_SESSION_NOT_CONFIGURED`; the test suite injects **synthetic** Sessions and Google responses.

## Next milestones, not done

1. MCP OAuth 2.1 client authorization plus a separate Google OAuth authorization code flow (PKCE), with least-privilege scopes, disconnect/revoke and secure account selection.
2. D1 schema for account/consent/approval state and properly encrypted Google refresh tokens, with rotation and concurrency safeguards.
3. A trusted one-use remote approval UI, separate from model tool parameters, tied to operation, user, target and content.
4. Worker deployment preview with explicit authorization and source-reviewed route settings. Never turn on global `workers.dev` for a token-gated developer prototype.
5. Integration with ChatGPT, Ayarime and Android only once the remote auth model is complete.

## Protocol design

The current MCP handler uses `createMcpHandler` from the current stable `@modelcontextprotocol/server` SDK v2. This avoids deprecated `McpAgent`, `WorkerTransport` and MCP SDK v1. A fresh authenticated server is created per MCP HTTP request; all application logic stays in shared services. Browser/local reads not requiring orchestration can continue to use direct Google UI, avoiding unnecessary Worker round trips.

The CI workflow additionally runs `npx wrangler deploy --dry-run --outdir dist-worker` without Cloudflare credentials to validate that Wrangler can bundle the Worker. This does **not** deploy, create an endpoint or verify a live Google account.
