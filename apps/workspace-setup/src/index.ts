import { OperationError } from "../../../packages/core/src/index.js";
import { GoogleOAuthBroker, type GoogleOAuthConfig } from "../../../packages/google-auth/src/index.js";
import { WORKSPACE_SCOPES } from "../../../packages/google-auth/src/scopes.js";
import { OwnerBrowserStore, type OwnerSession } from "../../../packages/google-auth/src/browser-store.js";
import { GoogleOAuthStore, type D1DatabaseLike } from "../../../packages/google-auth/src/store.js";
import {
  encodeBase64Url, decodeBase64Url, importVaultKey,
  seal, unseal, sha256Url
} from "../../../packages/google-auth/src/crypto.js";
import { verifyGoogleLogin, validLoginConfig } from
  "../../../packages/client-oauth/src/google-identity.js";

const LOGIN_COOKIE = "__Host-gmw_login";
const LINK_COOKIE = "__Host-gmw_link";
const OWNER_COOKIE = "__Host-gmw_owner";
const CSRF_COOKIE = "__Host-gmw_csrf";
const LOGIN_MS = 10 * 60_000;
const SESSION_MS = 60 * 60_000;
const LINK_MS = 10 * 60_000;
const ALLOWED_SCOPES = new Set(WORKSPACE_SCOPES);
const GOOGLE_LOGIN = "https://accounts.google.com/o/oauth2/v2/auth";

interface SetupRateLimiter {
  limit(input: {key: string}): Promise<{success: boolean}>;
}

export interface SetupEnv {
  readonly SETUP_RATE_LIMITER?: SetupRateLimiter;
  readonly DB?: D1DatabaseLike;
  readonly SETUP_ORIGIN?: string;
  readonly GOOGLE_LOGIN_CLIENT_ID?: string;
  readonly GOOGLE_LOGIN_CLIENT_SECRET?: string;
  readonly GOOGLE_WORKSPACE_CLIENT_ID?: string;
  readonly GOOGLE_WORKSPACE_CLIENT_SECRET?: string;
  readonly GOOGLE_WORKSPACE_REDIRECT_URI?: string;
  readonly GMW_TOKEN_ENC_KEY?: string;
  readonly GMW_ALLOWED_GOOGLE_SUB?: string;
}

interface SetupServices {
  readonly origin: string;
  readonly db: D1DatabaseLike;
  readonly browser: OwnerBrowserStore;
  readonly vault: GoogleOAuthStore;
  readonly broker: GoogleOAuthBroker;
  readonly key: CryptoKey;
  readonly login: {
    clientId: string; clientSecret: string;
    callback: string; allowedSubject: string;
  };
}
interface OwnerContext {
  readonly sessionRaw: string;
  readonly sessionHash: string;
  readonly csrfRaw: string;
  readonly record: OwnerSession;
}

function safeOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search ||
        url.hash || url.username || url.password || url.port || raw !== url.origin) {
      return null;
    }
    return url.origin;
  } catch { return null; }
}
function reply(html: string, status = 200, headers?: Headers): Response {
  const out = headers ?? new Headers();
  out.set("Content-Type", "text/html; charset=utf-8");
  out.set("Cache-Control", "no-store");
  out.set("X-Content-Type-Options", "nosniff");
  out.set("X-Frame-Options", "DENY");
  out.set("Referrer-Policy", "no-referrer");
  out.set("Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'");
  return new Response(html, {status, headers: out});
}
function redirect(target: string, cookies: string[] = []): Response {
  const out = new Headers();
  out.set("Location", target);
  for (const c of cookies) out.append("Set-Cookie", c);
  const response = reply("", 303, out);
  return response;
}
function cookie(name: string, raw: string, ageSec: number): string {
  return name + "=" + raw + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + ageSec;
}
function expire(name: string): string { return cookie(name, "", 0); }
function randomToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function getCookie(req: Request, name: string): string | null {
  const values = (req.headers.get("Cookie") || "").split(";")
    .map(x => x.trim())
    .filter(x => x.startsWith(name + "="))
    .map(x => x.slice(name.length + 1));
  // Duplicate cookies (e.g. a conflicting Path cookie) are never accepted.
  if (values.length !== 1) return null;
  return /^[A-Za-z0-9_-]{43}$/.test(values[0]) &&
    decodeBase64Url(values[0]).byteLength === 32 ? values[0] : null;
}
function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";");
}
/** The Cloudflare rate-limiting binding is approximate and location-scoped.
 * All anonymous requests without a trusted connecting IP share ONE key;
 * missing IP metadata must never create a distinct, attacker-chosen key.
 */
