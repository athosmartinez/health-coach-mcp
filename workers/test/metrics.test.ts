// Ports of internal/metrics/stats_test.go, quality_test.go and readiness_test.go.
import { describe, expect, it } from "vitest";

import { type LocalDate, addDays } from "../src/coach/date";
import type { ConfidenceLevel } from "../src/coach/envelope";
import {
  FLAG_LOW_HR_FOR_ACTIVITY,
  FLAG_MANUAL_ENTRY,
  FLAG_NO_HR_DATA,
  type Exercise,
  checkLogging,
  exerciseFlags,
  isMainMeal,
  isVigorous,
  normalizeMealType,
  partialDay,
} from "../src/metrics/quality";
import { type Level, type ReadinessThresholds, type Signal, assessReadiness, defaultThresholds } from "../src/metrics/readiness";
import {
  ALGO_VERSION,
  EWMA_ALPHA,
  MIN_BASELINE_NIGHTS,
  type Point,
  type Stats,
  type TargetDay,
  type TrendDirection,
  adherenceAtLeast,
  adherenceWithin,
  baseline,
  delta,
  deltaPct,
  ewma,
  sleepOnsetConsistency,
  slopePerWeek,
  trend,
  zScore,
} from "../src/metrics/stats";

/** 2026-10-01 plus n days. */
function day(n: number): LocalDate {
  return addDays("2026-10-01", n) as LocalDate;
}

const point = (date: LocalDate, value: number | null): Point => ({ date, value });

function near(got: number | null, want: number): void {
  expect(got).not.toBeNull();
  expect(Math.abs((got as number) - want)).toBeLessThan(1e-9);
}

describe("baseline", () => {
  it("covers the days before the day judged", () => {
    // The window for before = day 9 and 7 days is day 2 .. day 8.
    const series = [
      point(day(1), 100), // the day before the window
      point(day(8), 8), // last day in the window (listed out of order)
      point(day(2), 2), // first day in the window
      point(day(3), null), // missing day
      point(day(4), 4),
      point(day(6), 6),
      point(day(9), 100), // the day itself is not its own baseline
    ];
    const b = baseline(series, day(9), 7);
    // Values 2, 4, 6, 8: mean 5, sample variance (9+1+1+9)/3.
    expect(b.n).toBe(4);
    expect(b.mean).toBe(5);
    expect(Math.abs(b.sd - Math.sqrt(20 / 3))).toBeLessThan(1e-12);
  });

  it("handles an empty series and a single value", () => {
    expect(baseline([], day(9), 28)).toEqual({ mean: 0, sd: 0, n: 0 });
    expect(baseline([point(day(3), 61)], day(9), 28)).toEqual({ mean: 61, sd: 0, n: 1 });
  });

  it.each<[string, Point[], LocalDate, number, string]>([
    ["zero days", [], day(9), 0, "days"],
    ["invalid before", [], "2026-13-01", 7, "invalid date"],
    ["invalid point", [point("10/03/2026", 1)], day(9), 7, "invalid date"],
    ["duplicate date", [point(day(3), 1), point(day(3), 2)], day(9), 7, "twice"],
    ["not finite", [point(day(3), NaN)], day(9), 7, "not a finite"],
  ])("rejects %s", (_name, series, before, days, want) => {
    expect(() => baseline(series, before, days)).toThrow(want);
  });

  it("works across a month boundary and with a 1-day window", () => {
    // Exactly 7 nights present in a 28-day window across a month boundary.
    const before = "2026-11-03";
    const series = [50, 52, 54, 56, 58, 60, 62].map((v, i) => point(addDays(before, -4 * (i + 1)) as LocalDate, v));
    const b = baseline(series, before, 28);
    expect(b.n).toBe(7);
    expect(b.mean).toBe(56);
    near(zScore(56 + b.sd, b), 1);
    // A 1-day window is just the day before (2026-10-30, the first value).
    expect(baseline(series, "2026-10-31", 1)).toMatchObject({ n: 1, mean: 50 });
  });

  it("ignores bad rows outside the window", () => {
    const series = [
      point(day(-200), NaN), // corrupt, but long ago
      point(day(-200), 1),
      point(day(3), 60),
    ];
    expect(baseline(series, day(9), 28).n).toBe(1);
  });
});

