// End to end for the Google Health read side: the OAuth sign-in through the
// Worker, then /mcp with the MCP access token: the tool list, the prompts, the
// guardrails resource, one call of each coach tool, and one error of each kind.
//
// Every request goes Worker → CoachStore object, as in production. Google is
// behind a mocked `fetch`: the token endpoint and a fake Health API built from
// synthetic records (test/healthdata-helpers.ts mirrors the Go fixtures).
// test/coach-e2e.test.ts holds the detailed cases of each tool, and
// test/subrequests.test.ts the request counts of the worst cases.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireError } from "../src/coach/errors";
import { RECONNECT_HINT } from "../src/google";
import { GUARDRAILS, GUARDRAILS_URI } from "../src/prompts";
import { CoachStore, coachStore } from "../src/store";
import { NUTRITION_NOTICE } from "../src/tools/nutrition";
import { SERIES_NOTICE } from "../src/tools/series";
import { WEEKLY_NOTICE } from "../src/tools/weekly";
import { FOOD_NAME, SESSION_NAME, TODAY, day, everything, googleMock, skipRetryWaits } from "./e2e-helpers";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, rpc, signInAsOwner } from "./helpers";
import { ALL_TOOL_NAMES, COACH_TOOL_NAMES } from "./memory-helpers";

const g = googleMock();

let accessToken = "";
let nextId = 1;

/** A marked text in every error body of the fake: it must never reach an error or a log line. */
const BODY_MARK = "synthetic body 7711";