async function checkSetupRateLimit(request: Request, env: SetupEnv, route: string): Promise<boolean> {
  const originIp = request.headers.get("CF-Connecting-IP") || "";
  const ip = /^[0-9a-fA-F.:]{3,64}$/.test(originIp) ? originIp : "unknown";
  const limiter = env.SETUP_RATE_LIMITER;
  if (!limiter) throw new OperationError("SETUP_RATE_LIMIT_NOT_CONFIGURED");
  const result = await limiter.limit({key: route + ":" + ip});
  return result.success === true;
}

function csrfOkay(req: Request, origin: string): boolean {
  return req.headers.get("Origin") === origin &&
    (req.headers.get("Content-Type") || "").split(";")[0].trim() ===
      "application/x-www-form-urlencoded";
}
async function parseForm(req: Request): Promise<URLSearchParams> {
  const contentLength = Number(req.headers.get("Content-Length") || "0");
  if (!Number.isFinite(contentLength) || contentLength > 4096 || contentLength < 0) {
    throw new OperationError("SETUP_FORM_INVALID");
  }
  const body = await req.text();
  if (new TextEncoder().encode(body).byteLength > 4096) {
    throw new OperationError("SETUP_FORM_INVALID");
  }
  return new URLSearchParams(body);
}
function one(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);
  return values.length === 1 ? values[0] : null;
}
async function services(
  env: SetupEnv, request: Request, googleFetch: typeof fetch
): Promise<SetupServices> {
  const origin = safeOrigin(env.SETUP_ORIGIN);
  if (!origin || new URL(request.url).origin !== origin ||
      !env.DB || typeof env.DB.prepare !== "function" ||
      !env.SETUP_RATE_LIMITER || typeof env.SETUP_RATE_LIMITER.limit !== "function" ||
      !env.GMW_TOKEN_ENC_KEY || !env.GMW_ALLOWED_GOOGLE_SUB) {
    throw new OperationError("SETUP_NOT_CONFIGURED");
  }
  const login = {
    clientId: env.GOOGLE_LOGIN_CLIENT_ID || "",
    clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET || "",
    callback: origin + "/google/callback",
    allowedSubject: env.GMW_ALLOWED_GOOGLE_SUB
  };
  if (!validLoginConfig(login) ||
      env.GOOGLE_WORKSPACE_REDIRECT_URI !== origin + "/oauth/google/callback") {
    throw new OperationError("SETUP_NOT_CONFIGURED");
  }
  const workspace: GoogleOAuthConfig = {
    clientId: env.GOOGLE_WORKSPACE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_WORKSPACE_CLIENT_SECRET || "",
    redirectUri: env.GOOGLE_WORKSPACE_REDIRECT_URI,
    allowedSubject: env.GMW_ALLOWED_GOOGLE_SUB,
    encryptionKeyBase64Url: env.GMW_TOKEN_ENC_KEY
  };
  try {
    const key = await importVaultKey(env.GMW_TOKEN_ENC_KEY);
    const db = env.DB;
    const vault = new GoogleOAuthStore(db);
    return {
      origin, db, vault, key, login,
      browser: new OwnerBrowserStore(db),
      broker: new GoogleOAuthBroker(vault, workspace, googleFetch)
    };
  } catch { throw new OperationError("SETUP_NOT_CONFIGURED"); }
}

async function owner(req: Request, s: SetupServices, now: number): Promise<OwnerContext | null> {
  const sessionRaw = getCookie(req, OWNER_COOKIE);
  const csrfRaw = getCookie(req, CSRF_COOKIE);
  if (!sessionRaw || !csrfRaw) return null;
  const sessionHash = await sha256Url(sessionRaw);
  const record = await s.browser.getSession(sessionHash, now);
  if (!record || record.csrf_hash !== await sha256Url(csrfRaw)) return null;
  return {sessionRaw,sessionHash,csrfRaw,record};
}

async function beginLogin(s: SetupServices, now: number): Promise<Response> {
  const state = randomToken();
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const stateHash = await sha256Url(state);
  const verifierEnc = await seal(s.key, "owner-login:" + stateHash, {verifier});
  await s.browser.createLogin({state_hash: stateHash, verifier_enc: verifierEnc,
    expires_at: now + LOGIN_MS});

  const url = new URL(GOOGLE_LOGIN);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", s.login.clientId);
  url.searchParams.set("redirect_uri", s.login.callback);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", await sha256Url(verifier));
  url.searchParams.set("prompt", "select_account");
  return redirect(url.toString(),[cookie(LOGIN_COOKIE,state,600)]);
}

