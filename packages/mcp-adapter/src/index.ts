import { McpServer } from "@modelcontextprotocol/server";
import type { Principal, OperationRegistry } from "../../core/src/index.js";
import { publicError } from "../../core/src/index.js";

export type ResolvePrincipal = () => Promise<Principal>;

/** Transport-independent MCP tool registry; caller supplies trusted identity. */
export function createMcpServer(registry: OperationRegistry, resolvePrincipal: ResolvePrincipal, options: {readOnly?: boolean} = {}): McpServer {
  const server = new McpServer({ name: "google-master-worker", version: "0.1.0" });
  for (const definition of registry.catalogue()) {
    if (options.readOnly && definition.risk !== "read") continue;
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema as any,
      annotations: {
        title: definition.name.replaceAll("_", " "),
        readOnlyHint: definition.risk === "read",
        destructiveHint: definition.risk === "destructive",
        idempotentHint: definition.risk === "read"
      }
    }, async (args: any) => {
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
