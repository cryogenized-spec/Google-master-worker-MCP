# M6 — Protected MCP ↔ encrypted Google Workspace vault

**Status:** a server-only session integration, tested with synthetic Google accounts. No Google account linked, D1 database created or Cloudflare Worker deployed.

## What changed

The protected MCP resource no longer uses an always-disconnected placeholder. After validating the MCP client's audience, scope and identity through the authorization Worker's internal Service Binding, it can obtain an independently authorized Workspace access token from the M4 encrypted D1 vault.

Access is subject to **two separate grants**: the client must possess the OAuth resource token for `/mcp` with `mcp:read`, and the operator must have separately authorized the same Google subject to the Workspace vault. An additional server-side `GMW_WORKSPACE_READS_ENABLED=true` flag must be explicitly set. Missing or differently spelled flags leave every Google API operation disconnected.

The private session adapter uses a stable SHA-256-derived identifier for the validated OAuth client, including URL-based Client ID Metadata Document clients. No token, client-supplied account alias or personal Google email is allowed in tool input.

The public tool catalogue is **still read-only**: the existing seven Tasks and Apps Script read tools. Creating scripts, updating source, sending mail, creating Tasks and other writes are not exposed. The authorization Worker is still separate from the Google token broker.

## Required configuration — intentionally NOT provisioned

The protected MCP Worker will require:

| Binding / secret | Purpose |
| --- | --- |
| `AUTH_SERVER` Service Binding | Validates OAuth tokens against the auth Worker; use an internal Worker binding, never a public validator |
| `AUTH_ISSUER` | Exact HTTPS issuer origin of the auth Worker |
| `MCP_RESOURCE_URL` | Exact HTTPS MCP resource URL ending in `/mcp` |
| `DB` D1 binding | Database created by the operator; contains encrypted credential records and one-time OAuth state |
| `GOOGLE_WORKSPACE_CLIENT_ID` | Web OAuth client ID for Workspace access |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | Server-only secret |
| `GOOGLE_WORKSPACE_REDIRECT_URI` | Exact registered HTTPS `/oauth/google/callback` URI |
| `GMW_TOKEN_ENC_KEY` | Random 32-byte base64url AES-GCM key, stored as a Wrangler secret |
| `GMW_ALLOWED_GOOGLE_SUB` | The verified stable Google OIDC subject for the sole operator |
| `GMW_WORKSPACE_READS_ENABLED` | Server-side opt-in flag; must be exactly `true` |

**Do not place real values in git or Android/Firefox builds.** No binding IDs, hostnames or credential values are included in the checked-in configuration. The existing `wrangler.protected-mcp.jsonc` still has `workers_dev=false`, no routes, no D1 binding and no service binding, and will remain unavailable until operator-controlled provisioning.

Provisioning steps once the user chooses real Cloudflare hostnames and Google Cloud project:

1. Create a Cloudflare KV namespace for the authorization Worker (`OAUTH_KV`) and a separate Cloudflare D1 database for the Workspace vault (`DB`).
2. Enter their actual binding IDs and the `AUTH_SERVER` Service Binding into **private deployment configuration**, not test mocks. See Cloudflare's [Worker bindings](https://developers.cloudflare.com/workers/wrangler/configuration/) and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
3. Apply the reviewed `migrations/0001_google_oauth_vault.sql` to the intended D1 database. Review the target before using `wrangler d1 migrations apply <DATABASE> --remote`; this action changes a real Cloudflare database.
4. Create distinct Google Cloud Web OAuth registrations for human operator login (`/google/callback` on auth Worker) and Workspace API authorization (`/oauth/google/callback` on protected Worker). Use only minimum approved scopes; begin with Google Tasks readonly.
5. Generate the random vault key locally, store all credentials as Cloudflare secrets, and protect backups. Losing the vault key means refresh tokens cannot be recovered.
6. **Not implemented in this milestone:** a browser-session-bound `/oauth/google/start` and `/oauth/google/callback` user flow to populate the D1 vault, live end-to-end consent test, provider token revocation and key rotation. Do not try to link by inserting raw tokens into D1 or using the M3 development bearer route.
7. After those protections exist, conduct live private acceptance with a disposable Google test resource, verify that the connected account matches `GMW_ALLOWED_GOOGLE_SUB`, and explicitly opt in to reads. Enabling the flag before a real authorized connection exists still returns no Google session.

The API credential provider is separate from the MCP client identity issuer. A client token issued for the resource can never be used as a Google API credential. Google refresh tokens are stored only as AES-GCM ciphertext tied to the account alias, and never emitted by MCP tools. Retries and errors are bounded by the existing Google HTTP client and broker.

## Verification

Node 26 tests exercise a synthetic Google authorization → stable-subject verification → encrypted D1 vault insert → session retrieval → bounded Tasks read. They also prove that no Google request occurs when the opt-in flag is disabled, missing bindings fail closed, client identities are derived rather than guessed, and no Google token is returned in tool results. The CI workflow additionally typechecks the Worker and runs Wrangler bundle dry-runs for all three Workers.

**This is NOT a declaration of production readiness or a deployment approval.** The account-link browser flow and real Cloudflare bindings are still outstanding.
