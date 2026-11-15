// The coach-moment tools served as in production: one MCP HTTP request to the
// CoachStore object (the Worker form of the Go server's in-memory transport
// tests), the real Google Health client and healthdata source, and Google
// behind a mocked `fetch`: the token endpoint and a fake Health API.
//
// The clock is fixed at 2026-10-16 10:00 in São Paulo. All values are synthetic.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { WireError } from "../src/coach/errors";
import { OAUTH_CLIENT_HINT, RECONNECT_HINT } from "../src/google";
import { HEALTH_REQUESTS, MAX_SUBREQUESTS, TOKEN_REQUESTS } from "../src/googlehealth/budget";
import { CoachStore } from "../src/store";
import { NUTRITION_NOTICE } from "../src/tools/nutrition";
import { SERIES_NOTICE } from "../src/tools/series";
import { WEEKLY_NOTICE } from "../src/tools/weekly";
import {
  FOOD_NAME,
  RENEWED_TOKEN,
  RUN_ID,
  SESSION_NAME,
  STORED_TOKEN,
  TODAY,
  type ToolCall,
  batch,
  day,
  daysOfData,
  everything,
  foodDays,
  googleMock,
  linkedStore,
  meals,
  sessions,
  untilOk,
} from "./e2e-helpers";
import { at, exerciseRec, foodRec } from "./healthdata-helpers";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, rpc, signInAsOwner } from "./helpers";
import { COACH_TOOL_NAMES, type McpTarget, SCHEMA_HINT, freshStore, mcpRequest, objectTool } from "./memory-helpers";

/** Text that must never reach a log line or an error: names, tokens and marked values. */
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

// The clock fixed at 2026-10-16, a spy on every console level, and Google
// behind `fetch` with every external fetch counted.
const g = googleMock();

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
    everything(g.google);
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
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${STORED_TOKEN}`]));
    expect(g.external).not.toContain("token");
    // One log line: the tool name, the duration and the outcome.
    expect(g.logLines("log")).toEqual([["tool_call", { tool: "morning_briefing", duration_ms: expect.any(Number), is_error: false }]]);
    expect(g.logLines("warn")).toEqual([]);
    expect(g.logLines("error")).toEqual([]);
  });

  it("serves workout_review, with the target of the store", async () => {
    everything(g.google);
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
    everything(g.google);
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
    everything(g.google);
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
    expect(g.logLines("log").at(-1)).toEqual(["tool_call", { tool: "weekly_report", duration_ms: expect.any(Number), is_error: false }]);
    expect(g.logLines("warn")).toEqual([]);

    // A closed week, by any of its days.
    const closed = await ok(stub, "weekly_report", { week_end: day(-7) });
    expect(closed.data).toMatchObject({ week_start: "2026-10-05", week_end: "2026-10-11", through: "2026-10-11", decisions_this_week: [{ text: "An older synthetic decision" }] });
    expect(closed.coverage.n_days).toBe(7);
    expect(await fails(stub, "weekly_report", { week_end: day(1) })).toEqual({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
  });

  it("serves metric_series", async () => {
    everything(g.google);
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

    // Total calories of the days the band was worn. 2026-10-13 has no
    // zone-minutes row, but the band counted steps: it is a worn day.
    const burned = await ok(stub, "metric_series", { metric: "total_calories", from: day(-3), to: TODAY });
    expect(burned.data.points).toEqual([
      { date: "2026-10-13", value: 2403, n_days: 1, complete: true },
      { date: "2026-10-14", value: 2402, n_days: 1, complete: true },
      { date: "2026-10-15", value: 2401, n_days: 1, complete: true },
      { date: TODAY, value: null, n_days: 0, complete: true, reason: "partial_day" },
    ]);
    expect(burned.quality_flags).toEqual(["partial_day"]);
    // A range before the data starts: no band data, so no total is read or shown.
    const before = await ok(stub, "metric_series", { metric: "total_calories", from: day(-40), to: day(-39) });
    expect(before.data.points).toEqual([
      { date: "2026-09-06", value: null, n_days: 0, complete: true, reason: "band_not_worn" },
      { date: "2026-09-07", value: null, n_days: 0, complete: true, reason: "band_not_worn" },
    ]);
    expect(before.quality_flags).toEqual(["band_not_worn"]);

    expect(await fails(stub, "metric_series", { metric: "steps", from: day(-200), to: TODAY })).toEqual({
      code: "invalid_input",
      message: "the series would have 201 points, more than 180",
      hint: "use granularity week or a shorter range",
    });
    expect(await fails(stub, "metric_series", { metric: "mood", from: day(-3), to: TODAY })).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
  });

  it("serves a coach tool through the Worker, which forwards the request to the object", async () => {
    const { access_token: accessToken } = await signInAsOwner();
    g.install();
    everything(g.google);
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    const reply = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nutrition_day", arguments: { date: day(-2) } } });
    expect(reply.error).toBeUndefined();
    const result = reply.result as { isError?: boolean; structuredContent?: Record<string, any> };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.data.totals.kcal).toEqual({ value: 2200, items_reporting: 4, complete: true });
    // The Google token of the sign-in is the one sent to the Health API, and the
    // Worker itself made no request to Google.
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${GOOGLE_ACCESS_TOKEN}`]));
    expect(served).toHaveBeenCalledTimes(1);
  });
});

