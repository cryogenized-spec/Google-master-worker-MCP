/**
 * TEST ONLY. This stub is bundled into a local workerd harness; it is NEVER
 * included in production Wrangler configs or permitted in a deployment.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export default class TestAuthWorker extends WorkerEntrypoint {
  async fetch():Promise<Response> {
    return new Response("test worker: no HTTP authorization", {status:404});
  }

  async validateToken(resource: string, token: string) {
    if (resource !== "https://mcp.example.test/mcp" ||
        token !== "test-owner-read-token") return null;
    return {
      props: {userId:"owner",accountId:"default"},
      audience: resource,
      scope: ["mcp:read"],
      clientId: "synthetic-client-id",
      userId: "owner",
      expiresAt: Math.floor(Date.now()/1000)+300
    };
  }
}
