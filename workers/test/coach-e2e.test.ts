// The coach-moment tools served as in production: one MCP HTTP request to the
// CoachStore object (the Worker form of the Go server's in-memory transport
// tests), the real Google Health client and healthdata source, and Google
// behind a mocked `fetch`: the token endpoint and a fake Health API.
//
// The clock is fixed at 2026-10-16 10:00 in São Paulo. All values are synthetic.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDays } from "../src/coach/date";
import type { WireError } from "../src/coach/errors";
import { GOOGLE_HEALTH_SCOPES, GOOGLE_TOKEN_URL, OAUTH_CLIENT_HINT, RECONNECT_HINT } from "../src/google";
import { HEALTH_REQUESTS, MAX_SUBREQUESTS, TOKEN_REQUESTS } from "../src/googlehealth/budget";
import { CoachStore, type GoogleLink } from "../src/store";
import { NUTRITION_NOTICE } from "../src/tools/nutrition";
import { SERIES_NOTICE } from "../src/tools/series";
import { WEEKLY_NOTICE } from "../src/tools/weekly";
import {
  FakeGoogle,
  NOW,
  at,
  azmRollup,
  bodyFatRec,
  exerciseRec,
  foodRec,
  hrvNight,
  kcalRollup,
  restingRec,
  samplesEvery2s,
  sleepRec,
  stepRec,
  stepsRollup,
  weightRec,
} from "./healthdata-helpers";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, type JsonRpc, OWNER_EMAIL, OWNER_SUB, rpc, signInAsOwner } from "./helpers";
import { COACH_TOOL_NAMES, type McpTarget, SCHEMA_HINT, freshStore, mcpRequest, objectTool } from "./memory-helpers";

const TODAY = "2026-10-16";
const day = (offset: number) => addDays(TODAY, offset) as string;

const STORED_TOKEN = "at-stored-51c2";
const RENEWED_TOKEN = "at-renewed-8e07";

/** Text that must never reach a log line or an error: names, tokens and marked values. */
const SESSION_NAME = "JIU JITSU";
const FOOD_NAME = "Synthetic food";
const DECISION_TEXT = "Synthetic decision 7733: eat more at lunch";
const SECRETS = [
  STORED_TOKEN,
  RENEWED_TOKEN,
  GOOGLE_ACCESS_TOKEN,
  GOOGLE_REFRESH_TOKEN,
  SESSION_NAME,
  FOOD_NAME,
  DECISION_TEXT,
  "7733",
  "Synthetic Band",
  "Synthetic Scale",
];

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const spies = new Map<string, MockInstance>();
let google: FakeGoogle;
/** Every external fetch of the test so far: "token", or the Health data type. */
let external: string[];
/** The Authorization header of every Health API request. */
let auths: string[];
let tokenReply: () => Response | Promise<Response>;
/** When set, answers a Health API request instead of the fake API. */
let healthReply: ((request: Request) => Response | undefined) | undefined;

