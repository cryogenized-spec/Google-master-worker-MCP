# M19 — Full personal-account API inventory (Google Master MCP)

## Purpose

Build one extensible, typed Google service registry for **the full 23-scope
personal Gmail OAuth consent already stored in D1**, rather than artificially
keeping the remote MCP limited to Tasks and Apps Script. An individual scope
does not equal one API endpoint; different services have dozens of resources.
These operations form a secure broad baseline, not a claim that every endpoint
offered by Google is implemented.

The original 39-scope organization profile cannot be granted by an ordinary
consumer Gmail identity. Its enterprise-only capabilities remain a separate
organization deployment profile, not part of the existing OAuth grant.

## Core catalogue

Existing seven read operations: three Tasks reads and four Apps Script reads.

17 newly registered read operations:

| Category | Read operations |
|---|---|
| Drive | `drive_list_files`, `drive_get_file` |
| Drive Activity | `drive_query_activity` |
| Docs | `docs_get_document` |
| Sheets | `sheets_get_spreadsheet`, `sheets_get_values` |
| Slides | `slides_get_presentation` |
| Calendar | `calendar_list_calendars`, `calendar_list_events` |
| Gmail | `gmail_list_messages`, `gmail_get_message`, `gmail_list_labels` |
| Contacts | `contacts_list_connections` |
| Forms | `forms_get_form`, `forms_list_responses` |
| Meet | `meet_list_conferences`, `meet_get_space` |

**Total remotely discoverable read tools: 24.**

Five mutation operations are registered in the reusable core:
`drive_create_folder`, `calendar_create_event`,
`sheets_update_values`, `gmail_create_draft`, `gmail_send_message`.
All require the existing `ApprovalGate.consume` with an independently
host-issued action-specific one-use approval. The protected remote OAuth server
and REST adapter deliberately surface only read tools until a reviewed
authorization-and-approval implementation exists; an OAuth write scope by itself
never grants the ability to send emails or modify data. This prevents granting
any new mutation capability merely by toggling the Google read gate.

## Technical protections

- No arbitrary API URL proxy, executable code or generic Google batch endpoint.
- Each service uses a fixed Google HTTPS origin and URL path prefix.
- Zod strict input validation, bounded IDs, page sizes, query lengths.
- Provider error masking and size-limited Google responses.
- Existing encrypted D1 token vault, subject allowlist and OAuth client identity.
- Distinct OAuth trust boundaries: `mcp:read` for the MCP client and the
  23 service scopes for the Google account.
- User-visible Gmail email content is limited to snippet/headers; uploads,
  downloads, attachments, send, deletion and sharing require separate tools
  and reviewed approvals.
- OAuth provider tokens must never be handed to chat tools or logs.

## Activation

M19 is a code change only. Do not reset the Google Workspace OAuth connection,
recreate Client A/B, or repeat the 23-scope consent. Do not auto-enable
`GMW_WORKSPACE_READS_ENABLED`. Stage the MCP Worker only with
`wrangler versions upload`; inspect its secret names and D1/service
bindings; promote the version separately using `versions deploy`, not
a route-replacing `wrangler deploy` against the existing public hostname.
Leave Setup behind Cloudflare Access and Auth/MCP public with their own OAuth.

Once staged and deployed, ChatGPT may need its connector tools rediscovered
to see the new inventory. Then authorize the explicit Google read gate with
a versioned setting and perform a read-only smoke test, beginning with Tasks
before exercising other services.

## Further work without changing the OAuth grant

The 23 authorized scopes may support more operations than those implemented
above, such as Docs editing, Calendar patching, Drive uploads or sharing,
Gmail label actions, Contacts updates and more. For remote mutation tools,
first build the independent user-approved exact-action gate and extend the
MCP OAuth audience with an appropriate, separately consented write scope.
Never turn on unrestricted writes solely because the user approved a broad
Google OAuth scope.

Google's External/Testing refresh token can expire after approximately
seven days when using non-basic scopes. Deal with the consent-screen lifecycle
independently of the MCP tool registry.
