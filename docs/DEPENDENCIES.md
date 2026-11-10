# Supported runtimes and dependency policy

Checked **2026-11-10** against Node.js release schedule, npm published stable dist-tags, and GitHub Actions releases.

- Node.js: **26.x** (Active LTS, not 27 alpha). CI uses `.node-version` and `check-latest`.
- `@modelcontextprotocol/server`: **2.4.0** (SDK v2, current stable).
- `zod`: **4.6.7**.
- `typescript`: **7.0.2**.
- `@types/node`: **26.6.6**.
- `wrangler`: **4.158.0**.
- `actions/checkout` and `actions/setup-node`: **v7** (Node 24 internally, not deprecated Node 20).

Policy: latest **stable compatible** releases, never alpha/beta/RC by default. Prefer fewer dependencies. Do not use the deprecated `McpAgent`, `WorkerTransport`, or MCP SDK v1 for new code. Dependabot checks npm dependencies and GitHub Actions weekly, opening PRs for review rather than automatically merging. Test each update with CI before acceptance.

Current CI runs `npm install` because a resolved package lock is not yet committed. Before declaring production readiness, generate and commit `package-lock.json` using Node 26, switch to `npm ci`, and establish a repeatable dependency review and audit workflow. Never mistake `npm install` on CI for a reproducible locked build.

Sources:
- https://nodejs.org/en/about/previous-releases
- https://www.npmjs.com/package/@modelcontextprotocol/server
- https://www.npmjs.com/package/typescript
- https://www.npmjs.com/package/wrangler
- https://github.com/actions/checkout
- https://github.com/actions/setup-node
