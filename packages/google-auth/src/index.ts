import {
  OperationError, type GoogleSession, type Principal
} from "../../core/src/index.js";
import {
  decodeBase64Url, encodeBase64Url, importVaultKey, seal, unseal, sha256Url
} from "./crypto.js";
import { GoogleOAuthStore, type StoredConnection } from "./store.js";
import { verifyAuthorizedGoogleSubject } from "./identity.js";

const ALLOWED_SCOPES = new Set([
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/script.projects.readonly",
  "https://www.googleapis.com/auth/script.projects"
]);
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const GOOGLE_SUB = /^[0-9]{8,64}$/;
const OIDC_SCOPES = ["openid", "email"] as const;
const AUTHORIZATION_ORIGIN = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ORIGIN = "https://oauth2.googleapis.com/token";
const TOKEN_BODY_MAX_BYTES = 32 * 1024;
const STATE_LIFETIME_MS = 10 * 60 * 1000;

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must exactly equal the configured Google Web OAuth redirect URI. */
  readonly redirectUri: string;
  /** One 32-byte key encoded in canonical base64url, from a Worker secret. */
  readonly encryptionKeyBase64Url: string;
  /** Numeric Google OIDC subject independently verified for the owner at login. */
  readonly allowedSubject: string;
}
interface TokenEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}
interface PendingVerifier {
  readonly verifier: string;
}
interface TokenResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
  readonly grantedScopes?: string[];
}
export interface OAuthStart {
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}
export interface OAuthCompletion {
  readonly accountId: string;
  readonly connected: true;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

function cleanScopes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) {
    throw new OperationError("GOOGLE_SCOPES_INVALID");
  }
  const value = Array.from(new Set(raw));
  if (!value.every(item => typeof item === "string" && ALLOWED_SCOPES.has(item))) {
    throw new OperationError("GOOGLE_SCOPES_INVALID");
  }
  return value.sort();
}

function validatePrincipal(principal: Principal): void {
  if (!principal || principal.authenticated !== true ||
      !ACCOUNT.test(principal.accountId) || !ACCOUNT.test(principal.clientId)) {
    throw new OperationError("CLIENT_UNAUTHORIZED");
  }
}

function parseScopes(value: string): string[] {
  try { return cleanScopes(JSON.parse(value) as unknown); }
  catch { throw new OperationError("GOOGLE_SCOPES_INVALID"); }
}

function checkConfig(config: GoogleOAuthConfig): void {
  let target: URL;
  try { target = new URL(config.redirectUri); }
  catch { throw new OperationError("GOOGLE_OAUTH_NOT_CONFIGURED"); }
  if (!config.clientId || !config.clientSecret ||
      config.clientId.length > 1024 || config.clientSecret.length > 1024 ||
      target.protocol !== "https:" ||
      target.pathname !== "/oauth/google/callback" ||
      target.username || target.password || target.search || target.hash ||
      (target.port && target.port !== "443") ||
      typeof config.allowedSubject !== "string" || !GOOGLE_SUB.test(config.allowedSubject)) {
    throw new OperationError("GOOGLE_OAUTH_NOT_CONFIGURED");
  }
}

