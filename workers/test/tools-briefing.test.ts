// Ports of internal/tools/briefing_test.go. Each test serves morning_briefing
// over a synthetic health source, with "now" at 2026-10-16 08:00 in São Paulo.
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UTC } from "../src/coach/date";
import { ToolError } from "../src/coach/errors";
import { MAX_SESSIONS, READINESS_NOTICE, VENDOR_NOTICE } from "../src/tools/coach";
import { COACH_TODAY, type FakeHealth, activityDay, coachSession, heartRate, history, night, plus, session } from "./coach-helpers";

const YESTERDAY = plus(COACH_TODAY, -1);

let errorLog: MockInstance;

beforeEach(() => {
  // The tool-call log is checked in coach-e2e.test.ts.
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const briefing = (h: FakeHealth, args?: Record<string, unknown>) => coachSession(h).ok("morning_briefing", args);
const keys = (value: unknown) => Object.keys(value as object).sort();

function setNight(h: FakeHealth, day: string, change: (n: NonNullable<ReturnType<FakeHealth["nights"]["get"]>>) => void): void {
  const stored = h.nights.get(day);
  if (!stored) throw new Error(`no night on ${day}`);
  const copy = { ...stored, hrv: { ...stored.hrv } };
  change(copy);
  h.nights.set(day, copy);
}

describe("morning_briefing", () => {
  it("returns exactly the contract fields", async () => {
    const h = history(28);
    h.activityDays.set(YESTERDAY, activityDay({ steps: 9000, azm: 30, totalKcal: 2500, worn: true }));
    h.weight.set(plus(COACH_TODAY, -4), { at: undefined, value: 80.2, source: "Synthetic Scale" });
    const out = await briefing(h);

    expect(keys(out)).toEqual(["coverage", "data", "generated_at", "quality_flags", "sources"]);
    const data = out.data;
    expect(keys(data)).toEqual(["body", "hrv", "notice", "readiness", "resting_hr", "sleep", "yesterday_load"]);
    expect(keys(data.sleep)).toEqual(["asleep_min", "awake_min", "efficiency_pct", "end", "stages_min", "start", "vs_28d", "vs_7d"]);
    expect(keys(data.sleep.stages_min)).toEqual(["awake", "deep", "light", "rem"]);
    const versusKeys = ["asleep_min", "awake_min", "deep_min", "efficiency_pct", "light_min", "rem_min"];
    expect(keys(data.sleep.vs_7d)).toEqual(versusKeys);
    expect(keys(data.sleep.vs_28d)).toEqual(versusKeys);
    expect(keys(data.sleep.vs_28d.asleep_min)).toEqual(["avg", "delta", "n_days"]);
    expect(keys(data.hrv)).toEqual(["delta_pct_vs_28d", "median_ms", "z_score_vs_28d"]);
    expect(keys(data.resting_hr)).toEqual(["bpm", "delta_bpm_vs_28d"]);
    expect(keys(data.yesterday_load)).toEqual(["azm_min", "date", "exercises", "steps"]);
    expect(keys(data.readiness)).toEqual(["confidence", "level", "reasons"]);
    expect(keys(data.body)).toEqual(["date", "weight_kg"]);

    expect(data.sleep).toMatchObject({
      asleep_min: 480,
      awake_min: 40,
      efficiency_pct: 92.3,
      // The night is written in the coach's zone, with its offset.
      start: "2026-10-15T22:20:00-03:00",
      end: "2026-10-16T07:00:00-03:00",
    });
    expect(data.sleep.stages_min).toMatchObject({ deep: 96, awake: 40 });
    expect(data.sleep.vs_7d.asleep_min).toEqual({ avg: 450, delta: 30, n_days: 7 });
    expect(data.sleep.vs_28d.efficiency_pct).toMatchObject({ avg: 90, delta: 2.3 });
    expect(data.hrv).toEqual({ median_ms: 50, z_score_vs_28d: 0, delta_pct_vs_28d: 0 });
    expect(data.resting_hr).toEqual({ bpm: 60, delta_bpm_vs_28d: 0 });
    expect(data.yesterday_load).toEqual({ date: "2026-10-15", steps: 9000, azm_min: 30, exercises: [] });
    expect(data.readiness).toEqual({ level: "green", confidence: "high", reasons: [] });
    expect(data.body).toEqual({ weight_kg: 80.2, date: "2026-10-12" });

    expect(data.notice).toBe(`${READINESS_NOTICE} ${VENDOR_NOTICE}`);
    expect(out.coverage).toEqual({ n_days: 28, confidence: "high" });
    expect(out.quality_flags).toEqual([]);
    expect(out.sources).toEqual(["Synthetic Band", "Synthetic Scale"]);
    expect(out.generated_at).toBe("2026-10-16T11:00:00Z");
    // One recovery call covers both baselines; the night judged is not in
    // them. The load reads no total calories, and the body only the weight.
    expect(h.calls).toEqual([
      "recovery 2026-09-18..2026-10-16",
      "activity 2026-10-15..2026-10-15 values=steps,azm,worn",
      "exercises 2026-10-15..2026-10-15 maxHR=false",
      "body 2026-07-19..2026-10-16 values=weight",
    ]);
  });

  it.each<[string, (h: FakeHealth) => void, string, string[]]>([
    ["green", () => {}, "green", []],
    // z = (47 − 50) / 2.04 = −1.47: below −0.5, not below −1.5.
    ["hrv yellow", (h) => setNight(h, COACH_TODAY, (n) => (n.hrv.medianMs = 47)), "yellow", ["hrv_below_baseline"]],
    ["hrv red", (h) => setNight(h, COACH_TODAY, (n) => (n.hrv.medianMs = 46)), "red", ["hrv_well_below_baseline"]],
    ["resting hr red", (h) => h.resting.set(COACH_TODAY, { bpm: 65, method: "WITH_SLEEP" }), "red", ["resting_hr_well_above_baseline"]],
    ["short sleep yellow", (h) => h.nights.set(COACH_TODAY, night(COACH_TODAY, 400, 450, 50)), "yellow", ["sleep_short"]],
    [
      "missing signals",
      (h) => {
        setNight(h, COACH_TODAY, (n) => (n.hrv.medianMs = null));
        h.resting.delete(COACH_TODAY);
      },
      "green",
      ["missing:hrv", "missing:resting_hr"],
    ],
  ])("judges readiness: %s", async (_name, tweak, level, reasons) => {
    const h = history(28);
    tweak(h);
    const { readiness } = (await briefing(h)).data;
    expect(readiness.level).toBe(level);
    expect(readiness.reasons).toEqual(reasons);
  });

  it("does not judge the signals of a short history", async () => {
    const out = await briefing(history(5));
    const data = out.data;
    // Five nights: no z-score and an unjudged resting-HR delta, both shown
    // or left null, never treated as green.
    expect(data.readiness.confidence).toBe("low");
    expect(out.coverage).toEqual({ n_days: 5, confidence: "low" });
    expect(data.hrv.z_score_vs_28d).toBeNull();
    expect(data.hrv.median_ms).toBe(50);
    expect(data.resting_hr.delta_bpm_vs_28d).not.toBeNull();
    expect(data.readiness.reasons).toEqual(["missing:hrv", "missing:resting_hr"]);
    expect(data.sleep.vs_28d.asleep_min.n_days).toBe(5);
  });

  it("keeps missing values null with nothing before the night", async () => {
    const h = history(0);
    setNight(h, COACH_TODAY, (n) => {
      n.stages = null;
      n.hrv = { medianMs: null, coverage: 0 };
    });
    const out = await briefing(h);
    const data = out.data;
    // Missing values stay null, never 0, and the output schema accepts them.
    expect(data.sleep.vs_7d.asleep_min).toBeNull();
    expect(data.sleep.vs_28d.efficiency_pct).toBeNull();
    expect(data.sleep.stages_min).toEqual({ deep: null, light: null, rem: null, awake: 40 });
    expect(data.hrv).toEqual({ median_ms: null, z_score_vs_28d: null, delta_pct_vs_28d: null });
    expect(data.resting_hr.delta_bpm_vs_28d).toBeNull();
    expect(data.yesterday_load).toEqual({ date: YESTERDAY, exercises: [], steps: null, azm_min: null });
    expect(data.body).toEqual({ weight_kg: null, date: null });
    // No band data yesterday at all reads as not worn.
    expect(out.quality_flags).toEqual(["band_not_worn"]);
    expect(out.coverage.n_days).toBe(0);
  });

  it("leaves provisional nights out of the baselines", async () => {
    const h = history(7);
    const day = plus(COACH_TODAY, -2);
    h.nights.set(day, { ...night(day, 200, 600, 10), provisional: true });
    const { sleep } = (await briefing(h)).data;
    expect(sleep.vs_7d.asleep_min).toMatchObject({ avg: 450, n_days: 6 });
  });

  it("raises the quality flags in a fixed order", async () => {
    const h = history(28);
    setNight(h, COACH_TODAY, (n) => {
      n.provisional = true;
      n.hrv = { medianMs: null, coverage: 0.3 };
    });
    h.resting.set(COACH_TODAY, { bpm: 61, method: "OTHER" });
    h.recoveryExtra.skipped = 1;
    h.activityDays.set(YESTERDAY, activityDay({ steps: 300, totalKcal: 1700 }));
    h.sessions = [
      {
        ...session("1", YESTERDAY, 19, "JIU_JITSU", 60, heartRate(81), "low_hr_for_activity"),
        name: "Evening class",
      },
    ];
    const out = await briefing(h);
    expect(out.quality_flags).toEqual([
      "provisional_sleep",
      "hrv_low_coverage",
      "non_standard_resting_hr",
      "unreadable_records",
      "band_not_worn",
      "low_hr_for_activity",
    ]);
    // The briefing carries the type, never the free-text name.
    const [exercise] = out.data.yesterday_load.exercises;
    expect(exercise).toEqual({ type: "JIU_JITSU", minutes: 60, avg_hr_bpm: 81, quality_flags: ["low_hr_for_activity"] });
    expect(JSON.stringify(out)).not.toContain("Evening class");
    // A resting HR from another method is shown, but neither compared with
    // the standard-method baseline nor judged.
    expect(out.data.resting_hr).toEqual({ bpm: 61, delta_bpm_vs_28d: null });
    // A provisional night may change after sync: readiness says so and drops
    // to low confidence.
    expect(out.data.readiness.reasons).toEqual(["missing:hrv", "missing:resting_hr", "provisional:sleep"]);
    expect(out.data.readiness.confidence).toBe("low");
  });

  describe("errors", () => {
    it("answers no_data without a night on the date", async () => {
      const h = history(28);
      h.nights.delete(COACH_TODAY);
      const error = await coachSession(h).fails("morning_briefing");
      expect(error.code).toBe("no_data");
      expect(error.message).toBe("no main sleep recorded for the night ending on that date");
      expect(error.hint).toBeTruthy();
      // Nothing else is read for a night that is not there.
      expect(h.calls).toEqual(["recovery 2026-09-18..2026-10-16"]);
    });

    it("rejects a date after today", async () => {
      const h = history(1);
      const error = await coachSession(h).fails("morning_briefing", { date: "2026-10-17" });
      expect(error).toMatchObject({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
      expect(h.calls).toEqual([]);
    });

    it.each(["recovery", "activity", "exercises", "body"])("passes an error of the %s source on as it is", async (method) => {
      const h = history(28);
      h.errs[method] = new ToolError("auth_expired", "sign in again", "reconnect the connector");
      const error = await coachSession(h).fails("morning_briefing");
      expect(error).toMatchObject({ code: "auth_expired", message: "sign in again", hint: "reconnect the connector" });
    });

    it("passes the budget error of the client on as it is", async () => {
      const h = history(28);
      h.errs.recovery = new ToolError("invalid_input", "the date range holds more sleep data than one call reads", "use a shorter date range");
      const error = await coachSession(h).fails("morning_briefing");
      expect(error.text).toBe(
        '{"code":"invalid_input","message":"the date range holds more sleep data than one call reads","hint":"use a shorter date range"}',
      );
    });

    it("hides any other error of a source behind internal_error", async () => {
      const h = history(28);
      h.errs.body = new Error("synthetic failure: 80.2 kg");
      const error = await coachSession(h).fails("morning_briefing");
      expect(error.text).toBe('{"code":"internal_error","message":"unexpected internal error"}');
      // The log names the tool and the error type, never the error text.
      expect(errorLog.mock.calls).toEqual([["tool_internal_error", { tool: "morning_briefing", error_types: "Error" }]]);
    });

    it("reviews an earlier date", async () => {
      const { sleep, yesterday_load: load } = (await briefing(history(28), { date: "2026-10-10" })).data;
      expect(sleep.end).toBe("2026-10-10T07:00:00-03:00");
      expect(load.date).toBe("2026-10-09");
    });
  });

  it.each([{}, { date: "" }, { date: null }])("reads %j as today", async (args) => {
    const h = history(3);
    expect((await briefing(h, args)).data.sleep.end).toBe("2026-10-16T07:00:00-03:00");
    expect(h.calls[0]).toBe("recovery 2026-09-18..2026-10-16");
  });

  it.each([{ date: "2026-02-30" }, { date: "16/10/2026" }, { date: 20261016 }, { day: "2026-10-16" }])(
    "rejects the arguments %j before any read",
    async (args) => {
      const h = history(3);
      const error = await coachSession(h).fails("morning_briefing", args);
      expect(error.code).toBe("invalid_input");
      expect(error.schema).toBe(true);
      expect(h.calls).toEqual([]);
    },
  );

  it("takes today from the configured zone", async () => {
    // 2026-10-17 01:00 UTC is still the 16th in São Paulo.
    const late = new Date("2026-10-17T01:00:00Z");
    const local = history(3);
    await coachSession(local, { now: late }).ok("morning_briefing");
    expect(local.calls[0]).toBe("recovery 2026-09-18..2026-10-16");
    const utc = history(3);
    expect(await coachSession(utc, { now: late, zone: UTC }).fails("morning_briefing")).toMatchObject({ code: "no_data" });
    expect(utc.calls[0]).toBe("recovery 2026-09-19..2026-10-17");
  });

  it("compares each window and each field on its own", async () => {
    const h = history(28);
    // The last 7 nights differ from the 21 before them, so each window and
    // each field gives its own average.
    for (let i = 1; i <= 28; i++) {
      const day = plus(COACH_TODAY, -i);
      const hrv = h.nights.get(day)?.hrv.medianMs ?? null;
      h.nights.set(day, i <= 7 ? night(day, 420, 480, hrv) : night(day, 480, 500, hrv));
    }
    const { sleep } = (await briefing(h)).data;
    // Tonight: asleep 480 of 520, awake 40, efficiency 92.3, deep and REM 96, light 288.
    expect(sleep.vs_7d).toEqual({
      asleep_min: { avg: 420, delta: 60, n_days: 7 },
      awake_min: { avg: 60, delta: -20, n_days: 7 },
      efficiency_pct: { avg: 87.5, delta: 4.8, n_days: 7 },
      deep_min: { avg: 84, delta: 12, n_days: 7 },
      light_min: { avg: 252, delta: 36, n_days: 7 },
      rem_min: { avg: 84, delta: 12, n_days: 7 },
    });
    expect(sleep.vs_28d).toEqual({
      asleep_min: { avg: 465, delta: 15, n_days: 28 },
      awake_min: { avg: 30, delta: 10, n_days: 28 },
      efficiency_pct: { avg: 93.9, delta: -1.6, n_days: 28 },
      deep_min: { avg: 93, delta: 3, n_days: 28 },
      light_min: { avg: 279, delta: 9, n_days: 28 },
      rem_min: { avg: 93, delta: 3, n_days: 28 },
    });
  });

  it("judges each signal against its own baseline", async () => {
    const h = history(28);
    // HRV on 10 nights, resting HR on 5: coverage is the smallest baseline,
    // and readiness judges HRV but not resting HR.
    for (let i = 11; i <= 28; i++) setNight(h, plus(COACH_TODAY, -i), (n) => (n.hrv = { medianMs: null, coverage: 0 }));
    for (let i = 6; i <= 28; i++) h.resting.delete(plus(COACH_TODAY, -i));
    setNight(h, COACH_TODAY, (n) => (n.hrv.medianMs = 47));
    const out = await briefing(h);
    expect(out.coverage.n_days).toBe(5);
    expect(out.data.readiness.reasons).toEqual(["hrv_below_baseline", "missing:resting_hr"]);
    // 10 nights alternating 48/52: mean 50, sd 2.11; 47 is z −1.42, −6%.
    expect(out.data.hrv).toMatchObject({ z_score_vs_28d: -1.42, delta_pct_vs_28d: -6 });
  });

  it.each<[string, (h: FakeHealth) => void, string]>([
    ["not synced", () => {}, "synced"],
    ["unreadable", (h) => (h.recoveryExtra.skipped = 1), "could not be read"],
    ["another platform", (h) => (h.recoveryExtra.empty = ["sleep"]), "another platform"],
    // Unreadable records come first: they may hide the night.
    ["unreadable and another platform", (h) => (h.recoveryExtra = { skipped: 1, empty: ["sleep"] }), "could not be read"],
  ])("explains a missing night: %s", async (_name, tweak, hint) => {
    const h = history(3);
    h.nights.delete(COACH_TODAY);
    tweak(h);
    const error = await coachSession(h).fails("morning_briefing");
    expect(error.code).toBe("no_data");
    expect(error.hint).toContain(hint);
  });

  it.each<[string, (h: FakeHealth) => void, string[]]>([
    // The day's row was dropped as unreadable: not evidence the band was off.
    [
      "unreadable activity",
      (h) => {
        h.activityDays.delete(YESTERDAY);
        h.activitySkipped = 1;
      },
      ["unreadable_records"],
    ],
    ["unreadable sessions", (h) => (h.exercisesExtra.skipped = 1), ["unreadable_records"]],
    ["unreadable weight", (h) => (h.bodySkipped = 1), ["unreadable_records"]],
    ["recorded but not worn", (h) => h.activityDays.set(YESTERDAY, activityDay({ totalKcal: 1700 })), ["band_not_worn"]],
    ["steps without the band", (h) => h.activityDays.set(YESTERDAY, activityDay({ steps: 400 })), ["band_not_worn"]],
    ["sessions from another platform", (h) => (h.exercisesExtra.otherSource = 2), ["other_source_sessions_excluded"]],
  ])("flags yesterday's load: %s", async (_name, tweak, flags) => {
    const h = history(28);
    // A worn day has zone minutes, 0 without a row, as healthdata gives it.
    h.activityDays.set(YESTERDAY, activityDay({ steps: 8000, azm: 0, worn: true }));
    tweak(h);
    expect((await briefing(h)).quality_flags).toEqual(flags);
  });

  describe("a day that an unreadable row left out of yesterday's load", () => {
    const NARROW = "activity 2026-10-15..2026-10-15 values=steps,azm,worn";
    const KCAL = "activity 2026-10-15..2026-10-15 values=total_calories";
    const activityCalls = (h: FakeHealth) => h.calls.filter((call) => call.startsWith("activity"));

    it("is off the wrist when it has total calories, which the Go server reads", async () => {
      // A total-calories row, no zone minutes, no step record of the band, and
      // a steps row that cannot be read: in the Go server the day is there,
      // without band data.
      const h = history(28);
      h.activityDays.set(YESTERDAY, activityDay({ totalKcal: 1700 }));
      h.activitySkipped = 1;
      const out = await briefing(h);
      expect(out.quality_flags).toEqual(["band_not_worn", "unreadable_records"]);
      expect(out.data.yesterday_load).toEqual({ date: YESTERDAY, exercises: [], azm_min: null, steps: null });
      // One more read: the total calories of that day alone.
      expect(activityCalls(h)).toEqual([NARROW, KCAL]);
    });

    it("is not off the wrist when it has no total calories either", async () => {
      const h = history(28);
      h.activitySkipped = 1;
      const out = await briefing(h);
      expect(out.quality_flags).toEqual(["unreadable_records"]);
      expect(activityCalls(h)).toEqual([NARROW, KCAL]);
    });

    it("costs no read when every row was readable, or when the narrow read has the day", async () => {
      const off = history(28);
      off.activityDays.set(YESTERDAY, activityDay({ totalKcal: 1700 }));
      expect((await briefing(off)).quality_flags).toEqual(["band_not_worn"]);
      expect(activityCalls(off)).toEqual([NARROW]);

      const worn = history(28);
      worn.activityDays.set(YESTERDAY, activityDay({ steps: 8000, azm: 0, worn: true }));
      worn.activitySkipped = 1;
      expect((await briefing(worn)).quality_flags).toEqual(["unreadable_records"]);
      expect(activityCalls(worn)).toEqual([NARROW]);
    });
  });

  it("caps the sessions and lists each flag and source once", async () => {
    const h = history(28);
    h.activityDays.set(YESTERDAY, activityDay({ steps: 8000, azm: 0, worn: true }));
    h.recoveryExtra.sources = ["Band B"];
    h.weight.set(YESTERDAY, { at: undefined, value: 80, source: "Scale" });
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      h.sessions.push({ ...session(String(i), YESTERDAY, 0, "WALKING", 10, null, "no_hr_data"), source: "Band A" });
    }
    const out = await briefing(h);
    expect(MAX_SESSIONS).toBe(20);
    expect(out.data.yesterday_load.exercises).toHaveLength(MAX_SESSIONS);
    // Each flag once, however many sessions carry it.
    expect(out.quality_flags).toEqual(["sessions_truncated", "no_hr_data"]);
    expect(out.sources).toEqual(["Band A", "Band B", "Scale"]);
  });

  it("answers internal_error for a value that is not a finite number", async () => {
    const h = history(28);
    setNight(h, COACH_TODAY, (n) => (n.asleepMin = Number.NaN));
    // JSON would write null for it: the result is refused instead.
    const error = await coachSession(h).fails("morning_briefing");
    expect(error.text).toBe('{"code":"internal_error","message":"unexpected internal error"}');
    expect(errorLog.mock.calls).toEqual([["tool_internal_error", { tool: "morning_briefing", error_types: "OutputSchemaError" }]]);
  });
});
