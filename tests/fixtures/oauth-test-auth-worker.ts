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
        !["test-owner-read-token","test-owner-write-token","test-under-scoped-token",
          "test-wrong-audience-token","test-expired-token",
          "test-wrong-owner-token"].includes(token)) return null;
    return {
      props: {userId:token==="test-wrong-owner-token"?"unknown":"owner",
        accountId:"default"},
      audience:token==="test-wrong-audience-token"
        ?"https://unrelated.example.test/mcp":resource,
      scope:token==="test-under-scoped-token" ? ["offline_access"] :
        token==="test-owner-write-token" ? ["mcp:read","mcp:write"] : ["mcp:read"],
      clientId:"synthetic-client-id",
      userId:token==="test-wrong-owner-token"?"unknown":"owner",
      expiresAt:Math.floor(Date.now()/1000)+
        (token==="test-expired-token"?-100:300)
    };
  }
}
