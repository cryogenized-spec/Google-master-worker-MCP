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
      // SDK v2.4.0 drops nonstandard Tool.securitySchemes during tools/list.
      // Its HTTP response is enriched by withOAuthToolSchemes below.
      annotations: {
        title: definition.name.replaceAll("_", " "),
        readOnlyHint: definition.risk === "read",
        destructiveHint: definition.risk === "destructive",
        idempotentHint: definition.risk === "read"
      }
    }, async (args: any) => {
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


/**
 * Preserve OpenAI's per-tool securitySchemes on the wire until the pinned
 * @modelcontextprotocol/server SDK exposes this optional field. SDK v2.4.0
 * generates tools/list from a strict key whitelist and strips unknown
 * registerTool options. Patch ONLY successful, bounded JSON tools/list replies.
 *
 * No OAuth permissions are minted here: scope checks remain inside the
 * authenticated resource Worker and per-tool call handler.
 */
export async function withOAuthToolSchemes(
  request:Request,send:(request:Request)=>Promise<Response>,registry:OperationRegistry
):Promise<Response>{
  let listing=request.method==="POST" && request.headers.get("Mcp-Method")==="tools/list";
  if(!listing && request.method==="POST"){
    const claimed=Number(request.headers.get("Content-Length")||0);
    if(!claimed || claimed<=4096){
      try{
        const data=await request.clone().json() as {method?:string};
        listing=data?.method==="tools/list";
      }catch{/* Not a JSON-RPC tools/list request. */}
    }
  }
  const response=await send(request);
  if(!listing || !response.ok ||
    !/application\/json/i.test(response.headers.get("Content-Type")||""))return response;
  const length=Number(response.headers.get("Content-Length")||0);
  if(length>1024*1024)return response;
  let payload:{result?:{tools?:Array<Record<string,unknown>>}};
  try{payload=await response.clone().json();}
  catch{return response;}
  if(!Array.isArray(payload?.result?.tools) || payload.result.tools.length>250)return response;
  const byName=new Map(registry.catalogue().map(op=>[op.name,op.risk] as const));
  for(const tool of payload.result.tools){
    const risk=byName.get(typeof tool?.name==="string"?tool.name:"");
    if(!risk)continue;
    tool.securitySchemes=[{
      type:"oauth2",
      scopes:risk==="read"?["mcp:read"]:["mcp:read","mcp:write"]
    }];
  }
  const headers=new Headers(response.headers);
  headers.set("Content-Type","application/json; charset=utf-8");
  headers.set("Cache-Control","no-store");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("ETag");
  return new Response(JSON.stringify(payload),{
    status:response.status,statusText:response.statusText,headers
  });
}
