# Supported runtimes and dependency policy

Checked **2026-11-10** against Node.js release schedule, npm published stable dist-tags, and GitHub Actions releases.

- Node.js: **26.x** (Active LTS, not 27 alpha). CI uses `.node-version` and `check-latest`.
- `@modelcontextprotocol/server`: **2.4.0** (SDK v2, current stable).
- `zod`: **4.6.7**.
- `typescript`: **7.0.2**.
- `@types/node`: **26.6.6**.
- `wrangler`: **4.159.0**.
- `actions/checkout` and `actions/setup-node`: **v7** (Node 24 internally, not deprecated Node 20).

Policy: latest **stable compatible** releases, never alpha/beta/RC by default. Prefer fewer dependencies. Do not use the deprecated `McpAgent`, `WorkerTransport`, or MCP SDK v1 for new code. Dependabot checks npm dependencies and GitHub Actions weekly, opening PRs for review rather than automatically merging. Test each update with CI before acceptance.

A genuine npm-generated `package-lock.json` is now committed, and CI uses `npm ci` on Node 26. The lockfile pins transitive dependencies and package integrity hashes. Dependabot continues to open reviewable updates; do not silently regenerate the lockfile in CI. Review transitive changes and run the full test suite before merging dependency updates.

Sources:
- https://nodejs.org/en/about/previous-releases
- https://www.npmjs.com/package/@modelcontextprotocol/server
- https://www.npmjs.com/package/typescript
- https://www.npmjs.com/package/wrangler
- https://github.com/actions/checkout
- https://github.com/actions/setup-node