const CALLS: ToolCall[] = [
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
      expect(g.logged()).not.toContain(secret);
    }
  }

  it.each(CALLS)("%s answers auth_expired with the reconnect hint when no account is linked", async (name, args) => {
    everything(g.google);
    const error = await fails(freshStore(), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    // Nothing is asked of Google.
    expect(g.external).toEqual([]);
    expect(g.logLines("log")).toEqual([["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: true, code: "auth_expired" }]]);
  });

  it.each(CALLS)("%s answers auth_expired when Google rejects the stored token and the renewed one", async (name, args) => {
    everything(g.google);
    g.healthReply = googleError(401, "UNAUTHENTICATED");
    const error = await fails(await linkedStore(), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "Google Health rejected the sign-in", hint: RECONNECT_HINT });
    // One renewal, and the request sent once more with the new token.
    expect(g.auths).toEqual([`Bearer ${STORED_TOKEN}`, `Bearer ${RENEWED_TOKEN}`]);
    expect(g.takeExternal()).toMatchObject({ total: 3, token: 1 });
    expectNoLeak(error);
  });

  it.each(CALLS)("%s answers auth_expired when Google revoked the link", async (name, args) => {
    everything(g.google);
    g.tokenReply = () => Response.json({ error: "invalid_grant", error_description: `revoked ${GOOGLE_REFRESH_TOKEN}` }, { status: 400 });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const error = await fails(stub, name, args);
    expect(error).toEqual({ code: "auth_expired", message: "the Google sign-in expired or was revoked", hint: RECONNECT_HINT });
    expect(g.external).toEqual(["token"]);
    expectNoLeak(error);
    // The link is gone: the status tool says so.
    expect((await ok(stub, "google_account_status")).linked).toBe(false);
  });

  it.each(CALLS)("%s answers auth_expired when Google refuses the token renewal", async (name, args) => {
    everything(g.google);
    g.tokenReply = () => Response.json({ error: "invalid_client", error_description: "synthetic body 7711" }, { status: 401 });
    const error = await fails(await linkedStore({ accessTokenExpiresAt: 0 }), name, args);
    expect(error).toEqual({ code: "auth_expired", message: "Google rejected the token renewal", hint: `${OAUTH_CLIENT_HINT} ${RECONNECT_HINT}` });
    expect(g.external).toEqual(["token"]);
    expectNoLeak(error);
  });

  it.each(CALLS)("%s answers upstream_unavailable for a renewal answered without a usable token", async (name, args) => {
    everything(g.google);
    g.tokenReply = () => Response.json({ token_type: "Bearer", note: "synthetic body 7711" });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const error = await fails(stub, name, args);
    // The link and the OAuth client are fine: the same call can work later.
    expect(error).toEqual({ code: "upstream_unavailable", message: "Google's token service is unavailable", hint: "try again in a few minutes" });
    expect(g.external).toEqual(["token"]);
    expectNoLeak(error);
    expect(await ok(stub, "google_account_status")).toMatchObject({
      linked: true,
      token: "upstream_unavailable",
      hint: "Google is unavailable right now. Try again in a few minutes.",
    });
  });

  it.each(CALLS)("%s answers scope_missing when Google denies the data", async (name, args) => {
    everything(g.google);
    g.healthReply = googleError(403, "PERMISSION_DENIED");
    const error = await fails(await linkedStore(), name, args);
    expect(error.code).toBe("scope_missing");
    expect(error.message).toMatch(/^Google Health denied access to [a-z-]+ data$/);
    expect(error.hint).toBe(SCOPE_HINT);
    // A denial is not retried, and it is not a reason to renew the token.
    expect(g.takeExternal()).toMatchObject({ total: 1 });
    expectNoLeak(error);
  });

  it.each(CALLS)("%s hides a request that Google rejects behind internal_error", async (name, args) => {
    everything(g.google);
    g.healthReply = googleError(400, "INVALID_ARGUMENT");
    const error = await fails(await linkedStore(), name, args);
    expect(error).toEqual({ code: "internal_error", message: "unexpected internal error" });
    // The logs carry the data type, the HTTP status, Google's status enum and
    // the error types: never the answer's text.
    expect(g.logLines("warn")).toEqual([
      ["google health request rejected", { data_type: expect.any(String), http_status: 400, google_status: "INVALID_ARGUMENT" }],
    ]);
    expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: name, error_types: "Error > StatusError" }]]);
    expect(g.logLines("log")).toEqual([["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: true, code: "internal_error" }]]);
    expectNoLeak(error);
  });

  it("fails every coach tool, and names the variable in the log, with a zone it cannot use", async () => {
    everything(g.google);
    const stub = await linkedStore();
    await runInDurableObject(stub, async (instance) => {
      Object.assign(instance, { env: { ...env, HCM_TZ: "Local" } });
      for (const [name, args] of CALLS) {
        expect(await objectTool(instance, name, args)).toEqual({ ok: false, error: { code: "internal_error", message: "unexpected internal error" } });
      }
    });
    expect(g.logLines("error")).toEqual(CALLS.map(() => ["config_error", { variable: "HCM_TZ" }]));
    expect(g.external).toEqual([]);
  });
});