const newToken = (accessToken: string) => Response.json({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" });

beforeEach(() => {
  // Only the clock is fixed: timers stay real.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  for (const level of LEVELS) spies.set(level, vi.spyOn(console, level).mockImplementation(() => undefined));
  google = new FakeGoogle();
  external = [];
  auths = [];
  tokenReply = () => newToken(RENEWED_TOKEN);
  healthReply = undefined;
  installFetch();
});

/** Google behind `fetch`: the token endpoint and the fake Health API. Any other URL fails the test. */
function installFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === GOOGLE_TOKEN_URL && request.method === "POST") {
      external.push("token");
      return tokenReply();
    }
    if (!google.serves(request)) throw new Error(`unexpected fetch in test: ${request.method} ${request.url}`);
    const [, , , , , dataType = "?", operation = ""] = new URL(request.url).pathname.split("/");
    external.push(operation.endsWith(":dailyRollUp") ? `rollup ${dataType}` : dataType);
    auths.push(request.headers.get("authorization") ?? "");
    return healthReply?.(request) ?? google.respond(request);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(LEVELS.flatMap((level) => spies.get(level)?.mock.calls ?? []));
const logLines = (level: (typeof LEVELS)[number]) => spies.get(level)?.mock.calls ?? [];

/** The external fetches since the last take: a count per kind, and the total. */
function takeExternal(): Record<string, number> {
  const counts: Record<string, number> = { total: external.length };
  for (const kind of external) counts[kind] = (counts[kind] ?? 0) + 1;
  external = [];
  return counts;
}

function link(overrides: Partial<GoogleLink> = {}): GoogleLink {
  return {
    sub: OWNER_SUB,
    email: OWNER_EMAIL,
    refreshToken: GOOGLE_REFRESH_TOKEN,
    accessToken: STORED_TOKEN,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: ["openid", "email", ...GOOGLE_HEALTH_SCOPES].join(" "),
    ...overrides,
  };
}

/** A new store with a linked Google account. */
async function linkedStore(overrides: Partial<GoogleLink> = {}): Promise<DurableObjectStub<CoachStore>> {
  const stub = freshStore();
  await stub.linkGoogleAccount(link(overrides));
  return stub;
}

type Outcome = { ok: true; output: Record<string, any> } | { ok: false; error: WireError };

/** One HTTP request with several JSON-RPC messages; the answers by request id. */
async function batch(target: McpTarget, calls: [string, Record<string, unknown>][]): Promise<Outcome[]> {
  const body = calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  const response = await target.fetch(mcpRequest(body));
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const replies = new Map<number, JsonRpc>();
  const lines = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter((line) => line !== "")
    : [text];
  for (const line of lines) {
    const parsed = JSON.parse(line) as JsonRpc | JsonRpc[];
    for (const reply of Array.isArray(parsed) ? parsed : [parsed]) replies.set(Number(reply.id), reply);
  }
  return calls.map((_call, i) => {
    const reply = replies.get(i + 1);
    expect(reply?.error, JSON.stringify(reply)).toBeUndefined();
    const result = reply?.result as { isError?: boolean; content?: { text: string }[]; structuredContent?: Record<string, any> };
    if (result.isError) return { ok: false, error: JSON.parse(result.content?.[0]?.text ?? "") as WireError };
    return { ok: true, output: result.structuredContent ?? {} };
  });
}

/**
 * Synthetic data for today and the `back` days before it: each day a night of
 * 480 minutes in bed with 97 HRV samples, a resting heart rate, and the daily
 * totals. Every fifth day has no zone-minutes row but step records of the
 * band. A weigh-in with body fat every third day. A day that `offWrist` picks
 * has no band data: no zone-minutes row and no step record.
 */
function daysOfData(back: number, offWrist: (i: number) => boolean = () => false): void {
  for (let i = back; i >= 0; i--) {
    const [end, start] = [day(-i), day(-i - 1)];
    google.add("sleep", sleepRec(at(start, 23, 0), at(end, 7, 0), { deep: 60 }));
    google.add("heart-rate-variability", ...hrvNight(at(start, 23, 0), at(end, 7, 0), 40 + (i % 5)));
    google.add("daily-resting-heart-rate", restingRec(end, 55 + (i % 3), "WITH_SLEEP", "FITBIT"));
    google.addRollup("steps", stepsRollup(end, 8000 + 10 * (i % 100)));
    google.addRollup("total-calories", kcalRollup(end, 2400 + (i % 100)));
    // A day off the wrist has neither a zone-minutes row nor step records of the band.
    if (!offWrist(i)) {
      if (i % 5 === 3) google.add("steps", stepRec(end, "FITBIT"));
      else google.addRollup("active-zone-minutes", azmRollup(end, 20, 5, 0));
    }
    if (i % 3 === 0) {
      google.add("weight", weightRec(at(end, 7, 30), 80_000 + 100 * (i % 4), "FITBIT"));
      google.add("body-fat", bodyFatRec(at(end, 7, 30), 20 + (i % 2)));
    }
  }
}

/** One month, 2026-09-16 to 2026-10-16. */
const month = () => daysOfData(30);

const RUN_ID = "users/me/dataTypes/exercise/dataPoints/syn-run";

/** A jiu-jitsu class and a run on 2026-10-14, a walk on the 15th and a run on the 12th. */
function sessions(): void {
  const add = (date: string, hour: number, minutes: number, options: Parameters<typeof exerciseRec>[2], bpm: number) => {
    const [start, end] = [at(date, hour, 0), new Date(at(date, hour, 0).getTime() + minutes * 60_000)];
    google.add("exercise", exerciseRec(start, end, options));
    google.add("heart-rate", ...samplesEvery2s(start, end, bpm));
  };
  add(day(-2), 7, 60, { type: "JIU_JITSU", avgHR: 81, kcal: 400, azm: 10, zones: [40, 10, 0, 0] }, 95);
  add(day(-2), 18, 30, { type: "RUNNING", avgHR: 150, kcal: 350, azm: 50, zones: [2, 8, 15, 5], name: RUN_ID }, 164);
  add(day(-1), 12, 30, { type: "WALKING", avgHR: 100, kcal: 120, azm: 5, zones: [25, 5, 0, 0] }, 104);
  add(day(-4), 7, 40, { type: "RUNNING", avgHR: 148, kcal: 420, azm: 60, zones: [2, 8, 20, 10] }, 160);
}

/** Four meals on 2026-10-14 (kcal 2200, protein 130) and a snack today. */
function meals(): void {
  const closed = day(-2);
  google.add(
    "nutrition-log",
    foodRec(at(closed, 8, 0), { meal: "BREAKFAST", kcal: 500, carb: 60, fat: 15, list: { PROTEIN: 30 } }),
    foodRec(at(closed, 12, 0), { meal: "LUNCH", kcal: 800, carb: 90, fat: 25, list: { PROTEIN: 50, DIETARY_FIBER: 10 } }),
    foodRec(at(closed, 16, 0), { meal: "SNACK", kcal: 200, carb: 20, fat: 8, list: { PROTEIN: 10 } }),
    foodRec(at(closed, 20, 0), { meal: "DINNER", kcal: 700, carb: 70, fat: 20, list: { PROTEIN: 40 } }),
    foodRec(at(TODAY, 7, 0), { meal: "SNACK", kcal: 200, list: { PROTEIN: 10 } }),
  );
}

function everything(): void {
  month();
  sessions();
  meals();
}

async function ok(target: McpTarget, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const outcome = await objectTool(target, name, args);
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.output;
}

async function fails(target: McpTarget, name: string, args: Record<string, unknown> = {}): Promise<WireError> {
  const outcome = await objectTool(target, name, args);
  if (outcome.ok) throw new Error(`${name} succeeded, want an error`);
  return outcome.error;
}

describe("the coach tools over /mcp, inside the object", () => {
  it("serves morning_briefing", async () => {
    everything();
    const stub = await linkedStore();
    const out = await ok(stub, "morning_briefing");
    expect(out.data.sleep).toMatchObject({
      asleep_min: 440,
      awake_min: 40,
      efficiency_pct: 91.7,
      stages_min: { deep: 60, light: 292, rem: 88, awake: 40 },
      start: "2026-10-15T23:00:00-03:00",
      end: "2026-10-16T07:00:00-03:00",
    });
    expect(out.data.sleep.vs_7d.asleep_min).toEqual({ avg: 440, delta: 0, n_days: 7 });
    expect(out.data.sleep.vs_28d.deep_min).toEqual({ avg: 60, delta: 0, n_days: 28 });
    // The 28 nights before hold HRV 40 to 44 (mean 42, sd 1.39) and resting HR 55 to 57 (mean 56).
    expect(out.data.hrv).toEqual({ median_ms: 40, delta_pct_vs_28d: -4.8, z_score_vs_28d: -1.44 });
    expect(out.data.resting_hr).toEqual({ bpm: 55, delta_bpm_vs_28d: -1 });
    expect(out.data.readiness).toEqual({ level: "yellow", reasons: ["hrv_below_baseline"], confidence: "high" });
    // The session is listed by its type, never by its name.
    expect(out.data.yesterday_load).toEqual({
      date: "2026-10-15",
      exercises: [{ type: "WALKING", minutes: 30, avg_hr_bpm: 100, quality_flags: [] }],
      azm_min: 25,
      steps: 8010,
    });
    expect(out.data.body).toEqual({ weight_kg: 80, date: TODAY });
    expect(out.coverage).toEqual({ n_days: 28, confidence: "high" });
    expect(out.sources).toEqual(["Synthetic Band", "Synthetic Scale"]);
    expect(out.quality_flags).toEqual([]);
    expect(out.generated_at).toBe("2026-10-16T13:00:00Z");
    // The stored access token is sent, and nothing is asked of the token endpoint.
    expect(new Set(auths)).toEqual(new Set([`Bearer ${STORED_TOKEN}`]));
    expect(external).not.toContain("token");
    // One log line: the tool name, the duration and the outcome.
    expect(logLines("log")).toEqual([["tool_call", { tool: "morning_briefing", duration_ms: expect.any(Number), is_error: false }]]);
    expect(logLines("warn")).toEqual([]);
    expect(logLines("error")).toEqual([]);
  });

  it("serves workout_review, with the target of the store", async () => {
    everything();
    const stub = await linkedStore();
    await ok(stub, "targets_set", { effective_from: "2026-10-01", weekly_sessions: 4 });
    const out = await ok(stub, "workout_review", { date: day(-2) });
    expect(out.data.date).toBe("2026-10-14");
    expect(out.data.sessions).toEqual([
      {
        exercise_id: expect.stringMatching(/^users\/me\/dataTypes\/exercise\/dataPoints\/syn-\d+$/),
        type: "JIU_JITSU",
        name: SESSION_NAME,
        start: "2026-10-14T07:00:00-03:00",
        end: "2026-10-14T08:00:00-03:00",
        active_min: 60,
        avg_hr_bpm: 81,
        // The highest median of 5 consecutive band samples of the session.
        max_hr_bpm: 95,
        heart_rate_zone_minutes: { light: 40, moderate: 10, vigorous: 0, peak: 0 },
        kcal: 400,
        azm_min: 10,
        quality_flags: ["low_hr_for_activity"],
        source: "Synthetic Band",
      },
      {
        exercise_id: RUN_ID,
        type: "RUNNING",
        name: "RUNNING",
        start: "2026-10-14T18:00:00-03:00",
        end: "2026-10-14T18:30:00-03:00",
        active_min: 30,
        avg_hr_bpm: 150,
        max_hr_bpm: 164,
        heart_rate_zone_minutes: { light: 2, moderate: 8, vigorous: 15, peak: 5 },
        kcal: 350,
        azm_min: 50,
        quality_flags: [],
        source: "Synthetic Band",
      },
    ]);
    expect(out.data.sessions_omitted).toBe(0);
    // Monday the 12th to today: a run, the two sessions of the day and a walk.
    expect(out.data.week_context).toEqual({
      week_start: "2026-10-12",
      through: TODAY,
      sessions: 4,
      weekly_sessions_target: 4,
      active_min_by_type: { RUNNING: 70, JIU_JITSU: 60, WALKING: 30 },
    });
    // The night ending on the 15th against the 28 nights before it (HRV mean 42.1, resting HR mean 56.0).
    expect(out.data.recovery_context).toEqual({
      night_ending: "2026-10-15",
      hrv_ms: 41,
      hrv_delta_pct_vs_28d: -2.6,
      hrv_baseline_n_days: 28,
      resting_hr_bpm: 56,
      resting_hr_delta_bpm_vs_28d: 0,
      resting_hr_baseline_n_days: 28,
    });
    expect(out.coverage).toEqual({ n_days: 5, confidence: "low" });
    expect(out.sources).toEqual(["Synthetic Band"]);
    expect(out.quality_flags).toEqual(["low_hr_for_activity"]);

    // One session by its ID: the day is found in the last 28 days.
    const one = await ok(stub, "workout_review", { exercise_id: RUN_ID });
    expect(one.data.date).toBe("2026-10-14");
    expect(one.data.sessions.map((session: { type: string }) => session.type)).toEqual(["RUNNING"]);
    expect(await fails(stub, "workout_review", { exercise_id: "users/me/dataTypes/exercise/dataPoints/none" })).toMatchObject({ code: "no_data" });
  });

  it("serves nutrition_day, with the target of the store", async () => {
    everything();
    const stub = await linkedStore();
    await ok(stub, "targets_set", { effective_from: "2026-10-01", kcal: 2000, protein_g: 150 });
    const out = await ok(stub, "nutrition_day", { date: day(-2) });
    const data = out.data;
    expect(data).toMatchObject({ date: "2026-10-14", items_logged: 4, items_omitted: 0, notice: NUTRITION_NOTICE });
    expect(data.totals).toEqual({
      kcal: { value: 2200, items_reporting: 4, complete: true },
      protein_g: { value: 130, items_reporting: 4, complete: true },
      carb_g: { value: 240, items_reporting: 4, complete: true },
      fat_g: { value: 68, items_reporting: 4, complete: true },
      fiber_g: { value: 10, items_reporting: 1, complete: false },
      sugar_g: null,
      sodium_mg: null,
    });
    expect(data.per_meal.map((meal: { meal_type: string }) => meal.meal_type)).toEqual(["BREAKFAST", "LUNCH", "DINNER", "SNACK"]);
    expect(data.per_meal[1].items).toEqual([
      {
        name: FOOD_NAME,
        time: "2026-10-14T12:00:00-03:00",
        nutrients: { kcal: 800, protein_g: 50, carb_g: 90, fat_g: 25, fiber_g: 10, sugar_g: null, sodium_mg: null },
        rejected_nutrients: [],
      },
    ]);
    // The weigh-in of the 13th (80.3 kg) is the last one on or before the day.
    expect(data.targets).toEqual({
      effective_from: "2026-10-01",
      kcal_target: 2000,
      kcal_delta: 200,
      protein_g_target: 150,
      protein_g_delta: -20,
      protein_g_per_kg: 1.62,
      protein_g_lower_bound: false,
      weight_kg: 80.3,
      weight_date: "2026-10-13",
      weight_age_days: 1,
    });
    // 2402 kcal burned, shown to the nearest 50.
    expect(data.energy_balance).toEqual({ intake_kcal: 2200, total_calories_kcal: 2400, balance_kcal: -200 });
    expect(data.logging_completeness).toEqual({ meals_logged: 4, has_main_meal: true, likely_incomplete: false, kcal_pct_of_target: 110 });
    expect(out.coverage).toEqual({ n_days: 1, confidence: "low" });
    // A food record names no device: its label is the platform.
    expect(out.sources).toEqual(["FITBIT", "Synthetic Scale"]);
    expect(out.quality_flags).toEqual([]);

    // Today is a partial day: the totals are still running.
    const today = await ok(stub, "nutrition_day");
    expect(today.data.date).toBe(TODAY);
    expect(today.data.energy_balance).toEqual({ intake_kcal: 200, total_calories_kcal: 2400, balance_kcal: null, unavailable: "partial_day" });
    expect(today.quality_flags).toEqual(["partial_day"]);
    // A day without a log.
    expect(await fails(stub, "nutrition_day", { date: day(-1) })).toMatchObject({ code: "no_data", message: "no food logged on that day" });
  });

  it("serves weekly_report, with the targets and the decision notes of the store", async () => {
    everything();
    const stub = await linkedStore();
    await ok(stub, "targets_set", { effective_from: "2026-10-01", kcal: 2000, protein_g: 150, weekly_sessions: 4 });
    const decision = await ok(stub, "note_add", { kind: "decision", text: DECISION_TEXT, related_date: day(-2) });
    // A decision of another week, and a note of another kind in this week: not listed.
    await ok(stub, "note_add", { kind: "decision", text: "An older synthetic decision", related_date: day(-9) });
    await ok(stub, "note_add", { kind: "insight", text: "A synthetic insight", related_date: day(-2) });
    const out = await ok(stub, "weekly_report");
    const data = out.data;
    // Friday 2026-10-16: the week runs from Monday the 12th and counts up to today.
    expect(data).toMatchObject({ week_start: "2026-10-12", week_end: "2026-10-18", through: TODAY, prev_week_start: "2026-10-05", notice: WEEKLY_NOTICE });
    // Today's running totals are left out: four days this week, and the month's 26 days before the week.
    expect(data.cardio.steps_per_day).toEqual({ this_week: 8025, prev_week: 8080, avg_28d: 8175, trend: "flat", n_days: 4, prev_week_n_days: 7, avg_28d_n_days: 26 });
    // 2026-10-13 has no zone-minutes row, but the band counted steps: 0 minutes, not a missing day.
    expect(data.cardio.azm_per_day).toMatchObject({ this_week: 18.8, prev_week: 21.4, trend: "flat", n_days: 4, prev_week_n_days: 7 });
    expect(data.cardio.resting_hr_bpm).toMatchObject({ this_week: 55.8, prev_week: 56.1, trend: "flat", n_days: 5, prev_week_n_days: 7, avg_28d_n_days: 26 });
    expect(data.cardio.hrv_ms).toMatchObject({ this_week: 42, prev_week: 41.6, trend: "flat", n_days: 5, prev_week_n_days: 7 });
    expect(data.sleep.asleep_min).toEqual({ this_week: 440, prev_week: 440, avg_28d: 440, trend: "flat", n_days: 5, prev_week_n_days: 7, avg_28d_n_days: 26 });
    expect(data.sleep.efficiency_pct).toMatchObject({ this_week: 91.7, prev_week: 91.7, trend: "flat" });
    expect(data.sleep.onset_sd_min).toMatchObject({ this_week: 0, prev_week: 0, trend: "flat" });
    // Two weigh-ins this week (the 13th and today): too few for a trend.
    expect(data.body.weight_kg).toMatchObject({ trend: "unknown", trend_unavailable: "insufficient_days", n_days: 2, prev_week_n_days: 2 });
    expect(data.body).toMatchObject({ last_weigh_in: TODAY, weight_age_days: 0, weight_slope_n_days: 10, weight_slope_span_days: 27 });
    expect(data.body.body_fat_pct).toMatchObject({ trend: "unknown", trend_unavailable: "insufficient_days", n_days: 2 });
    // The 14th (2200 kcal, 130 g protein) against 2000 kcal and 150 g; today's log is still growing.
    expect(data.adherence).toEqual({
      kcal_within_10pct: { pct: 100, days_hit: 1, days_counted: 1, days_below: 0, days_above: 0, days_left_out: { partial_day: 1 } },
      protein_at_least_target: { pct: 0, days_hit: 0, days_counted: 1, days_left_out: { partial_day: 1 } },
      days_logged: 2,
      sessions: 4,
      weekly_sessions_target: 4,
    });
    expect(data.decisions_this_week).toEqual([decision]);
    expect(data.decisions_more).toBe(false);
    expect(out.coverage).toEqual({ n_days: 5, confidence: "low" });
    expect(out.sources).toEqual(["Synthetic Band", "Synthetic Scale"]);
    expect(out.quality_flags).toEqual(["partial_day"]);
    expect(logLines("log").at(-1)).toEqual(["tool_call", { tool: "weekly_report", duration_ms: expect.any(Number), is_error: false }]);
    expect(logLines("warn")).toEqual([]);

    // A closed week, by any of its days.
    const closed = await ok(stub, "weekly_report", { week_end: day(-7) });
    expect(closed.data).toMatchObject({ week_start: "2026-10-05", week_end: "2026-10-11", through: "2026-10-11", decisions_this_week: [{ text: "An older synthetic decision" }] });
    expect(closed.coverage.n_days).toBe(7);
    expect(await fails(stub, "weekly_report", { week_end: day(1) })).toEqual({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
  });

  it("serves metric_series", async () => {
    everything();
    const stub = await linkedStore();
    const steps = await ok(stub, "metric_series", { metric: "steps", from: day(-3), to: TODAY });
    expect(steps.data).toEqual({
      metric: "steps",
      unit: "steps",
      granularity: "day",
      from: "2026-10-13",
      to: TODAY,
      points: [
        { date: "2026-10-13", value: 8030, n_days: 1, complete: true },
        { date: "2026-10-14", value: 8020, n_days: 1, complete: true },
        { date: "2026-10-15", value: 8010, n_days: 1, complete: true },
        // Today's total still grows: null with the reason, never a low value.
        { date: TODAY, value: null, n_days: 0, complete: true, reason: "partial_day" },
      ],
      notice: SERIES_NOTICE,
    });
    expect(steps.coverage).toEqual({ n_days: 3, confidence: "low" });
    expect(steps.quality_flags).toEqual(["partial_day"]);
    expect(steps.sources).toEqual([]);

    // Weeks from their Monday; the month of data starts on Wednesday 2026-09-16.
    const hrv = await ok(stub, "metric_series", { metric: "hrv", from: "2026-09-14", to: "2026-09-27", granularity: "week" });
    expect(hrv.data.points).toEqual([
      { date: "2026-09-14", value: 42, n_days: 5, complete: true },
      { date: "2026-09-21", value: 42, n_days: 7, complete: true },
    ]);
    expect(hrv.data.unit).toBe("ms");
    expect(hrv.sources).toEqual(["Synthetic Band"]);

    // Food without a kcal target: the log check takes the calories burned as its reference.
    const kcal = await ok(stub, "metric_series", { metric: "kcal_in", from: day(-3), to: day(-1) });
    expect(kcal.data.points).toEqual([
      { date: "2026-10-13", value: null, n_days: 0, complete: true },
      { date: "2026-10-14", value: 2200, n_days: 1, complete: true },
      { date: "2026-10-15", value: null, n_days: 0, complete: true },
    ]);
    expect(kcal.sources).toEqual(["FITBIT"]);

    expect(await fails(stub, "metric_series", { metric: "steps", from: day(-200), to: TODAY })).toEqual({
      code: "invalid_input",
      message: "the series would have 201 points, more than 180",
      hint: "use granularity week or a shorter range",
    });
    expect(await fails(stub, "metric_series", { metric: "mood", from: day(-3), to: TODAY })).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
  });

  it("serves a coach tool through the Worker, which forwards the request to the object", async () => {
    const { access_token: accessToken } = await signInAsOwner();
    installFetch();
    everything();
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    const reply = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nutrition_day", arguments: { date: day(-2) } } });
    expect(reply.error).toBeUndefined();
    const result = reply.result as { isError?: boolean; structuredContent?: Record<string, any> };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.data.totals.kcal).toEqual({ value: 2200, items_reporting: 4, complete: true });
    // The Google token of the sign-in is the one sent to the Health API, and the
    // Worker itself made no request to Google.
    expect(new Set(auths)).toEqual(new Set([`Bearer ${GOOGLE_ACCESS_TOKEN}`]));
    expect(served).toHaveBeenCalledTimes(1);
  });
});

const CALLS: [string, Record<string, unknown>][] = [
  ["morning_briefing", {}],
  ["workout_review", { date: day(-2) }],
  ["nutrition_day", { date: day(-2) }],
  ["weekly_report", {}],
  ["metric_series", { metric: "steps", from: day(-6), to: TODAY }],
];

describe("a coach tool without a usable Google link", () => {
  const SCOPE_HINT = `${RECONNECT_HINT} Allow every permission, and check that the Google Health API is enabled in the Cloud project.`;
  const googleError = (status: number, grpc: string) => () =>
    Response.json({ error: { code: status, message: `denied for ${STORED_TOKEN}: synthetic body 7711`, status: grpc } }, { status });

  /** No token, no name and no part of Google's answer in the error or in a log line. */
  function expectNoLeak(error: WireError): void {
    for (const secret of [...SECRETS, "7711", "invalid_client", "invalid_grant"]) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(logged()).not.toContain(secret);
    }
  }

  it.each(CALLS)("%s answers auth_expired with the reconnect hint when no account is linked", async (name, args) => {
    everything();
    const error = await fails(freshStore(), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    // Nothing is asked of Google.
    expect(external).toEqual([]);
    expect(logLines("log")).toEqual([["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: true, code: "auth_expired" }]]);
  });

  it.each(CALLS)("%s answers auth_expired when Google rejects the stored token and the renewed one", async (name, args) => {
    everything();
    healthReply = googleError(401, "UNAUTHENTICATED");
    const error = await fails(await linkedStore(), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "Google Health rejected the sign-in", hint: RECONNECT_HINT });
    // One renewal, and the request sent once more with the new token.
    expect(auths).toEqual([`Bearer ${STORED_TOKEN}`, `Bearer ${RENEWED_TOKEN}`]);
    expect(takeExternal()).toMatchObject({ total: 3, token: 1 });
    expectNoLeak(error);
  });

  it.each(CALLS)("%s answers auth_expired when Google revoked the link", async (name, args) => {
    everything();
    tokenReply = () => Response.json({ error: "invalid_grant", error_description: `revoked ${GOOGLE_REFRESH_TOKEN}` }, { status: 400 });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const error = await fails(stub, name, args);
    expect(error).toEqual({ code: "auth_expired", message: "the Google sign-in expired or was revoked", hint: RECONNECT_HINT });
    expect(external).toEqual(["token"]);
    expectNoLeak(error);
    // The link is gone: the status tool says so.
    expect((await ok(stub, "google_account_status")).linked).toBe(false);
  });

  it.each(CALLS)("%s answers auth_expired when Google refuses the token renewal", async (name, args) => {
    everything();
    tokenReply = () => Response.json({ error: "invalid_client", error_description: "synthetic body 7711" }, { status: 401 });
    const error = await fails(await linkedStore({ accessTokenExpiresAt: 0 }), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "Google rejected the token renewal", hint: `${OAUTH_CLIENT_HINT} ${RECONNECT_HINT}` });
    expect(external).toEqual(["token"]);
    expectNoLeak(error);
  });

  it.each(CALLS)("%s answers upstream_unavailable for a renewal answered without a usable token", async (name, args) => {
    everything();
    tokenReply = () => Response.json({ token_type: "Bearer", note: "synthetic body 7711" });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const error = await fails(stub, name, args);
    // The link and the OAuth client are fine: the same call can work later.
    expect(error).toEqual({ code: "upstream_unavailable", message: "Google's token service is unavailable", hint: "try again in a few minutes" });
    expect(external).toEqual(["token"]);
    expectNoLeak(error);
    expect(await ok(stub, "google_account_status")).toMatchObject({
      linked: true,
      token: "upstream_unavailable",
      hint: "Google is unavailable right now. Try again in a few minutes.",
    });
  });

  it.each(CALLS)("%s answers scope_missing when Google denies the data", async (name, args) => {
    everything();
    healthReply = googleError(403, "PERMISSION_DENIED");
    const error = await fails(await linkedStore(), name, args);
    expect(error.code).toBe("scope_missing");
    expect(error.message).toMatch(/^Google Health denied access to [a-z-]+ data$/);
    expect(error.hint).toBe(SCOPE_HINT);
    // A denial is not retried, and it is not a reason to renew the token.
    expect(takeExternal()).toMatchObject({ total: 1 });
    expectNoLeak(error);
  });

  it.each(CALLS)("%s hides a request that Google rejects behind internal_error", async (name, args) => {
    everything();
    healthReply = googleError(400, "INVALID_ARGUMENT");
    const error = await fails(await linkedStore(), name, args);
    expect(error).toEqual({ code: "internal_error", message: "unexpected internal error" });
    // The logs carry the data type, the HTTP status, Google's status enum and
    // the error types: never the answer's text.
    expect(logLines("warn")).toEqual([
      ["google health request rejected", { data_type: expect.any(String), http_status: 400, google_status: "INVALID_ARGUMENT" }],
    ]);
    expect(logLines("error")).toEqual([["tool_internal_error", { tool: name, error_types: "Error > StatusError" }]]);
    expect(logLines("log")).toEqual([["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: true, code: "internal_error" }]]);
    expectNoLeak(error);
  });

  it("fails every coach tool, and names the variable in the log, with a zone it cannot use", async () => {
    everything();
    const stub = await linkedStore();
    await runInDurableObject(stub, async (instance) => {
      Object.assign(instance, { env: { ...env, HCM_TZ: "Local" } });
      for (const [name, args] of CALLS) {
        expect(await objectTool(instance, name, args)).toEqual({ ok: false, error: { code: "internal_error", message: "unexpected internal error" } });
      }
    });
    expect(logLines("error")).toEqual(CALLS.map(() => ["config_error", { variable: "HCM_TZ" }]));
    expect(external).toEqual([]);
  });
});

describe("the logs of the coach tools", () => {
  it("carry no health value, name, token or response body", async () => {
    everything();
    // A record that cannot be read, with a marked value.
    google.add("sleep", { dataSource: { platform: "FITBIT" }, sleep: { interval: { endTime: "2026-10-16T10:00:00Z" }, summary: { minutesAsleep: { marked: "7711" } } } });
    const stub = await linkedStore();
    // A decision note of this week: weekly_report returns its text.
    await ok(stub, "note_add", { kind: "decision", text: DECISION_TEXT, related_date: day(-2) });
    for (const level of LEVELS) spies.get(level)?.mockClear();
    const outputs = new Map<string, Record<string, any>>();
    for (const [name, args] of CALLS) outputs.set(name, await ok(stub, name, args));
    expect(outputs.get("morning_briefing")?.quality_flags).toEqual(["unreadable_records"]);
    expect(outputs.get("weekly_report")?.quality_flags).toEqual(["partial_day", "unreadable_records"]);
    expect(outputs.get("weekly_report")?.data.decisions_this_week).toMatchObject([{ text: DECISION_TEXT }]);
    expect(COACH_TOOL_NAMES).toEqual(CALLS.map(([name]) => name));
    // One line per call, with the tool name, the duration and the outcome.
    expect(logLines("log")).toEqual(CALLS.map(([name]) => ["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: false }]));
    // The unreadable record: the range asked and a count, once per call that fetched it.
    expect(logLines("warn")).toEqual([
      ["unreadable records in a recovery fetch", { from: "2026-09-18", to: "2026-10-16", skipped: 1 }],
      ["unreadable records in a recovery fetch", { from: "2026-09-17", to: "2026-10-15", skipped: 1 }],
      ["unreadable records in a recovery fetch", { from: "2026-09-14", to: "2026-10-16", skipped: 1 }],
    ]);
    expect(logLines("error")).toEqual([]);
    // No token, name or note text, and no value of a result: steps, kcal, weight, minutes, weekly means.
    for (const secret of [...SECRETS, "7711", "8010", "2200", "80.3", "440", "8025", "55.8", "18.8"]) expect(logged()).not.toContain(secret);
  });

  it("carry no health value or note text for a call that fails", async () => {
    everything();
    const stub = await linkedStore();
    await ok(stub, "note_add", { kind: "decision", text: DECISION_TEXT, related_date: day(-2) });
    for (const level of LEVELS) spies.get(level)?.mockClear();
    // Google rejects one data type with a body that quotes a value; the reads before it succeed.
    healthReply = (request) =>
      request.url.includes("/nutrition-log/") || request.url.includes("/weight/")
        ? Response.json({ error: { code: 400, message: "bad filter near 8025 for Synthetic food", status: "INVALID_ARGUMENT" } }, { status: 400 })
        : undefined;
    const internal = { code: "internal_error", message: "unexpected internal error" };
    expect(await fails(stub, "weekly_report")).toEqual(internal);
    expect(await fails(stub, "metric_series", { metric: "kcal_in", from: day(-6), to: TODAY })).toEqual(internal);
    expect(await fails(stub, "metric_series", { metric: "weight", from: day(-6), to: TODAY })).toEqual(internal);
    expect(logLines("log")).toEqual(
      ["weekly_report", "metric_series", "metric_series"].map((tool) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: true, code: "internal_error" }]),
    );
    // The data type, the HTTP status and Google's status enum: never the answer's text.
    expect(logLines("warn")).toEqual([
      ["google health request rejected", { data_type: "weight", http_status: 400, google_status: "INVALID_ARGUMENT" }],
      ["google health request rejected", { data_type: "nutrition-log", http_status: 400, google_status: "INVALID_ARGUMENT" }],
      ["google health request rejected", { data_type: "weight", http_status: 400, google_status: "INVALID_ARGUMENT" }],
    ]);
    expect(logLines("error")).toEqual(
      ["weekly_report", "metric_series", "metric_series"].map((tool) => ["tool_internal_error", { tool, error_types: "Error > StatusError" }]),
    );
    for (const secret of [...SECRETS, "8025", "bad filter", "2200", "80.3", "440"]) expect(logged()).not.toContain(secret);
  });
});

// The request plan of each tool, counted as HTTP requests to Google. Days up
// to 2026-10-13 are settled, so a second call finds them in the cache.
describe("the Google requests of one MCP request", () => {
  it.each<[string, Record<string, unknown>, Record<string, number>, Record<string, number>]>([
    [
      "morning_briefing",
      {},
      // recovery (sleep in 2 pages, HRV, resting heart rate), yesterday's
      // activity (steps and zone minutes), yesterday's sessions, the weight.
      { total: 8, sleep: 2, "heart-rate-variability": 1, "daily-resting-heart-rate": 1, "rollup steps": 1, "rollup active-zone-minutes": 1, exercise: 1, weight: 1 },
      { total: 7, sleep: 1, "heart-rate-variability": 1, "daily-resting-heart-rate": 1, "rollup steps": 1, "rollup active-zone-minutes": 1, exercise: 1, weight: 1 },
    ],
    [
      "workout_review",
      { date: day(-2) },
      // the day's sessions with one heart-rate list each, the week's sessions,
      // recovery of the night after.
      { total: 8, exercise: 2, "heart-rate": 2, sleep: 2, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 },
      { total: 7, exercise: 2, "heart-rate": 2, sleep: 1, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 },
    ],
    [
      "nutrition_day",
      { date: day(-2) },
      // the food log, the day's activity (zone minutes for "worn", total
      // calories), the weight. The day is not settled yet: nothing is cached.
      { total: 4, "nutrition-log": 1, "rollup active-zone-minutes": 1, "rollup total-calories": 1, weight: 1 },
      { total: 4, "nutrition-log": 1, "rollup active-zone-minutes": 1, "rollup total-calories": 1, weight: 1 },
    ],
  ])("%s on a cold cache with one month of data, then on the cache it filled", async (name, args, cold, warm) => {
    everything();
    const stub = await linkedStore();
    const first = await ok(stub, name, args);
    expect(takeExternal(), "cold").toEqual(cold);
    const second = await ok(stub, name, args);
    expect(takeExternal(), "warm").toEqual(warm);
    expect(second.data).toEqual(first.data);
  });

  it("lists the band's steps only when the day has no zone-minutes row", async () => {
    everything();
    const stub = await linkedStore();
    // 2026-10-13 has no zone-minutes row; the band's step records show it was worn.
    await ok(stub, "targets_set", { effective_from: "2026-10-01", kcal: 2000 });
    google.add("nutrition-log", foodRec(at(day(-3), 12, 0), { meal: "LUNCH", kcal: 1800, list: { PROTEIN: 90 } }));
    const out = await ok(stub, "nutrition_day", { date: day(-3) });
    expect(out.quality_flags).toEqual([]);
    expect(out.data.energy_balance).toEqual({ intake_kcal: 1800, total_calories_kcal: 2400, balance_kcal: -600 });
    expect(takeExternal()).toEqual({ total: 5, "nutrition-log": 1, "rollup active-zone-minutes": 1, steps: 1, "rollup total-calories": 1, weight: 1 });
    // The day is settled: its activity now comes from the cache, with the same result.
    const again = await ok(stub, "nutrition_day", { date: day(-3) });
    expect(takeExternal()).toEqual({ total: 2, "nutrition-log": 1, weight: 1 });
    expect(again.data).toEqual(out.data);
    expect(again.quality_flags).toEqual([]);
  });
});

/** Two meals on each of the `back` days before today. */
function foodDays(back: number): void {
  for (let i = back; i >= 1; i--) {
    google.add(
      "nutrition-log",
      foodRec(at(day(-i), 12, 0), { meal: "LUNCH", kcal: 1200, list: { PROTEIN: 70 } }),
      foodRec(at(day(-i), 20, 0), { meal: "DINNER", kcal: 900, list: { PROTEIN: 60 } }),
    );
  }
}

/**
 * Calls a tool on one store, one MCP HTTP request per call, until it
 * succeeds. Returns the Google requests of each call. A call may fail only
 * with the budget error of the client, and never sends more than the budget.
 */
async function untilOk(target: McpTarget, name: string, args: Record<string, unknown>): Promise<{ output: Record<string, any>; calls: Record<string, number>[] }> {
  const calls: Record<string, number>[] = [];
  for (let n = 0; n < 6; n++) {
    const outcome = await objectTool(target, name, args);
    const counts = takeExternal();
    calls.push(counts);
    expect(counts.total, `call ${n + 1}`).toBeLessThanOrEqual(HEALTH_REQUESTS);
    expect(counts.token ?? 0).toBe(0);
    if (outcome.ok) return { output: outcome.output, calls };
    expect(outcome.error.message, `call ${n + 1}`).toMatch(/^the date range holds more [a-z-]+ data than one call reads$/);
    expect(outcome.error).toMatchObject({ code: "invalid_input", hint: "use a shorter date range" });
  }
  throw new Error(`${name} did not succeed in ${calls.length} calls: ${JSON.stringify(calls)}`);
}

// The request plans of weekly_report and metric_series, counted as HTTP
// requests to Google on a cold cache. One MCP HTTP request may send 45.
describe("the Google requests of the two report tools on a cold cache", () => {
  it("weekly_report with six weeks of data", async () => {
    daysOfData(41);
    sessions();
    meals();
    const stub = await linkedStore();
    const first = await ok(stub, "weekly_report");
    // No kcal target: the log check of the week's two logged days reads total calories too.
    expect(takeExternal(), "cold, no targets").toEqual({
      total: 12,
      // recovery of the 28 days before the week and the week: sleep in 2 pages, HRV, resting heart rate
      sleep: 2,
      "heart-rate-variability": 1,
      "daily-resting-heart-rate": 1,
      // steps and zone minutes, and the band's steps for the days without a zone-minutes row
      "rollup steps": 1,
      "rollup active-zone-minutes": 1,
      steps: 1,
      // 90 days of weight and body fat
      weight: 1,
      "body-fat": 1,
      // the week's food log and sessions
      "nutrition-log": 1,
      exercise: 1,
      // total calories of the week's logged days
      "rollup total-calories": 1,
    });
    const second = await ok(stub, "weekly_report");
    // The settled days come from the cache: one sleep page less, and no steps list.
    expect(takeExternal(), "the cache it filled").toEqual({
      total: 10,
      sleep: 1,
      "heart-rate-variability": 1,
      "daily-resting-heart-rate": 1,
      "rollup steps": 1,
      "rollup active-zone-minutes": 1,
      weight: 1,
      "body-fat": 1,
      "nutrition-log": 1,
      exercise: 1,
      "rollup total-calories": 1,
    });
    expect(second.data).toEqual(first.data);
    // With a kcal target in force the total-calories rollup is not read.
    const withTarget = await linkedStore();
    await ok(withTarget, "targets_set", { effective_from: "2026-10-01", kcal: 2000, protein_g: 150, weekly_sessions: 4 });
    await ok(withTarget, "weekly_report");
    const targeted = takeExternal();
    expect(targeted.total, "cold, with a kcal target").toBe(11);
    expect(targeted).not.toHaveProperty("rollup total-calories");
    // A closed week reads the same data types over a range that ends on its Sunday.
    await ok(await linkedStore(), "weekly_report", { week_end: day(-7) });
    expect(takeExternal().total, "cold, the week before").toBe(11);
  });

  // A day without band data has no zone-minutes value, so no call can cache
  // it: every call reads it again. These years are harder than the one above.
  it.each<[string, (i: number) => boolean, Record<string, [number[], number]>]>([
    // Each later call reads the off-wrist days again: their zone-minutes
    // rollups and step lists, and for total_calories their 14-day windows.
    // kcal_in reads total calories only for the days with the band.
    ["a day off the wrist in every week", (i) => i % 7 === 6, { total_calories: [[45], 43], azm: [[18], 17], kcal_in: [[45, 18], 18] }],
    // total_calories takes the whole budget on every call. kcal_in has no
    // day with the band, so it reads no total calories: the food log 1, the
    // zone-minutes rollup 5 and the steps lists 13.
    ["no band data at all", () => true, { total_calories: [[45], 45], azm: [[18], 18], kcal_in: [[19], 19] }],
  ])("metric_series over 366 days with %s", async (_name, offWrist, expected) => {
    daysOfData(365, offWrist);
    foodDays(365);
    const measured: Record<string, [number[], number]> = {};
    for (const metric of Object.keys(expected)) {
      const stub = await linkedStore();
      const args = { metric, from: day(-365), to: TODAY, granularity: "week" };
      const cold = await untilOk(stub, "metric_series", args);
      const warm = await untilOk(stub, "metric_series", args);
      expect(warm.calls, metric).toHaveLength(1);
      expect(warm.output.data, metric).toEqual(cold.output.data);
      measured[metric] = [cold.calls.map((counts) => counts.total), warm.calls[0]?.total ?? 0];
    }
    expect(measured).toEqual(expected);
  });

  // 366 days by week: 53 points. The data has one night with 97 HRV samples,
  // one resting value and three rollup rows per day; every fifth day has no
  // zone-minutes row but step records of the band. `calls` lists the Google
  // requests of each MCP request until the tool succeeds, and `again` the
  // requests of one more call on the cache they filled.
  it.each<[string, number[], number]>([
    // one weight list
    ["weight", [1], 1],
    // one resting heart rate list
    ["resting_hr", [1], 1],
    // sleep 18 pages (6 windows of 63 nights), HRV 6
    ["hrv", [24], 2],
    ["sleep_asleep_min", [24], 2],
    // one steps rollup per 90 days
    ["steps", [5], 1],
    // zone-minutes rollup 5, the band's steps for the days without a row 13
    ["azm", [18], 1],
    // total-calories rollup 27 (14 days each), zone minutes 5, the band's steps 13: the whole budget
    ["total_calories", [45], 2],
    // No kcal target: the food log 1, then the 45 of total_calories do not fit.
    // The first call ends with the budget error and leaves its windows cached.
    ["kcal_in", [45, 3], 3],
    ["protein_g", [45, 3], 3],
  ])("metric_series %s over 366 days", async (metric, calls, again) => {
    daysOfData(365);
    foodDays(365);
    const stub = await linkedStore();
    const args = { metric, from: day(-365), to: TODAY, granularity: "week" };
    const cold = await untilOk(stub, "metric_series", args);
    expect(cold.output.data.points).toHaveLength(53);
    expect(cold.calls.map((counts) => counts.total), JSON.stringify(cold.calls)).toEqual(calls);
    const warm = await untilOk(stub, "metric_series", args);
    expect(warm.calls.map((counts) => counts.total), JSON.stringify(warm.calls)).toEqual([again]);
    expect(warm.output.data).toEqual(cold.output.data);
  });
});

// One HTTP request can carry several tool calls: the transport takes a
// JSON-RPC batch. The limit of 50 subrequests is for the whole HTTP request.
describe("one HTTP request with several tool calls", () => {
  it("shares one request budget and one token answer between the coach tools and google_account_status", async () => {
    everything();
    // An expired access token and a cold cache: the worst start.
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const [briefing, workout, nutrition, weekly, series, status] = await batch(stub, [...CALLS, ["google_account_status", {}]]);
    expect(briefing).toMatchObject({ ok: true, output: { data: { readiness: { level: "yellow" } } } });
    expect(workout).toMatchObject({ ok: true, output: { data: { date: "2026-10-14" } } });
    expect(nutrition).toMatchObject({ ok: true, output: { data: { items_logged: 4 } } });
    expect(weekly).toMatchObject({ ok: true, output: { data: { week_start: "2026-10-12", through: TODAY } } });
    expect(series).toMatchObject({ ok: true, output: { data: { metric: "steps", unit: "steps" } } });
    expect(status).toMatchObject({ ok: true, output: { linked: true, token: "ok" } });
    // Every external fetch of the HTTP request: one token renewal for the six
    // calls, and the Google Health requests of the five tools, which take
    // turns: a later tool finds in the cache what an earlier one fetched.
    // 8 + 8 + 4 for the three day tools, 12 for the weekly report and 1 for the series.
    const counts = takeExternal();
    expect(counts).toEqual({
      total: 34,
      token: 1,
      sleep: 6,
      "heart-rate-variability": 3,
      "daily-resting-heart-rate": 3,
      "rollup steps": 3,
      "rollup active-zone-minutes": 3,
      "rollup total-calories": 2,
      steps: 1,
      exercise: 4,
      "heart-rate": 2,
      "nutrition-log": 2,
      weight: 3,
      "body-fat": 1,
    });
    expect(counts.total).toBeLessThanOrEqual(MAX_SUBREQUESTS);
    expect(new Set(auths)).toEqual(new Set([`Bearer ${RENEWED_TOKEN}`]));
    expect(logLines("log").map(([, fields]) => (fields as { tool: string }).tool).sort()).toEqual(
      ["google_account_status", ...COACH_TOOL_NAMES].sort(),
    );
  });

  it("asks a token endpoint that is down once, whatever the request calls", async () => {
    everything();
    tokenReply = () => new Response("<html>down</html>", { status: 503 });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const calls: [string, Record<string, unknown>][] = [];
    for (let i = 0; i < 30; i++) calls.push(["google_account_status", {}], CALLS[i % CALLS.length] as [string, Record<string, unknown>]);
    const answers = await batch(stub, calls);
    for (const [i, answer] of answers.entries()) {
      if (i % 2 === 0) expect(answer).toMatchObject({ ok: true, output: { linked: true, token: "upstream_unavailable" } });
      else expect(answer).toMatchObject({ ok: false, error: { code: "upstream_unavailable", message: "Google's token service is unavailable" } });
    }
    // 60 tool calls, one token request, no Google Health request.
    expect(external).toEqual(["token"]);
    // The next HTTP request asks again.
    await ok(stub, "google_account_status");
    expect(external).toEqual(["token", "token"]);
  });

  it("does not send the request that would pass the budget, also across tool calls", async () => {
    month();
    // 25 sessions with heart rate on a day: its review lists heart rate once per session.
    const heavy = day(-8);
    for (let n = 0; n < 25; n++) {
      const start = new Date(at(heavy, 6, 0).getTime() + n * 20 * 60_000);
      google.add("exercise", exerciseRec(start, new Date(start.getTime() + 10 * 60_000), { type: "WALKING", avgHR: 120, kcal: 50, zones: [5, 5, 0, 0] }));
    }
    const stub = await linkedStore();
    const [first, second] = await batch(stub, [
      ["workout_review", { date: heavy }],
      ["workout_review", { date: heavy }],
    ]);
    expect(first).toMatchObject({ ok: true, output: { data: { sessions_omitted: 5 }, quality_flags: ["sessions_truncated"] } });
    // The second review needs the same 30 requests, and 15 are left: the
    // error is the budget error of the client, passed on as it is.
    expect(second).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "the date range holds more heart-rate data than one call reads", hint: "use a shorter date range" },
    });
    const counts = takeExternal();
    expect(counts.total).toBe(HEALTH_REQUESTS);
    expect(counts).toEqual({ total: 45, exercise: 3, "heart-rate": 39, sleep: 1, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
    // The next HTTP request has a budget of its own.
    expect((await objectTool(stub, "workout_review", { date: heavy })).ok).toBe(true);
    expect(takeExternal().total).toBe(30);
  });

  it("is refused by the transport above 100 messages", async () => {
    const stub = await linkedStore();
    const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "google_account_status", arguments: {} } });
    const response = await stub.fetch(mcpRequest(Array.from({ length: 101 }, (_unused, i) => message(i + 1))));
    expect(response.status).toBe(400);
    expect(logLines("log")).toEqual([]);
    // 100 messages are served, with one token answer for all of them.
    expect(await batch(stub, Array.from({ length: 100 }, (): [string, Record<string, unknown>] => ["google_account_status", {}]))).toHaveLength(100);
    expect(external).toEqual([]);
    expect(TOKEN_REQUESTS).toBe(2);
  });
});
