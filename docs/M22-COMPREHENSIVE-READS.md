# M22 — One-batch personal Google read catalogue

## Scope of this milestone

This is a broad read-only expansion of the *existing* 23-scope personal Google
OAuth grant. It does not demand new Google consent, modify an account, or enable
writes. Google offers hundreds of endpoints with varying eligibility, quotas,
response bodies and administrative account requirements; "every imaginable
read" is not a finite set. Instead M22 adds named, supported read workflows
across **every personal-account product represented in our OAuth profile**.

The existing 24 read operations remain unchanged. M22 adds 76 fixed Google
GET operations plus the explicitly specified side-effect-free Calendar
freeBusy POST query: **101 total remote read operations**.

| Product | New read workflows |
| --- | --- |
| Tasks | Task-list details, advanced tasks pagination/filtering |
| Apps Script | User/script executions, usage metrics, deployment details |
| Drive | Quotas/account, permissions, comments/replies, revisions, change tokens and feed, shared drive metadata |
| Docs | Tab-inclusive document structure |
| Sheets | Formula ranges, bounded grid slice, developer metadata |
| Slides | Page elements and thumbnail URL metadata |
| Calendar | Event details, recurring instances, calendar details, settings, ACL, colour schemes, free/busy |
| Gmail | Mailbox profile, full messages, threads, drafts, labels, history, settings, filters, aliases, forwarding and delegates |
| Contacts | Individual contacts, contact search, contact groups, other contacts |
| Forms | Individual responses and watch metadata |
| Meet | Conference/participant/session and meeting artifact metadata, recordings, transcripts, notes and members |

Drive Activity, as well as additional rich read methods for Drive,
Calendar, Docs, Sheets, Gmail, Contacts, Forms and Meet, were already
present in M19.

## Boundaries

- Only hard-coded Google HTTPS origin/path prefixes. No generic URL input,
  arbitrary REST proxy, script execution or dynamic HTTP verbs.
- Every operation has a strict Zod input shape and at least one explicit
  granted-scope requirement.
- List operations support bounded pages; details use a 95,000-character
  recursive projection limit; Google JSON transport also has a byte cap.
- No write methods are exposed remotely; a special freeBusy POST is a
  documented query endpoint with typed bounded body and no side effects.
- Content and metadata from Google are treated as *untrusted data*, not
  instructions for the assistant.
- Empty collections are legitimate; a 403 may indicate service eligibility,
  delegated access or administrator restrictions even where the scope string
  is present. It is not evidence of OAuth needing to be rebuilt.
- Large full messages, Docs tabs, Sheets grids and Meet transcripts may hit
  the configured Google response byte cap. An explicit streaming/download
  workflow will be a separate read capability when binary data is required.
- Some account-only methods (e.g., Gmail delegated access or shared drives)
  will not work for a personal Gmail identity. Their presence is not a promise
  of entitlement.

## Test plan

1. Unit tests must check 76 GET descriptors have unique names, pinned
   provider origins, and at least one scope granted by the current 23-scope
   personal profile.
2. Every new GET operation must be invoked through the typed operation
   registry against a service-specific mock that checks OAuth Authorization,
   redirect manual, credentials omit, cache no-store and bounded responses.
3. A distinct test must verify Calendar freeBusy's exact POST body.
4. Strict input tests must reject traversal, arbitrary URLs, client-supplied
   access tokens, extra fields and invalid time parameters.
5. Scope test must reject under-scoped calls before Google network I/O.
6. Cloudflare workerd runtime acceptance checks 101-tool MCP discovery and
   REST capabilities; Node/TypeScript build and bundle dry runs must pass.
7. After an operator-controlled M22 production deployment, use the **same
   Google Master MCP connector** to smoke test representative reads for each
   service that has actual data, without modifying any Google records.
   If a target service has no owned content, report it as empty/not testable
   rather than inventing a successful resource retrieval.

## Deployment handoff

The operator has an active protected MCP Worker behind OAuth and an encrypted
D1 vault, with `GMW_WORKSPACE_READS_ENABLED=true`. Do not rotate the
connection, remove the existing OAuth scopes, or deploy the route-free local
Wrangler config with an ordinary `wrangler deploy` command.

After tests pass, stage the updated protected MCP Worker code via
`wrangler versions upload -c .wrangler-deploy.mcp.jsonc --var
GMW_WORKSPACE_READS_ENABLED:true`. Inspect the stage for the existing four
secret bindings, D1, Auth service binding, OAuth resource URLs, and read flag.
Promote the inspected version to 100% traffic with `wrangler versions deploy`.
Keep the setup application behind Cloudflare Access, retain existing triggers,
then rediscover the MCP tool catalogue.

## API references

- https://developers.google.com/workspace/drive/api/reference/rest/v3
- https://developers.google.com/workspace/gmail/api/reference/rest
- https://developers.google.com/workspace/calendar/api/v3/reference
- https://developers.google.com/people/api/rest
- https://developers.google.com/workspace/meet/api/reference/rest/v2
- https://developers.google.com/apps-script/api/reference/rest
- https://developers.google.com/workspace/forms/api/reference/rest
