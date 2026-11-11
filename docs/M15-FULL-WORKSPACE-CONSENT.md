# M15 — One-session Google Workspace OAuth scope bundle

## Scope
The operator requested the broad Workspace OAuth scope registration to be used
in one explicit browser authorization rather than repeated, per-service Google
consent setup.

The source-of-truth registry is `packages/google-auth/src/scopes.ts`.
Both the encrypted D1 OAuth broker and operator setup form consume it. The
setup page now offers one visible authorization action, shows the entire
scope list inside an expandable review, and submits the exact scope bundle
to Google's normal consent page. Login remains a separate `openid email`
Google OAuth flow through Client A. Workspace authorization uses Client B.

The broker validates all requested scopes against this registry, rejects
duplicates/unsupported scopes, rejects missing returned Workspace scopes,
and refuses unexpected provider grants. It continues to require an offline
refresh token and to verify the Google account's stable `sub` through
Google UserInfo before writing encrypted credentials to D1.

## Crucial limits

- **Registered scopes are not functioning API tools.** The protected remote
  MCP/REST Worker still exposes only the existing seven read-only Tasks and
  Apps Script operations. Google write/delete/share calls remain unavailable
  until separately implemented, gated and tested.
- **Account eligibility matters.** Admin Directory, Google Vault,
  Groups Settings, parts of Classroom/Keep/Chat and other services can
  require an eligible Google Workspace subscription, administrator privileges,
  app verification, or organization configuration. A personal Gmail user
  may be unable to grant the entire bundle; if Google rejects a scope the
  full authorization will not succeed. Do not weaken validation to work
  around a denied grant.
- **Restricted scopes and review.** Broad Gmail and Drive scopes can
  trigger Google OAuth verification/security assessment obligations,
  particularly when handling data server-side.
- **Google External + Testing refresh tokens expire after seven days** when
  Workspace scopes are included. This is a Google platform behavior, not a
  Cloudflare deployment bug or a guarantee of permanent one-time consent.
  Review the applicable verification/publishing conditions before production.
- **Private until explicitly activated.** The generated Worker configs keep
  `workers_dev=false`, `preview_urls=false`, no routes, and
  `GMW_WORKSPACE_READS_ENABLED=false`. This milestone does not change them.
  Client A and Client B secret versions are not rewritten by repository commits.
- **Google scopes can be normalized.** Never silently record more grants
  than requested. Live end-to-end testing is still required.

## Validation and launch sequence

1. Run `npm ci && npm test && npm run test:runtime`, plus Wrangler
   dry-run builds using the generated local private configs.
2. Confirm the Cloudflare account, KV/D1 bindings, version/secret inventory,
   migrations, login subject and Google Cloud OAuth callback registrations.
3. Review eligibility of every requested scope and Google Cloud OAuth
   publishing status before the initial Workspace connection.
4. Only then build and stage revised Worker code **with existing secrets
   preserved**; inspect changes, deploy through an explicitly approved
   version, and configure a narrow browser-access policy/callback exception.
5. Keep Google reads disabled until the first controlled authorization and
   explicit opt-in. Verify returned scopes and connection in the encrypted D1
   vault; prove only seven read tools are exposed.

Google references:
- https://developers.google.com/workspace/guides/configure-oauth-consent
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/workspace/gmail/api/auth/scopes