async function tokenRequest(
  form: URLSearchParams, request: typeof fetch
): Promise<TokenResult> {
  let response: Response;
  try {
    response = await request(TOKEN_ORIGIN, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: form.toString()
    });
  } catch {
    throw new OperationError("GOOGLE_OAUTH_NETWORK_UNAVAILABLE");
  }
  if (!response.ok) {
    // Never reflect token endpoint provider bodies or OAuth authorization codes.
    throw new OperationError(response.status >= 500 ?
      "GOOGLE_OAUTH_PROVIDER_UNAVAILABLE" : "GOOGLE_OAUTH_TOKEN_REJECTED");
  }

  if (Number(response.headers.get("content-length") ?? "0") > TOKEN_BODY_MAX_BYTES) {
    throw new OperationError("GOOGLE_OAUTH_RESPONSE_INVALID");
  }
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (!response.body) throw Error("missing body");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > TOKEN_BODY_MAX_BYTES) throw Error("too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("bad JSON");
    const obj = body as Record<string, unknown>;
    const accessToken = obj.access_token;
    const refreshToken = obj.refresh_token;
    const expiresIn = obj.expires_in;
    if (typeof accessToken !== "string" || accessToken.length < 8 ||
        accessToken.length > 8192 || obj.token_type !== "Bearer" ||
        typeof expiresIn !== "number" || !Number.isFinite(expiresIn) ||
        expiresIn <= 0 || expiresIn > 86400 ||
        (refreshToken !== undefined && (typeof refreshToken !== "string" ||
          refreshToken.length < 8 || refreshToken.length > 8192)) ||
        (obj.scope !== undefined && typeof obj.scope !== "string")) {
      throw Error("invalid token fields");
    }
    return {
      accessToken,
      ...(typeof refreshToken === "string" ? { refreshToken } : {}),
      expiresIn,
      ...(typeof obj.scope === "string" ? {
        grantedScopes: obj.scope.split(/\s+/).filter(Boolean)
      } : {})
    };
  } catch {
    throw new OperationError("GOOGLE_OAUTH_RESPONSE_INVALID");
  }
}

export class GoogleOAuthBroker {
  private readonly key: Promise<CryptoKey>;
  constructor(
    private readonly store: GoogleOAuthStore,
    private readonly config: GoogleOAuthConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now()
  ) {
    checkConfig(config);
    this.key = importVaultKey(config.encryptionKeyBase64Url);
  }

  async begin(principal: Principal, scopesRaw: readonly string[]): Promise<OAuthStart> {
    validatePrincipal(principal);
    const scopes = cleanScopes(scopesRaw);
    if (await this.store.load(principal.accountId)) {
      // Fail closed on attempts to bind a different Google user to the same alias.
      // Incremental authorization and verified Google subject are later milestones.
      throw new OperationError("GOOGLE_ACCOUNT_ALREADY_CONNECTED");
    }
    const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
    const stateHash = await sha256Url(state);
    const ciphertext = await seal(await this.key, "pending:" + stateHash, { verifier });
    const expiresAt = this.now() + STATE_LIFETIME_MS;
    await this.store.createPending({
      state_hash: stateHash, account_id: principal.accountId,
      client_id: principal.clientId, verifier_enc: ciphertext,
      scopes_json: JSON.stringify(scopes), expires_at: expiresAt
    });

    const url = new URL(AUTHORIZATION_ORIGIN);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", await sha256Url(verifier));
    // Bind any granted Workspace API scopes to the same Google identity
    // previously verified by the client authorization Worker.
    url.searchParams.set("scope", [...scopes, ...OIDC_SCOPES].join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "false");
    return { authorizationUrl: url.toString(), expiresAt };
  }

  async complete(state: string, code: string): Promise<OAuthCompletion> {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        decodeBase64Url(state).byteLength !== 32 ||
        typeof code !== "string" || code.length < 1 || code.length > 4096 ||
        /[\x00-\x1f]/.test(code)) {
      throw new OperationError("GOOGLE_OAUTH_CALLBACK_INVALID");
    }
    const stateHash = await sha256Url(state);
    const pending = await this.store.consumePending(stateHash, this.now());
    if (!pending) throw new OperationError("GOOGLE_OAUTH_STATE_EXPIRED_OR_USED");

