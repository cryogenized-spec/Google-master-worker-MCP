import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  OperationRegistry, OperationError, publicError,
  type Principal, type SessionStore
} from "../../../packages/core/src/index.js";
import { GoogleJsonClient } from "../../../packages/google-http/src/index.js";
import { registerGoogleTasks } from "../../../packages/google-tasks/src/index.js";
import { registerAppsScript } from "../../../packages/google-apps-script/src/index.js";
import { createMcpServer } from "../../../packages/mcp-adapter/src/index.js";

/**
 * M3 private development gateway: no production OAuth or Google token broker.
 * Static bearer authentication is for local smoke tests only, NOT Android,
 * Firefox, ChatGPT OAuth, or an internet-exposed production service.
 */
export interface GatewayEnv {
  GMW_DEV_AUTH_ENABLED?: string;
  GMW_DEV_BEARER_TOKEN?: string;
}

export interface GatewayDependencies {
  /** Production default always denies Google access until OAuth is implemented. */
  sessions?: SessionStore;
  /** For synthetic tests only; defaults to the real global fetch. */
  googleFetch?: typeof fetch;
}

const lockedSessions: SessionStore = {
  async get() { return null; }
};
const idPattern = /^[a-z][a-z0-9_]*$/;
const maxRequestBytes = 32768;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function boundedInput(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > maxRequestBytes) {
    throw new OperationError("INPUT_TOO_LARGE");
  }
  if (!request.body) throw new OperationError("INVALID_JSON_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRequestBytes) throw new OperationError("INPUT_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("not an object");
    }
    return payload;
  } catch {
    throw new OperationError("INVALID_JSON_BODY");
  }
}

async function tokenMatches(supplied: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function authenticate(request: Request, env: GatewayEnv): Promise<Principal | null> {
  // Explicit local-development activation; reject weak or missing configured secrets.
  const expected = env.GMW_DEV_BEARER_TOKEN;
  if (env.GMW_DEV_AUTH_ENABLED !== "true" || typeof expected !== "string" ||
      expected.length < 32) {
    throw new OperationError("GATEWAY_NOT_CONFIGURED");
  }
  const header = request.headers.get("Authorization") ?? "";
  const supplied = /^Bearer\s+([^\s]+)$/i.exec(header)?.[1] ?? "";
  if (!supplied || !(await tokenMatches(supplied, expected))) return null;

  // Client/account are assigned by the server, NEVER accepted from HTTP body or headers.
  return { authenticated: true, clientId: "local_dev_http", accountId: "default" };
}

export function createGateway(dependencies: GatewayDependencies = {}) {
  const registry = new OperationRegistry(dependencies.sessions ?? lockedSessions);
  registerGoogleTasks(registry,
    new GoogleJsonClient("https://tasks.googleapis.com", "/tasks/v1/",
      dependencies.googleFetch ?? fetch));
  registerAppsScript(registry,
    new GoogleJsonClient("https://script.googleapis.com", "/v1/",
      dependencies.googleFetch ?? fetch));

  return {
    async fetch(request: Request, env: GatewayEnv): Promise<Response> {
      const { pathname, origin: requestOrigin } = new URL(request.url);
      if (pathname === "/healthz" && request.method === "GET") {
        return json({ service: "google-master-worker", state: "development",
          googleOAuth: "not_configured" });
      }
      // Browser CORS policy is intentionally not implemented yet.
      // Reject cross-origin browser calls, including credential-bearing requests.
      const originHeader = request.headers.get("Origin");
      if (originHeader && originHeader !== requestOrigin) {
        return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
      }

      let principal: Principal | null;
      try {
        principal = await authenticate(request, env);
      } catch (error) {
        return json(publicError(error), 503);
      }
      if (!principal) return json({ error: "CLIENT_UNAUTHORIZED" }, 401);

      if (pathname === "/v1/capabilities" && request.method === "GET") {
        return json({ operations: registry.catalogue().map(({ name, description, risk }) =>
          ({ name, description, risk })) });
      }

      const operation = /^\/v1\/operations\/([a-z][a-z0-9_]*)$/.exec(pathname)?.[1];
      if (operation && request.method === "POST") {
        if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
          return json({ error: "INVALID_CONTENT_TYPE" }, 415);
        }
        try {
          const input = await boundedInput(request);
          return json({ result: await registry.execute(operation, input, principal) });
        } catch (error) {
          const safe = publicError(error);
          const status = safe.error === "INVALID_ARGUMENTS" ||
            safe.error === "INVALID_JSON_BODY" ||
            safe.error === "INPUT_TOO_LARGE" ? 400 :
            safe.error === "UNKNOWN_OPERATION" ? 404 :
            safe.error === "GOOGLE_SESSION_NOT_CONFIGURED" ||
            safe.error === "GOOGLE_SESSION_EXPIRED" ? 503 :
            safe.error === "WRITE_APPROVAL_REQUIRED" ||
            safe.error === "GOOGLE_SCOPE_MISSING" ? 403 : 502;
          return json(safe, status);
        }
      }

      if (pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(request.method)) {
        // Fresh authenticated server per HTTP request. No global principal state.
        const handler = createMcpHandler(
          () => createMcpServer(registry, async () => principal),
          { legacy: "stateless" }
        );
        return handler.fetch(request);
      }

      return json({ error: "NOT_FOUND" }, 404);
    }
  };
}

// No Cloudflare bindings, OAuth secrets or Google credentials have been set up.
// An accidental deployment remains locked without an explicit dev secret.
export default createGateway();
