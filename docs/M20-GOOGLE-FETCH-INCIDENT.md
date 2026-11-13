# M20 — Diagnostic checkpoint for live Google API subrequest failure

## Live facts (13 November 2026)

The protected MCP Worker is now at 100% on version
`58ceeda9-8a6b-45e2-9a65-0d8a1ed878d3` (M19, with Workspace reads enabled).
Its OAuth protected-resource metadata responds HTTP 200. Its unauthenticated
`/v1/capabilities` responds HTTP 401. ChatGPT correctly discovers the 24
remote read operations. Client authentication reaches the Google API layer,
but a real `tasks_list_tasklists` call returns
`{"error":"GOOGLE_NETWORK_UNAVAILABLE"}`.

The production Google vault has one previously confirmed `default`
connection with 23 scopes. The source of the downstream request failure is
not yet known. An expired/revoked Google token would ordinarily result in a
Google HTTP 401 (`GOOGLE_UNAUTHORIZED`), not an exception from `fetch()`.

## Root limitation

`GoogleJsonClient.json()` catches *all* errors thrown by Cloudflare's
outbound `fetch()` and maps them to one `GOOGLE_NETWORK_UNAVAILABLE` code.
Cloudflare Workers supports the currently used
`redirect: "manual"` and `cache: "no-store"` options, so treating either
as definitely broken without evidence would be unjustified.

## Change

- Categorize exceptions by safe types and narrow known compatibility
  signatures, retaining generic fallback for unrelated problems.
- Preserve `credentials: "omit"`, `redirect: "manual"`,
  `cache: "no-store"`, and a 15-second abort signal.
- Never expose exception.message, Google request URL, access token,
  Google data or stack trace to a client.
- Unit-test normalization on malformed request, Cloudflare compatibility,
  timeout and unknown failure cases.
- No cloud configuration, account grant, Worker binding, OAuth registration,
  remote write capability or read-gate flag change in this commit.

## Interpretation for the next test

- `GOOGLE_FETCH_CACHE_UNSUPPORTED`: runtime disabled/rejected cache option.
- `GOOGLE_FETCH_REDIRECT_UNSUPPORTED`: runtime rejected redirect mode.
- `GOOGLE_FETCH_CONTEXT_UNAVAILABLE`: I/O attempted outside request context.
- `GOOGLE_FETCH_TIMEOUT`: abort/timeout of request.
- `GOOGLE_FETCH_TYPE_ERROR`: other exception with TypeError name; inspect
  worker local runtime test or privacy-safe tail logs.
- `GOOGLE_NETWORK_UNAVAILABLE`: other failure (including possible network).
- `GOOGLE_UNAUTHORIZED`/`GOOGLE_FORBIDDEN`: actual Google HTTP response.

The type/category is a diagnostic only, not a waiver of the existing OAuth
or per-operation scope checks.

## Rollout

1. Require green CI including workerd tests and Worker bundles.
2. Pull and stage MCP Worker code with the already enabled Google read gate:
   `wrangler versions upload -c .wrangler-deploy.mcp.jsonc --var
   GMW_WORKSPACE_READS_ENABLED:true` and a nonsecret message.
3. Inspect all four secret *names*, D1, Auth service binding and the enabled
   read flag. Do **not** print credentials or query token ciphertext.
4. Promote with `wrangler versions deploy`, never route-replacing
   `wrangler deploy` against the generated route-free configs.
5. Retest one bounded Tasks read from the existing ChatGPT MCP connector.
6. Apply a targeted fix to the observed category, not a guessed change.
