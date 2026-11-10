import { OperationError } from "../../core/src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OperationError("CREDENTIAL_UNREADABLE");
  }
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const result = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
    if (encodeBase64Url(result) !== value) throw Error("noncanonical");
    return result;
  } catch {
    throw new OperationError("CREDENTIAL_UNREADABLE");
  }
}

export async function importVaultKey(base64url: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try { bytes = decodeBase64Url(base64url); }
  catch { throw new OperationError("ENCRYPTION_NOT_CONFIGURED"); }
  if (bytes.byteLength !== 32) throw new OperationError("ENCRYPTION_NOT_CONFIGURED");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sha256Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function seal(key: CryptoKey, binding: string, payload: unknown): Promise<string> {
  if (!binding || binding.length > 256) throw new OperationError("INVALID_VAULT_BINDING");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: enc.encode("GMW:" + binding)
  }, key, enc.encode(JSON.stringify(payload)));
  return "g1." + encodeBase64Url(iv) + "." +
    encodeBase64Url(new Uint8Array(ciphertext));
}

export async function unseal<T>(key: CryptoKey, binding: string, envelope: string): Promise<T> {
  try {
    const parts = envelope.split(".");
    if (parts.length !== 3 || parts[0] !== "g1") throw Error("format");
    const iv = decodeBase64Url(parts[1]);
    const cipher = decodeBase64Url(parts[2]);
    if (iv.byteLength !== 12 || cipher.byteLength < 16 || cipher.byteLength > 65536) throw Error("bounds");
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv, additionalData: enc.encode("GMW:" + binding)
    }, key, cipher);
    return JSON.parse(dec.decode(plaintext)) as T;
  } catch {
    // Never expose plaintext, key material, or native AES verification errors.
    throw new OperationError("CREDENTIAL_UNREADABLE");
  }
}
