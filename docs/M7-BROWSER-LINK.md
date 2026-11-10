# M7 — Browser-based Google Workspace account linking

**Status: implemented and tested with synthetic identity responses. No Cloudflare deployment, real credentials, or Google account connection.**

## Architecture

The new private **Workspace Setup Worker** provides a browser-only management interface. Google operator sign-in and Google Workspace authorization are two separate consent flows, each requiring an HTTPS redirect from Google.

- `GET /setup/login` starts Google OIDC sign-in with PKCE S256 and a one-time, cookie-bound state.
- `GET /google/callback` consumes the login state and calls Google UserInfo to verify the configured, stable numeric operator subject (`sub`); it mints a one-hour, opaque `Secure; HttpOnly; SameSite=Lax` owner session.
- `GET /setup` renders a script-free owner-only page showing whether the vault is connected, with selectable **read-only** Google Tasks and Apps Script scope options. The page carries a session-bound anti-CSRF token, but no Google token.
- `POST /setup/google/connect` checks the owner session, CSRF form token and exact same-origin `Origin` header, then starts the Workspace OAuth flow using `GoogleOAuthBroker.begin`. It additionally binds the Workspace OAuth state to the current owner session using an expiring D1 record and a browser cookie.
- `GET /oauth/google/callback` requires both the owner session and matching one-use Workspace state cookie/D1 record, then invokes `GoogleOAuthBroker.complete`: OAuth code exchange with PKCE, read-only scope verification, Google OIDC subject verification, encryption of access/refresh tokens, and D1 insert. After success it redirects to a clean `/setup` URL without the authorization code.
- `POST /setup/disconnect` requires owner session and CSRF approval, **revokes the stored refresh token at Google's revoke endpoint first**, then removes only that vault version. A provider failure retains the encrypted record and reports the operation as failed.
- `POST /setup/logout` destroys the owner browser session; Workspace credentials are left in the vault until independently revoked/disconnected.

The separate MCP authorization Worker still validates every client. **The Setup Worker never issues MCP tokens**. The protected MCP service still requires an independently verified OAuth client, a separately linked Google account and the explicit `GMW_WORKSPACE_READS_ENABLED=true` operator flag. All public MCP write operations are excluded.

## Security and limits

Owner sessions and both Google OAuth state records are stored by SHA-256 hash only; PKCE verifier and Google credentials are AES-256-GCM encrypted. OAuth callback state is single-use and browser-bound. The sign-in state expires after 10 minutes, the owner session after one hour, and Workspace state after 10 minutes. Headers disallow browser framing, caching and cross-origin referrers. The HTML contains no JavaScript or external assets.

The Workspace Setup Worker **has no live route, secrets or database bindings in source control** and `workers_dev=false`. The included `wrangler.setup.jsonc` supports **dry-run** packaging only until host-specific bindings are configured.

Before enabling for a real account, address outstanding production requirements: per-IP OAuth/login rate limiting, deployment hostnames, Cloudflare KV and D1 bindings, migration review, secret/key backups, operational audit logging and incident response. OAuth refresh token rotation concurrency and provider account-policy considerations should be reviewed during live acceptance. The current service remains single-operator, not a public multi-user platform.

## Cloudflare and Bash setup tonight

Use your local Linux Mint terminal and a **current Node.js 26 runtime**, but complete both Google OAuth consent flows in the browser. Do not exchange tokens by copying authorization codes into Bash or paste secrets into ChatGPT.

1. Open the repository and authenticate **Wrangler** interactively with Cloudflare:
   ```bash
   git clone https://github.com/cryogenized-spec/Google-master-worker-MCP.git
   cd Google-master-worker-MCP
   npm install
   npm test
   npx wrangler login
   npx wrangler whoami
   ```
2. Choose the **three distinct HTTPS hosts** for authorization, protected MCP and private setup. Their actual hostnames must be registered under a zone you control. The Setup Worker `SETUP_ORIGIN` must equal its exact HTTPS origin (without trailing slash).
3. Create the Cloudflare authorization KV namespace and D1 database using Wrangler. Bind `OAUTH_KV` to the auth Worker and `DB` to both the setup Worker and protected MCP Worker. This requires editing the three Wrangler configs with real resource IDs, not committing IDs that belong to a different user's account:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler d1 create google-master-vault
   ```
   Review the target database before applying `migrations/0001_google_oauth_vault.sql` and `migrations/0002_owner_browser_sessions.sql` using the Cloudflare D1 migration workflow. Do **not** run remote migrations against an unrelated existing D1 database.
4. Register **two separate Google Cloud Web application OAuth clients**, one for human operator sign-in, one for the Workspace API vault, using these exact authorized HTTPS callback paths on the Setup Worker:
   ```
   https://YOUR-SETUP-HOST/google/callback
   https://YOUR-SETUP-HOST/oauth/google/callback
   ```
   The auth Worker's **own** human sign-in is a third callback path `https://YOUR-AUTH-HOST/google/callback`. This may use the same operator login OAuth client if Google is configured with both exact authorized redirect URIs, but its client secret must remain server-side. Set the same verified Google subject on both Workers. No client secret belongs in Firefox or Android.
5. Configure the auth Worker's `AUTH_ISSUER`, `MCP_RESOURCE_URL`, `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`, and `GMW_ALLOWED_GOOGLE_SUB`; configure the protected MCP Worker's internal `AUTH_SERVER` Service Binding and D1, together with Workspace OAuth client configuration and the vault encryption secret. Configure the Setup Worker with `SETUP_ORIGIN`, `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`, `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_REDIRECT_URI`, `GMW_ALLOWED_GOOGLE_SUB`, and **the same** securely supplied `GMW_TOKEN_ENC_KEY` used by protected MCP.
6. Enter all secrets via **interactive** `npx wrangler secret put SECRET_NAME -c wrangler.setup.jsonc` (and corresponding config for other Workers); never check real values into Git or leave them in terminal history. Use a cryptographically random 32-byte base64url key. Store a private backup of the key; losing it requires reconnecting Google.
7. Review Worker routing and rate limiting, deploy privately and perform Google login/consent in the browser. The connected MCP endpoint should still be read-only; only enable `GMW_WORKSPACE_READS_ENABLED=true` after confirming the user and Google grant are correct.

**No real Cloudflare actions have been authorized or executed by this PR.** In particular, a successful Wrangler dry-run does not mean the service is deployed or a D1 database has been created.

## Verification and references

`npm test` exercises synthetic Google login → session cookie → CSRF form → Workspace OAuth → encrypted vault connection → provider revocation and disconnect, along with negative tests for expired/replayed state, wrong OAuth subject, wrong Origin, unauthorized session and failed revocation. CI also runs `wrangler deploy --dry-run` for **all four** Workers.

- Google OAuth web server: https://developers.google.com/identity/protocols/oauth2/web-server
- Cloudflare D1: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- Cloudflare Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
