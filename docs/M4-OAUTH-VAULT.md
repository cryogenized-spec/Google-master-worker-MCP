# M4a — Private Google OAuth broker and encrypted D1 vault

**Status: implementation and synthetic SQLite tests only. No Google account has been connected. There is no public Google sign-in, callback route, or production MCP client authorization yet.**

This module is designed for the eventual Cloudflare Worker gateway without coupling it to a particular HTTP or MCP transport.

## Implemented

- Google OAuth 2.0 web-server authorization request, with PKCE S256, cryptographically random state and verifier, 10-minute single-use state and offline consent.
- Separate application identity (trusted principal account/client IDs) from Google scopes. Only the explicitly allowlisted Tasks and Apps Script scopes are currently permitted.
- One-time OAuth state consumption via an atomic D1-compatible DELETE ... RETURNING statement. Only the state **hash** is stored; the PKCE verifier is encrypted.
- Web Crypto AES-256-GCM sealed token envelopes, randomized IV and authenticated associated data binding the ciphertext to the exact account. A 32-byte key is supplied as a secret, not embedded in source or D1.
- Credential insert that refuses to replace a previously connected account alias; token refresh with compare-and-set version updates; local disconnect (clears credentials).
- The module deliberately returns no access/refresh token to HTTP clients, logs, or MCP tool results. Its internal SessionStore method returns short-lived tokens **only to server-side code** after the caller establishes a trusted client identity.
- SQLite-backed tests using Node 26 built-in sqlite, with the exact D1 SQL migration: expiry, single-use, scopes, AES tamper detection, refresh, version conflict and disconnect.

## Not wired into the Worker yet

There is **no /oauth/google/start or /oauth/google/callback route** on the deployed API. Do not bolt the broker into the existing static development bearer-auth gateway: this would make a development token capable of triggering real Google account access. A production-quality client-to-gateway OAuth authorization server is a separate trust boundary.

Before wiring this to a remotely reachable Worker, deliver:
1. OAuth 2.1/MCP client identity and authorization via the **current v1 Workers OAuth Provider split API** or equivalent verified system; consent page must show client identity and requested permissions.
2. An authenticated, user-initiated start action and a narrowly constrained Google redirect callback with one-use state, browser flow binding, rejection of account linking/replacement, and verified Google subject/account identity.
3. D1 provisioning, migrations, key management, key rotation/recovery strategy, token revocation at Google, disconnect, and the host-only write-approval path.
4. Source review and private deployment validation under an actual Cloudflare Worker binding. No site-wide static bearer token for browser/mobile clients.

## Future environment secrets / provisioning (nothing is created)

- GOOGLE_OAUTH_CLIENT_ID (Google Cloud **Web application** OAuth client).
- GOOGLE_OAUTH_CLIENT_SECRET (confidential server-side OAuth client secret).
- GOOGLE_OAUTH_REDIRECT_URI (exact HTTPS https://your-worker-host/oauth/google/callback registered at Google).
- GMW_TOKEN_ENC_KEY (cryptographically random **32-byte base64url** AES-GCM key; never store in Git, Android APK or Firefox extension).
- D1 binding named DB to an existing private D1 database, with migrations/0001_google_oauth_vault.sql applied.

No real IDs or secrets are included in this repository. The current wrangler.jsonc intentionally contains no DB binding or public route. Tests use in-memory SQLite and fake provider tokens. **Do not run Wrangler D1 remote commands or deploy this branch without authorization.**

Note: A lost encryption key means existing encrypted Google tokens cannot be recovered; existing connections must be reauthorized. Implement versioned key rotation before production.

## Security decisions and deferred work

- OAuth token exchange uses only https://oauth2.googleapis.com/token, POST URL form, bounded response, no redirect following, and redacted provider errors.
- A refresh token is required on first authorization. Google may not issue a refresh token on later reauthorization; this prototype instead refuses to overwrite an existing alias. Support scope expansion only after verifying a stable Google OIDC subject.
- This module **does not yet verify an OIDC Google subject** and therefore must not be connected to user-facing callback routes. Google account matching and consent are a prerequisite to live authorization.
- A local disconnect deletes the vault entry but is **not** a Google token revocation. Actual revocation and error handling are a separate integration milestone.
- Concurrent refresh handling uses a version CAS; an outdated refresh writer cannot overwrite a newer token, but Google token rotation and crash recovery warrant further testing.
- No broad Drive/Gmail scopes are introduced automatically. Personal-use does not imply unrestricted OAuth eligibility.

## References

- Google OAuth for server applications: https://developers.google.com/identity/protocols/oauth2/web-server
- Cloudflare D1 SQL/prepared statements: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- Cloudflare D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- Cloudflare Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare MCP authorization v1: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
