# M21 — Cloudflare Google API fetch invocation context

## Live evidence

- Production MCP Worker M20 version `c7b9057e-17fb-4ded-99c2-dc67acd1231d` active at 100%.
- MCP OAuth and Google vault checks succeeded; all 24 read operations are
  discoverable from ChatGPT.
- Actual `tasks_list_tasklists(maxResults:3)` returns
  `GOOGLE_FETCH_CONTEXT_UNAVAILABLE` (M20's safe diagnostic category).

The error does *not* contain the original exception or a stack trace. M20
classifies both a request-context error and an `Illegal invocation`
error into that category, so we must distinguish these possibilities in
testing rather than pretending they are the same root cause.

## Specific source defect addressed

The reusable `GoogleJsonClient` class previously used:

```ts
constructor(..., private readonly request: typeof fetch = fetch) {}
// later:
response = await this.request(url.href, options);
```

In JavaScript, `this.request(...)` passes the `GoogleJsonClient`
instance as the receiver of the stored `fetch` function. The method
is intended to call a global Web API transport, not to invoke a
GoogleJsonClient method. Cloudflare explicitly documents
`TypeError: Illegal invocation` for incorrect `this` receivers on
runtime Web API functions.

M21 changes the default transport to a request-time arrow wrapper
`(input, init) => fetch(input, init)` and extracts a plain function for
invocation (`const request = this.request; await request(...)`).
This ensures global Worker `fetch` is resolved within the active handler
and never receives a GoogleJsonClient object as its receiver.

Tests assert a receiver-sensitive transport is invoked with
`this === undefined`, while verifying the existing OAuth header,
manual redirect refusal and no-store cache protections.

## Deployment

No Google account changes, OAuth reconnect, new scopes, admin
privileges or additional write surfaces are required.

1. Require green GitHub CI (Node unit + workerd runtime + Worker bundle).
2. Operator stages only the MCP Worker with current read gate enabled:
   `wrangler versions upload -c .wrangler-deploy.mcp.jsonc
    --var GMW_WORKSPACE_READS_ENABLED:true`
3. Inspect four secret names, D1, AUTH_SERVER, OAuth URLs and the gate.
4. Promote **that** uploaded version to 100% using
   `wrangler versions deploy` rather than `wrangler deploy` (route-free config).
5. Test `tasks_list_tasklists` via the already-connected ChatGPT plugin.
   If it still fails, the remaining error may be actual request-context
   loss inside the stateless MCP handler; instrument and fix it separately.

Sources:
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/
