# M1 development: typed foundation and Google Tasks parity

This feature branch is **local development only**: a working TypeScript operation registry and restricted Google REST transport with an MCP stdio adapter and four dedicated Google Tasks tools. No Cloudflare Worker, public MCP endpoint, Google OAuth consent broker, Android client, or production credential store has been deployed.

## Code ownership

- `packages/core`: typed operation registry; trusted client principal; per-account Google scopes; mutation approval interface; safe error codes. The principal must come from the authenticated transport, **not from a tool argument**.
- `packages/google-http`: fixed-HTTPS-origin JSON requests; path constraints; bounded responses; safe Google status mapping; timeout.
- `packages/google-tasks`: 4 bounded, explicit Tasks operations; strict per-tool Zod input and bounded output.
- `packages/mcp-adapter`: an MCP tools/list and tools/call interface over the same operation registry.
- `apps/local-mcp`: Node stdio developer entry, temporary environment-token session provider, and local user-issued one-time approval mechanism. These local components are **not** suitable for remote deployment.

There is deliberately **no generic URL tool** or user/model-issued approval operation. Every call uses fixed, code-owned Google REST routes. The MCP caller is never permitted to provide OAuth tokens, select arbitrary accounts, or self-approve a mutation.

## Run tests

Requires Node 22+ and npm. In a fresh checkout:

```sh
npm install
npm test
```

The tests use synthetic data and mocked Google responses only; they validate read/write scope separation, fixed destinations, bounded projections, host-only approvals and an actual stdio MCP handshake. Passing tests **do not prove** live Google login or hosted MCP support.

## Local developer-only Google Tasks read

Only if you have a temporary, authorized Google Tasks test account and an actual short-lived OAuth token, configure the following environment variables *outside scripts, commits and shell history*:

- `GMW_GOOGLE_ACCOUNT` (defaults to `default`)
- `GMW_GOOGLE_ACCESS_TOKEN` (real temporary access token; never paste into ChatGPT or issues)
- `GMW_GOOGLE_SCOPES` (space-separated Google OAuth scopes)
- `GMW_GOOGLE_TOKEN_EXPIRES_AT` (actual ISO-8601 expiry)

Run `node dist/apps/local-mcp/src/stdio.js`. This exposes a **local stdio MCP process**; it is not an HTTP listener or Cloudflare deployment.

For an authorized, disposable Task creation, the user must separately run a local terminal command after enabling the Google Tasks write scope:

```sh
node dist/apps/local-mcp/src/approve-task.js \
  --tasklist "YOUR_TEST_LIST_ID" \
  --title "Disposable test task"
```

Review the exact action and type `APPROVE` in that **independent terminal**. The grant is tied to the local account, client identity, tasklist, title, notes and scheduled day. It expires after two minutes and is consumed once. It does not constitute a remotely authenticated approval workflow.

## Next steps

1. Confirm the M1 implementation compiles/tests in GitHub CI and review the PR.
2. Build a Cloudflare transport shell and proper OAuth/session brokerage without exposing local environment tokens or filesystem approvals.
3. Implement Apps Script project/content/version operations through the shared registry (see the roadmap PR).
4. Add first-party typed HTTPS endpoints and Android/ELF//SHELL clients only after the remote authorization boundary works.

The reference source for the pre-existing four Tasks tools and local approval semantics is
[ELF//SHELL Workspace AI — mcp](https://github.com/cryogenized-spec/elf-shell-workspace-ai/tree/main/mcp).
Ported behavior remains under the source project's MPL-2.0 terms.
