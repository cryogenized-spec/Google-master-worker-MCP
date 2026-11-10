# M11 — Local Cloudflare Worker OAuth acceptance checks

This milestone adds a **real local workerd multi-Worker test harness** to complement the existing portable Node unit tests and Wrangler \`--dry-run\` bundle checks. No public Cloudflare deployment, domain, Google Cloud account, credential or D1 production resource is used.

## What is tested

The official, non-deprecated Wrangler \`createTestHarness()\` starts two Workers in a local \`workerd\` instance:

- the **production** \`apps/protected-mcp/src/index.ts\` entrypoint, built from source;
- a **test-only** Worker at \`tests/fixtures/oauth-test-auth-worker.ts\`, which mocks the authorization Worker's \`validateToken(resource, token)\` RPC method and recognizes a single hardcoded fake token. It does **not** implement or bypass real OAuth in production, and is not listed in any deployable Wrangler configuration.

The protected Worker connects through its **actual internal Service Binding** \`AUTH_SERVER\`, with the same default-export binding semantics established in M9. The test harness supplies only mock \`AUTH_ISSUER\`, \`MCP_RESOURCE_URL\`, and \`GMW_WORKSPACE_READS_ENABLED=false\`. There is **no Google D1 connection, no Google session, and no Google API request**.

The harness verifies: public minimal health response; missing/invalid client bearer rejected with a 401 challenge; test-authorized read-only tool catalogue; write-name rejection; read requests still denied without Google Workspace authorization; exact-origin CORS preflight and rejection; CORS for permitted browser success and OAuth failure; MCP route requiring its own OAuth token.

## Running locally

On Linux Mint with Node 26 and the reviewed source checkout:

\`\`\`bash
npm ci
npm test
npm run test:runtime
\`\`\`

\`npm run test:runtime\` uses the exact Wrangler version in the committed lockfile. It does not use deprecated \`unstable_dev()\` or \`unstable_startWorker()\` and does not need a Cloudflare login. It executes in a **local workerd** process through Cloudflare's test harness, which is *not a hardened security sandbox*. Run only trusted source code.

## Important limitations

- The mock authorization Worker only verifies the **resource-server side** of the OAuth contract. It does **not** establish that the real Google login, consent page, token endpoint, durable KV, or token revocation function correctly under production bindings.
- The test is synthetic and fully local: this does **not** demonstrate successful deployment or a real Google Tasks read.
- Real deployments need Cloudflare KV/D1, operator-controlled domains, OAuth client registrations and secrets, migrations, policy review and a live disposable-resource acceptance test.
- The first-party TypeScript and Android reference clients are still unintegrated into Ayarime and CiRYVA. No Android binaries are built here.
- No remote writes are exposed. The live protected resource remains read-only by design.
- Do not use the old local development bearer gateway for public Internet connectivity.

Official Cloudflare documentation: https://developers.cloudflare.com/workers/testing/test-harness/get-started/ and https://developers.cloudflare.com/workers/wrangler/api/#createtestharness
