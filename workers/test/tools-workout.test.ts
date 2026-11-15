// Ports of internal/tools/workout_test.go. Each test serves workout_review
// over a synthetic health source, with "now" at 2026-10-16 08:00 in São Paulo
// (a Friday).
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolError } from "../src/coach/errors";
import { MAX_SESSIONS, VENDOR_NOTICE } from "../src/tools/coach";
import { MAX_EXERCISE_ID, NO_TARGET_HINT } from "../src/tools/workout";
import { COACH_TODAY, type FakeHealth, coachSession, fakeTargets, heartRate, history, session } from "./coach-helpers";

const ID = "users/me/dataTypes/exercise/dataPoints/";

/**
 * In the week of Mon 2026-10-12, a run on Monday and, on Wednesday, a
 * jiu-jitsu class with a low average heart rate and a manual strength session
 * without heart rate. A run on the Sunday before is outside the week.
 */
function workoutWeek(): FakeHealth {
  const h = history(28);
  h.sessions = [
    session("0", "2026-10-11", 9, "RUNNING", 30, heartRate(150)),
    session("1", "2026-10-12", 7, "RUNNING", 40, heartRate(145, 170)),
    session("2", "2026-10-14", 19, "JIU_JITSU", 60, heartRate(81, 150, [30, 20, 8, 2]), "low_hr_for_activity"),
    session("3", "2026-10-14", 7, "STRENGTH_TRAINING", 45, null, "manual_entry", "no_hr_data"),
  ];
  return h;
}

const weeklyTargets = fakeTargets({ effective_from: "2026-10-01", weekly_sessions: 3 }, { effective_from: "2026-10-15", weekly_sessions: 5 });

let errorLog: MockInstance;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const review = (h: FakeHealth, args?: Record<string, unknown>, targets = weeklyTargets) =>
  coachSession(h, { targets }).ok("workout_review", args);

