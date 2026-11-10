import { OperationError } from "../../core/src/index.js";

/** Google OIDC's own UserInfo endpoint (not tokeninfo, which is for debugging). */
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_IDENTITY_BYTES = 8192;
const GOOGLE_SUB = /^[0-9]{8,64}$/;

/** Fetch and validate the stable Google account subject before saving credentials. */
export async function verifyAuthorizedGoogleSubject(
  accessToken: string,
  expectedSubject: string,
  request: typeof fetch = fetch
): Promise<void> {
  if (typeof expectedSubject !== "string" || !GOOGLE_SUB.test(expectedSubject) ||
      typeof accessToken !== "string" || accessToken.length < 8 ||
      accessToken.length > 8192) {
    throw new OperationError("GOOGLE_IDENTITY_NOT_CONFIGURED");
  }
  let response: Response;
  try {
    response = await request(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: {Authorization: "Bearer " + accessToken, Accept: "application/json"},
      redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new OperationError("GOOGLE_IDENTITY_UNAVAILABLE");
  }
  if (!response.ok) {
    throw new OperationError(response.status >= 500 ?
      "GOOGLE_IDENTITY_UNAVAILABLE" : "GOOGLE_IDENTITY_NOT_VERIFIED");
  }
  if (Number(response.headers.get("content-length") || 0) > MAX_IDENTITY_BYTES ||
      !response.body) {
    throw new OperationError("GOOGLE_IDENTITY_NOT_VERIFIED");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IDENTITY_BYTES) {
        throw new OperationError("GOOGLE_IDENTITY_NOT_VERIFIED");
      }
      parts.push(value);
    }
  } catch(error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError("GOOGLE_IDENTITY_UNAVAILABLE");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part,offset); offset += part.byteLength; }
  let data: unknown;
  try { data=JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new OperationError("GOOGLE_IDENTITY_NOT_VERIFIED"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new OperationError("GOOGLE_IDENTITY_NOT_VERIFIED");
  }
  const claims = data as Record<string,unknown>;
  if (claims.sub !== expectedSubject || claims.email_verified !== true ||
      typeof claims.email !== "string" || claims.email.length < 3) {
    throw new OperationError("GOOGLE_IDENTITY_MISMATCH");
  }
}
