# Google Master Worker MCP

**Status:** architecture and roadmap draft; no production service deployed.

A private-use, TypeScript-first Google Workspace integration backend that exposes independently maintained Google API modules through an authenticated remote MCP gateway and a reusable HTTPS interface for **ELF//SHELL Ayarime** and **CiRYVA Android**.

## Principles

- **One shared implementation, multiple clients:** Google REST adapters are not coupled to MCP, Firefox, or Android.
- **Modular Google services:** Apps Script, Drive, Sheets, Docs, Tasks, Calendar and additional integrations use distinct, typed modules and named operations.
- **Personal BYOK deployment:** Cloudflare Workers, operator-controlled Google Cloud OAuth, and explicitly authorized accounts.
- **Separate identities:** Access to our gateway is not equivalent to Google account authorization; scope and write-approval checks occur independently.
- **Safe changes:** source diffs, approvals for meaningful mutations, audit breadcrumbs, idempotency, and rollback paths. Do not expose arbitrary Google REST requests or credentials as AI tools.
- **Incremental delivery:** one functioning end-to-end vertical slice at a time; no monolithic rewrite or test-first delivery blockade.

## Project lineage

The established Tasks REST MCP development slice in [ELF//SHELL Workspace AI](https://github.com/cryogenized-spec/elf-shell-workspace-ai/tree/main/mcp) provides four tools and a local stdio harness, with mock API tests and separate local action approvals. Those pieces are a **source of reusable logic**, not a hosted production deployment. Migration will preserve verified functionality and will not affect the existing Firefox companion until explicitly integrated.

## Roadmap

See the proposed [development roadmap](docs/ROADMAP.md) in the draft pull request. No deploy, credential onboarding, data changes or production OAuth configuration is authorized by this document.

## Status and workflow

This repository starts with a minimal README to establish its default branch. Architecture decisions and the milestone plan are developed in a **draft pull request** before implementation or merging. Keep credentials and user Google account data out of Git commits, issues, pull requests and CI logs.

License, precise package layout and release policy remain to be established by approved implementation changes.
