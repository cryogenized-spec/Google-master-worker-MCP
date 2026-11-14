# M25 — ChatGPT OAuth read/write scope discovery correction

## What the real consent screen showed

On 14 November 2026, ChatGPT's verified client-domain consent screen for
Google Master Worker offered **only `mcp:read`**, although M24 demanded
`mcp:read` and `mcp:write` for *every* request.

This was a server integration mistake, not an account-MFA diagnosis.

## Protocol correction

The protected resource now requires only `mcp:read` to connect, list and
execute reads. It lists 191 registered operations without granting execution
permission for 90 writes.

Every read tool advertises:

```json
{"securitySchemes":[{"type":"oauth2","scopes":["mcp:read"]}]}
```

Every write tool advertises:

```json
{"securitySchemes":[{"type":"oauth2","scopes":["mcp:read","mcp:write"]}]}
```

The pinned `@modelcontextprotocol/server@2.4.0` SDK discards
`securitySchemes` supplied to `registerTool`, even with a TypeScript cast.
The protected HTTP response uses a bounded, exact-`tools/list` response
adapter to preserve the per-tool metadata on the wire. This is tested both
with the SDK and an actual local workerd MCP Worker.

A read-scoped client invoking a write receives an MCP tool error with
`_meta["mcp/www_authenticate"]`: an `insufficient_scope` bearer challenge
that identifies the resource metadata URL and the exact `mcp:read mcp:write`
grant. ChatGPT can present the one-time additional OAuth consent. Neither
the model nor a request parameter can grant itself additional scopes.

The REST adapter likewise accepts read-only clients for reads but returns a
403 `WWW-Authenticate` scope challenge for writes without `mcp:write`.

The Google Workspace vault, verified user identity, existing account scope
grants, operation schemas, fixed API origins and the direct-write execution
path remain unchanged. No M23 approval page is reintroduced.

## Deploy this hotfix only

```bash
cd ~/Google-master-worker-MCP
nvm use 26
git pull --ff-only
bash scripts/release-m25.sh stage
# Verify binding names/secret names and version details from Wrangler output
bash scripts/release-m25.sh promote
```

Only the protected `google-master-mcp` Worker is staged and deployed; Auth
and Setup retain their M24 production versions. Both Google read and write
flags stay enabled.

After deployment, existing `mcp:read` ChatGPT consent should permit reads.
When ChatGPT invokes a write tool, the OAuth client should ask once for
`mcp:write` as well. On later approved calls, the direct workflow remains:
prompt → tool call → execute → feedback, subject to host-level safety
confirmations. A repeated write may execute more than once; the backend
does not invent idempotency.

## Verification

Unit and workerd tests cover 191-tool metadata, both OAuth scope schemes,
scope challenge, read-only REST access, refusal of write operations with
read-only OAuth, and continuing availability of the direct mutation path.

If ChatGPT cannot open the browser after the corrected metadata and challenge
are verified, inspect ChatGPT-side connector registration and OAuth client
scope request, rather than granting write privilege to `mcp:read` or
silently expanding a token beyond what the owner approved.