    const { verifier } = await unseal<PendingVerifier>(
      await this.key, "pending:" + stateHash, pending.verifier_enc
    );
    const scopes = parseScopes(pending.scopes_json);
    if (!verifier || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
      throw new OperationError("GOOGLE_OAUTH_STATE_INVALID");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret
    });
    const result = await tokenRequest(form, this.request);
    if (!result.refreshToken) {
      // Do not accidentally save an unrefreshable connection under a reused alias.
      throw new OperationError("GOOGLE_REFRESH_TOKEN_MISSING");
    }
    if (!result.grantedScopes) throw new OperationError("GOOGLE_SCOPES_UNVERIFIED");
    if (!OIDC_SCOPES.every(scope => result.grantedScopes!.includes(scope))) {
      throw new OperationError("GOOGLE_IDENTITY_SCOPES_DENIED");
    }
    const returnedScopes = cleanScopes(
      result.grantedScopes.filter(scope => !OIDC_SCOPES.includes(scope as "openid" | "email"))
    );
    if (!scopes.every(scope => returnedScopes.includes(scope))) {
      throw new OperationError("GOOGLE_REQUIRED_SCOPES_DENIED");
    }
    // The callback never trusts an email address or caller-supplied account alias:
    // Google userinfo determines the stable account subject independently.
    // A mismatch MUST fail before encrypting or storing any credentials.
    await verifyAuthorizedGoogleSubject(
      result.accessToken, this.config.allowedSubject, this.request
    );
    // Never implicitly grant tools additional scopes not explicitly requested here.
    const granted = scopes;
    const expiresAt = this.now() + Math.floor(result.expiresIn * 1000);
    const encrypted = await seal(await this.key, "connection:" + pending.account_id, {
      accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt
    } satisfies TokenEnvelope);
    await this.store.connectNew({
      account_id: pending.account_id,
      tokens_enc: encrypted,
      scopes_json: JSON.stringify(granted),
      access_expires_at: expiresAt
    }, this.now());
    return { accountId: pending.account_id, connected: true, scopes: granted, expiresAt };
  }

  /** Internal-only SessionStore method: callers must have verified client identity. */
  async get(accountId: string, _clientId: string): Promise<GoogleSession | null> {
    if (!ACCOUNT.test(accountId)) throw new OperationError("INVALID_ACCOUNT_ID");
    const record = await this.store.load(accountId);
    if (!record) return null;
    const token = await unseal<TokenEnvelope>(
      await this.key, "connection:" + accountId, record.tokens_enc
    );
    const scopes = parseScopes(record.scopes_json);
    if (!token.accessToken || !token.refreshToken ||
        !Number.isFinite(token.expiresAt) || token.expiresAt !== record.access_expires_at) {
      throw new OperationError("CREDENTIAL_UNREADABLE");
    }
    if (token.expiresAt > this.now() + 45000) {
      return { accessToken: token.accessToken, expiresAt: token.expiresAt, scopes };
    }
    return this.refresh(record, token, scopes);
  }

  private async refresh(
    current: StoredConnection, token: TokenEnvelope, scopes: string[]
  ): Promise<GoogleSession> {
    const result = await tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret
    }), this.request);
    const granted = result.grantedScopes
      ? scopes.filter(scope => result.grantedScopes!.includes(scope))
      : scopes;
    if (!granted.length) throw new OperationError("GOOGLE_REQUIRED_SCOPES_DENIED");
    const expiresAt = this.now() + Math.floor(result.expiresIn * 1000);
    const encrypted = await seal(await this.key, "connection:" + current.account_id, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? token.refreshToken,
      expiresAt
    } satisfies TokenEnvelope);
    const won = await this.store.compareAndSetTokens({
      account_id: current.account_id, tokens_enc: encrypted,
      scopes_json: JSON.stringify(granted), access_expires_at: expiresAt
    }, current.version, this.now());
    if (won) return { accessToken: result.accessToken, scopes: granted, expiresAt };

    // Another Worker refreshed or disconnected this account concurrently.
    // Never overwrite a newer connection from a stale reader.
    const reread = await this.store.load(current.account_id);
    if (!reread) throw new OperationError("GOOGLE_SESSION_NOT_CONFIGURED");
    const newer = await unseal<TokenEnvelope>(
      await this.key, "connection:" + current.account_id, reread.tokens_enc
    );
    if (newer.expiresAt <= this.now() + 5000) {
      throw new OperationError("GOOGLE_REFRESH_CONFLICT");
    }
    return { accessToken: newer.accessToken, scopes: parseScopes(reread.scopes_json),
      expiresAt: newer.expiresAt };
  }

  /** Local-only disconnect; external Google token revocation is a later capability. */
  async disconnectLocal(accountId: string): Promise<boolean> {
    if (!ACCOUNT.test(accountId)) throw new OperationError("INVALID_ACCOUNT_ID");
    return this.store.disconnect(accountId);
  }
}
