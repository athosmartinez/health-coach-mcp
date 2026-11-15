// The coach-moment tools as the server registers them (Go: the RegisterX calls
// of internal/server/server.go, CAPABILITY §4.1).
//
// Like the memory tools, their definitions and bodies run inside the
// CoachStore Durable Object. Their bodies read Google Health through the
// source of the MCP request, which holds the request budget.

import type { McpServer } from "@modelcontextprotocol/server";

import { INTERNAL_ERROR } from "../coach/errors";
import { MORNING_BRIEFING } from "./briefing";
import type { Args, CoachDeps, CoachTool } from "./coach";
import { NUTRITION_DAY } from "./nutrition";
import { type Tool, type ToolOutcome, captureAsync, register } from "./register";
import { WORKOUT_REVIEW } from "./workout";

/** The coach-moment tools, in the order the Go server registers them. */
const COACH: readonly CoachTool[] = [MORNING_BRIEFING, WORKOUT_REVIEW, NUTRITION_DAY];

export const COACH_TOOLS: readonly Tool[] = COACH.map((one) => one.tool);

const byName = new Map(COACH.map((one) => [one.tool.name, one]));

/**
 * Runs the body of a coach-moment tool. Errors come back in the outcome and
 * are never thrown: a ToolError of the body or of the Google Health client
 * (auth_expired, scope_missing, upstream_unavailable, the budget error) as it
 * is, anything else as internal_error.
 */
export async function runCoachTool(deps: CoachDeps, name: string, args: Args): Promise<ToolOutcome> {
  const one = byName.get(name);
  if (!one) return { ok: false, error: INTERNAL_ERROR };
  return captureAsync(one.tool, () => one.body(deps, args));
}

/** Adds the coach-moment tools. `run` executes a tool body and returns its outcome. */
export function registerCoach(server: McpServer, run: (name: string, args: Args) => Promise<ToolOutcome>): void {
  for (const tool of COACH_TOOLS) register(server, tool, (args) => run(tool.name, args));
}
