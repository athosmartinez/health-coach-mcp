import { McpServer } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { coachStore } from "./store";
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

  server.registerTool(
    "google_account_status",
    {
      description:
        "Shows which Google account is linked to the coach, the Google Health scopes it granted or is missing, " +
        "and whether its access still works. It never returns a token.",
      inputSchema: z.object({}),
      outputSchema: googleAccountStatusOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const status = await coachStore(env).googleAccountStatus();
      const output: z.infer<typeof googleAccountStatusOutput> = {
        linked: status.linked,
        email: status.email,
        linked_at: status.linkedAt,
        scopes_granted: status.scopesGranted,
        scopes_missing: status.scopesMissing,
        token: status.token,
        hint: hintFor(status.token, status.scopesMissing.length > 0),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

const googleAccountStatusOutput = z.object({
  linked: z.boolean(),
  email: z.string().nullable(),
  linked_at: z.string().nullable().describe("ISO 8601 UTC time of the last sign-in"),
  scopes_granted: z.array(z.string()),
  scopes_missing: z.array(z.string()).describe("Google Health scopes the coach needs that were not granted"),
  token: z
    .enum(["ok", "not_linked", "auth_expired", "upstream_unavailable", "internal_error"])
    .describe("Whether a Google access token can be obtained now"),
  hint: z.string().nullable(),
});

const RECONNECT = "Disconnect and reconnect this connector in the MCP client to sign in with Google again.";

function hintFor(token: string, scopesMissing: boolean): string | null {
  switch (token) {
    case "not_linked":
    case "auth_expired":
      return RECONNECT;
    case "upstream_unavailable":
      return "Google is unavailable right now. Try again in a few minutes.";
    case "internal_error":
      return "The Google token request failed. Check the server's Google OAuth client settings.";
  }
  return scopesMissing ? `Some Google Health permissions were not granted. ${RECONNECT}` : null;
}
