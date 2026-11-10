import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  OAuthResourceServer, insufficientScope, type AuthorizationServerBinding
} from "@cloudflare/workers-oauth-provider";
import { OperationRegistry, type Principal } from "../../../packages/core/src/index.js";
import { GoogleJsonClient } from "../../../packages/google-http/src/index.js";
import { registerGoogleTasks } from "../../../packages/google-tasks/src/index.js";
import { registerAppsScript } from "../../../packages/google-apps-script/src/index.js";
import { createMcpServer } from "../../../packages/mcp-adapter/src/index.js";
import { handleReadOnlyApi, isRestPath, restPreflight, corsOrigin, corsResponse } from "../../../packages/rest-adapter/src/index.js";
import { createWorkspaceReadSessionStore, scopedMcpClientId, type WorkspaceVaultEnv } from "../../../packages/google-auth/src/worker-session.js";

interface AuthProps { userId: "owner"; accountId: "default"; }
export interface ProtectedEnv extends WorkspaceVaultEnv {
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  AUTH_ISSUER: string;
  MCP_RESOURCE_URL: string;
  GMW_ALLOWED_BROWSER_ORIGINS?: string;
}

function configured(env: ProtectedEnv, request: Request): boolean {
  try {
    const issuer = new URL(env.AUTH_ISSUER);
    const resource = new URL(env.MCP_RESOURCE_URL);
    return Boolean(env.AUTH_SERVER?.validateToken) &&
      issuer.protocol === "https:" && issuer.pathname === "/" &&
      !issuer.username && !issuer.password && !issuer.search && !issuer.hash &&
      resource.protocol === "https:" && resource.pathname === "/mcp" &&
      !resource.username && !resource.password && !resource.search && !resource.hash &&
      new URL(request.url).origin === resource.origin;
  } catch { return false; }
}

/** Read-only OAuth resource. Google access requires a separate encrypted vault connection and explicit opt-in. */
export function createProtectedResource(env: ProtectedEnv) {
  return new OAuthResourceServer<ProtectedEnv, AuthProps>({
    resourceMetadata: {
      resource: env.MCP_RESOURCE_URL,
      authorization_servers: [env.AUTH_ISSUER],
      resource_name: "Google Master Worker (private)"
    },
    requiredScopes: ["mcp:read"],
    validateToken: env => env.AUTH_SERVER.validateToken,
    handler: {
      async fetch(request, _env, ctx) {
        if (!ctx.auth.scope.includes("mcp:read")) {
          return insufficientScope(ctx.auth, ["mcp:read"]);
        }
        // The auth server must have independently verified the allowed Google sub.
        if (ctx.props.userId !== "owner" || ctx.props.accountId !== "default" ||
            ctx.auth.userId !== "owner" || !ctx.auth.clientId) {
          return new Response("Unauthorized principal", {status: 403});
        }
        // Each validated OAuth client gets a stable opaque identity, without
        // relying on untrusted client display names or a fixed shared ID.
        let principal: Principal;
        try {
          principal = {
            authenticated: true, accountId: "default",
            clientId: await scopedMcpClientId(ctx.auth.clientId)
          };
        } catch {
          return new Response("Unauthorized principal", {status:403});
        }

        // An MCP sign-in is NOT permission to access Google. Workspace reads
        // need an independently granted, matching Google account in D1,
        // a server-held encryption key and explicit operator opt-in.
        let registry: OperationRegistry;
        try {
          const sessions = createWorkspaceReadSessionStore(_env);
          registry = new OperationRegistry(sessions);
        } catch {
          return new Response("Workspace vault unavailable", {
            status:503, headers: {"Cache-Control":"no-store"}
          });
        }
        registerGoogleTasks(registry,
          new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/"));
        registerAppsScript(registry,
          new GoogleJsonClient("https://script.googleapis.com","/v1/"));
        if (isRestPath(new URL(request.url).pathname)) {
          const origin = corsOrigin(request, _env.GMW_ALLOWED_BROWSER_ORIGINS);
          if (origin === false) {
            return new Response("Browser origin forbidden", {
              status:403,headers:{"Cache-Control":"no-store"}
            });
          }
          return corsResponse(await handleReadOnlyApi(request,registry,principal),origin);
        }
        const handler = createMcpHandler(
          () => createMcpServer(registry, async () => principal, {readOnly: true}),
          {legacy: "stateless"}
        );
        return handler.fetch(request);
      }
    }
  });
}

export default {
  fetch(request: Request, env: ProtectedEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") {
      return Response.json({status:"locked", googleConnection:false});
    }
    if (!configured(env,request)) {
      return new Response("MCP OAuth resource not configured", {status:503});
    }
    if (path.startsWith("/v1/")) {
      if (!isRestPath(path)) {
        return new Response("Not found", {
          status:404, headers:{"Cache-Control":"no-store"}
        });
      }
      if (request.method === "OPTIONS") {
        return restPreflight(request,env.GMW_ALLOWED_BROWSER_ORIGINS);
      }
      if (corsOrigin(request,env.GMW_ALLOWED_BROWSER_ORIGINS) === false) {
        return new Response("Browser origin forbidden",{
          status:403,headers:{"Cache-Control":"no-store"}
        });
      }
    } else if (path !== "/mcp" &&
        path !== "/.well-known/oauth-protected-resource/mcp") {
      return new Response("Not found", {status:404});
    }
    return createProtectedResource(env).fetch(request,env,ctx);
  }
};
