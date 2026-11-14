import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  OAuthResourceServer, insufficientScope, type AuthorizationServerBinding
} from "@cloudflare/workers-oauth-provider";
import { OperationRegistry, type Principal } from "../../../packages/core/src/index.js";
import { GoogleJsonClient } from "../../../packages/google-http/src/index.js";
import { registerGoogleTasks } from "../../../packages/google-tasks/src/index.js";
import { registerAppsScript } from "../../../packages/google-apps-script/src/index.js";
import { registerWorkspaceServices } from "../../../packages/google-workspace/src/index.js";
import { registerGoogleReadCatalogue } from "../../../packages/google-read-catalogue/src/index.js";
import { registerGoogleWriteCatalogue } from "../../../packages/google-write-catalogue/src/index.js";
import { createMcpServer, withOAuthToolSchemes } from "../../../packages/mcp-adapter/src/index.js";
import { handleReadOnlyApi, isRestPath, restPreflight, corsOrigin, corsResponse } from "../../../packages/rest-adapter/src/index.js";
import { createWorkspaceReadSessionStore, scopedMcpClientId, type WorkspaceVaultEnv } from "../../../packages/google-auth/src/worker-session.js";

interface AuthProps { userId: "owner"; accountId: "default"; }
export interface ProtectedEnv extends WorkspaceVaultEnv {
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  AUTH_ISSUER: string;
  MCP_RESOURCE_URL: string;
  GMW_ALLOWED_BROWSER_ORIGINS?: string;
  GMW_WRITES_ENABLED?: string;
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


function createReadRegistry(env: ProtectedEnv): OperationRegistry {
  // A client token cannot activate Google reads. The D1 session remains
  // independently gated by GMW_WORKSPACE_READS_ENABLED and Google consent.
  const writesEnabled=env.GMW_WRITES_ENABLED==="true";
  // Token validation below requires mcp:write before clients reach this
  // registry when writes are enabled; Google scopes remain checked per operation.
  const registry = new OperationRegistry(createWorkspaceReadSessionStore(env),
    writesEnabled ? "direct" : undefined);
  registerGoogleTasks(registry,
    new GoogleJsonClient("https://tasks.googleapis.com", "/tasks/v1/"));
  registerAppsScript(registry,
    new GoogleJsonClient("https://script.googleapis.com", "/v1/"));
  registerWorkspaceServices(registry);
  registerGoogleReadCatalogue(registry);
  if(writesEnabled) registerGoogleWriteCatalogue(registry);
  return registry;
}

function bearerChallenge(env: ProtectedEnv, error: string, status = 401): Response {
  const canonical = new URL(env.MCP_RESOURCE_URL);
  const metadata = canonical.origin + "/.well-known/oauth-protected-resource/mcp";
  const demanded=env.GMW_WRITES_ENABLED==="true" ? "mcp:read mcp:write" : "mcp:read";
  const header = 'Bearer realm="Google Master Worker", error="' + error +
    '", resource_metadata="' + metadata + '", scope="' + demanded + '"';
  return new Response(JSON.stringify({error: error.toUpperCase()}), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": header,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

/** REST must route separately: the MCP-specific OAuth wrapper does not
 * dispatch arbitrary /v1 paths. Both resource protocols validate through the
 * same private AUTH_SERVER RPC and exact resource audience. */
async function protectedReadApi(
  request: Request, env: ProtectedEnv
): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+\/=-]{8,8192})$/i.exec(authorization);
  if (!match) return bearerChallenge(env, "invalid_token");
  let auth: Awaited<ReturnType<ProtectedEnv["AUTH_SERVER"]["validateToken"]>>;
  try {
    auth = await env.AUTH_SERVER.validateToken(env.MCP_RESOURCE_URL, match[1]);
  } catch {
    return new Response(JSON.stringify({error:"AUTHORIZATION_UNAVAILABLE"}), {
      status: 503, headers: {
        "Content-Type": "application/json", "Cache-Control": "no-store"
      }
    });
  }
  if (!auth || auth.audience !== env.MCP_RESOURCE_URL ||
      (auth.expiresAt !== undefined &&
        (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()/1000)) ||
      !auth.clientId || typeof auth.clientId !== "string") {
    return bearerChallenge(env, "invalid_token");
  }
  // A read-only token must still be able to list and use read operations.
  // Write tools independently require mcp:write, without a new Google vault login.
  if (!Array.isArray(auth.scope) || !auth.scope.includes("mcp:read")) {
    return bearerChallenge(env, "insufficient_scope", 403);
  }
  if (auth.userId !== "owner" ||
      auth.props?.userId !== "owner" ||
      auth.props?.accountId !== "default") {
    return bearerChallenge(env, "invalid_token");
  }
  let principal: Principal;
  try {
    principal = {
      authenticated: true,
      accountId: "default",
      clientId: await scopedMcpClientId(auth.clientId)
    };
  } catch {
    return bearerChallenge(env, "invalid_token");
  }
  let registry: OperationRegistry;
  try {
    registry = createReadRegistry(env);
  } catch {
    return new Response(JSON.stringify({error:"WORKSPACE_VAULT_NOT_CONFIGURED"}), {
      status: 503, headers:{
        "Content-Type":"application/json","Cache-Control":"no-store"
      }
    });
  }
  const operation=/^\/v1\/operations\/([a-z][a-z0-9_]{0,95})$/.exec(
    new URL(request.url).pathname)?.[1];
  if(env.GMW_WRITES_ENABLED==="true" && !auth.scope.includes("mcp:write") &&
     operation && registry.catalogue().some(meta=>meta.name===operation && meta.risk!=="read")){
    return bearerChallenge(env,"insufficient_scope",403);
  }
  return handleReadOnlyApi(request, registry, principal,
    {writesEnabled:env.GMW_WRITES_ENABLED==="true" && auth.scope.includes("mcp:write")});
}

