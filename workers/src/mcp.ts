import { McpServer } from "@modelcontextprotocol/server";

import type { GoogleAccountStatus } from "./store";
import { registerMemory } from "./tools/memory";
import { type ToolOutcome, defineTool, register } from "./tools/register";
import { inputSchema, s } from "./tools/schema";
import { SERVER_NAME, TRANSPORT, VERSION } from "./version";

/** The one route that serves MCP. */
export const MCP_PATH = "/mcp";

/**
 * What the tools need from the object that serves them. The server is built
 * inside the CoachStore Durable Object, so every call here is a direct call:
 * no RPC hop, and no call from the object to its own stub.
 */
export interface ServerDeps {
  /** Runs the body of a coach memory tool on the store. */
  memory(name: string, args: Record<string, unknown>): ToolOutcome;
  googleAccountStatus(): Promise<GoogleAccountStatus>;
}

// Tool definitions are built once per isolate: createServer runs on every request.

const NO_ARGUMENTS = inputSchema(s.object({}));

const SERVER_INFO = defineTool({
  name: "server_info",
  description: "Returns the server name, version, and transport. Use it to check that the coach MCP is reachable.",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: NO_ARGUMENTS,
  outputSchema: s.object({ name: s.string(), version: s.string(), transport: s.string() }),
});

const TOKEN_STATES = ["ok", "not_linked", "auth_expired", "upstream_unavailable", "internal_error"];

const GOOGLE_ACCOUNT_STATUS = defineTool({
  name: "google_account_status",
  description:
    "Shows which Google account is linked to the coach, the Google Health scopes it granted or is missing, " +
    "and whether its access still works. It never returns a token.",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: NO_ARGUMENTS,
  outputSchema: s.object({
    linked: s.boolean(),
    email: s.nullable(s.string()),
    linked_at: s.nullable(s.string("ISO 8601 UTC time of the last sign-in")),
    scopes_granted: { type: "array", items: s.string() },
    scopes_missing: {
      type: "array",
      items: s.string(),
      description: "Google Health scopes the coach needs that were not granted",
    },
    token: { type: "string", enum: TOKEN_STATES, description: "Whether a Google access token can be obtained now" },
    hint: s.nullable(s.string()),
  }),
});

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  register(server, SERVER_INFO, () => ({
    ok: true,
    output: { name: SERVER_NAME, version: VERSION, transport: TRANSPORT },
  }));

  register(server, GOOGLE_ACCOUNT_STATUS, async () => {
    const status = await deps.googleAccountStatus();
    return {
      ok: true,
      output: {
        linked: status.linked,
        email: status.email,
        linked_at: status.linkedAt,
        scopes_granted: status.scopesGranted,
        scopes_missing: status.scopesMissing,
        token: status.token,
        hint: hintFor(status.token, status.scopesMissing.length > 0),
      },
    };
  });

  registerMemory(server, deps.memory);

  return server;
}

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
