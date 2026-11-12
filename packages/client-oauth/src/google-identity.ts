import { OperationError } from "../../core/src/index.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_PROVIDER_BYTES = 16384;

export interface GoogleLoginConfig {
  clientId: string;
  clientSecret: string;
  callback: string;
  allowedSubject: string;
}

export function validLoginConfig(value: GoogleLoginConfig): boolean {
  try {
    const url = new URL(value.callback);
    return url.protocol === "https:" && url.pathname === "/google/callback" &&
      !url.username && !url.password && !url.hash && !url.search &&
      url.port === "" && value.clientId.length > 10 && value.clientId.length < 1024 &&
      value.clientSecret.length > 10 && value.clientSecret.length < 1024 &&
      /^[0-9]{8,64}$/.test(value.allowedSubject);
  } catch { return false; }
}

async function boundedObject(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get("content-length") || "0") > MAX_PROVIDER_BYTES) {
    throw new OperationError("IDENTITY_PROVIDER_INVALID");
  }
  if (!response.body) throw new OperationError("IDENTITY_PROVIDER_INVALID");
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_BYTES) throw new OperationError("IDENTITY_PROVIDER_INVALID");
      pieces.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const piece of pieces) { out.set(piece,cursor); cursor += piece.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(out));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("not object");
    return result as Record<string,unknown>;
  } catch { throw new OperationError("IDENTITY_PROVIDER_INVALID"); }
}

function fail(code: string): never { throw new OperationError(code); }

/**
 * Google login is authentication of the HUMAN OPERATOR, not authorization
 * for the Google Workspace API. A Google subject (sub) is stable; email is not.
 */
export async function verifyGoogleLogin(
  code: string,
  verifier: string,
  config: GoogleLoginConfig,
  request: typeof fetch = fetch
): Promise<{ userId: "owner"; accountId: "default" }> {
  if (!validLoginConfig(config) ||
      typeof code !== "string" || code.length < 1 || code.length > 4096 ||
      typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    fail("IDENTITY_LOGIN_INVALID");
  }
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code, code_verifier: verifier,
    redirect_uri: config.callback,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });
  let tokenResponse: Response;
  try {
    tokenResponse = await request(TOKEN_ENDPOINT, {
      method: "POST", body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });
  } catch { fail("IDENTITY_PROVIDER_UNAVAILABLE"); }
  if (!tokenResponse.ok) fail("IDENTITY_LOGIN_DENIED");
  const token = await boundedObject(tokenResponse);
  if (token.token_type !== "Bearer" ||
      typeof token.access_token !== "string" ||
      token.access_token.length < 8 || token.access_token.length > 8192) {
    fail("IDENTITY_PROVIDER_INVALID");
  }

  let identityResponse: Response;
  try {
    identityResponse = await request(USERINFO_ENDPOINT, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(12000),
      headers: { Authorization: "Bearer " + token.access_token, Accept: "application/json" }
    });
  } catch { fail("IDENTITY_PROVIDER_UNAVAILABLE"); }
  if (!identityResponse.ok) fail("IDENTITY_LOGIN_DENIED");
  const identity = await boundedObject(identityResponse);
  if (identity.sub !== config.allowedSubject || identity.email_verified !== true ||
      typeof identity.email !== "string" || identity.email.length < 3) {
    fail("IDENTITY_OPERATOR_NOT_ALLOWED");
  }
  return { userId: "owner", accountId: "default" };
}