async function finishLogin(
  s: SetupServices, req: Request, now: number, googleFetch: typeof fetch
): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state || state !== getCookie(req,LOGIN_COOKIE)) {
    throw new OperationError("SETUP_LOGIN_STATE_MISMATCH");
  }
  const stateHash = await sha256Url(state);
  const data = await s.browser.consumeLogin(stateHash,now);
  if (!data) throw new OperationError("SETUP_LOGIN_STATE_EXPIRED");
  if (url.searchParams.has("error")) return redirect(s.origin+"/setup?status=cancelled",
    [expire(LOGIN_COOKIE)]);
  const {verifier} = await unseal<{verifier:string}>(
    s.key,"owner-login:"+stateHash,data.verifier_enc);
  await verifyGoogleLogin(url.searchParams.get("code") || "",verifier,s.login,googleFetch);

  const session = randomToken();
  const csrf = randomToken();
  await s.browser.createSession({
    session_hash: await sha256Url(session),
    csrf_hash: await sha256Url(csrf),
    expires_at: now + SESSION_MS
  });
  return redirect(s.origin+"/setup",[
    expire(LOGIN_COOKIE),
    cookie(OWNER_COOKIE,session,3600),
    cookie(CSRF_COOKIE,csrf,3600)
  ]);
}
function documentPage(connected:boolean, csrf:string, status:string): string {
  const statusText = status === "connected" ? "Workspace connected successfully." :
    status === "cancelled" ? "Authorization cancelled." :
    status === "disconnected" ? "Stored connection disconnected and revoked." : "";
  const connect = connected ? (
    '<p>Google Workspace vault: <strong>Connected</strong></p>'+
    '<form method="post" action="/setup/disconnect"><input type="hidden" name="csrf" value="'+htmlEscape(csrf)+'">'+
    '<button type="submit">Revoke Google grant and disconnect</button></form>'
  ):(
    '<p>Google Workspace vault: <strong>Not connected</strong></p>'+
    '<p>This requests the complete registered Workspace OAuth scope bundle in one consent session. '+
    'Google account eligibility and API access restrictions still apply. '+
    'Cloudflare MCP operations remain separately controlled.</p>'+
    '<form method="post" action="/setup/google/connect"><input type="hidden" name="csrf" value="'+htmlEscape(csrf)+'">'+
    WORKSPACE_SCOPES.map(scope => '<input type="hidden" name="scope" value="'+htmlEscape(scope)+'">').join('')+
    '<details><summary>Review all '+WORKSPACE_SCOPES.length+' requested scopes</summary><ul>'+
    WORKSPACE_SCOPES.map(scope => '<li>'+htmlEscape(scope)+'</li>').join('')+
    '</ul></details>'+
    '<p><button type="submit">Authorize complete Google Workspace bundle</button></p></form>'
  );
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>Google Master Worker setup</title></head><body>'+
    '<main><h1>Google Master Worker · Private setup</h1>'+
    '<p>Operator identity verified. This page never displays OAuth tokens.</p>'+
    (statusText ? '<p role="status">'+htmlEscape(statusText)+'</p>' : '')+
    connect+
    '<p>Remote MCP Google access stays disabled until separately enabled in Cloudflare.</p>'+
    '<form method="post" action="/setup/logout"><input type="hidden" name="csrf" value="'+htmlEscape(csrf)+'">'+
    '<button type="submit">Log out of setup</button></form></main></body></html>';
}
async function formAuthenticated(
  req: Request, s: SetupServices, now: number
): Promise<{ctx:OwnerContext;form:URLSearchParams}> {
  const ctx = await owner(req,s,now);
  if (!ctx) throw new OperationError("SETUP_OWNER_NOT_AUTHENTICATED");
  if (!csrfOkay(req,s.origin)) throw new OperationError("SETUP_CSRF_REJECTED");
  const form = await parseForm(req);
  if (one(form,"csrf") !== ctx.csrfRaw) throw new OperationError("SETUP_CSRF_REJECTED");
  return {ctx,form};
}
async function startLink(
  req: Request, s: SetupServices, now: number
): Promise<Response> {
  const {ctx,form} = await formAuthenticated(req,s,now);
  if ([...form.keys()].some(key => key !== "csrf" && key !== "scope")) {
    throw new OperationError("SETUP_FORM_INVALID");
  }
  const scopes = form.getAll("scope");
  if (!scopes.length || scopes.length > WORKSPACE_SCOPES.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some(value => !ALLOWED_SCOPES.has(value))) {
    throw new OperationError("SETUP_SCOPES_REJECTED");
  }
  const started = await s.broker.begin({
    authenticated:true, accountId:"default",clientId:"owner_browser"
  },scopes);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) throw new OperationError("SETUP_STATE_INVALID");
  await s.browser.createLink(
    await sha256Url(state),ctx.sessionHash,Math.min(started.expiresAt,now+LINK_MS)
  );
  return redirect(url.toString(),[cookie(LINK_COOKIE,state,600)]);
}
async function finishLink(
  req: Request, s: SetupServices, now: number
): Promise<Response> {
  const ctx = await owner(req,s,now);
  if (!ctx) throw new OperationError("SETUP_OWNER_NOT_AUTHENTICATED");
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state || state !== getCookie(req,LINK_COOKIE)) {
    throw new OperationError("SETUP_LINK_STATE_MISMATCH");
  }
  const valid = await s.browser.consumeLink(
    await sha256Url(state),ctx.sessionHash,now
  );
  if (!valid) throw new OperationError("SETUP_LINK_STATE_EXPIRED");
  if (url.searchParams.has("error")) {
    return redirect(s.origin+"/setup?status=cancelled",[expire(LINK_COOKIE)]);
  }
  // Google's code is redeemed server-side, with PKCE and matching Google OIDC
  // subject verification, by the pre-existing encrypted vault broker.
  await s.broker.complete(state,url.searchParams.get("code") || "");
  return redirect(s.origin+"/setup?status=connected",[expire(LINK_COOKIE)]);
}

