# Google Master Worker MCP — Product and Engineering Roadmap

**Status:** DRAFT — review before implementation, deployment, or merge  
**Written:** 2026-11-10 (Africa/Johannesburg)  
**Deployment model:** personal, bring-your-own Google Cloud project, single operator at first  
**Repository:** https://github.com/cryogenized-spec/Google-master-worker-MCP  
**Existing code to reuse:** https://github.com/cryogenized-spec/elf-shell-workspace-ai/tree/main/mcp

## 0. Decision and purpose

**Adopt one central authenticated Cloudflare Worker gateway backed by modular TypeScript Google API adapters, exposed through both MCP (ChatGPT/other compatible clients) and a typed HTTPS API (ELF//SHELL Ayarime, CiRYVA Android).**

This is **centralization of policy, authentication, routing, and deployment**, *not* centralization of every function into one giant source file. Each Google service is independently built, tested, enabled, versioned, and discoverable. Client UIs retain direct links and local interactions when proxying offers no benefit.

The central hub must make it possible for the operator to say in ChatGPT, Ayarime, or CiRYVA: “Add these workout results to my tracker,” and have all clients invoke the **same** authorized, typed Google Sheets operation. More complex requests may orchestrate several approved service operations. There is no need to implement Google authorization and Sheets business logic separately in three client applications.

### Explicit non-goals for first release

- A public multi-user SaaS or third-party app marketplace.
- An unrestricted AI-controlled Google REST proxy or arbitrary remote script execution endpoint.
- Replacing Google APIs with Apps Script for everything.
- Rebuilding the existing Firefox UI, CiRYVA AI stack, or working Tasks slice.
- Automatically forwarding private Google data to an AI model.
- Large file buffering through Worker memory; use streaming, capped responses, or direct destination access.
- Universal support for every Workspace feature regardless of account/API eligibility.

## 1. Architectural boundaries

```text
ChatGPT / MCP clients ────────┐
ELF//SHELL Ayarime ─── HTTPS ─┤
CiRYVA Android ─────── HTTPS ─┤
Future personal clients ──────┘
                              ↓
           Cloudflare Worker: master gateway
      route / identity / scope / approvals / quotas
           ├─ /mcp    (remote Streamable HTTP)
           ├─ /v1/*   (typed HTTP/JSON)
           └─ /auth/* (our client and Google OAuth)
                              ↓
                Shared TypeScript core
      contracts / policy / Google session / errors
                              ↓
     ┌──────────┬───────────┬───────────┬──────────┐
     │AppsScript│   Drive   │  Sheets   │  Tasks   │ ...
     └──────────┴───────────┴───────────┴──────────┘
                              ↓
               Google Workspace REST APIs
```

**Conventions**

- Service modules export named operations, input/output schemas, OAuth scope requirements and risk classifications. They know nothing about MCP message framing or Android UI.
- Transport adapters (MCP and HTTP) translate validated external requests into identical internal service operations.
- The Worker is **stateless per request**. D1 is the preferred initial durable home for account metadata, authorization/approval records and small audit records; KV can hold ephemeral/configuration/cache data where its consistency model permits. Store any OAuth refresh tokens encrypted at rest using runtime-managed keys, restrict access and never log them. Consider Durable Objects or Queues only for demonstrated coordination/background job needs, not by default.
- Treat Google API data (documents, emails, task text) as untrusted content, not instructions to the agent. Bound pagination, response fields, timeouts and retries.
- Separate **client-to-hub authentication** from **hub-to-Google OAuth authorization**. Use a service identity for ChatGPT and first-party app sessions, then per-operation Google scope checks. Android uses an interactive authorization flow with PKCE and secure token storage; do not bundle permanent backend secrets in an APK or extension.
- Persist per-account connection metadata and scopes without conflating Google logins with our clients. This project starts with one operator and one account but does not hard-code one account into business logic.
- Use typed named operations; group tool catalogues per Google app and expose only selected modules to each MCP connection. No opaque generic `google_api_request` tool.
- Distinguish read, write, delete, share, externally-visible/send and code-execution capabilities. Explicit out-of-band approvals bind principal, operation, target and content hash/parameters, expire and cannot be forged with model-provided `approved: true`.
- Build minimal redacted logs (request ID, module, duration, result category) with no personal document/email text or credentials. Apply throttling and quota guards even for private use.
- Deployable on Workers but keep adapters and core compatible with standard TypeScript runtimes where practical (avoid coupling service rules to Cloudflare APIs).

## 2. Packages / repository layout (target, not yet present)

```text
apps/
  worker/                # Cloudflare deployment: HTTP, MCP, OAuth callbacks
packages/
  contracts/             # operation IDs, zod/JSON schemas, shared results
  core/                  # routing, policy, approval contracts, errors, telemetry
  google-auth/           # Google OAuth token broker and least-privilege scopes
  google-http/           # restricted Google HTTP client, pagination, retries
  google-apps-script/    # projects, content, versions, deployments, scripts.run
  google-tasks/          # migration and completion of existing Tasks slice
  google-calendar/
  google-drive/
  google-sheets/
  google-docs/
  google-gmail/
  google-slides/
  google-contacts/       # later
  mcp-adapter/           # MCP tool registration + transport-facing mapping
  rest-adapter/          # typed JSON routes for first-party clients
  client-sdk/            # minimal client contracts for Firefox and Android
docs/
  ROADMAP.md
  architecture.md        # produced in implementation milestones
  oauth-and-security.md
  operations.md
tests/
  integration/
```

Use npm workspaces and a bounded TypeScript build; avoid a full monorepo framework until justified. CI can test changed packages plus smoke tests, not rerun unrelated desktop suites on every commit.

## 3. Existing work: preserve, do not pretend it is deployed

Our separate `elf-shell-workspace-ai` repository already has a local `mcp/` package, an MCP handshake, Zod validation and four Google Tasks REST tools:
`tasks_list_tasklists`, `tasks_list_tasks`, `tasks_get_task`, `tasks_create_task`.
Its local one-use create approval, bounded outputs and mocked tests are useful migration references. **It is not a production remote MCP or OAuth broker.**

The Firefox Workspace companion already has profiles, a Hub, sidebar, locally authorized Calendar/Tasks read paths and partial Drive/Docs/Sheets/Gmail read functionality. Those remain functional and independent; the new backend replaces or supplements them only after an end-to-end comparison. Its existing BYOK settings must not automatically grant Google tool invocation.

Migration rules: audit the files in source `mcp/`, preserve licensing and commit provenance, port one working operation with parity tests, then continue. No blind copy that changes existing extension behavior. Keep `elf-shell-workspace-ai` and CiRYVA as **clients** of this repository, not as nested subprojects.

## 4. Release sequence

**Each milestone must demonstrate one real vertical slice and a concrete acceptance result before the next. Use a disposable Google account or explicitly created test resources for writes.**

### M0 — Project charter and repository baseline (first PR; planned)

- Create this roadmap, minimal README and architectural decisions.
- Confirm code ownership, license choice and source-of-truth repositories.
- Establish `main` as stable, feature branches and draft PRs as the development process.
- **Exit:** reviewer approves repo purpose, security boundaries and milestone order. No production credentials or deployment.

### M1 — Portable TypeScript core and Tasks parity

- Create `contracts`, `core`, `google-http`, `google-auth` interfaces (without production tokens), and a local MCP adapter.
- Migrate four existing Tasks operation schemas/adapters and deterministic mock tests to the new package structure. Preserve one-use approval as an interface; existing local approval implementation remains development-only.
- Build read paths and a no-secrets local validation harness with real MCP `tools/list` + `tools/call`.
- **Exit:** local Tasks list/read works against mocked Google endpoints; approved/denied create behaves identically; no regressions in original extension.

### M2 — Apps Script API: read and source lifecycle

- Typed operations for project creation/metadata, getContent, updateContent, versions, deployment inventory and script metrics/processes, using supported Apps Script REST methods.
- **Project discovery caveat:** Apps Script Projects REST does **not** have a `projects.list` method. Discover accessible script projects using supported Drive metadata/search methods where granted, or require an explicit script ID.
- Source authoring flow: TypeScript source in GitHub → compile compatible JavaScript for Apps Script V8 → inspect/apply a source diff → safely write full content → create version → deploy. The Apps Script project and GitHub source are distinct artifacts.
- **Critical rule:** `projects.updateContent` replaces the full project file set. Read full existing content and manifest, check concurrency/diff, preserve untouched files, obtain approval, then write. Do not silently overwrite someone else's project.
- A hosted API executable is optional at this phase; do not promise live function execution before proper setup.
- **Exit:** create an isolated disposable script project, read and update its source with an approved diff, create a version, and re-read for exact match; all with redacted logs.

### M3 — Apps Script remote execution and safeguards

- Add `script_run_approved_function` for explicit allowlisted script IDs/function names and serializable parameters, plus bounded execution response and diagnostics.
- Validate Google's requirements for **API executable deployment**, shared **standard Google Cloud project** with OAuth client, necessary OAuth scopes, and support for basic transferable types only. Service accounts do not work for this API.
- Enforce input validation, user-granted scope boundaries, max request/response sizes, exact approval for script execution, timeout/error classification and idempotency when feasible. Source editing/deployment and remote execution are separate permissions.
- Respect Apps Script's current 6-minute per-execution limit, concurrency limits and applicable daily quotas; avoid trying to run long pipelines synchronously in the Worker. Scripts should be idempotent where possible, and long work should be decomposed into bounded operations or queued state machines.
- **Exit:** a known harmless deployed function returns a verified structured response; a denied or unallowlisted function cannot run; errors are attributable without leaking script content.

### M4 — Private Cloudflare Worker gateway and OAuth

- Implement authenticated remote Streamable HTTP MCP endpoint, with tested discovery/calls and correct tool input/output schemas.
- Expose typed `/v1` first-party JSON routes sharing the same operation engine. No generic arbitrary-code execution route.
- Build Google OAuth account connection with consented least-privilege scopes, refresh/revocation/disconnect handling, encrypted durable secrets and no tokens in tool arguments.
- Authenticate ChatGPT and first-party clients separately from Google; out-of-band approval UI or secure operator confirmation required before sensitive writes.
- Implement request IDs, audit records, rate limits and deployment rollback. Use Wrangler secrets/bindings; no credentials in git, test fixtures or browser bundle.
- **Exit:** authenticated personal remote read succeeds from an approved MCP client; unauthenticated/under-scoped requests fail; one approved write can be completed and audited. No tunnel or personal laptop uptime dependency.

### M5 — Drive, Sheets and Docs application modules

- **Drive:** file search, metadata, access, export/download where permitted, create/copy/move, selected-file grants and permission-sensitive actions behind stronger approval. Prefer `drive.file` and operator-selected files where feasible; a pasted Drive URL alone is not an access grant.
- **Sheets:** metadata, bounded ranges, formulas, append/update, formatting, validation, tabs, charts; preserve grid IDs, protected ranges and revision/concurrency constraints. First real demo: write one set into the personal star-jump tracker with confirmation and reread verification.
- **Docs:** create/get, structured text operations, replace/insert/style with version-aware batchUpdate; no unbounded raw editor API exposed to the agent.
- Avoid Apps Script as a substitute for direct APIs when a direct API is simpler, faster and quota-friendly.
- **Exit:** three authorized end-to-end operations (Drive lookup, Sheets append, Docs update) with before/after verification and appropriate approvals.

### M6 — Tasks and Calendar completion; Gmail and Slides

- Finish Tasks list/create/update/complete/move/delete and tasklist operations, respecting due-day semantics and pagination.
- Calendar read/freebusy/recurrence and write operations with timezone handling and invitation side effects explicitly previewed.
- Gmail metadata-first, then separately approved body/draft/label tools; sending and destructive actions require recipient/content confirmation and allowed scopes.
- Slides read/create/edit and later chart/image operations with safe object IDs.
- Scope-restricted Google services may require appropriate OAuth verification or user-testing limitations; being personal-use does **not** exempt the project from API provider rules.
- **Exit:** each enabled module has a real disposable-resource demo; absent permissions fail safely.

### M7 — Ayarime and CiRYVA clients

- Add a small native HTTPS client to Ayarime Workspace AI without deleting its working local Google read functionality. User-selected records are not forwarded to an AI model by default.
- Add CiRYVA Android client support for the same typed operation catalogue, account sign-in, operation previews and explicit confirmation. Store no backend client secret in APK; use secure Android session storage.
- One backend tool invocation behaves consistently across MCP, Firefox and Android; UIs may differ while authorization, policy and Google API calls remain shared.
- Maintain Android offline UI behavior and browser direct-tab navigation without forcing every click through the Worker.
- **Exit:** identical read operation demonstrated from all three clients; an approved write from one client visible to the others.

### M8 — Cross-Workspace orchestration and reliability

- Implement orchestrated workflows with explicit composed operations and audit trails, such as a verified daily briefing, task ↔ calendar follow-up, or approved Docs → Drive → Sheets reporting.
- Per-step status, retries only for safe/idempotent requests, compensating actions where possible; don't imply an atomic Google-wide transaction.
- Async or scheduled work only with an actual Cloudflare scheduling/queue mechanism and persistent job state; never pretend a Worker request remains alive between sessions.
- Bound budgets and usage by Google API quotas, Apps Script limits and Cloudflare plan limits.
- **Exit:** user-initiated multi-app workflow succeeds, clearly reports partial failures and never silently repeats a non-idempotent write.

### M9 — Release-readiness and maintenance

- Review per-scope permissions and Google consent/verification requirements, Cloudflare deployment configuration, token rotation, incident/backup/recovery, logging redaction and repository CI.
- Publish operator-facing setup and maintenance instructions; keep the project BYOK rather than claiming broadly supported public login.
- Generate a machine-readable capability catalogue and per-module compatibility tests; run health checks without reading private content.
- **Exit:** personal production usage documented and reproducible, with a rollback path and no unresolved high-risk auth/security gaps.

## 5. Priority decisions and tradeoffs

1. **One Worker deployment first, not one deployment per Google product.** Keep modules isolated in packages. Split to multiple Workers/service bindings only if security, cost, scaling or operational evidence justifies it.
2. **MCP is an interface, not the application core.** ChatGPT may support a different subset of remote tools or write actions than Firefox/Android. The direct HTTPS route must remain useful independently.
3. **Not every interaction should traverse the hub.** Simple Google page navigation, local browser state and optionally direct secure large-file transfers stay close to the user. Hub handles privileged automation and coordinated Google calls.
4. **Apps Script is an enhancement, not the baseline executor for Docs/Sheets.** Prefer native Workspace REST calls for common operations; use Apps Script for specific cross-product/custom logic.
5. **No large-bang migration.** Keep the verified Tasks slice and Firefox companion stable while moving reusable logic over step by step.
6. **Only one actual Google OAuth user account is needed initially**, but account identity, scopes and approvals must be explicit and not encoded as constants throughout the codebase.
7. **One narrow functioning feature beats weeks of scaffolding.** Run focused tests and one working demo per milestone, then proceed.

## 6. First four pull requests after roadmap acceptance

- **PR A — Workspace skeleton:** npm workspaces, TypeScript base config, contracts/core, explicit operation registry, validation and local smoke tests.
- **PR B — Tasks port:** bring in four existing Tasks operations and preserve approval semantics; demo local MCP `tools/list` and calls.
- **PR C — Apps Script read/project lifecycle:** `projects.get`, `getContent`, `create`, `updateContent` (whole-project safety), version/list deployment, mock tests and first disposable-project acceptance.
- **PR D — Apps Script API executable / run:** allowlisted function execution, parameters/output schemas, Google cloud project setup guide and live disposable-resource demo.

**Do not conflate a passing mock test with Google OAuth acceptance, remote MCP deployment, or a working Android app.** Once those are real, the roadmap moves on to Worker/gateway connectivity and the wider modules.

## 7. Risk register (keep short, actionable)

| Risk | Mitigation |
| --- | --- |
| Central Worker outage affects multiple clients | Maintain fallback local browser operations, health/rollback; don't force all UI through gateway |
| Token compromise / overbroad scopes | Least-privilege scopes, client identity separation, encrypted tokens, manual revocation and redacted logs |
| AI-triggered unwanted writes | Exact action/out-of-band approval, allowlisted operations, immutable audit summary, idempotency |
| Apps Script whole-project overwrite | Full project read, diff and manifest preservation, source versioning, explicit write approval |
| Apps Script executable configuration mismatch | Verify shared standard Google Cloud project and API executable; reject unsupported project configurations |
| Quotas, latency, request budgets | Small bounded Google calls, pagination, cooldowns, streaming/async patterns only when warranted |
| Too many MCP tool definitions | Namespaced service catalogs, per-client tool sets, schema discovery; keep operations explicit |
| Google account scope verification | Implement only provider-permitted scopes/consent mode, don't assume personal-use bypass |
| API/runtime portability | Keep Google modules independent of Cloudflare bindings; isolate adapters at gateway boundary |
| Losing existing functionality | Incremental migration, compare against source Tasks behavior, no automatic Firefox UI replacement |

## 8. Technical documentation / references

- Original independent Google REST MCP roadmap and migration baseline: https://github.com/cryogenized-spec/elf-shell-workspace-ai/blob/main/docs/custom-google-rest-mcp-roadmap.md
- Current Tasks MVP package: https://github.com/cryogenized-spec/elf-shell-workspace-ai/tree/main/mcp
- Google Apps Script REST API: https://developers.google.com/apps-script/api/reference/rest
- Apps Script project content replacement: https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent
- Apps Script remote execution requirements: https://developers.google.com/apps-script/api/how-tos/execute
- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- Cloudflare MCP transport: https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- Cloudflare remote MCP server: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Cloudflare MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/

## 9. Decision record (proposed)

- ADR-001: A single central Worker gateway with independently maintained Google service modules.
- ADR-002: Shared TypeScript operation registry, separate MCP and HTTPS transport adapters.
- ADR-003: Google OAuth authorization distinct from our hub/client authentication; explicit approved writes.
- ADR-004: GitHub is the source of truth for Apps Script source; compiled script deployments are derived and versioned.
- ADR-005: Migrate tested Tasks slice and preserve ELF//SHELL and CiRYVA independence until verified integration.
- ADR-006: For performance, use hybrid direct/local operations where appropriate; don't proxy all traffic blindly.

**Next action after approval:** implement PR A and PR B on separate branches; do not merge or deploy without operator review.
