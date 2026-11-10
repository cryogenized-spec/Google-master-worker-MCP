import {
  AuthorizationError, CimdFetchError, OAuthAuthorizationServer,
  authorizationErrorRedirect, type AuthRequest
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { encodeBase64Url, sha256Url } from "../../../packages/google-auth/src/crypto.js";
import { verifyGoogleLogin, validLoginConfig } from "../../../packages/client-oauth/src/google-identity.js";
import { renderConsent } from "../../../packages/client-oauth/src/html.js";

interface AuthEnv {
  OAUTH_KV: KVNamespace;
  AUTH_ISSUER: string;
  MCP_RESOURCE_URL: string;
  GOOGLE_LOGIN_CLIENT_ID: string;
  GOOGLE_LOGIN_CLIENT_SECRET: string;
  GMW_ALLOWED_GOOGLE_SUB: string;
}
interface UpstreamState { verifier: string; }
interface AuthProps { userId: "owner"; accountId: "default"; }

const SCOPES = ["mcp:read", "offline_access"] as const;

function validRoot(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" &&
      !url.search && !url.hash && !url.username && !url.password && url.port === "";
  } catch { return false; }
}
function validResource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/mcp" &&
      !url.search && !url.hash && !url.username && !url.password && url.port === "";
  } catch { return false; }
}
function configured(env: AuthEnv): boolean {
  if (!env?.OAUTH_KV || !validRoot(env.AUTH_ISSUER) ||
      !validResource(env.MCP_RESOURCE_URL)) return false;
  return validLoginConfig({
    clientId: env.GOOGLE_LOGIN_CLIENT_ID,
    clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET,
    callback: new URL("/google/callback", env.AUTH_ISSUER).toString(),
    allowedSubject: env.GMW_ALLOWED_GOOGLE_SUB
  });
}
function authorizationServer(env: AuthEnv) {
  return new OAuthAuthorizationServer<AuthEnv, AuthProps>({
    issuer: env.AUTH_ISSUER,
    resources: [env.MCP_RESOURCE_URL],
    scopesSupported: [...SCOPES],
    clientIdMetadataDocumentEnabled: true,
    // Older MCP clients can register dynamically. All clients need user consent.
    clientRegistrationEndpoint: "/oauth/register"
  });
}
function problem(status: number, message: string) {
  return new Response(message, {status, headers: {
    "Content-Type":"text/plain; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"
  }});
}
function redirect(location: string, headers: Headers): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

async function startAuthorization(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = authorizationServer(env).getOAuthApi(env);
  const request = await oauth.parseAuthRequest(req);
  const description = await oauth.describeConsent(request);
  // Set state cookie and frame-denying headers before drawing any client-controlled content.
  const consent = await oauth.beginConsent(request);
  consent.headers.set("Content-Type","text/html; charset=utf-8");
  return new Response(renderConsent(description, consent.handle), {
    status: 200, headers: consent.headers
  });
}

async function finishConsent(req: Request, env: AuthEnv): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (origin && origin !== env.AUTH_ISSUER.replace(/\/$/, "")) {
    return problem(403,"Wrong origin");
  }
  if (Number(req.headers.get("Content-Length") || "0") > 8192) {
    return problem(413,"Form too large");
  }
  const raw = await req.text();
  if (raw.length > 8192) return problem(413,"Form too large");
  const form = new URLSearchParams(raw);
  const handle = form.get("handle") ?? "";
  if (handle.length > 1024) return problem(400, "Invalid form");
  const oauth = authorizationServer(env).getOAuthApi(env);
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, {status: 302, headers: denied.headers});
  }
  const approved = await oauth.approveConsent(req, handle, {
    scope: form.getAll("scope")
  });
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const upstream = await oauth.beginUpstream(approved.request, {
    data: {verifier} satisfies UpstreamState,
    headers: approved.headers
  });
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.searchParams.set("response_type","code");
  google.searchParams.set("client_id", env.GOOGLE_LOGIN_CLIENT_ID);
  google.searchParams.set("redirect_uri",
    new URL("/google/callback",env.AUTH_ISSUER).toString());
  google.searchParams.set("scope","openid email");
  google.searchParams.set("state", upstream.state);
  google.searchParams.set("code_challenge_method", "S256");
  google.searchParams.set("code_challenge",await sha256Url(verifier));
  google.searchParams.set("prompt","select_account");
  return redirect(google.toString(), upstream.headers);
}

async function finishGoogle(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = authorizationServer(env).getOAuthApi(env);
  // The helper binds the upstream state to the same browser and consumes it once.
  const { request, data, headers } = await oauth.finishUpstream<UpstreamState>(req);
  const url = new URL(req.url);
  if (url.searchParams.has("error")) {
    return redirect(authorizationErrorRedirect(request,"access_denied"), headers);
  }
  const code = url.searchParams.get("code") ?? "";
  const identity = await verifyGoogleLogin(code, data.verifier, {
    clientId: env.GOOGLE_LOGIN_CLIENT_ID,
    clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET,
    callback: new URL("/google/callback",env.AUTH_ISSUER).toString(),
    allowedSubject: env.GMW_ALLOWED_GOOGLE_SUB
  });
  const {redirectTo} = await oauth.completeAuthorization({
    request,
    userId: identity.userId,
    metadata: {},
    scope: request.scope.filter(scope => SCOPES.includes(scope as typeof SCOPES[number])),
    props: identity
  });
  return redirect(redirectTo, headers);
}

function safeOAuthError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return problem(400,"Authorization request rejected");
  }
  if (error instanceof CimdFetchError) {
    return problem(400,"Client metadata could not be verified");
  }
  // Don't expose codes, tokens or provider response details.
  return problem(403,"Authorization could not be completed");
}

/** Private operator-only OAuth authorization server. No hardcoded test user. */
export default class AuthServer extends WorkerEntrypoint<AuthEnv> {
  async fetch(request: Request): Promise<Response> {
    if (!configured(this.env)) return problem(503,"Authorization not configured");
    if (new URL(request.url).origin !==
        new URL(this.env.AUTH_ISSUER).origin) return problem(421,"Unknown host");
    const path = new URL(request.url).pathname;
    try {
      if (path === "/authorize" && request.method === "GET") {
        return await startAuthorization(request,this.env);
      }
      if (path === "/authorize" && request.method === "POST") {
        return await finishConsent(request,this.env);
      }
      if (path === "/google/callback" && request.method === "GET") {
        return await finishGoogle(request,this.env);
      }
      return authorizationServer(this.env).fetch(request,this.env,this.ctx);
    } catch (error) {
      return safeOAuthError(error);
    }
  }

  validateToken(resource: string, token: string) {
    if (!configured(this.env)) throw Error("AUTH_NOT_CONFIGURED");
    return authorizationServer(this.env).validateToken(resource,token,this.env);
  }
}
