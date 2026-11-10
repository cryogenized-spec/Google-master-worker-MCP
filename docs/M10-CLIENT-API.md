# M10 — Shared read-only first-party HTTPS API

**Status:** implemented and tested with synthetic OAuth credentials. No Cloudflare deployment, Google account connection, CiRYVA APK changes or Firefox extension installation has occurred.

## Purpose

ChatGPT uses remote Streamable HTTP MCP, while Ayarime (Firefox) and CiRYVA (Android) need smaller, predictable JSON calls. The protected Worker now supports **both transports** using one operation registry, one authenticated principal and the same separately consented Google D1 vault.

| Method | Path | Response |
| --- | --- | --- |
| \`GET\` | \`/v1/capabilities\` | \`{"operations":[{"name":"...", "description":"...", "risk":"read"}]}\` |
| \`POST\` | \`/v1/operations/tasks_list_tasklists\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/tasks_list_tasks\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/tasks_get_task\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/script_get_project\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/script_get_content\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/script_list_versions\` | \`{"result":{...}}\` |
| \`POST\` | \`/v1/operations/script_list_deployments\` | \`{"result":{...}}\` |

Request arguments are a JSON **object** with \`Content-Type: application/json\`; the core validates each against its existing Zod schema. For instance, \`tasks_list_tasks\` takes \`{"tasklistId":"...","maxResults":25}\`. All requests use \`Authorization: Bearer <OAUTH_ACCESS_TOKEN>\`, where that token is issued for the **MCP resource** \`https://mcp.<domain>/mcp\` with \`mcp:read\`. **Do not supply a Google access token or refresh token here.** The authorization server verifies the client identity and consent, and a separate D1 vault supplies Google credentials *only after separately authorized account linking*.

Read-only catalogue and invocation share the same OAuthResourceServer as \`/mcp\`. The typed API cannot invoke a write operation even if Google granted write scopes or somebody later adds an approval gate to the core. It excludes the legacy, local-development bearer gateway entirely.

## App adapter APIs

**Firefox/Ayarime:** \`packages/client-sdk/src/index.ts\` exports \`GoogleMasterReadClient\` and \`READ_OPERATION_NAMES\`, with \`capabilities()\` and \`call(operation, input)\` methods. Pass the exact HTTPS MCP resource URL and an app-controlled asynchronous \`getAccessToken\` function that obtains a short-lived access token via the *real* OAuth authorization-code + PKCE flow. The SDK never acquires, logs, persists or refreshes tokens on its own. Browser background scripts may use a host permission for the MCP origin, but actual cross-origin \`Origin\` requests must pass the server's explicit allowlist. Do not replace the extension's working local features until live parity tests pass.

**Android/CiRYVA:** \`clients/android/GoogleMasterReadClient.kt\` is a standalone platform transport example based on the Android-provided \`org.json\` and standard HTTPS connections. It does not bring in any dependency or assume an Android project package structure. It must be invoked off the UI thread and given a token from a properly implemented *public native OAuth client flow with PKCE*. **It is not yet integrated into CiRYVA and not Android-compiled in this repository.** Do not embed a confidential client secret in APK resources; authenticate in the system browser using secure redirect/app-link handling and store short-lived tokens with appropriate device security.

Both client adapters use a strict operation-name allowlist and have no generic arbitrary Google proxy methods.

## Browser CORS restrictions

All \`/v1\` requests must pass through a validated \`Origin\` check **before** OAuth. Native Android requests generally have no Origin and are still subject to bearer authentication. Same-origin requests are permitted; third-party browser/extension requests require an exact matching entry in the protected MCP Worker's optional public **\`GMW_ALLOWED_BROWSER_ORIGINS\`** setting.

This variable is intentionally generated as **empty** by \`scripts/prepare-cloudflare.mjs\`. After installing the actual trusted extension, configure one exact \`moz-extension://<stable-instance-id>\` origin; for a hosted trusted client use the exact \`https://workspace.example.net\` *operator-owned* origin. No wildcard, \`null\`, broad \`moz-extension://*\` or arbitrary origin reflected. CORS preflight is limited to \`Authorization\`, \`Content-Type\`, GET and POST. The server does **not** send \`Access-Control-Allow-Credentials\`; the clients use authorization headers rather than cross-site cookies. An allowed origin is **not authentication**; OAuth bearer validation still runs on the server.

A browser extension's allowed origin may change on reinstall or across browsers. Configure and verify it after actual installation, not by guessing an ID. The SDK does not grant a user consent: real browser/Android OAuth remains a follow-up project task.

## API limits and errors

- Request bodies: 32 KiB maximum, streaming bound even without Content-Length.
- Serialized responses: 512 KiB maximum. Source-heavy operations can return \`RESPONSE_TOO_LARGE\`, rather than unlimited data.
- Errors: \`{"error":"SAFE_CODE"}\`, suitable status (400, 403, 404, 405, 415, 503, 502) and \`Cache-Control: no-store\`. Provider failures never echo Google tokens, payloads or exception stacks.
- The browser client has a default 12-second timeout and does not follow HTTP redirects. The Android example also disables redirects and caps the response size.
- No general \`google_api_request\` tool, writes, Apps Script execution, Gmail, Drive, or additional OAuth scopes were introduced.

## What counts as completed, and what does not

Unit and integration tests in \`tests/rest-client.test.mjs\` verify mock Google Tasks reads, the exact seven read operations, the OAuth validation path, unauthenticated and wrong-scope rejection, host/origin restrictions, overlarge requests and client token handling. Wrangler dry-run bundles the existing Cloudflare Workers.

To **finish the actual Ayarime and CiRYVA integrations**, we still need the real application repositories and their login/session architectures. Add the SDK to Ayarime's background service without removing existing local Google reads. Implement native OAuth 2.1 authorization-code PKCE and lifecycle handling in CiRYVA, then call the same remote read operation from both. Compare each live result with ChatGPT MCP on a disposable test account. No live Google account or Cloudflare zone is connected.

The earlier \`M7\`–\`M9\` numeric names in the original roadmap differ from the later implementation sequence. The implementation milestones follow the PR series; keep this page's scope precise and do not claim feature-complete clients until cross-app acceptance succeeds.
