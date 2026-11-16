import { McpServer } from "@modelcontextprotocol/server";

import { OAUTH_CLIENT_HINT, RECONNECT_HINT, missingWriteScopes } from "./google";
import { registerGuardrails, registerPrompts } from "./prompts";
import type { GoogleAccountStatus } from "./store";
import { registerExerciseLog } from "./tools/exerciselog";
import { registerMemory } from "./tools/memory";
import { registerWrites } from "./tools/foodlog";
import { registerCoach } from "./tools/moments";
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
  /**
   * Runs the body of a coach-moment tool. It reads Google Health on the
   * request budget of this MCP HTTP request, which every call here shares.
   */
  coach(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /**
   * Runs the body of a tool that writes to Google Health. It takes its turn
   * with the coach-moment tools, on the same request budget and token answer.
   */
  write(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Shares the access token answer of this MCP HTTP request with the coach tools. */
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
        hint: hintFor(status.token, status.scopesMissing),
      },
    };
  });

  registerMemory(server, deps.memory);
  registerCoach(server, deps.coach);
  registerWrites(server, deps.write);
  registerExerciseLog(server, deps.write);
  registerGuardrails(server);
  // The prompts call profile_get and the coach tools: this server has both.
  registerPrompts(server);

  return server;
}

function hintFor(token: string, scopesMissing: readonly string[]): string | null {
  switch (token) {
    case "not_linked":
    case "auth_expired":
      return RECONNECT_HINT;
    case "upstream_unavailable":
      return "Google is unavailable right now. Try again in a few minutes.";
    case "internal_error":
      return `The Google token request failed. ${OAUTH_CLIENT_HINT}`;
  }
  if (scopesMissing.length === 0) return null;
  // A missing write scope is named with the tools that need it: an account
  // that signed in before the scope was requested reads here why those tools
  // answer scope_missing, and that a new sign-in grants it.
  const writes = missingWriteScopes(scopesMissing);
  return `Some Google Health permissions were not granted.${writes === "" ? "" : ` ${writes}`} ${RECONNECT_HINT}`;
}
