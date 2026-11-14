import { McpServer } from "@modelcontextprotocol/server";
import type { Principal, OperationRegistry } from "../../core/src/index.js";
import { publicError } from "../../core/src/index.js";

export type ResolvePrincipal = () => Promise<Principal>;

export interface McpServerOptions {
  readOnly?: boolean;
  /** Provided exclusively by a validated OAuth resource session, never from MCP tool arguments. */
  oauth?: {
    grantedScopes: readonly string[];
    resourceMetadataUrl: string;
  };
}
const READ_SCOPES = ["mcp:read"] as const;
const WRITE_SCOPES = ["mcp:read","mcp:write"] as const;

/** Same server for read-only and write-capable clients; per-tool auth supports scope upgrades. */
export function createMcpServer(
  registry: OperationRegistry,
  resolvePrincipal: ResolvePrincipal,
  options: McpServerOptions = {}
): McpServer {
  const server = new McpServer({ name: "google-master-worker", version: "0.2.5" });
  for (const definition of registry.catalogue()) {
    if (options.readOnly && definition.risk !== "read") continue;
    const requiredScopes=definition.risk==="read" ? READ_SCOPES : WRITE_SCOPES;
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema as any,
      // Advertise this explicitly rather than inheriting mcp:read from the
      // protected resource's discovery metadata. ChatGPT uses tool-level
      // securitySchemes when obtaining additional OAuth permissions.
      securitySchemes: [{type:"oauth2" as const,scopes:[...requiredScopes]}],
      annotations: {
        title: definition.name.replaceAll("_", " "),
        readOnlyHint: definition.risk === "read",
        destructiveHint: definition.risk === "destructive",
        idempotentHint: definition.risk === "read"
      }
    } as any, async (args: any) => {
      if(options.oauth && requiredScopes.some(s => !options.oauth!.grantedScopes.includes(s))){
        // OAuth discovery + tool securitySchemes alone are insufficient for
        // incremental auth. ChatGPT requires mcp/www_authenticate in the
        // error result to present a linking / scope-upgrade interface.
        const url=new URL(options.oauth.resourceMetadataUrl);
        if(url.protocol!=="https:" || url.pathname!=="/.well-known/oauth-protected-resource/mcp" ||
            url.username || url.password || url.search || url.hash){
          return {content:[{type:"text" as const,text:JSON.stringify({error:"AUTH_CONFIGURATION_INVALID"})}],isError:true as const};
        }
        const challenge='Bearer resource_metadata="'+url.toString()+
          '", error="insufficient_scope", error_description="Authorize Google Master Worker to modify your Google data", scope="'+
          requiredScopes.join(" ")+'"';
        return {
          content:[{type:"text" as const,text:JSON.stringify({error:"OAUTH_SCOPE_UPGRADE_REQUIRED",scopes:requiredScopes})}],
          _meta:{"mcp/www_authenticate":[challenge]},
          isError:true as const
        };
      }
      try {
        const principal = await resolvePrincipal();
        const result = await registry.execute(definition.name, args, principal);
        const structuredContent = result as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(publicError(error)) }],
          isError: true as const
        };
      }
    });
  }
  return server;
}
