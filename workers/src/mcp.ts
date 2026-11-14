import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { SERVER_NAME, TRANSPORT, VERSION } from "./version";

const serverInfoOutput = z.object({
  name: z.string(),
  version: z.string(),
  transport: z.string(),
});

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  server.registerTool(
    "server_info",
    {
      description:
        "Returns the server name, version, and transport. Use it to check that the coach MCP is reachable.",
      inputSchema: z.object({}),
      outputSchema: serverInfoOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const output = {
        name: SERVER_NAME,
        version: VERSION,
        transport: TRANSPORT,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}