describe("zScore", () => {
  const run = (n: number): Point[] => Array.from({ length: n }, (_, i) => point(day(i), i + 1));

  it("needs seven nights", () => {
    expect(MIN_BASELINE_NIGHTS).toBe(7);
    expect(zScore(8, baseline(run(6), day(28), 28))).toBeNull();
    const seven = baseline(run(7), day(28), 28);
    // Values 1..7: mean 4, sample variance 28/6.
    near(zScore(8, seven), 4 / Math.sqrt(28 / 6));
    expect(zScore(null, seven)).toBeNull();
  });

  it("gives nothing against a flat baseline", () => {
    // The same non-round value every night: the computed sd is 0 or a rounding
    // residue, and either way there is no spread to measure against.
    const flat = baseline(
      Array.from({ length: 10 }, (_, i) => point(day(i), 55.3)),
      day(10),
      28,
    );
    expect(zScore(60, flat)).toBeNull();
    expect(zScore(60, { mean: 60, sd: 0, n: 10 })).toBeNull();
    // A small but real spread still gives a z-score.
    near(zScore(60.001, { mean: 60, sd: 1e-3, n: 10 }), 1);
  });

  it.each<[string, number, Stats]>([
    ["NaN sd", 60, { mean: 60, sd: NaN, n: 10 }],
    ["Inf mean", 60, { mean: Infinity, sd: 2, n: 10 }],
    ["NaN value", NaN, { mean: 60, sd: 2, n: 10 }],
  ])("gives nothing with %s", (_name, value, stats) => {
    expect(zScore(value, stats)).toBeNull();
  });
});

describe("delta", () => {
  const b: Stats = { mean: 58, sd: 2, n: 20 };
  const none: Stats = { mean: 0, sd: 0, n: 0 };

  it("is the change from the mean, also in percent", () => {
    near(delta(63, b), 5);
    near(deltaPct(63.8, b), 10);
    // A rise is positive even when the mean is negative.
    near(deltaPct(-9, { mean: -10, sd: 0, n: 3 }), 10);
  });

  it.each<[string, number | null]>([
    ["NaN value", delta(NaN, b)],
    ["missing value", delta(null, b)],
    ["no baseline", delta(63, none)],
    ["pct missing value", deltaPct(null, b)],
    ["pct no baseline", deltaPct(63, none)],
    ["pct zero mean", deltaPct(1, { mean: 0, sd: 0, n: 3 })],
  ])("is null with %s", (_name, got) => {
    expect(got).toBeNull();
  });
});

describe("ewma", () => {
  it("matches the hand-computed series", () => {
    const series = [
      point(day(4), 30),
      point(day(0), null), // before the first value: nothing to smooth yet
      point(day(1), 10),
      point(day(2), null), // missing: the state carries over unchanged
      // day 3 has no point at all, which is the same as a missing value
      point(day(5), 20),
    ];
    // Seed 10; 0.25·30 + 0.75·10 = 15; 0.25·20 + 0.75·15 = 16.25.
    expect(EWMA_ALPHA).toBe(0.25);
    expect(ewma(series, EWMA_ALPHA)).toEqual([
      point(day(0), null),
      point(day(1), 10),
      point(day(2), null),
      point(day(4), 15),
      point(day(5), 16.25),
    ]);
    // The caller's array keeps its order.
    expect(series[0]?.date).toBe(day(4));
  });

  it("rejects a bad alpha and a duplicate date", () => {
    for (const alpha of [0, -0.1, 1.5, NaN]) expect(() => ewma([], alpha)).toThrow("alpha");
    expect(() => ewma([point(day(1), 1), point(day(1), 2)], EWMA_ALPHA)).toThrow("twice");
    expect(ewma([], 1)).toEqual([]);
    // alpha 1 keeps only the newest value: the series comes back unchanged.
    expect(ewma([point(day(0), 3), point(day(1), 7)], 1)).toEqual([point(day(0), 3), point(day(1), 7)]);
  });
});