describe("workout_review", () => {
  it("reviews the sessions of a day", async () => {
    const h = workoutWeek();
    const out = await review(h, { date: "2026-10-14" });
    const data = out.data;
    expect(Object.keys(data).sort()).toEqual(["date", "notice", "recovery_context", "sessions", "sessions_omitted", "week_context"]);
    expect(data.notice).toBe(VENDOR_NOTICE);
    expect(data.date).toBe("2026-10-14");
    expect(data.sessions[0]).toEqual({
      exercise_id: `${ID}2`,
      type: "JIU_JITSU",
      name: "Session 2",
      start: "2026-10-14T19:00:00-03:00",
      end: "2026-10-14T20:00:00-03:00",
      active_min: 60,
      avg_hr_bpm: 81,
      max_hr_bpm: 150,
      heart_rate_zone_minutes: { light: 30, moderate: 20, vigorous: 8, peak: 2 },
      kcal: 480,
      azm_min: 30,
      quality_flags: ["low_hr_for_activity"],
      source: "Synthetic Band",
    });
    // A session without heart rate has no zones, average or max.
    expect(data.sessions[1]).toMatchObject({ type: "STRENGTH_TRAINING", heart_rate_zone_minutes: null, avg_hr_bpm: null, max_hr_bpm: null });
    expect(data.sessions_omitted).toBe(0);
    expect(out.quality_flags).toEqual(["low_hr_for_activity", "manual_entry", "no_hr_data"]);
    // The week runs Monday to Sunday, up to today, against the target in force on the day.
    expect(data.week_context).toEqual({
      week_start: "2026-10-12",
      through: "2026-10-16",
      sessions: 3,
      weekly_sessions_target: 3,
      active_min_by_type: { RUNNING: 40, JIU_JITSU: 60, STRENGTH_TRAINING: 45 },
    });
    // The night after the session is the one ending on the 15th: HRV 52 ms
    // and resting HR 62 against the 27 earlier nights (means 49.9 and 59.9).
    expect(data.recovery_context).toEqual({
      night_ending: "2026-10-15",
      hrv_ms: 52,
      hrv_delta_pct_vs_28d: 4.2,
      hrv_baseline_n_days: 27,
      resting_hr_bpm: 62,
      resting_hr_delta_bpm_vs_28d: 2.1,
      resting_hr_baseline_n_days: 27,
    });
    expect(out.coverage).toEqual({ n_days: 5, confidence: "low" });
    expect(out.sources).toEqual(["Synthetic Band"]);
    // Max heart rate is read for the reviewed day only, never for the week.
    expect(h.calls).toEqual([
      "exercises 2026-10-14..2026-10-14 maxHR=true",
      "exercises 2026-10-12..2026-10-16 maxHR=false",
      "recovery 2026-09-17..2026-10-15",
    ]);
  });

  it("reviews one session by its ID", async () => {
    const h = workoutWeek();
    const out = await review(h, { exercise_id: `${ID}3` });
    expect(out.data.sessions).toHaveLength(1);
    expect(out.data.sessions[0].type).toBe("STRENGTH_TRAINING");
    expect(out.data.date).toBe("2026-10-14");
    // The flags are the session's own; the week still counts every session.
    expect(out.quality_flags).toEqual(["manual_entry", "no_hr_data"]);
    expect(out.data.week_context.sessions).toBe(3);
    // The ID is looked up in the last 28 days, without max heart rate.
    expect(h.calls).toEqual([
      "exercises 2026-09-19..2026-10-16 maxHR=false",
      "exercises 2026-10-14..2026-10-14 maxHR=true",
      "exercises 2026-10-12..2026-10-16 maxHR=false",
      "recovery 2026-09-17..2026-10-15",
    ]);
  });

  it("answers no_data for an unknown ID, and refuses a date with an ID", async () => {
    const c = coachSession(workoutWeek(), { targets: weeklyTargets });
    const unknown = await c.fails("workout_review", { exercise_id: `${ID}missing` });
    expect(unknown).toMatchObject({
      code: "no_data",
      message: "no session with that exercise_id in the last 28 days",
      hint: "call workout_review with the session's date instead",
    });
    const both = await c.fails("workout_review", { date: "2026-10-14", exercise_id: `${ID}3` });
    expect(both.text).toBe('{"code":"invalid_input","message":"pass date or exercise_id, not both"}');
  });

  it.each([{ exercise_id: "" }, { exercise_id: null }])("reads %j as no ID", async (args) => {
    const out = await review(workoutWeek(), { date: "2026-10-14", ...args });
    expect(out.data.sessions).toHaveLength(2);
  });

  it("reviews today without a recovery context", async () => {
    const h = workoutWeek();
    h.sessions.push(session("4", COACH_TODAY, 6, "TREADMILL", 20, heartRate(120)));
    const out = await coachSession(h).ok("workout_review");
    const data = out.data;
    // Today's night has not come: no recovery context, and the day may grow.
    expect(data.recovery_context).toBeNull();
    expect(out.quality_flags).toContain("partial_day");
    expect(data.date).toBe(COACH_TODAY);
    // No target store: the target is null with a hint to set one.
    expect(data.week_context).toMatchObject({ weekly_sessions_target: null, target_hint: NO_TARGET_HINT, sessions: 4 });
    expect(NO_TARGET_HINT).toContain("targets_set");
    // Recovery is not read for a night still to come.
    expect(h.calls).toEqual(["exercises 2026-10-16..2026-10-16 maxHR=true", "exercises 2026-10-12..2026-10-16 maxHR=false"]);
  });

  describe("targets", () => {
    it("uses the version in force on the reviewed day", async () => {
      // The version starting on the 15th is in force on the 16th.
      const { week_context: week } = (await review(workoutWeek(), { date: "2026-10-16" })).data;
      expect(week.weekly_sessions_target).toBe(5);
      expect(week).not.toHaveProperty("target_hint");
    });

    it.each([
      // A version without a sessions target leaves it null, with the hint.
      ["a version without a sessions target", fakeTargets({ effective_from: "2026-10-01", kcal: 2200 })],
      // No version yet on the day reads the same as no target.
      ["no version yet on the day", fakeTargets({ effective_from: "2026-10-15", weekly_sessions: 5 })],
      ["a store that never had a target", fakeTargets()],
    ])("reports %s as not set", async (_name, targets) => {
      const { week_context: week } = (await review(workoutWeek(), { date: "2026-10-14" }, targets)).data;
      expect(week.weekly_sessions_target).toBeNull();
      expect(week.target_hint).toBe(NO_TARGET_HINT);
    });

    it("answers an error for a failing store, not a missing target", async () => {
      const failing = () => {
        throw new Error("disk I/O error");
      };
      const error = await coachSession(workoutWeek(), { targets: failing }).fails("workout_review", { date: "2026-10-14" });
      expect(error.text).toBe('{"code":"internal_error","message":"unexpected internal error"}');
      expect(errorLog.mock.calls).toEqual([["tool_internal_error", { tool: "workout_review", error_types: "Error" }]]);
    });
  });

  it("reviews a rest day and a past week", async () => {
    const h = workoutWeek();
    const rest = (await coachSession(h).ok("workout_review", { date: "2026-10-13" })).data;
    expect(rest.sessions).toEqual([]);
    expect(rest.week_context.week_start).toBe("2026-10-12");
    // Sunday the 11th closes the week of Monday the 5th.
    const sunday = (await coachSession(h).ok("workout_review", { date: "2026-10-11" })).data;
    expect(sunday.week_context).toMatchObject({ week_start: "2026-10-05", through: "2026-10-11", sessions: 1 });
  });

  it("lists at most 20 sessions and counts the rest", async () => {
    const h = history(28);
    for (let i = 0; i < MAX_SESSIONS + 3; i++) h.sessions.push(session(String(i), "2026-10-14", 0, "WALKING", 10, null));
    const out = await coachSession(h).ok("workout_review", { date: "2026-10-14" });
    expect(out.data.sessions).toHaveLength(MAX_SESSIONS);
    expect(out.data.sessions_omitted).toBe(3);
    expect(out.quality_flags).toContain("sessions_truncated");
    expect(out.data.week_context.sessions).toBe(MAX_SESSIONS + 3);
  });

  it("flags unreadable records and omitted max heart rates", async () => {
    const h = workoutWeek();
    h.exercisesExtra = { skipped: 1, maxHROmitted: 2 };
    const out = await coachSession(h).ok("workout_review", { date: "2026-10-14" });
    expect(out.quality_flags).toContain("max_hr_omitted");
    expect(out.quality_flags).toContain("unreadable_records");
    expect(out.quality_flags).not.toContain("partial_day");
  });

  it("rejects a date after today", async () => {
    const h = workoutWeek();
    const error = await coachSession(h).fails("workout_review", { date: "2026-10-17" });
    expect(error).toMatchObject({ code: "invalid_input", message: "date is after today" });
    expect(h.calls).toEqual([]);
  });

  it.each(["exercises", "recovery"])("passes an error of the %s source on as it is", async (method) => {
    const h = workoutWeek();
    h.errs[method] = new ToolError("upstream_unavailable", "try later");
    const error = await coachSession(h).fails("workout_review", { date: "2026-10-14" });
    expect(error.text).toBe('{"code":"upstream_unavailable","message":"try later"}');
  });

  it("bounds the exercise_id length in the schema", async () => {
    expect(MAX_EXERCISE_ID).toBe(256);
    const c = coachSession(workoutWeek());
    // At the bound the body runs (and finds nothing); past it the schema
    // rejects the call before the body.
    expect((await c.fails("workout_review", { exercise_id: "x".repeat(256) })).code).toBe("no_data");
    const h = workoutWeek();
    const long = await coachSession(h).fails("workout_review", { exercise_id: "x".repeat(257) });
    expect(long.code).toBe("invalid_input");
    expect(long.schema).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it("reads the night that ends today for yesterday's sessions", async () => {
    // Reviewed the next morning: the night after ends today.
    const { recovery_context: recovery } = (await coachSession(workoutWeek()).ok("workout_review", { date: "2026-10-15" })).data;
    expect(recovery).toMatchObject({ night_ending: COACH_TODAY, hrv_ms: 50, resting_hr_bpm: 60 });
  });

  it("qualifies the recovery context", async () => {
    const h = workoutWeek();
    const next = "2026-10-15";
    const stored = h.nights.get(next);
    if (!stored) throw new Error("no night");
    h.nights.set(next, { ...stored, provisional: true, hrv: { medianMs: null, coverage: 0.3 } });
    h.resting.set(next, { bpm: 66, method: "OTHER" });
    h.recoveryExtra.skipped = 1;
    const out = await coachSession(h).ok("workout_review", { date: "2026-10-14" });
    for (const flag of ["provisional_sleep", "hrv_low_coverage", "non_standard_resting_hr", "unreadable_records"]) {
      expect(out.quality_flags).toContain(flag);
    }
    expect(out.data.recovery_context).toMatchObject({ resting_hr_bpm: 66, resting_hr_delta_bpm_vs_28d: null, hrv_ms: null });
  });

  it("leaves the deltas out below 7 nights of baseline, and keeps the counts", async () => {
    const short = history(4);
    short.sessions = workoutWeek().sessions;
    const { recovery_context: recovery } = (await coachSession(short).ok("workout_review", { date: "2026-10-14" })).data;
    expect(recovery).toMatchObject({
      hrv_delta_pct_vs_28d: null,
      resting_hr_delta_bpm_vs_28d: null,
      hrv_baseline_n_days: 3,
      resting_hr_baseline_n_days: 3,
      hrv_ms: 52,
    });
  });

  it.each([
    ["unreadable in the week", "2026-10-12..2026-10-16", { skipped: 1 }, "unreadable_records"],
    ["another platform in the week", "2026-10-12..2026-10-16", { otherSource: 1 }, "other_source_sessions_excluded"],
    // The reviewed day alone can carry them too.
    ["another platform on the day", "2026-10-14..2026-10-14", { otherSource: 1 }, "other_source_sessions_excluded"],
  ])("flags records left out: %s", async (_name, range, extra, flag) => {
    const h = workoutWeek();
    h.byRange.set(range, extra);
    expect((await coachSession(h).ok("workout_review", { date: "2026-10-14" })).quality_flags).toContain(flag);
  });

  it("says when the lookup may have missed an unreadable record", async () => {
    const h = workoutWeek();
    h.exercisesExtra.skipped = 1;
    const error = await coachSession(h).fails("workout_review", { exercise_id: `${ID}missing` });
    expect(error.code).toBe("no_data");
    expect(error.hint).toBe(
      "some exercise records could not be read, and the session may be one of them; call workout_review with the session's date instead",
    );
  });

  it("sums the minutes of each type before it rounds", async () => {
    const h = workoutWeek();
    h.sessions = [session("a", "2026-10-12", 7, "RUNNING", 25.4, null), session("b", "2026-10-13", 7, "RUNNING", 20.3, null)];
    const { week_context: week } = (await coachSession(h).ok("workout_review", { date: "2026-10-13" })).data;
    expect(week.active_min_by_type).toEqual({ RUNNING: 45.7 });
    expect(week.sessions).toBe(2);
  });

  it("writes session times in the coach's zone", async () => {
    const h = workoutWeek();
    // 2026-10-14 22:30:15.5 UTC, as the API sends an instant.
    h.sessions = [{ ...session("z", "2026-10-14", 19, "RUNNING", 30, null), start: new Date("2026-10-14T22:30:15.500Z") }];
    const [listed] = (await coachSession(h).ok("workout_review", { date: "2026-10-14" })).data.sessions;
    expect(listed.start).toBe("2026-10-14T19:30:15.5-03:00");
  });
});
