# Google Master Worker MCP

**Status: M1 TypeScript / local MCP development — NOT deployed or connected to any personal Google account.**

A single modular Google Workspace backend for private, bring-your-own-key use. Intended clients: **ChatGPT** (remote MCP), **ELF//SHELL Ayarime** (Firefox / HTTPS) and **CiRYVA Android** (HTTPS). The target gateway is a Cloudflare Worker, but service modules are designed to remain independently testable and portable.

## Current implementation on `feat/m1-core-tasks`

- TypeScript core: named operation registry, Google OAuth scope checks, trusted client/account identity, output schema validation, independent write approvals.
- Restricted HTTP transport to fixed Google API hosts and paths, with response-size caps and redacted errors.
- Four Google Tasks REST tools (list tasklists, list tasks, get task, approved task creation), migrated in behavior from the existing [ELF//SHELL Workspace AI MCP](https://github.com/cryogenized-spec/elf-shell-workspace-ai/tree/main/mcp).
- Local stdio MCP development entry and a separate human-operated CLI for one-use Task write approval.
- Synthetic/mock test suite and MCP stdio protocol handshake.

**Not yet implemented:** Cloudflare Worker, remote Streamable HTTP MCP, Google OAuth broker, credential encryption, first-party REST API, Apps Script operations, Android/Firefox integration, additional Google services, live Google test acceptance.

## Development

Requires Node.js 22 or later:

```sh
npm install
npm test
```

See [M1 developer instructions](docs/M1-DEVELOPMENT.md) for environment and approval details. Never commit credentials, environment files, or personal Google content.

## Architecture and roadmap

[Architecture and full staged roadmap (draft PR #1)](https://github.com/cryogenized-spec/Google-master-worker-MCP/pull/1). The roadmap remains a draft pending approval. M1 stays in a separate draft pull request, with no automatic merge or deployment.

MCP is one interface over the core, not the core itself. The planned Worker will handle remote identity, Google OAuth and risk-sensitive approvals; Firefox and Android will use the same typed operations over HTTPS. Browser navigation and appropriate large transfers may remain direct rather than pass through the Worker.

## License

MPL-2.0, matching the source project's license for the migrated Tasks functionality. See [LICENSE](LICENSE).
