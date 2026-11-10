import { OperationError, type SessionStore } from "../../core/src/index.js";
import { GoogleOAuthBroker, type GoogleOAuthConfig } from "./index.js";
import { GoogleOAuthStore, type D1DatabaseLike } from "./store.js";

/**
 * Deliberate two-gate design:
 * 1. Protected OAuthResourceServer validates client and resource audience.
 * 2. Only this server-side SessionStore can decrypt a separately authorized
 *    Google Workspace connection; a missing opt-in remains disconnected.
 */
export interface WorkspaceVaultEnv {
  readonly DB?: D1DatabaseLike;
  readonly GMW_WORKSPACE_READS_ENABLED?: string;
  readonly GOOGLE_WORKSPACE_CLIENT_ID?: string;
  readonly GOOGLE_WORKSPACE_CLIENT_SECRET?: string;
  readonly GOOGLE_WORKSPACE_REDIRECT_URI?: string;
  readonly GMW_TOKEN_ENC_KEY?: string;
  readonly GMW_ALLOWED_GOOGLE_SUB?: string;
}

const DISCONNECTED: SessionStore = Object.freeze({
  async get() { return null; }
});

function getConfig(env: WorkspaceVaultEnv): GoogleOAuthConfig {
  if (!env.DB || typeof env.DB.prepare !== "function" ||
      !env.GOOGLE_WORKSPACE_CLIENT_ID ||
      !env.GOOGLE_WORKSPACE_CLIENT_SECRET ||
      !env.GOOGLE_WORKSPACE_REDIRECT_URI ||
      !env.GMW_TOKEN_ENC_KEY ||
      !env.GMW_ALLOWED_GOOGLE_SUB) {
    throw new OperationError("WORKSPACE_VAULT_NOT_CONFIGURED");
  }
  return {
    clientId: env.GOOGLE_WORKSPACE_CLIENT_ID,
    clientSecret: env.GOOGLE_WORKSPACE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_WORKSPACE_REDIRECT_URI,
    encryptionKeyBase64Url: env.GMW_TOKEN_ENC_KEY,
    allowedSubject: env.GMW_ALLOWED_GOOGLE_SUB
  };
}

export function createWorkspaceReadSessionStore(
  env: WorkspaceVaultEnv,
  googleFetch: typeof fetch = fetch
): SessionStore {
  // Never enable Google access merely because a client completed MCP login.
  // Missing, malformed or false flags keep all Google reads disconnected.
  if (env.GMW_WORKSPACE_READS_ENABLED !== "true") return DISCONNECTED;

  const config = getConfig(env);
  const store = new GoogleOAuthStore(env.DB!);
  const broker = new GoogleOAuthBroker(store, config, googleFetch);

  return {
    async get(accountId, clientId) {
      // Current system is personal single-operator; do not accept arbitrary
      // accounts or caller-supplied identity names.
      if (accountId !== "default" ||
          !/^mcp_[a-f0-9]{48}$/.test(clientId)) {
        throw new OperationError("CLIENT_UNAUTHORIZED");
      }
      return broker.get(accountId, clientId);
    }
  };
}

/** Stable, opaque, server-derived ID; handles CIMD URL client IDs. */
export async function scopedMcpClientId(clientId: string): Promise<string> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 2048) {
    throw new OperationError("CLIENT_UNAUTHORIZED");
  }
  const bytes = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(clientId)
  );
  return "mcp_" + Array.from(new Uint8Array(bytes))
    .slice(0, 24).map(x => x.toString(16).padStart(2, "0")).join("");
}