describe("slopePerWeek", () => {
  it("fits on dates, not on positions", () => {
    // y = 80 − 0.1·x on days 0, 2 and 7 (days 1, 3–6 missing). Fitting on array
    // positions instead of dates would give a different slope.
    near(slopePerWeek([point(day(7), 79.3), point(day(0), 80), point(day(3), null), point(day(2), 79.8)]), -0.7);
    expect(slopePerWeek([point(day(0), 80), point(day(1), null)])).toBeNull();
    expect(() => slopePerWeek([point(day(0), 1), point(day(0), 2)])).toThrow("twice");
    expect(() => slopePerWeek([point(day(0), 1), point(day(1), Infinity)])).toThrow("not a finite");
  });
});

describe("trend", () => {
  it.each<[number | null, number | null, number, TrendDirection]>([
    [70.3, 70.0, 0.3, "up"], // exactly the threshold, despite 70.3−70.0 = 0.2999…
    [70.0, 70.3, 0.3, "down"],
    [70.2, 70.0, 0.3, "flat"],
    [70.0, 70.0, 0, "flat"], // no change is flat even with no threshold
    [70.1, 70.0, 0, "up"],
    [1e6 + 0.3, 1e6, 0.3, "up"], // the rounding allowance scales with magnitude
    [1e6 + 0.2, 1e6, 0.3, "flat"],
    [null, 70, 0.3, "unknown"],
    [70, null, 0.3, "unknown"],
    [NaN, 70, 0.3, "unknown"],
    [70, Infinity, 0.3, "unknown"],
  ])("trend(%s, %s, %s) is %s", (current, prev, min, want) => {
    expect(trend(current, prev, min)).toBe(want);
  });

  it.each([-0.3, NaN, Infinity])("rejects the threshold %s", (bad) => {
    expect(() => trend(1, 0, bad)).toThrow("threshold");
  });
});

describe("sleepOnsetConsistency", () => {
  it.each<[string, number[], number]>([
    ["across midnight", [23 * 60 + 50, 10], 10], // 23:50 and 00:10
    ["wide across midnight", [22 * 60, 2 * 60], 120],
    ["same side", [23 * 60, 23 * 60 + 20, 23 * 60 + 40], Math.sqrt(800 / 3)],
    ["identical", [60, 60, 60], 0],
    // Three nights around midnight: mean 23:58:20, deviations −18:20, −3:20, +21:40.
    [
      "three across midnight",
      [23 * 60 + 40, 23 * 60 + 55, 20],
      Math.sqrt((18.333333333333332 ** 2 + 3.3333333333333335 ** 2 + 21.666666666666668 ** 2) / 3),
    ],
    // The first night is not at the mean, so the reference must come from the circle.
    ["first night off the mean", [2 * 60, 0, 1 * 60], Math.sqrt((2 / 3) * 3600)],
    // Opposite times have no mean direction; the answer is the same from either side.
    ["opposite", [0, 12 * 60], 6 * 60],
  ])("%s", (_name, starts, want) => {
    near(sleepOnsetConsistency(starts), want);
  });

  it("needs two nights and real minutes of the day", () => {
    expect(sleepOnsetConsistency([23 * 60])).toBeNull();
    for (const bad of [-1, 24 * 60, NaN, 10.5]) {
      expect(() => sleepOnsetConsistency([0, bad])).toThrow("sleep start #1 is not a minute of the day");
    }
  });
});