describe("the logs of the coach tools", () => {
  it("carry no health value, name, token or response body", async () => {
    everything(g.google);
    // A record that cannot be read, with a marked value.
    g.google.add("sleep", { dataSource: { platform: "FITBIT" }, sleep: { interval: { endTime: "2026-10-16T10:00:00Z" }, summary: { minutesAsleep: { marked: "7711" } } } });
    const stub = await linkedStore();
    // A decision note of this week: weekly_report returns its text.
    await ok(stub, "note_add", { kind: "decision", text: DECISION_TEXT, related_date: day(-2) });
    g.clearLogs();
    const outputs = new Map<string, Record<string, any>>();
    for (const [name, args] of CALLS) outputs.set(name, await ok(stub, name, args));
    expect(outputs.get("morning_briefing")?.quality_flags).toEqual(["unreadable_records"]);
    expect(outputs.get("weekly_report")?.quality_flags).toEqual(["partial_day", "unreadable_records"]);
    expect(outputs.get("weekly_report")?.data.decisions_this_week).toMatchObject([{ text: DECISION_TEXT }]);
    expect(COACH_TOOL_NAMES).toEqual(CALLS.map(([name]) => name));
    // One line per call, with the tool name, the duration and the outcome.
    expect(g.logLines("log")).toEqual(CALLS.map(([name]) => ["tool_call", { tool: name, duration_ms: expect.any(Number), is_error: false }]));
    // The unreadable record: the range asked and a count, once per call that fetched it.
    expect(g.logLines("warn")).toEqual([
      ["unreadable records in a recovery fetch", { from: "2026-09-18", to: "2026-10-16", skipped: 1 }],
      ["unreadable records in a recovery fetch", { from: "2026-09-17", to: "2026-10-15", skipped: 1 }],
      ["unreadable records in a recovery fetch", { from: "2026-09-14", to: "2026-10-16", skipped: 1 }],
    ]);
    expect(g.logLines("error")).toEqual([]);
    // No token, name or note text, and no value of a result: steps, kcal, weight, minutes, weekly means.
    for (const secret of [...SECRETS, "7711", "8010", "2200", "80.3", "440", "8025", "55.8", "18.8"]) expect(g.logged()).not.toContain(secret);
  });

  it("carry no health value or note text for a call that fails", async () => {
    everything(g.google);
    const stub = await linkedStore();
    await ok(stub, "note_add", { kind: "decision", text: DECISION_TEXT, related_date: day(-2) });
    g.clearLogs();
    // Google rejects one data type with a body that quotes a value; the reads before it succeed.
    g.healthReply = (request) =>
      request.url.includes("/nutrition-log/") || request.url.includes("/weight/")
        ? Response.json({ error: { code: 400, message: "bad filter near 8025 for Synthetic food", status: "INVALID_ARGUMENT" } }, { status: 400 })
        : undefined;
    const internal = { code: "internal_error", message: "unexpected internal error" };
    expect(await fails(stub, "weekly_report")).toEqual(internal);
    expect(await fails(stub, "metric_series", { metric: "kcal_in", from: day(-6), to: TODAY })).toEqual(internal);
    expect(await fails(stub, "metric_series", { metric: "weight", from: day(-6), to: TODAY })).toEqual(internal);
    expect(g.logLines("log")).toEqual(
      ["weekly_report", "metric_series", "metric_series"].map((tool) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: true, code: "internal_error" }]),
    );
    // The data type, the HTTP status and Google's status enum: never the answer's text.
    expect(g.logLines("warn")).toEqual([
      ["google health request rejected", { data_type: "weight", http_status: 400, google_status: "INVALID_ARGUMENT" }],
      ["google health request rejected", { data_type: "nutrition-log", http_status: 400, google_status: "INVALID_ARGUMENT" }],
      ["google health request rejected", { data_type: "weight", http_status: 400, google_status: "INVALID_ARGUMENT" }],
    ]);
    expect(g.logLines("error")).toEqual(
      ["weekly_report", "metric_series", "metric_series"].map((tool) => ["tool_internal_error", { tool, error_types: "Error > StatusError" }]),
    );
    for (const secret of [...SECRETS, "8025", "bad filter", "2200", "80.3", "440"]) expect(g.logged()).not.toContain(secret);
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
    everything(g.google);
    const stub = await linkedStore();
    const first = await ok(stub, name, args);
    expect(g.takeExternal(), "cold").toEqual(cold);
    const second = await ok(stub, name, args);
    expect(g.takeExternal(), "warm").toEqual(warm);
    expect(second.data).toEqual(first.data);
  });

  it("lists the band's steps only when the day has no zone-minutes row", async () => {
    everything(g.google);
    const stub = await linkedStore();
    // 2026-10-13 has no zone-minutes row; the band's step records show it was worn.
    await ok(stub, "targets_set", { effective_from: "2026-10-01", kcal: 2000 });
    g.google.add("nutrition-log", foodRec(at(day(-3), 12, 0), { meal: "LUNCH", kcal: 1800, list: { PROTEIN: 90 } }));
    const out = await ok(stub, "nutrition_day", { date: day(-3) });
    expect(out.quality_flags).toEqual([]);
    expect(out.data.energy_balance).toEqual({ intake_kcal: 1800, total_calories_kcal: 2400, balance_kcal: -600 });
    expect(g.takeExternal()).toEqual({ total: 5, "nutrition-log": 1, "rollup active-zone-minutes": 1, steps: 1, "rollup total-calories": 1, weight: 1 });
    // The day is settled: its activity now comes from the cache, with the same result.
    const again = await ok(stub, "nutrition_day", { date: day(-3) });
    expect(g.takeExternal()).toEqual({ total: 2, "nutrition-log": 1, weight: 1 });
    expect(again.data).toEqual(out.data);
    expect(again.quality_flags).toEqual([]);
  });
});