/** Owner OAuth resource: writes require a one-time client mcp:write grant. */
export function createProtectedResource(env: ProtectedEnv) {
  return new OAuthResourceServer<ProtectedEnv, AuthProps>({
    resourceMetadata: {
      resource: env.MCP_RESOURCE_URL,
      authorization_servers: [env.AUTH_ISSUER],
      resource_name: "Google Master Worker (private)"
    },
    // The resource-wide gate only requires read access. Individual write
    // tools publish their stronger OAuth permission and handle upgrades.
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

        let registry: OperationRegistry;
        try { registry = createReadRegistry(_env); }
        catch {
          return new Response("Workspace vault unavailable", {
            status:503,headers:{"Cache-Control":"no-store"}
          });
        }
        const handler = createMcpHandler(
          () => createMcpServer(registry, async () => principal, {
            readOnly: _env.GMW_WRITES_ENABLED!=="true",
            oauth: {
              grantedScopes:ctx.auth.scope,
              resourceMetadataUrl:
                new URL("/.well-known/oauth-protected-resource/mcp",
                  _env.MCP_RESOURCE_URL).toString()
            }
          }),
          {legacy: "stateless"}
        );
        return withOAuthToolSchemes(request,r=>handler.fetch(r),registry);
      }
    }
  });
}

export default {
  async fetch(request: Request, env: ProtectedEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") {
      return Response.json({status:"locked", googleConnection:false});
    }
    if (!configured(env,request)) {
      return new Response("MCP OAuth resource not configured", {status:503});
    }
    if (path.startsWith("/v1/")) {
      if (!isRestPath(path)) {
        return new Response("Not found",{status:404});
      }
      if (request.method === "OPTIONS") {
        return restPreflight(request,env.GMW_ALLOWED_BROWSER_ORIGINS);
      }
      const origin = corsOrigin(request,env.GMW_ALLOWED_BROWSER_ORIGINS);
      if (origin === false) {
        return new Response("Browser origin forbidden",{
          status:403,headers:{"Cache-Control":"no-store"}
        });
      }
      return corsResponse(await protectedReadApi(request,env),origin);
    }
    if (path !== "/mcp" &&
        path !== "/.well-known/oauth-protected-resource/mcp") {
      return new Response("Not found",{status:404});
    }
    const response=await createProtectedResource(env).fetch(request,env,ctx);
    return response;
  }
};