describe("adherence", () => {
  const target = (date: LocalDate, value: number | null, goal: number | null, partial = false): TargetDay => ({
    date,
    value,
    target: goal,
    partial,
  });

  it("counts days within a tolerance of the target", () => {
    const days = [
      target(day(0), 2200, 2000), // +10%: inside, inclusive
      target(day(1), 1800, 2000), // −10%: inside
      target(day(2), 2201, 2000), // outside
      target(day(3), 1000, 2000, true), // partial day: not counted
      target(day(4), null, 2000), // nothing logged: not counted
      target(day(5), 2500, null), // no target in force: not counted
      target(day(6), 2420, 2200), // the target changed: +10% of 2200
      target(day(7), 0, 0), // a zero target has no band: not counted
      target(day(8), 1799, 2000), // below the band
    ];
    const a = adherenceWithin(days, 0.1);
    expect(a).toMatchObject({ days_hit: 3, days_counted: 5, days_below: 1, days_above: 1 });
    near(a.pct, 60);
    // No eligible day: a null percentage, never 0%.
    expect(adherenceWithin(days.slice(3, 6), 0.1)).toEqual({
      pct: null,
      days_hit: 0,
      days_counted: 0,
      days_below: 0,
      days_above: 0,
    });
    for (const tolerance of [-0.1, 1, NaN]) expect(() => adherenceWithin(days, tolerance)).toThrow("tolerance");
  });

  it("counts days at or above the target", () => {
    const days = [
      target(day(0), 140, 140), // exactly the target
      target(day(1), 139.9, 140),
      target(day(2), 200, 140),
      target(day(3), 10, 140, true),
      target(day(4), 0, 0), // a zero target is no target: not a free hit
    ];
    const a = adherenceAtLeast(days);
    expect(a).toMatchObject({ days_hit: 2, days_counted: 3, days_below: 1, days_above: 0 });
    near(a.pct, 200 / 3);
    expect(adherenceAtLeast([])).toMatchObject({ days_counted: 0, pct: null });
  });

  it.each<[string, TargetDay[]]>([
    ["NaN value", [target(day(0), NaN, 140)]],
    ["infinite target", [target(day(0), 140, Infinity)]],
    ["negative value", [target(day(0), -5, 140)]],
    ["duplicate date", [target(day(0), 140, 140), target(day(0), 150, 140)]],
    ["invalid date", [target("2026-02-30", 140, 140)]],
  ])("rejects %s", (_name, days) => {
    expect(() => adherenceAtLeast(days)).toThrow();
    expect(() => adherenceWithin(days, 0.1)).toThrow();
  });

  it("never quotes a value in an error", () => {
    expect(() => adherenceAtLeast([target(day(0), -5.25, 140)])).toThrow(/^value on 2026-10-01 is negative$/);
    expect(() => adherenceAtLeast([target(day(0), NaN, 140)])).toThrow(/^value on 2026-10-01 is not a finite number$/);
  });

  it("allows a zero tolerance", () => {
    const a = adherenceWithin([target(day(0), 2000, 2000), target(day(1), 2001, 2000)], 0);
    expect(a).toMatchObject({ days_hit: 1, days_counted: 2 });
  });
});

