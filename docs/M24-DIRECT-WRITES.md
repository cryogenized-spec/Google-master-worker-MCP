# M24 — Direct Google writes from authorized MCP clients

**Operator decision:** eliminate the per-mutation private-browser approval step.

## Requested workflow

1. Prompt
2. Understand intended operation and validated target
3. Make the named Google Master MCP tool call
4. Execute the Google API operation immediately
5. Return the Google result, or a redacted error

No `write_prepare_action`, approval ID, owner setup link, approval D1 table
access, second tool invocation or per-action expiry is involved.

## One-time permissions (not per-action approval)

- The private OAuth issuer now advertises `mcp:write` in addition to
  `mcp:read` and `offline_access`.
- When `GMW_WRITES_ENABLED=true`, the protected MCP resource requires BOTH
  `mcp:read` and `mcp:write` **at the client OAuth boundary**. Old read-only
  client access tokens must be reauthorized once; a read token does not
  silently become a write token.
- The owner identity and resource/audience are verified over the existing
  `AUTH_SERVER` service binding; Google grant and encrypted vault remain
  independent.
- Each operation still requires an actual granted Google OAuth scope,
  Zod-validated input, fixed destination, bounded response, and the
  server-side `GMW_WRITES_ENABLED=true` opt-in flag.
- A client granted `mcp:write` can execute the entire write catalogue
  allowed by the connected Google account's scopes; this is intentionally
  more powerful than a per-action approval grant. Treat authorized client
  tokens accordingly.
- Cloudflare, ChatGPT and other clients may independently enforce connection
  permission or host-side action confirmation; the backend does not and
  cannot suppress those platform controls.

## Code removals

- Removed `write_prepare_action` from the remote operation registry.
- Removed the D1 approval gate and approval package from runtime.
- Removed private owner /setup proposal review and approval submission route.
- Changed TS SDK and Android client to call an exact named mutation directly
  (`callWrite`) instead of prepare + execute.
- Retained the generic optional `ApprovalGate` interface for older LOCAL
  development tests and applications; remote Google Master no longer uses it.
- The historic D1 `google_write_approvals` table and its migration remain
  in the database as inactive historical metadata. They are no longer
  consulted or written. No destructive table drop is performed.
- The expired pending M23 proposal cannot be executed through M24.

## Release

```bash
cd ~/Google-master-worker-MCP
nvm use 26
git pull --ff-only
bash scripts/release-m24.sh stage
# Review the Auth, Setup, MCP staged versions and their existing bindings
bash scripts/release-m24.sh promote
```

All checks run before staging and before promotion. The script uploads the
Auth OAuth issuer, Setup Worker without approval UI, and protected MCP Worker
as a coordinated three-Worker release without modifying routes. It promotes
Auth, Setup and MCP in that order and explicitly preserves:
`GMW_WORKSPACE_READS_ENABLED=true`, `GMW_WRITES_ENABLED=true`.

**After promotion:** reconnect/reauthorize the Google Master MCP plugin once
in ChatGPT so the client receives the new `mcp:write` permission. The
23 personal Google OAuth grants do not need to be requested again.

## Acceptance criteria

- 191 named operations: 101 read, 90 write. No proposal tool.
- Workerd rejects old mcp:read-only tokens with a 403 scope challenge that
  includes `mcp:write`.
- Workerd accepts a write-granted client token for catalogue discovery,
  but denies Google access when the separate encrypted Google connection
  is unavailable.
- Synthetic direct-write tests cover all 11 services, no approval store, no
  second call, strict validation, scope checks and HTTP 204 success.
- Live read verification remains healthy after deployment.
- First live write uses a harmless disposable resource and reports returned
  Google ID and read-back result. No production email, sharing or deletion
  is required for acceptance.

## Important behavior

Direct writes are no longer *one-use*. If the client deliberately calls the
same create/send action twice, Google may perform it twice. The backend
does not automatically retry non-idempotent writes or invent confirmations.
Use precise targets and check result IDs before repeating operations.

The M23 runbook is historic and superseded by this document; do **not** use
`release-m23.sh` again to deploy M24.
