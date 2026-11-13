# M23 — Broad Google write suite, independent owner approval

## Scope and inventory

M23 adds **81** explicitly named, scope-checked mutations to the existing
Google Tasks, Apps Script, and M19 Workspace write functions (nine existing),
giving **90 mutation tools** and one separately classified `write_prepare_action`
tool in a write-enabled protected MCP Worker. M22 contributes 101 reads, so
the protected capability catalogue becomes **192** entries when both read and
write gates are on. No arbitrary provider URL, generic HTTP proxy or script
code execution tool is exposed.

The core write suite includes Tasks/tasklists; Apps Script deployments; Drive
file metadata/copy/move/trash/delete/shares/comments/replies/revisions;
Docs create and batchUpdate; Sheets create/append/clear/batch update;
Slides create/batch update; Calendar event/calendar/ACL; Gmail drafts/send,
labels/message/thread modifications/deletion and vacation/filter settings;
People contact and contact-group management; Forms create/batch update/publish;
and Meet spaces, members and conference termination.

Provider method availability remains dependent on the user's actual OAuth
grant, account type, file ownership and Google API product eligibility.
Not every product API supports binary uploads or file streaming through this
JSON-only Worker. The 23 personal granted scopes do not create admin privileges,
and API errors must be reported rather than bypassed.

## Approval model

1. A verified MCP/HTTPS client calls `write_prepare_action` with **one**
   registered mutation name and its complete parameter object.
2. The operation registry checks the named target exists, parses its strict
   input schema, checks the session has at least one required Google scope,
   then persists an AES-256-GCM encrypted copy in D1. The plaintext D1 metadata
   contains only an action digest, risk class, client identifier, timestamps
   and opaque request ID. Proposal generation never calls Google's API.
3. The client receives a private owner-browser link:
   `https://google-master-workspace-setup.cryogenized.workers.dev/setup?approval=<id>`.
   Cloudflare Access remains configured separately, and the setup Worker
   requires its own Google-verified owner login session, secure SameSite
   HttpOnly cookies, anti-CSRF state and an exact same-origin form submission.
4. The owner reviews all parameters (and decoded RFC 5322 Gmail MIME when
   supplied) and selects **Approve once** or **Reject**. Each request expires
   after 20 minutes, and approvals expire after five additional minutes.
5. The requesting client invokes the **same** named mutation with the **same**
   parsed input object. The protected Worker matches principal, Google account,
   operation and canonical SHA-256 parameter digest. One atomic D1
   UPDATE ... RETURNING consumes the approval **before** any Google API I/O.
6. A modified input, different client, expired request, rejected request or
   second execution fails with `WRITE_APPROVAL_REQUIRED`. The model cannot
   self-approve through MCP. A failed provider request does **not** automatically
   replenish an approval; inspect target state before a new proposal.

Owner credentials, Google tokens, exception messages and MIME payloads are
not logged. The owner UI HTML-escapes every field. 30 KB canonical request
limit and 10 pending per client restrict abuse. The approval database retains
status metadata and encrypted input for audit; retention cleanup is a separate
future maintenance feature.

## Default deployment protection

- The generated Worker configuration sets
  `GMW_WORKSPACE_READS_ENABLED=false` and
  `GMW_WRITES_ENABLED=false` (older locally generated configs lacking the
  latter remain safely false).
- The protected MCP exposes mutations and `write_prepare_action` only when
  `GMW_WRITES_ENABLED` equals **the literal string** `true`; then every
  mutation still requires a D1 one-time owner approval. REST dispatch is
  similarly gated.
- The setup Worker can show the owner review UI independently but cannot
  grant access to a different OAuth principal. Access cannot be inferred
  from completing MCP login or receiving a proposal link.
- Existing read-only behavior remains intact when writes are disabled.

## One release procedure

On the user's Linux Mint system:

```bash
cd ~/Google-master-worker-MCP
nvm use 26
git pull --ff-only
bash scripts/release-m23.sh check
bash scripts/release-m23.sh stage
# Verify both staged version bindings/secret names before proceeding
bash scripts/release-m23.sh promote
```

The script runs tests, applies the numbered D1 migration with Wrangler
migration tracking, uploads and inspects Setup then MCP versions, promotes
Setup first, and promotes MCP with **both** reads and writes explicitly
enabled. Do not use ordinary `wrangler deploy` against the generated
route-free configuration. Do not recreate OAuth consent or edit the D1 token
vault.

The `stage` command performs a remote D1 migration but does not change
production Worker traffic. It is intentionally not a read-only command.

## Acceptance tests

- Existing 101-read discovery and read-only API tests remain green.
- All 81 new mutation names, scopes and risk classes are checked in tests.
- Direct unapproved writes must fail before Google API I/O.
- D1 tests cover encrypted payloads, approval request generation, cross-client
  replay denial, changed input denial, rejection, expiry and exactly-once use.
- Eleven approved representative operations test verbs, fixed Google routes,
  colon action suffixes and expected body parameters.
- Google HTTP client recognizes HTTP 204 DELETE/CLEAR success.
- Node tests, local workerd OAuth tests and all Worker dry-run bundles must
  pass before merging.
- Live smoke test after deployment: list and read operations must still work;
  direct unauthorized write must fail; an owner-approved harmless new
  disposable item can be created and re-read, then deleted only with separate
  owner approval. Never test by sending a real email, deleting real Drive
  items or changing real file permissions.

## Field caveats and roadmap

- Google endpoints are numerous and some change frequently. Some operation
  bodies may require exact provider adjustments when exercised live.
  Distinguish `GOOGLE_FORBIDDEN` from missing scope and unsupported API.
- There is no binary Drive upload or large attachment streaming in this
  release; those need a bounded multipart/media transport separate from
  the fixed JSON HTTP client.
- Google Workspace-only services such as Vault, Admin SDK, enterprise Keep,
  Groups Settings and Chat remain outside the 23 granted personal scopes.
- No blanket destructive approval is ever minted. A user may authorize
  multiple exact actions individually, but external sending, sharing and
  deletion are not autoapproved by code.
