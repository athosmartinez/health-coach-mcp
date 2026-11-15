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
import {
  FakeGoogle,
  NOW,
  at,
  azmRollup,
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
import { COACH_TOOL_NAMES, type McpTarget, freshStore, mcpRequest, objectTool } from "./memory-helpers";

const TODAY = "2026-10-16";
const day = (offset: number) => addDays(TODAY, offset) as string;

const STORED_TOKEN = "at-stored-51c2";
const RENEWED_TOKEN = "at-renewed-8e07";

/** Text that must never reach a log line or an error: names, tokens and marked values. */
const SESSION_NAME = "JIU JITSU";
const FOOD_NAME = "Synthetic food";
const SECRETS = [STORED_TOKEN, RENEWED_TOKEN, GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, SESSION_NAME, FOOD_NAME, "Synthetic Band", "Synthetic Scale"];

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
 * One month of synthetic data, 2026-09-16 to 2026-10-16: each day a night of
 * 480 minutes in bed with HRV samples, a resting heart rate, and the daily
 * totals. Every fifth day has no zone-minutes row but step records of the
 * band. A weigh-in every third day.
 */
function month(): void {
  for (let i = 30; i >= 0; i--) {
    const [end, start] = [day(-i), day(-i - 1)];
    google.add("sleep", sleepRec(at(start, 23, 0), at(end, 7, 0), { deep: 60 }));
    google.add("heart-rate-variability", ...hrvNight(at(start, 23, 0), at(end, 7, 0), 40 + (i % 5)));
    google.add("daily-resting-heart-rate", restingRec(end, 55 + (i % 3), "WITH_SLEEP", "FITBIT"));
    google.addRollup("steps", stepsRollup(end, 8000 + 10 * i));
    google.addRollup("total-calories", kcalRollup(end, 2400 + i));
    if (i % 5 === 3) google.add("steps", stepRec(end, "FITBIT"));
    else google.addRollup("active-zone-minutes", azmRollup(end, 20, 5, 0));
    if (i % 3 === 0) google.add("weight", weightRec(at(end, 7, 30), 80_000 + 100 * (i % 4), "FITBIT"));
  }
}

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
    const briefing = await ok(stub, "morning_briefing");
    expect(briefing.quality_flags).toEqual(["unreadable_records"]);
    await ok(stub, "workout_review", { date: day(-2) });
    await ok(stub, "nutrition_day", { date: day(-2) });
    expect(COACH_TOOL_NAMES).toEqual(CALLS.map(([name]) => name));
    // One line per call, with the tool name, the duration and the outcome.
    expect(logLines("log")).toEqual(CALLS.map(([name]) => ["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: false }]));
    // The unreadable record: the range asked and a count, once per call that fetched it.
    expect(logLines("warn")).toEqual([
      ["unreadable records in a recovery fetch", { from: "2026-09-18", to: "2026-10-16", skipped: 1 }],
      ["unreadable records in a recovery fetch", { from: "2026-09-17", to: "2026-10-15", skipped: 1 }],
    ]);
    expect(logLines("error")).toEqual([]);
    for (const secret of [...SECRETS, "7711", "8010", "2200", "80.3", "440"]) expect(logged()).not.toContain(secret);
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

// One HTTP request can carry several tool calls: the transport takes a
// JSON-RPC batch. The limit of 50 subrequests is for the whole HTTP request.
describe("one HTTP request with several tool calls", () => {
  it("shares one request budget and one token answer between the coach tools and google_account_status", async () => {
    everything();
    // An expired access token and a cold cache: the worst start.
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const [briefing, workout, nutrition, status] = await batch(stub, [...CALLS, ["google_account_status", {}]]);
    expect(briefing).toMatchObject({ ok: true, output: { data: { readiness: { level: "yellow" } } } });
    expect(workout).toMatchObject({ ok: true, output: { data: { date: "2026-10-14" } } });
    expect(nutrition).toMatchObject({ ok: true, output: { data: { items_logged: 4 } } });
    expect(status).toMatchObject({ ok: true, output: { linked: true, token: "ok" } });
    // Every external fetch of the HTTP request: one token renewal for the four
    // calls, and the Google Health requests of the three tools (8 + 8 + 4),
    // which take turns.
    const counts = takeExternal();
    expect(counts).toEqual({
      total: 21,
      token: 1,
      sleep: 4,
      "heart-rate-variability": 2,
      "daily-resting-heart-rate": 2,
      "rollup steps": 1,
      "rollup active-zone-minutes": 2,
      "rollup total-calories": 1,
      exercise: 3,
      "heart-rate": 2,
      "nutrition-log": 1,
      weight: 2,
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
