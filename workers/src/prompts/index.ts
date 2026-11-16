// The coach's MCP prompts, one per coaching moment, and the coach://guardrails
// resource with the rules every moment follows.
//
// The prompts and the resource are static text: they read no health data and
// write no log line. Their handlers are set on the low-level server, not with
// McpServer.registerPrompt and registerResource: those add `required: false`
// to each prompt argument and write their own text for a prompt or a resource
// that does not exist, and the frozen fixture is the contract here
// (test/fixtures/go-prompts.json).

import { type McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from "@modelcontextprotocol/server";

import { parseDate } from "../coach/date";
import { compareText, truncate } from "../coach/text";
import { MAX_ECHOED_ERROR } from "../tools/register";
import { GUARDRAILS, GUARDRAILS_URI } from "./guardrails";

export { GUARDRAILS, GUARDRAILS_URI } from "./guardrails";

/** The guardrails resource as resources/list shows it. */
const GUARDRAILS_RESOURCE = {
  uri: GUARDRAILS_URI,
  name: "guardrails",
  title: "Coach guardrails",
  description: "The coach's medical limits, data rules and tone. Every coaching answer follows them.",
  mimeType: "text/markdown",
};

/** Adds the coach://guardrails resource. */
export function registerGuardrails(server: McpServer): void {
  const low = server.server;
  // The resource list is advertised with listChanged. The list never changes while a server lives.
  low.registerCapabilities({ resources: { listChanged: true } });
  low.setRequestHandler("resources/list", () => ({ resources: [GUARDRAILS_RESOURCE] }));
  low.setRequestHandler("resources/templates/list", () => ({ resourceTemplates: [] }));
  low.setRequestHandler("resources/read", (request) => {
    const uri = request.params.uri;
    if (uri !== GUARDRAILS_URI) throw new ResourceNotFoundError(uri, "Resource not found");
    return { contents: [{ uri: GUARDRAILS_URI, mimeType: "text/markdown", text: GUARDRAILS }] };
  });
}

/**
 * One coaching prompt: the tool it runs, the tool's day argument and what the
 * coach does with the result.
 */
export interface Moment {
  name: string;
  title: string;
  description: string;
  tool: string;
  arg: string;
  argHelp: string;
  task: string;
}

/** The moments, in briefing, nutrition, workout, then weekly order. */
export const MOMENTS: readonly Moment[] = [
  {
    name: "morning_briefing",
    title: "Morning briefing",
    description: "Last night's sleep and recovery against the user's baseline, and today's training call.",
    tool: "morning_briefing",
    arg: "date",
    argHelp: "local day the night ended (YYYY-MM-DD); omit for today",
    task:
      "Tell the user how they slept and recovered against their own baseline, then give today's " +
      "training call (train as planned, go lighter or rest) with one reason. If readiness is red, the call is " +
      "go lighter or rest. If the user reports symptoms or pain, the call is rest and the guardrails decide " +
      "what else to say. Keep it short.",
  },
  {
    name: "nutrition_review",
    title: "Nutrition review",
    description: "One day's food log against the targets in force.",
    tool: "nutrition_day",
    arg: "date",
    argHelp: "local day of the log (YYYY-MM-DD); omit for today",
    task:
      "Review the day's intake against the targets in force: calories, protein (also per kg of body " +
      "weight) and the energy balance when the tool gives one. Say what to adjust in the next meal or day, " +
      "in foods, not only numbers. Over a target, say so plainly; never suggest skipping or shrinking a meal " +
      "to make up for it.",
  },
  {
    name: "workout_review",
    title: "Workout review",
    description: "One day's training sessions and the week's training load against the plan.",
    tool: "workout_review",
    arg: "date",
    argHelp: "local day to review (YYYY-MM-DD); omit for today",
    task:
      "Review the sessions: duration, heart-rate zones, Active Zone Minutes and the week's sessions " +
      "against the plan. Say what went well and how to adjust the next session, within the user's health " +
      "items and recovery.",
  },
  {
    name: "weekly_report",
    title: "Weekly report",
    description: "The week against the previous week and the 28-day average, with next week's priorities.",
    tool: "weekly_report",
    arg: "week_end",
    argHelp: "any local day of the week (YYYY-MM-DD); omit for this week",
    task:
      "Summarize the week against the previous week and the 28-day average: weight, body fat, resting " +
      "heart rate, HRV, sleep, steps and adherence, and the decisions recorded this week. Pick at most " +
      "three priorities for next week.",
  },
];

const byName = new Map(MOMENTS.map((moment) => [moment.name, moment]));

/** The prompts as prompts/list shows them: sorted by name. */
const LISTED = [...MOMENTS]
  .sort((a, b) => compareText(a.name, b.name))
  .map((moment) => ({
    name: moment.name,
    title: moment.title,
    description: moment.description,
    // The day is optional: no `required`.
    arguments: [{ name: moment.arg, description: moment.argHelp }],
  }));

/**
 * The text of a prompt. Only the moment's own argument is read, and only a
 * parsed date reaches the text, so an argument cannot carry instructions. An
 * empty value is an omitted one. The error for text that is not a calendar
 * date does not repeat the input either.
 */
export function promptText(moment: Moment, args: Record<string, unknown> | undefined): string {
  let call = `Call ${moment.tool} with no arguments (it picks the default day).`;
  const value = args?.[moment.arg];
  if (value !== undefined && value !== "") {
    const day = typeof value === "string" ? parseDate(value) : undefined;
    if (day === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${moment.arg} must be a calendar date (YYYY-MM-DD)`);
    call = `Call ${moment.tool} with {"${moment.arg}": "${day}"}.`;
  }
  return (
    "You are the user's health and fitness coach.\n\n" +
    "1. Call profile_get for the user's goals, targets, health history and preferences.\n" +
    `2. ${call}\n` +
    `3. ${moment.task}\n\n` +
    `Follow the coach guardrails below (also the ${GUARDRAILS_URI} resource) in everything you say.\n\n` +
    GUARDRAILS
  );
}

/**
 * Adds one prompt per coaching moment. Each prompt names tools the server
 * must also register: profile_get and the moment's own tool.
 */
export function registerPrompts(server: McpServer): void {
  const low = server.server;
  low.registerCapabilities({ prompts: { listChanged: true } });
  low.setRequestHandler("prompts/list", () => ({ prompts: LISTED }));
  low.setRequestHandler("prompts/get", (request) => {
    const moment = byName.get(request.params.name);
    if (!moment) {
      // The name is the client's own text: bounded, as every echoed input is.
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, truncate(`unknown prompt ${JSON.stringify(request.params.name)}`, MAX_ECHOED_ERROR));
    }
    return {
      description: moment.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText(moment, request.params.arguments) } }],
    };
  });
}