// The request plans of weekly_report and metric_series, counted as HTTP
// requests to Google on a cold cache. One MCP HTTP request may send 45.
describe("the Google requests of the two report tools on a cold cache", () => {
  it("weekly_report with six weeks of data", async () => {
    daysOfData(g.google, 41);
    sessions(g.google);
    meals(g.google);
    const stub = await linkedStore();
    const first = await ok(stub, "weekly_report");
    // No kcal target: the log check of the week's two logged days reads total calories too.
    expect(g.takeExternal(), "cold, no targets").toEqual({
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
    expect(g.takeExternal(), "the cache it filled").toEqual({
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
    const targeted = g.takeExternal();
    expect(targeted.total, "cold, with a kcal target").toBe(11);
    expect(targeted).not.toHaveProperty("rollup total-calories");
    // A closed week reads the same data types over a range that ends on its Sunday.
    await ok(await linkedStore(), "weekly_report", { week_end: day(-7) });
    expect(g.takeExternal().total, "cold, the week before").toBe(11);
  });

  // Harder years than the one below. A day without band data has no
  // zone-minutes value, so no call can cache it: every call asks again if the
  // band was worn on it (the zone-minutes rollup and the steps lists). Its
  // total calories are never read. In a dense account a 31-day list of the
  // band's steps has more than one page: here every such list has two.
  // Each metric: the Google requests of each call until success, then the
  // requests of one more call on the cache they filled.
  it.each<[string, (i: number) => boolean, boolean, Record<string, [number[], number]>]>([
    // Later calls ask "worn" again for the off-wrist days (17) and read the live days' totals (1).
    ["a day off the wrist in every week", (i) => i % 7 === 6, false, { total_calories: [[45], 18], azm: [[18], 17], kcal_in: [[45, 18], 18] }],
    // No day with the band: no total-calories request at all. The
    // zone-minutes rollup 5 and the steps lists 13, and for kcal_in the food log 1.
    ["no band data at all", () => true, false, { total_calories: [[18], 18], azm: [[18], 18], kcal_in: [[19], 19] }],
    // "Worn" costs 5 + 26. The first call ends with the budget error inside
    // the total-calories windows, and leaves the finished ones cached.
    ["two pages in every list of the band's steps", () => false, true, { total_calories: [[45, 14], 2], azm: [[31], 1], kcal_in: [[45, 16], 3] }],
    [
      "a day off the wrist in every week and two pages in every steps list",
      (i) => i % 7 === 6,
      true,
      { total_calories: [[45, 42], 30], azm: [[31], 29], kcal_in: [[45, 43], 30] },
    ],
  ])("metric_series over 366 days with %s", async (_name, offWrist, twoPages, expected) => {
    daysOfData(g.google, 365, offWrist, twoPages ? 2 : 1);
    foodDays(g.google, 365);
    if (twoPages) g.google.twoPages.add("steps");
    const measured: Record<string, [number[], number]> = {};
    for (const metric of Object.keys(expected)) {
      const stub = await linkedStore();
      const args = { metric, from: day(-365), to: TODAY, granularity: "week" };
      const cold = await untilOk(g, stub,"metric_series", args);
      const warm = await untilOk(g, stub,"metric_series", args);
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
    // One steps rollup per 90 days. A read of steps alone learns no
    // zone-minutes value, so it caches nothing and costs the same again.
    ["steps", [5], 5],
    // zone-minutes rollup 5, the band's steps for the days without a row 13
    ["azm", [18], 1],
    // "Worn" first (zone minutes 5, the band's steps 13), then the
    // total-calories rollup of the worn days 27 (14 days each): the whole budget.
    ["total_calories", [45], 2],
    // No kcal target: the food log 1, then the 45 of total_calories do not fit.
    // The first call ends with the budget error and leaves its windows cached.
    ["kcal_in", [45, 3], 3],
    ["protein_g", [45, 3], 3],
  ])("metric_series %s over 366 days", async (metric, calls, again) => {
    daysOfData(g.google, 365);
    foodDays(g.google, 365);
    const stub = await linkedStore();
    const args = { metric, from: day(-365), to: TODAY, granularity: "week" };
    const cold = await untilOk(g, stub,"metric_series", args);
    expect(cold.output.data.points).toHaveLength(53);
    expect(cold.calls.map((counts) => counts.total), JSON.stringify(cold.calls)).toEqual(calls);
    const warm = await untilOk(g, stub,"metric_series", args);
    expect(warm.calls.map((counts) => counts.total), JSON.stringify(warm.calls)).toEqual([again]);
    expect(warm.output.data).toEqual(cold.output.data);
  });
});

// One HTTP request can carry several tool calls: the transport takes a
// JSON-RPC batch. The limit of 50 subrequests is for the whole HTTP request.
describe("one HTTP request with several tool calls", () => {
  it("shares one request budget and one token answer between the coach tools and google_account_status", async () => {
    everything(g.google);
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
    const counts = g.takeExternal();
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
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${RENEWED_TOKEN}`]));
    expect(g.logLines("log").map(([, fields]) => (fields as { tool: string }).tool).sort()).toEqual(
      ["google_account_status", ...COACH_TOOL_NAMES].sort(),
    );
  });

  it("asks a token endpoint that is down once, whatever the request calls", async () => {
    everything(g.google);
    g.tokenReply = () => new Response("<html>down</html>", { status: 503 });
    const stub = await linkedStore({ accessTokenExpiresAt: 0 });
    const calls: [string, Record<string, unknown>][] = [];
    for (let i = 0; i < 30; i++) calls.push(["google_account_status", {}], CALLS[i % CALLS.length] as [string, Record<string, unknown>]);
    const answers = await batch(stub, calls);
    for (const [i, answer] of answers.entries()) {
      if (i % 2 === 0) expect(answer).toMatchObject({ ok: true, output: { linked: true, token: "upstream_unavailable" } });
      else expect(answer).toMatchObject({ ok: false, error: { code: "upstream_unavailable", message: "Google's token service is unavailable" } });
    }
    // 60 tool calls, one token request, no Google Health request.
    expect(g.external).toEqual(["token"]);
    // The next HTTP request asks again.
    await ok(stub, "google_account_status");
    expect(g.external).toEqual(["token", "token"]);
  });

  it("does not send the request that would pass the budget, also across tool calls", async () => {
    daysOfData(g.google, 30);
    // 25 sessions with heart rate on a day: its review lists heart rate once per session.
    const heavy = day(-8);
    for (let n = 0; n < 25; n++) {
      const start = new Date(at(heavy, 6, 0).getTime() + n * 20 * 60_000);
      g.google.add("exercise", exerciseRec(start, new Date(start.getTime() + 10 * 60_000), { type: "WALKING", avgHR: 120, kcal: 50, zones: [5, 5, 0, 0] }));
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
    const counts = g.takeExternal();
    expect(counts.total).toBe(HEALTH_REQUESTS);
    expect(counts).toEqual({ total: 45, exercise: 3, "heart-rate": 39, sleep: 1, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
    // The next HTTP request has a budget of its own.
    expect((await objectTool(stub, "workout_review", { date: heavy })).ok).toBe(true);
    expect(g.takeExternal().total).toBe(30);
  });

  it("is refused by the transport above 100 messages", async () => {
    const stub = await linkedStore();
    const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "google_account_status", arguments: {} } });
    const response = await stub.fetch(mcpRequest(Array.from({ length: 101 }, (_unused, i) => message(i + 1))));
    expect(response.status).toBe(400);
    expect(g.logLines("log")).toEqual([]);
    // 100 messages are served, with one token answer for all of them.
    expect(await batch(stub, Array.from({ length: 100 }, (): [string, Record<string, unknown>] => ["google_account_status", {}]))).toHaveLength(100);
    expect(g.external).toEqual([]);
    expect(TOKEN_REQUESTS).toBe(2);
  });
});
