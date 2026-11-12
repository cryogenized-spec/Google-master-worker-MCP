# M18 — Personal Gmail OAuth compatibility after invalid_scope

## Incident
The private Setup and operator login succeeded through Cloudflare Access and
Google Client A. Client B then rejected the all-39-scope authorization with
Google error `400 invalid_scope` **before issuing a token**.

Google explains that `invalid_scope` means at least one permission is not
recognized or cannot be requested by the application. Google did not identify
which item in the bulk request caused this failure. We must not claim to have
isolated a particular scope solely from this error.

The previous 39-scope registry mixed personal APIs (Tasks, Gmail, Calendar,
Drive, Docs, Sheets, Slides, Forms, Contacts, Apps Script, Meet) with
organization-specific capabilities (Admin Directory, Vault, Groups Settings,
enterprise Keep, Workspace directory and certain Chat/Classroom functionality).
A consumer Gmail account lacks the enterprise domain privileges these
integrations require. The scope registry itself remains useful for a future
managed Workspace deployment.

## Change
- Preserve `WORKSPACE_SCOPES` as the full catalog.
- Offer `PERSONAL_WORKSPACE_SCOPES` as the **default one-session consent**:
  23 scopes covering core personal Google services. Exclude the 16
  organizational/dependent/redundant scopes; retain the 39-scope advanced
  button for eligible managed Workspace accounts.
- The setup UI explicitly labels the profiles and lists their scopes.
- Google permits granular consent. The broker now checks that returned Workspace
  scopes are a subset of those explicitly requested, verifies the same stable
  Google subject, and saves **only the permissions Google actually granted**.
  Empty or unexpected Workspace grants still fail closed.
- The setup page shows the *actual granted-scope count*, not an implied full
  authorization.
- No Google API tools are added by registering these scopes. The remote MCP
  continues to provide only the existing seven read-only operations. Google
  reads remain disabled by default.

## Caveats
- The personal bundle is a **compatibility candidate**, not a guarantee:
  Google's OAuth policies, API setup, individual account eligibility or
  consent configuration may still reject a particular scope.
- The exact invalid item(s) in the original 39-scope request are **unproven**.
- Gmail/Drive restricted scopes may have additional verification and
  security obligations. External/Testing authorizations for non-basic scopes
  ordinarily have a 7-day refresh token lifetime.
- Organizational scopes require a qualifying account and often admin
  privileges; adding them in Google Auth Platform does not grant those.
- Full-profile and consumer-profile permission requests remain separate options,
  but **the user shouldn't have to reconfigure OAuth clients or Google APIs**.

## Safe operator deployment
1. Wait for CI including Node 26 unit/runtime tests and all Worker dry-runs.
2. Use `git pull --ff-only`, `npm run cloudflare:verify` and
   `wrangler versions upload -c .wrangler-deploy.setup.jsonc` to stage
   revised Setup code while preserving all six secrets.
3. Inspect version bindings/secrets and promote only after review.
4. Keep the Cloudflare Access All Traffic policy in place and Preview disabled;
   don't use ordinary route-free `wrangler deploy` on the currently enabled
   Setup hostname.
5. Navigate freshly to `/setup`, choose the **personal Gmail** button,
   and view Google's permission screen. Do not reuse a failed callback URL.
6. On success, verify D1 `google_oauth_connections` via account ID and
   `json_array_length(scopes_json)` only; never query/share token ciphertext,
   authorization codes or refresh secrets.
7. Keep Google MCP reads disabled until specifically approved.

## References
- https://support.google.com/accounts/answer/16668185
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/workspace/vault/auth
- https://developers.google.com/workspace/keep/api/guides