beforeEach(async () => {
  // The named store is shared by the tests of this file: start each one empty.
  await runInDurableObject(coachStore(env), (_instance, state) => {
    for (const table of ["profile", "targets", "health_items", "lab_results", "preferences", "notes", "daily_metrics", "google_account"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  // The sign-in stores the Google link: a refresh token and an access token good for an hour.
  accessToken = (await signInAsOwner()).access_token;
  expectNoSecret(g.logged());
  // The sign-in put its own mock on `fetch`: from here on Google is the fake API.
  g.install();
  g.clearLogs();
  everything(g.google);
});

/** No token, no name and no part of a Google answer. */
function expectNoSecret(text: string): void {
  for (const secret of [accessToken, GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, SESSION_NAME, FOOD_NAME, "Synthetic Band", "Synthetic Scale", BODY_MARK]) {
    if (secret !== "") expect(text).not.toContain(secret);
  }
}

/** One JSON-RPC request to /mcp of the Worker, with the MCP access token. */
async function mcp(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
  const reply = await rpc(accessToken, { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  return reply.result as Record<string, any>;
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
}

/** Calls a tool that must succeed and returns its structured content. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = (await mcp("tools/call", { name, arguments: args })) as ToolResult;
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  // The text content is the same JSON as the structured content.
  expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual(result.structuredContent);
  return result.structuredContent ?? {};
}

/** Calls a tool that must fail and returns the {code,message,hint} of its text content. */
async function fails(name: string, args: Record<string, unknown> = {}): Promise<WireError> {
  const result = (await mcp("tools/call", { name, arguments: args })) as ToolResult;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const text = result.content?.[0]?.text ?? "";
  expectNoSecret(text);
  return JSON.parse(text) as WireError;
}

const toolCall = (tool: string, code?: string) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: code !== undefined, ...(code === undefined ? {} : { code }) }];

const googleError = (status: number, grpc: string) => () =>
  Response.json({ error: { code: status, message: `${BODY_MARK} for ${GOOGLE_ACCESS_TOKEN}`, status: grpc } }, { status });

describe("the Google Health read side, from the sign-in to a tool result", () => {
  it("lists the 20 tools, the 4 prompts and the guardrails resource after the sign-in", async () => {
    const { tools } = await mcp("tools/list");
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);
    expect(tools).toHaveLength(20);
    // The five coach tools only read. Only the two tools of the food log change
    // Google Health: test/foodlog-e2e.test.ts covers them.
    for (const name of COACH_TOOL_NAMES) {
      const tool = tools.find((one: { name: string }) => one.name === name);
      expect(tool.annotations, name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool.outputSchema.type, name).toBe("object");
    }

    const { prompts } = await mcp("prompts/list");
    expect(prompts.map((prompt: { name: string }) => prompt.name)).toEqual(["morning_briefing", "nutrition_review", "weekly_report", "workout_review"]);
    const prompt = await mcp("prompts/get", { name: "nutrition_review", arguments: { date: day(-2) } });
    const text = prompt.messages[0].content.text as string;
    expect(prompt.messages).toHaveLength(1);
    expect(text).toContain('Call nutrition_day with {"date": "2026-10-14"}.');
    expect(text).toContain("profile_get");

    const { resources } = await mcp("resources/list");
    expect(resources.map((resource: { uri: string }) => resource.uri)).toEqual([GUARDRAILS_URI]);
    const read = await mcp("resources/read", { uri: GUARDRAILS_URI });
    expect(read.contents).toEqual([{ uri: GUARDRAILS_URI, mimeType: "text/markdown", text: GUARDRAILS }]);
    // R3, in the words of the Go server.
    expect(read.contents[0].text).toContain("You are a coach, not a clinician. Never diagnose");
    expect(read.contents[0].text).toContain("Never suggest starting, stopping or changing the dose of any medication or supplement.");

    // The account of the sign-in is linked, and its access token is still good.
    expect(await ok("google_account_status")).toMatchObject({ linked: true, email: "owner@example.com", token: "ok", scopes_missing: [] });
    // Lists, prompts, the resource and the status: nothing was asked of Google.
    expect(g.external).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("google_account_status")]);
    expectNoSecret(g.logged());
  });

  it("serves each of the five coach tools with the Google token of the sign-in", async () => {
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    const requests: number[] = [];
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const output = await ok(name, args);
      requests.push(g.takeExternal().total ?? 0);
      return output;
    };

    const briefing = await call("morning_briefing");
    expect(briefing.data.sleep).toMatchObject({ asleep_min: 440, efficiency_pct: 91.7, start: "2026-10-15T23:00:00-03:00", end: "2026-10-16T07:00:00-03:00" });
    expect(briefing.data.hrv).toEqual({ median_ms: 40, delta_pct_vs_28d: -4.8, z_score_vs_28d: -1.44 });
    expect(briefing.data.readiness).toEqual({ level: "yellow", reasons: ["hrv_below_baseline"], confidence: "high" });
    // I1: every aggregate has n_days and a confidence.
    expect(briefing.coverage).toEqual({ n_days: 28, confidence: "high" });
    expect(briefing.generated_at).toBe("2026-10-16T13:00:00Z");

    const workout = await call("workout_review", { date: day(-2) });
    expect(workout.data.sessions.map((session: Record<string, unknown>) => [session.type, session.active_min, session.max_hr_bpm])).toEqual([
      ["JIU_JITSU", 60, 95],
      ["RUNNING", 30, 164],
    ]);
    expect(workout.data.week_context).toMatchObject({ week_start: "2026-10-12", through: TODAY, sessions: 4 });
    expect(workout.data.recovery_context).toMatchObject({ night_ending: "2026-10-15", hrv_ms: 41, resting_hr_bpm: 56 });
    // I7: suspicious data is flagged, not hidden.
    expect(workout.quality_flags).toEqual(["low_hr_for_activity"]);

    // The target comes from the coach memory of the same store (I6).
    await ok("targets_set", { effective_from: "2026-10-01", kcal: 2000, protein_g: 150 });
    const nutrition = await call("nutrition_day", { date: day(-2) });
    expect(nutrition.data).toMatchObject({ date: "2026-10-14", items_logged: 4, notice: NUTRITION_NOTICE });
    expect(nutrition.data.totals.kcal).toEqual({ value: 2200, items_reporting: 4, complete: true });
    // I3: a nutrient that no item reports is null, never 0.
    expect(nutrition.data.totals.sugar_g).toBeNull();
    expect(nutrition.data.targets).toMatchObject({ kcal_target: 2000, kcal_delta: 200, protein_g_delta: -20, weight_kg: 80.3 });
    expect(nutrition.data.energy_balance).toEqual({ intake_kcal: 2200, total_calories_kcal: 2400, balance_kcal: -200 });

    const weekly = await call("weekly_report");
    expect(weekly.data).toMatchObject({ week_start: "2026-10-12", week_end: "2026-10-18", through: TODAY, notice: WEEKLY_NOTICE });
    expect(weekly.data.cardio.steps_per_day).toMatchObject({ this_week: 8025, prev_week: 8080, trend: "flat", n_days: 4 });
    expect(weekly.data.adherence.kcal_within_10pct).toMatchObject({ pct: 100, days_hit: 1, days_counted: 1, days_left_out: { partial_day: 1 } });
    expect(weekly.quality_flags).toEqual(["partial_day"]);

    const steps = await call("metric_series", { metric: "steps", from: day(-3), to: TODAY });
    expect(steps.data).toMatchObject({ metric: "steps", unit: "steps", granularity: "day", notice: SERIES_NOTICE });
    expect(steps.data.points.map((point: Record<string, unknown>) => point.value)).toEqual([8030, 8020, 8010, null]);
    expect(steps.data.points[3]).toMatchObject({ date: TODAY, reason: "partial_day" });

    // Each call is one request that the Worker forwards to the object (also targets_set).
    expect(served).toHaveBeenCalledTimes(6);
    // The Google requests of each call, all to the Health API. test/coach-e2e.test.ts
    // holds the plan of each tool, and test/subrequests.test.ts the worst cases.
    expect(requests).toEqual([8, 8, 4, 11, 1]);
    // The access token of the sign-in is sent to the Health API. No call asked for a new one.
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${GOOGLE_ACCESS_TOKEN}`]));
    // R4: the whole log is one line per call, with the tool name, the duration
    // and the outcome. No argument, result or health value has a place in it.
    expect(g.logLines("log")).toEqual(["morning_briefing", "workout_review", "targets_set", "nutrition_day", "weekly_report", "metric_series"].map((tool) => toolCall(tool)));
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });
});

describe("one error of each kind, as the client reads it", () => {
  it("answers no_data for a day without a food log", async () => {
    const error = await fails("nutrition_day", { date: day(-1) });
    expect(error).toMatchObject({ code: "no_data", message: "no food logged on that day" });
    expect(error.hint).toEqual(expect.any(String));
    // Only the food log is read: nothing else is asked for a day without one.
    expect(g.takeExternal()).toEqual({ total: 1, "nutrition-log": 1 });
    expect(g.logLines("log")).toEqual([toolCall("nutrition_day", "no_data")]);
  });

  it("answers invalid_input for a day after today, without a request to Google", async () => {
    expect(await fails("morning_briefing", { date: day(1) })).toEqual({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
    expect(g.external).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("morning_briefing", "invalid_input")]);
  });

  it("answers auth_expired with the reconnect hint when no Google account is linked", async () => {
    // The MCP grant is still valid; the Google link is gone.
    await runInDurableObject(coachStore(env), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });
    for (const name of COACH_TOOL_NAMES) {
      const args = name === "metric_series" ? { metric: "steps", from: day(-3), to: TODAY } : {};
      expect(await fails(name, args), name).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    }
    expect(await ok("google_account_status")).toMatchObject({ linked: false, token: "not_linked" });
    // Nothing is asked of Google, not even a token.
    expect(g.external).toEqual([]);
    expect(g.logLines("log")).toEqual([...COACH_TOOL_NAMES.map((name) => toolCall(name, "auth_expired")), toolCall("google_account_status")]);
  });

  it("answers scope_missing for an HTTP 403, without a retry", async () => {
    g.healthReply = googleError(403, "PERMISSION_DENIED");
    expect(await fails("workout_review", { date: day(-2) })).toEqual({
      code: "scope_missing",
      message: "Google Health denied access to exercise data",
      hint: `${RECONNECT_HINT} Allow every permission, and check that the Google Health API is enabled in the Cloud project.`,
    });
    expect(g.takeExternal()).toEqual({ total: 1, exercise: 1 });
    expect(g.logLines("log")).toEqual([toolCall("workout_review", "scope_missing")]);
    expect(g.logLines("warn")).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("answers upstream_unavailable when Google Health answers 503 to every attempt", async () => {
    const waited = skipRetryWaits(g);
    g.healthReply = googleError(503, "UNAVAILABLE");
    expect(await fails("metric_series", { metric: "weight", from: day(-6), to: TODAY })).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "try again in a few minutes",
    });
    // 4 attempts, with a wait of about 1, 2 and 4 seconds between them.
    expect(g.takeExternal()).toEqual({ total: 4, weight: 4 });
    expect(waited).toHaveLength(3);
    // The log has the data type, the HTTP status and the retry count: never the body.
    expect(g.logLines("warn")).toEqual(
      [1, 2, 3].map((retry) => ["google health request failed; retrying", { data_type: "weight", http_status: 503, retry, wait_ms: expect.any(Number) }]),
    );
    expect(g.logLines("log")).toEqual([toolCall("metric_series", "upstream_unavailable")]);
    expect(g.logLines("error")).toEqual([]);
    expectNoSecret(g.logged());
  });
});
