#!/usr/bin/env node
// Development-only local stdio server. Never expose this process publicly.
// stdout is reserved for MCP JSON-RPC, not diagnostic text or credentials.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OperationRegistry, type SessionStore } from "../../../packages/core/src/index.js";
import { registerGoogleTasks } from "../../../packages/google-tasks/src/index.js";
import { createMcpServer } from "../../../packages/mcp-adapter/src/index.js";
import { createFileApprovalGate } from "./approvals.js";

const accountId = process.env.GMW_GOOGLE_ACCOUNT || "default";
const sessions: SessionStore = {
  async get(requestedAccountId) {
    if (requestedAccountId !== accountId) return null;
    const accessToken = process.env.GMW_GOOGLE_ACCESS_TOKEN || "";
    const expiresAt = Date.parse(process.env.GMW_GOOGLE_TOKEN_EXPIRES_AT || "");
    const scopes = (process.env.GMW_GOOGLE_SCOPES || "").split(/\s+/).filter(Boolean);
    return accessToken && Number.isFinite(expiresAt)
      ? { accessToken, expiresAt, scopes } : null;
  }
};
serveStdio(() => {
  const registry = new OperationRegistry(sessions, createFileApprovalGate());
  registerGoogleTasks(registry);
  return createMcpServer(registry, async () => ({
    authenticated: true, clientId: "local_dev", accountId
  }));
});
