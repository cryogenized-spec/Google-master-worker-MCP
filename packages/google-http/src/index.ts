import { OperationError } from "../../core/src/index.js";

export type QueryValue = string | number | boolean | null | undefined;

export interface GoogleRequest {
  readonly path: string;
  readonly accessToken: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
}

/**
 * The public MCP error must never include an upstream exception message: Google
 * URLs, credentials or runtime details can appear in those strings. Collapse
 * known Worker/request failures into a small, content-free diagnostic category.
 * Unknown network failures stay a generic unavailable error.
 */
export function classifyGoogleFetchFailure(error: unknown): string {
  if (!error || typeof error !== "object") return "GOOGLE_NETWORK_UNAVAILABLE";
  const kind = "name" in error && typeof error.name === "string"
    ? error.name : "";
  const message = "message" in error && typeof error.message === "string"
    ? error.message : "";
  if (kind === "TimeoutError" || kind === "AbortError" ||
      /(?:^|\\W)(?:timed out|timeout|deadline exceeded)(?:$|\\W)/i.test(message)) {
    return "GOOGLE_FETCH_TIMEOUT";
  }
  if (/unsupported cache mode|cache.*field.*not implemented/i.test(message)) {
    return "GOOGLE_FETCH_CACHE_UNSUPPORTED";
  }
  if (/redirect.*(?:not implemented|unsupported|invalid)/i.test(message)) {
    return "GOOGLE_FETCH_REDIRECT_UNSUPPORTED";
  }
  if (/outside.*request|request context|I\\/O.*(?:not allowed|context)|global scope|illegal invocation/i.test(message)) {
    return "GOOGLE_FETCH_CONTEXT_UNAVAILABLE";
  }
  if (kind === "TypeError") {
    return "GOOGLE_FETCH_TYPE_ERROR";
  }
  return "GOOGLE_NETWORK_UNAVAILABLE";
}

export class GoogleJsonClient {
  constructor(
    private readonly origin: string,
    private readonly requiredPathPrefix: string,
    private readonly request: typeof fetch = fetch,
    private readonly maxBytes = 256 * 1024
  ) {
    const fixed = new URL(origin);
    if (fixed.protocol !== "https:" || fixed.pathname !== "/" ||
        !requiredPathPrefix.startsWith("/") || !requiredPathPrefix.endsWith("/")) {
      throw new OperationError("GOOGLE_DESTINATION_REJECTED");
    }
  }

  async json({ path, accessToken, method = "GET", query, body }: GoogleRequest): Promise<Record<string, unknown>> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") ||
        path.includes("#") || path.includes("\\") || !accessToken) {
      throw new OperationError("GOOGLE_DESTINATION_REJECTED");
    }
    const url = new URL(path, this.origin);
    if (url.origin !== new URL(this.origin).origin || !url.pathname.startsWith(this.requiredPathPrefix)) {
      throw new OperationError("GOOGLE_DESTINATION_REJECTED");
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.request(url.href, {
        method, redirect: "manual", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      // Classification is deliberately not based on returning provider text.
      throw new OperationError(classifyGoogleFetchFailure(error));
    }
    if (!response.ok) {
      const code = response.status === 401 ? "GOOGLE_UNAUTHORIZED" :
        response.status === 403 ? "GOOGLE_FORBIDDEN" :
        response.status === 404 ? "GOOGLE_NOT_FOUND" :
        response.status === 429 ? "GOOGLE_RATE_LIMITED" :
        response.status >= 500 ? "GOOGLE_UNAVAILABLE" : "GOOGLE_REQUEST_REJECTED";
      throw new OperationError(code);
    }

    const announced = Number(response.headers?.get("content-length") ?? 0);
    if (announced > this.maxBytes) throw new OperationError("GOOGLE_RESPONSE_TOO_LARGE");
    let bytes: Uint8Array;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > this.maxBytes) throw new OperationError("GOOGLE_RESPONSE_TOO_LARGE");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        bytes = new TextEncoder().encode(await response.text());
      }
      if (bytes.byteLength > this.maxBytes) throw new OperationError("GOOGLE_RESPONSE_TOO_LARGE");
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new OperationError("GOOGLE_RESPONSE_INVALID");
      }
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError("GOOGLE_RESPONSE_INVALID");
    }
  }
}