export function createSetupApp(
  dependencies: { googleFetch?: typeof fetch; now?: () => number } = {}
) {
  const googleFetch=dependencies.googleFetch ?? fetch;
  const clock=dependencies.now ?? (()=>Date.now());
  return {
    async fetch(request:Request,env:SetupEnv):Promise<Response> {
      const pathname=new URL(request.url).pathname;
      if (pathname==="/healthz" && request.method==="GET") {
        return reply("Setup service unavailable until configured.",503);
      }
      let s: SetupServices;
      try { s=await services(env,request,googleFetch); }
      catch { return reply("Private setup unavailable.",503); }
      try {
        // Rate-limit entrypoints BEFORE creating state, exchanging OAuth codes,
        // reading a browser session or calling Google. Deny on limiter errors.
        const guardedPaths = new Set([
          "/setup/login", "/google/callback", "/setup/google/connect",
          "/oauth/google/callback", "/setup/disconnect", "/setup/logout"
        ]);
        if (guardedPaths.has(pathname)) {
          let allowed = false;
          try { allowed = await checkSetupRateLimit(request,env,pathname); }
          catch { return reply("Setup temporarily unavailable.",503); }
          if (!allowed) {
            const headers = new Headers({"Retry-After":"60"});
            return reply("Too many requests. Try again later.",429,headers);
          }
        }
        const now=clock();
        if (pathname==="/setup/login" && request.method==="GET") {
          return await beginLogin(s,now);
        }
        if (pathname==="/google/callback" && request.method==="GET") {
          return await finishLogin(s,request,now,googleFetch);
        }
        if (pathname==="/setup" && request.method==="GET") {
          const ctx=await owner(request,s,now);
          if (!ctx) return redirect(s.origin+"/setup/login");
          const connected=Boolean(await s.vault.load("default"));
          const status=new URL(request.url).searchParams.get("status") || "";
          return reply(documentPage(connected,ctx.csrfRaw,status));
        }
        if (pathname==="/setup/google/connect" && request.method==="POST") {
          return await startLink(request,s,now);
        }
        if (pathname==="/oauth/google/callback" && request.method==="GET") {
          return await finishLink(request,s,now);
        }
        if (pathname==="/setup/disconnect" && request.method==="POST") {
          await formAuthenticated(request,s,now);
          await s.broker.revokeAndDisconnect("default");
          return redirect(s.origin+"/setup?status=disconnected");
        }
        if (pathname==="/setup/logout" && request.method==="POST") {
          const {ctx}=await formAuthenticated(request,s,now);
          await s.browser.removeSession(ctx.sessionHash);
          return redirect(s.origin+"/setup/login",[
            expire(OWNER_COOKIE),expire(CSRF_COOKIE),expire(LINK_COOKIE)
          ]);
        }
        return reply("Not found",404);
      } catch (error) {
        // Never show OAuth codes, tokens, secrets, internal D1 errors or stacks.
        const type=error instanceof OperationError ? error.code : "SETUP_OPERATION_FAILED";
        const status=type.includes("NOT_CONFIGURED") ? 503 :
          type.includes("ALREADY_CONNECTED") ? 409 : 403;
        return reply("Setup request rejected: "+htmlEscape(type),status);
      }
    }
  };
}

export default createSetupApp();
