# M17 — Private Setup CSRF form submits under browser referrer policy

## Live symptom

The operator successfully reached `/setup` after Google Client A login,
then the ordinary browser POST to `/setup/google/connect` returned
`SETUP_CSRF_REJECTED` before starting Client B authorization.

The Setup Worker had a contradictory combination:
- `reply()` globally emitted `Referrer-Policy: no-referrer`.
- `csrfOkay()` required `Origin` to equal the exact HTTPS `SETUP_ORIGIN`
  for application/x-www-form-urlencoded POSTs.
- Under `no-referrer`, HTML form POST navigations may carry `Origin: null`,
  even when the form submits to the page's own origin.

The browser behavior is documented by MDN:
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy#effect_on_the_origin_header

## Fix

Only the authenticated HTML GET `/setup` form page sends
`Referrer-Policy: same-origin`. This allows the browser to preserve the
same-site Origin header during normal form submissions while suppressing
cross-site referrer disclosure. OAuth redirects and callbacks retain the
original `no-referrer` policy, avoiding unnecessary exposure of callback
paths in Referer headers.

`csrfOkay()` is **unchanged**. It continues to require:
1. an exact same-origin `Origin` header (not `null` or absent);
2. exact `application/x-www-form-urlencoded` Content-Type;
3. a valid verified owner session and matching submitted CSRF cookie/token.

Tests ensure only form pages use `same-origin`, callbacks remain
`no-referrer`, cross-origin/null origins fail closed, and a valid full
39-scope form can start the Client B OAuth flow.

## Rollout

Stage new Setup Worker code via `wrangler versions upload`, inspect the
six retained secrets and D1/rate limiter bindings, then promote the
version using `wrangler versions deploy`. Keep the already configured
Cloudflare Access All-traffic policy in place, Setup Preview disabled, and
Google Master Auth/MCP production routes disabled. Do not use ordinary
`wrangler deploy` with the stale route-free config; it may disable the
manually enabled Setup production URL.

After deployment, navigate freshly to `/setup`, confirm verified owner
status, and click the authorization button once. A *subsequent* Google
error about scope eligibility or Client B is separate from this CSRF issue.