describe("quality flags", () => {
  const HOUR = 3_600_000;
  const session = (over: Partial<Exercise>): Exercise => ({
    type: "JIU_JITSU",
    durationMs: HOUR,
    avgHR: null,
    manualEntry: false,
    ...over,
  });

  it.each<[string, Exercise, string[]]>([
    ["jiu-jitsu with a low average HR", session({ avgHR: 81 }), [FLAG_LOW_HR_FOR_ACTIVITY]],
    ["display name spelling", session({ type: " Jiu-jitsu", avgHR: 81 }), [FLAG_LOW_HR_FOR_ACTIVITY]],
    ["exactly 100 bpm", session({ type: "RUNNING", avgHR: 100 }), []],
    ["exactly 30 min", session({ type: "HIIT", durationMs: 30 * 60_000, avgHR: 90 }), [FLAG_LOW_HR_FOR_ACTIVITY]],
    ["short session", session({ type: "HIIT", durationMs: 29 * 60_000, avgHR: 90 }), []],
    ["easy activity", session({ type: "WALKING", avgHR: 85 }), []],
    ["strength training rests", session({ type: "STRENGTH_TRAINING", avgHR: 92 }), []],
    ["no heart rate", session({}), [FLAG_NO_HR_DATA]],
    ["zero heart rate", session({ avgHR: 0 }), [FLAG_NO_HR_DATA]],
    ["NaN heart rate", session({ avgHR: NaN }), [FLAG_NO_HR_DATA]],
    ["manual entry without HR", session({ type: "RUNNING", manualEntry: true }), [FLAG_MANUAL_ENTRY, FLAG_NO_HR_DATA]],
  ])("exerciseFlags: %s", (_name, exercise, want) => {
    expect(exerciseFlags(exercise)).toEqual(want);
  });

  it("marks today and later days as partial", () => {
    const today = day(10);
    expect(partialDay(day(10), today)).toBe(true);
    expect(partialDay(day(11), today)).toBe(true);
    expect(partialDay(day(9), today)).toBe(false);
    expect(() => partialDay("", today)).toThrow("invalid date");
    expect(() => partialDay(today, "")).toThrow("invalid date");
  });

  const main = ["SNACK", "LUNCH"];
  it.each<[string, number | null, number | null, string[], boolean, number | null]>([
    ["complete", 1100, 2200, main, false, 50], // the rule is strictly below 50%
    ["under half", 1078, 2200, main, true, 49],
    ["only snacks", 1900, 1900, ["SNACK"], true, 100],
    ["nothing logged", null, 2200, [], true, null],
    ["zero kcal", 0, null, main, true, null],
    ["NaN kcal", NaN, 2200, main, true, null],
    ["no target", 800, null, main, false, null],
    ["zero target", 800, 0, main, false, null],
    ["lowercase meal type", 1900, 1900, ["dinner"], false, 100],
  ])("checkLogging: %s", (_name, kcal, goal, meals, incomplete, pct) => {
    const got = checkLogging(kcal, goal, meals);
    expect(got.likely_incomplete).toBe(incomplete);
    if (pct === null) expect(got.kcal_pct_of_target).toBeNull();
    else near(got.kcal_pct_of_target, pct);
  });

  it("looks meal and exercise types up in their normal form", () => {
    expect(isMainMeal("Breakfast")).toBe(true);
    expect(isMainMeal("SNACK")).toBe(false);
    expect(isVigorous("crossfit")).toBe(true);
    expect(isVigorous("WEIGHTLIFTING")).toBe(false);
    expect(checkLogging(1900, 1900, ["dinner"]).has_main_meal).toBe(true);
    expect(normalizeMealType(" Late snack\n")).toBe("LATE_SNACK");
    expect(normalizeMealType("pre-workout")).toBe("PRE_WORKOUT");
    // Each character is mapped on its own, as in Go: no "SS" for "ß".
    expect(normalizeMealType("frühstück groß")).toBe("FRÜHSTÜCK_GROß");
  });
});

