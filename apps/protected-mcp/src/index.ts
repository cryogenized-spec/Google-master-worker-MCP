import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  OAuthResourceServer, insufficientScope, type AuthorizationServerBinding
} from "@cloudflare/workers-oauth-provider";
import { OperationRegistry, type Principal } from "../../../packages/core/src/index.js";
import { GoogleJsonClient } from "../../../packages/google-http/src/index.js";
import { registerGoogleTasks } from "../../../packages/google-tasks/src/index.js";
import { registerAppsScript } from "../../../packages/google-apps-script/src/index.js";
import { createMcpServer } from "../../../packages/mcp-adapter/src/index.js";

interface AuthProps { userId: "owner"; accountId: "default"; }
export interface ProtectedEnv {
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  AUTH_ISSUER: string;
  MCP_RESOURCE_URL: string;
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

/** Production route remains read-only AND disconnected from Google pending linking. */
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
      fetch(request, _env, ctx) {
        if (!ctx.auth.scope.includes("mcp:read")) {
          return insufficientScope(ctx.auth, ["mcp:read"]);
        }
        // The auth server must have independently verified the allowed Google sub.
        if (ctx.props.userId !== "owner" || ctx.props.accountId !== "default" ||
            ctx.auth.userId !== "owner" || !ctx.auth.clientId) {
          return new Response("Unauthorized principal", {status: 403});
        }
        const principal: Principal = {
          authenticated: true, accountId: "default", clientId: "oauth_client"
        };
        // No live Google session is yet available in this Worker. This ensures
        // client OAuth alone CANNOT read Google data without explicit Google linking.
        const registry = new OperationRegistry({async get() { return null; }});
        registerGoogleTasks(registry,
          new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/"));
        registerAppsScript(registry,
          new GoogleJsonClient("https://script.googleapis.com","/v1/"));
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
    if (path !== "/mcp" &&
        path !== "/.well-known/oauth-protected-resource/mcp") {
      return new Response("Not found", {status:404});
    }
    return createProtectedResource(env).fetch(request,env,ctx);
  }
};
