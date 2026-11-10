# M2 — Apps Script project lifecycle (development)

This module adds **seven named Apps Script REST operations** to the reusable TypeScript core:

- `script_get_project` — metadata by exact script ID
- `script_get_content` — full current/immutable-version source and deterministic SHA-256 snapshot fingerprint
- `script_create_project` — user-approved creation of standalone or bound project
- `script_update_sources` — guarded upsert of SERVER_JS/HTML files; never deletes other files or rewrites manifest intentionally
- `script_list_versions` — bounded version inventory
- `script_create_version` — approved immutable version creation (does not deploy)
- `script_list_deployments` — bounded deployment inventory (no create/update/delete)

Endpoints are fixed to `https://script.googleapis.com/v1/` and require either `script.projects.readonly` or `script.projects` Google OAuth scopes as applicable.

## Critical source-edit safety

`projects.updateContent` **replaces all files in the project**, including the manifest. The module therefore reads all files, verifies an exact user-provided prior SHA-256 fingerprint, upserts only specified non-manifest source files, sends the preserved full file array, and reads the project again to verify the result. The input fingerprint and complete proposed changes must be covered by a trusted, one-use write approval. New `appsscript` manifest modifications and arbitrary deletion are not allowed in this M2 slice.

The provider API does not expose a supported atomic compare-and-swap precondition on `updateContent`; a concurrent edit between the last read and the PUT can still race. For high-consequence existing projects, create a separate backup/version through a deliberate workflow and avoid simultaneous editors. Return `CONTENT_CHANGED_REVIEW_REQUIRED` when prior content differs and `CONTENT_WRITE_UNVERIFIED` when a post-write reread differs.

## Scope boundaries

A client may not choose an arbitrary Google origin, provide OAuth tokens, or approve its own mutation. Authorization principal and scope enforcement continue to be handled by the core registry, and the local file gate remains *development-only*. The module does not expose `scripts.run`, trigger creation, deployment writes, or unrestricted code execution.

There is no `projects.list` Apps Script REST method. Discover script project IDs via authorized Drive search/selection later, or supply an ID already known to the operator.

Remote execution is deliberately M3: it requires a Google Apps Script **API executable** deployed under the same **standard Google Cloud project** as the calling OAuth client. The Apps Script API does not work with service accounts.

## Tests and acceptance

`npm test` runs mocked read, create, upsert/manifest-preservation, stale-hash refusal and version/deployment tests. Tests do **not** connect to a real Google account. Production OAuth, deployment and user-confirmed live Apps Script project acceptance remain outstanding.

References:
- https://developers.google.com/apps-script/api/reference/rest
- https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent
- https://developers.google.com/apps-script/api/how-tos/execute