describe("readiness", () => {
  /** A signal with a full 28-night baseline. */
  const sig = (value: number | null): Signal => ({ value, nights: 28 });
  const none: Signal = { value: null, nights: 0 };

  it.each<[string, number | null, number | null, number | null, Level, string[]]>([
    ["all good", 0.2, 1, 450, "green", []],
    ["hrv z −1.5", -1.5, 0, 450, "yellow", ["hrv_below_baseline"]], // red is strictly below
    ["hrv z below −1.5", -1.51, 0, 450, "red", ["hrv_well_below_baseline"]],
    ["hrv z −0.5", -0.5, 0, 450, "green", []], // yellow is strictly below
    ["hrv z below −0.5", -0.51, 0, 450, "yellow", ["hrv_below_baseline"]],
    ["rhr +5", 0, 5, 450, "red", ["resting_hr_well_above_baseline"]], // inclusive
    ["rhr +5 rounded", 0, 4.9999999999, 450, "red", ["resting_hr_well_above_baseline"]],
    ["rhr +4.9", 0, 4.9, 450, "yellow", ["resting_hr_above_baseline"]],
    ["rhr +3", 0, 3, 450, "yellow", ["resting_hr_above_baseline"]],
    ["rhr +2.9", 0, 2.9, 450, "green", []],
    ["rhr lower", 0, -6, 450, "green", []],
    ["asleep 360", 0, 0, 360, "yellow", ["sleep_short"]], // red is strictly below
    ["asleep 359", 0, 0, 359, "red", ["sleep_very_short"]],
    ["asleep 420", 0, 0, 420, "green", []],
    ["asleep 419", 0, 0, 419, "yellow", ["sleep_short"]],
    [
      "worst wins, all reasons listed in order",
      -0.8,
      6,
      400,
      "red",
      ["hrv_below_baseline", "resting_hr_well_above_baseline", "sleep_short"],
    ],
    ["hrv missing, good sleep", null, 0, 480, "green", ["missing:hrv"]],
    ["only one signal", null, null, 300, "red", ["missing:hrv", "missing:resting_hr", "sleep_very_short"]],
    ["no signal", null, null, null, "unknown", ["missing:hrv", "missing:resting_hr", "missing:sleep"]],
    // A value that is not a number must not pass every comparison as green.
    ["NaN everywhere", NaN, NaN, NaN, "unknown", ["missing:hrv", "missing:resting_hr", "missing:sleep"]],
    ["infinite hrv", -Infinity, 0, 450, "green", ["missing:hrv"]],
  ])("level: %s", (_name, hrvZ, rhrDelta, asleep, level, reasons) => {
    const r = assessReadiness(defaultThresholds(), sig(hrvZ), sig(rhrDelta), asleep);
    expect(r.level).toBe(level);
    expect(r.reasons).toEqual(reasons);
  });

  it("does not judge a signal on a short baseline", () => {
    // Resting HR +6 on a 2-night baseline is not evidence of anything.
    expect(assessReadiness(defaultThresholds(), sig(0), { value: 6, nights: 2 }, 450)).toEqual({
      level: "green",
      reasons: ["missing:resting_hr"],
      confidence: "medium",
    });
    // Both baselines short: only sleep is left, and it carries no baseline.
    expect(assessReadiness(defaultThresholds(), { value: -3, nights: 6 }, { value: 9, nights: 6 }, 450)).toMatchObject({
      level: "green",
      confidence: "low",
    });
  });

  it.each<[string, Signal, Signal, number | null, ConfidenceLevel]>([
    ["full baselines", sig(0), sig(0), 450, "high"],
    ["21 nights", { value: 0, nights: 21 }, { value: 0, nights: 21 }, 450, "high"],
    ["the smaller baseline wins", { value: 0, nights: 28 }, { value: 0, nights: 14 }, 450, "medium"],
    ["7 nights", { value: 0, nights: 7 }, { value: 0, nights: 7 }, 450, "medium"],
    ["6 nights", { value: 0, nights: 6 }, { value: 0, nights: 6 }, 450, "low"],
    ["one missing", none, sig(0), 480, "medium"],
    ["one missing, 7 nights", none, { value: 0, nights: 7 }, 480, "medium"],
    ["one missing, 6 nights", { value: 0, nights: 6 }, sig(0), 480, "medium"],
    ["sleep missing, 28 nights", sig(0), sig(0), null, "medium"],
    ["two missing", none, none, 480, "low"],
    ["no signal", none, none, null, "low"],
  ])("confidence: %s", (_name, hrv, rhr, asleep, want) => {
    expect(assessReadiness(defaultThresholds(), hrv, rhr, asleep).confidence).toBe(want);
  });

  // Each line is moved past a value that is green under the defaults; a closure
  // reading the wrong field would leave the level unchanged.
  it.each<[string, Partial<ReadinessThresholds>, number, number, number, Level]>([
    ["hrv red", { hrvZRed: 0.5 }, 0, 0, 450, "red"],
    ["hrv yellow", { hrvZYellow: 0.5 }, 0, 0, 450, "yellow"],
    ["rhr red", { restingHRRed: 1 }, 0, 1, 450, "red"],
    ["rhr yellow", { restingHRYellow: 1 }, 0, 1, 450, "yellow"],
    ["asleep red", { asleepMinRed: 460 }, 0, 0, 450, "red"],
    ["asleep yellow", { asleepMinYellow: 460 }, 0, 0, 450, "yellow"],
  ])("reads the %s threshold", (_name, move, hrv, rhr, asleep, want) => {
    const th = { ...defaultThresholds(), ...move };
    expect(assessReadiness(th, sig(hrv), sig(rhr), asleep).level).toBe(want);
  });

  it("hands out a fixed copy of the default thresholds", () => {
    expect(defaultThresholds()).toEqual({
      hrvZRed: -1.5,
      hrvZYellow: -0.5,
      restingHRRed: 5,
      restingHRYellow: 3,
      asleepMinRed: 360,
      asleepMinYellow: 420,
    });
    const changed = defaultThresholds();
    changed.hrvZRed = 9;
    expect(defaultThresholds().hrvZRed).toBe(-1.5);
  });
});

describe("algo version", () => {
  it("is the version the Go server stamps on cached rows", () => {
    expect(ALGO_VERSION).toBe(2);
  });
});
