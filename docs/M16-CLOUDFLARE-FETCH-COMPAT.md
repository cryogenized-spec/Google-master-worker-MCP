# M16 — Cloudflare Workers Google fetch redirect compatibility

## Incident

The live Google Master operator setup page returned
`SETUP_LOGIN_STATE_EXPIRED` on a repeated/old callback and then
`IDENTITY_PROVIDER_UNAVAILABLE` after a fresh Google consent. The D1
`google_owner_login_pending` table contained zero pending rows after
the latter attempt, consistent with the once-only state being consumed.

The upstream token and UserInfo requests used `redirect: "error"`,
which the Cloudflare Workers runtime does **not implement**.
Cloudflare throws a `TypeError` as the Request is constructed before
the network request is sent. The server intentionally catches fetch
errors and returns a generic `IDENTITY_PROVIDER_UNAVAILABLE` code.

Cloudflare documentation:
https://developers.cloudflare.com/workers/runtime-apis/request/

## Correction

Worker-side Google fetch calls in these four packages now use
`redirect: "manual"`:

- `packages/client-oauth/src/google-identity.ts`
- `packages/google-auth/src/index.ts`
- `packages/google-auth/src/identity.ts`
- `packages/google-http/src/index.ts`

Each caller already rejects non-2xx responses, including all 3xx
redirects. No Google credentials are forwarded to redirected URLs;
there is no automatic redirect following. Tests assert `manual` and
verify both token and UserInfo redirects fail without a second request.

The browser-focused `packages/client-sdk` retains `redirect:"error"`
as browser fetch supports it, and its fail-closed behavior is deliberate.

## Activation

1. Run `npm test`, `npm run test:runtime`, and Cloudflare Worker dry runs.
2. Verify the currently deployed Setup Worker retains the intended
   Cloudflare Access **All traffic** policy, private D1, rate limiter,
   and six existing secrets. Verify Google reads remain disabled on MCP.
3. Upload only revised Worker code as an inactive version, inspect its
   bindings/secrets, then explicitly promote it. **Do not run an ordinary
   deploy** using the local route-free configuration without reviewing
   effects on the manually enabled Access-protected Setup production URL.
4. Retest a brand-new `/setup` login in Firefox rather than refreshing
   a consumed `/google/callback` URL. Do not copy callback URLs with
   OAuth code/state into tickets or chat.
5. A later `IDENTITY_LOGIN_DENIED` is a separate Google token rejection
   (credential mismatch, bad authorization code or registration); do not
   assume this patch resolves every possible login problem.
