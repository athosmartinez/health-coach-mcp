// Ports of internal/tools/series_test.go. Each test serves metric_series over
// a synthetic health source, with "now" at 2026-10-16 08:00 in São Paulo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalDate } from "../src/coach/date";
import { ToolError } from "../src/coach/errors";
import { MAX_RANGE_DAYS } from "../src/healthdata";
import { COACH_TOOLS } from "../src/tools/moments";
import { MAX_SERIES_POINTS, SERIES_METRICS, SERIES_NOTICE, SERIES_UNITS } from "../src/tools/series";
import {
  COACH_TODAY,
  FakeHealth,
  REPORT_TARGETS,
  activityDay,
  coachSession,
  fakeTargets,
  food,
  foodDay,
  fullDay,
  night,
  weeklyHealth,
} from "./coach-helpers";

// All values below are synthetic.

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Out = Record<string, any>;

/** Renders a series as "date=value/n_days[/partial][/reason][/-left_out]" entries. */
function render(out: Out): string {
  return (out.data.points as Out[])
    .map((p) => {
      let text = `${p.date}=${p.value}/${p.n_days}`;
      if (p.complete === false) text += "/partial";
      if (p.reason !== undefined) text += `/${p.reason}`;
      if (p.days_left_out !== undefined) text += `/-${p.days_left_out}`;
      return text;
    })
    .join(" ");
}

/**
 * The two reads of the calories burned over one run of days (burnOf): whether
 * the band was worn, then the total calories of the worn days.
 */
function burnCalls(first: LocalDate, last: LocalDate): string[] {
  const days = first === last ? first : `${first}..${last}`;
  return [`activity ${first}..${last} values=worn days=${days}`, `activity ${first}..${last} values=total_calories days=${days}`];
}

function args(from: LocalDate, to: LocalDate, metric: string, granularity?: string): Record<string, unknown> {
  return { metric, from, to, ...(granularity === undefined ? {} : { granularity }) };
}

describe("metric_series", () => {
  it("gives one point per day, null for a day without a comparable value", async () => {
    const h = weeklyHealth();
    // Not comparable with the band's standard method: left out.
    h.resting.set("2026-10-03", { bpm: 70, method: "WITHOUT_SLEEP" });
    const out = await coachSession(h).ok("metric_series", args("2026-10-02", "2026-10-06", "resting_hr"));
    expect(render(out)).toBe("2026-10-02=58/1 2026-10-03=null/0 2026-10-04=58/1 2026-10-05=60/1 2026-10-06=60/1");
    expect(out.data).toMatchObject({ metric: "resting_hr", unit: "bpm", granularity: "day", from: "2026-10-02", to: "2026-10-06", notice: SERIES_NOTICE });
    // I3: the day without a value is null and counts no day; every other point is complete.
    expect(out.data.points[1]).toEqual({ date: "2026-10-03", value: null, n_days: 0, complete: true });
    expect(out.data.points[0]).toEqual({ date: "2026-10-02", value: 58, n_days: 1, complete: true });
    expect(out.coverage).toEqual({ n_days: 4, confidence: "low" });
    expect(out.generated_at).toBe("2026-10-16T11:00:00Z");
    // Resting heart rate alone: no sleep and no HRV list.
    expect(h.calls).toEqual(["recovery 2026-10-02..2026-10-06 values=resting_hr"]);
  });

  it("averages the days of each ISO week", async () => {
    const h = weeklyHealth();
    const out = await coachSession(h).ok("metric_series", args("2026-10-01", COACH_TODAY, "steps", "week"));
    // Weeks start on Monday; the first one only counts from 10-01, and
    // today's running total is left out.
    expect(render(out)).toBe("2026-09-28=8000/4 2026-10-05=10000/7 2026-10-12=9000/4/-1");
    expect(out.data.granularity).toBe("week");
    expect(out.quality_flags).toEqual(["partial_day"]);
    // Coverage counts the days with a value, not the points.
    expect(out.coverage).toEqual({ n_days: 15, confidence: "medium" });
    expect(h.calls).toEqual(["activity 2026-10-01..2026-10-16 values=steps"]);
  });

  describe("each metric", () => {
    const health = (): FakeHealth => {
      const h = weeklyHealth();
      h.nights.set(COACH_TODAY, { ...night(COACH_TODAY, 430, 480, 50), provisional: true });
      h.nutritionDays.set("2026-10-14", fullDay("2026-10-14"));
      h.nutritionDays.set("2026-10-15", fullDay("2026-10-15"));
      h.recoveryExtra.sources = ["Synthetic Band"];
      return h;
    };

    // Each metric with its unit, its points, a flag and a source it must carry,
    // and its request plan: the source calls with their narrow option.
    it.each<[string, string, string, string, string, string[]]>([
      ["weight", "kg", "2026-10-14=76.3/1 2026-10-15=76.2/1 2026-10-16=76.1/1", "", "Synthetic scale", ["body 2026-10-14..2026-10-16 values=weight"]],
      ["resting_hr", "bpm", "2026-10-14=61/1 2026-10-15=61/1 2026-10-16=61/1", "", "Synthetic Band", ["recovery 2026-10-14..2026-10-16 values=resting_hr"]],
      ["hrv", "ms", "2026-10-14=50/1 2026-10-15=50/1 2026-10-16=null/0", "provisional_sleep", "Synthetic Band", ["recovery 2026-10-14..2026-10-16 values=nights"]],
      [
        "sleep_asleep_min",
        "min",
        "2026-10-14=430/1 2026-10-15=430/1 2026-10-16=null/0",
        "provisional_sleep",
        "Synthetic Band",
        ["recovery 2026-10-14..2026-10-16 values=nights"],
      ],
      ["steps", "steps", "2026-10-14=9000/1 2026-10-15=9000/1 2026-10-16=null/0/partial_day", "partial_day", "", ["activity 2026-10-14..2026-10-16 values=steps"]],
      ["azm", "min", "2026-10-14=20/1 2026-10-15=20/1 2026-10-16=null/0/partial_day", "partial_day", "", ["activity 2026-10-14..2026-10-16 values=azm"]],
      [
        "total_calories",
        "kcal",
        "2026-10-14=2600/1 2026-10-15=2600/1 2026-10-16=null/0/partial_day",
        "partial_day",
        "",
        burnCalls("2026-10-14", "2026-10-16"),
      ],
      // No kcal target: the log check of the two logged days needs the
      // calories burned, for the days the band was worn.
      [
        "kcal_in",
        "kcal",
        "2026-10-14=2200/1 2026-10-15=2200/1 2026-10-16=null/0",
        "partial_day",
        "Google Fitbit Air",
        ["nutrition 2026-10-14..2026-10-16", ...burnCalls("2026-10-14", "2026-10-15")],
      ],
      [
        "protein_g",
        "g",
        "2026-10-14=130/1 2026-10-15=130/1 2026-10-16=null/0",
        "partial_day",
        "Google Fitbit Air",
        ["nutrition 2026-10-14..2026-10-16", ...burnCalls("2026-10-14", "2026-10-15")],
      ],
    ])("%s", async (metric, unit, points, flag, source, calls) => {
      const h = health();
      const out = await coachSession(h).ok("metric_series", args("2026-10-14", COACH_TODAY, metric));
      expect(render(out)).toBe(points);
      expect(out.data.unit).toBe(unit);
      expect(out.quality_flags).toEqual(flag === "" ? [] : [flag]);
      expect(out.sources).toEqual(source === "" ? [] : [source]);
      expect(h.calls).toEqual(calls);
    });

    it("covers the closed list of the input schema, each with a unit", () => {
      expect(SERIES_METRICS).toEqual(["weight", "resting_hr", "hrv", "sleep_asleep_min", "steps", "azm", "kcal_in", "protein_g", "total_calories"]);
      expect(SERIES_UNITS).toEqual({
        weight: "kg",
        resting_hr: "bpm",
        hrv: "ms",
        sleep_asleep_min: "min",
        steps: "steps",
        azm: "min",
        kcal_in: "kcal",
        protein_g: "g",
        total_calories: "kcal",
      });
    });

    it("does not tie resting heart rate to the night's processing", async () => {
      const out = await coachSession(health()).ok("metric_series", args("2026-10-14", COACH_TODAY, "resting_hr"));
      expect(out.quality_flags).not.toContain("provisional_sleep");
    });
  });

  it("serves a single day, as a day or as its week", async () => {
    const day = await coachSession(weeklyHealth()).ok("metric_series", args("2026-10-07", "2026-10-07", "steps"));
    expect(render(day)).toBe("2026-10-07=10000/1");
    expect(day.coverage.n_days).toBe(1);
    const week = await coachSession(weeklyHealth()).ok("metric_series", args("2026-10-07", "2026-10-07", "steps", "week"));
    expect(render(week)).toBe("2026-10-05=10000/1");
  });

  it.each([null, "", "day"])("reads granularity %j as day", async (granularity) => {
    const out = await coachSession(weeklyHealth()).ok("metric_series", { metric: "steps", from: "2026-10-07", to: "2026-10-08", granularity });
    expect(out.data.granularity).toBe("day");
    expect(render(out)).toBe("2026-10-07=10000/1 2026-10-08=10000/1");
  });

  it("gives no total calories for a day without the band", async () => {
    const h = weeklyHealth();
    h.activityDays.set("2026-10-14", activityDay({ steps: 400, azm: 0, totalKcal: 1700, worn: false }));
    let out = await coachSession(h).ok("metric_series", args("2026-10-13", "2026-10-15", "total_calories"));
    // Without the band the total is mostly a resting estimate: null.
    expect(render(out)).toBe("2026-10-13=2600/1 2026-10-14=null/0/band_not_worn 2026-10-15=2600/1");
    expect(out.quality_flags).toEqual(["band_not_worn"]);
    // Two steps: the days the band was worn, then the totals of those days alone.
    expect(h.calls).toEqual([
      "activity 2026-10-13..2026-10-15 values=worn days=2026-10-13..2026-10-15",
      "activity 2026-10-13..2026-10-15 values=total_calories days=2026-10-13,2026-10-15",
    ]);
    out = await coachSession(h).ok("metric_series", args("2026-10-12", "2026-10-15", "total_calories", "week"));
    expect(render(out)).toBe("2026-10-12=2600/3/-1");
    // Steps stay: they come from the band or the phone either way.
    out = await coachSession(h).ok("metric_series", args("2026-10-14", "2026-10-14", "steps"));
    expect(render(out)).toBe("2026-10-14=400/1");
    expect(out.quality_flags).toEqual([]);
  });

  it("reads no total calories at all when the band was never worn", async () => {
    // The Go server gives no reason for a day that has no total at all. This
    // server does not read the total of a day without the band, so it cannot
    // tell that day from one with a resting estimate: both are band_not_worn.
    const h = weeklyHealth();
    for (const d of ["2026-10-13", "2026-10-14", "2026-10-15"]) h.activityDays.delete(d);
    h.activityDays.set("2026-10-14", activityDay({ steps: 400, totalKcal: 1700, worn: false }));
    const out = await coachSession(h).ok("metric_series", args("2026-10-13", "2026-10-15", "total_calories"));
    expect(render(out)).toBe("2026-10-13=null/0/band_not_worn 2026-10-14=null/0/band_not_worn 2026-10-15=null/0/band_not_worn");
    expect(out.quality_flags).toEqual(["band_not_worn"]);
    expect(out.coverage.n_days).toBe(0);
    expect(h.calls).toEqual(["activity 2026-10-13..2026-10-15 values=worn days=2026-10-13..2026-10-15"]);
    // By week: the three days are left out for a reason.
    const week = await coachSession(h).ok("metric_series", args("2026-10-13", "2026-10-15", "total_calories", "week"));
    expect(render(week)).toBe("2026-10-12=null/0/-3");
  });

  it("keeps a worn day without a total as null, with no reason", async () => {
    const h = weeklyHealth();
    h.activityDays.set("2026-10-14", activityDay({ steps: 9000, azm: 20, worn: true }));
    const out = await coachSession(h).ok("metric_series", args("2026-10-13", "2026-10-15", "total_calories"));
    expect(render(out)).toBe("2026-10-13=2600/1 2026-10-14=null/0 2026-10-15=2600/1");
    expect(out.quality_flags).toEqual([]);
  });

  it("gives today no total, worn or not: the day is still running", async () => {
    const h = weeklyHealth();
    const today = async () => render(await coachSession(h).ok("metric_series", args("2026-10-15", COACH_TODAY, "total_calories")));
    expect(await today()).toBe("2026-10-15=2600/1 2026-10-16=null/0/partial_day");
    h.activityDays.delete(COACH_TODAY);
    expect(await today()).toBe("2026-10-15=2600/1 2026-10-16=null/0/partial_day");
  });

  it("raises unreadable_records for a row that either step of total_calories could not read", async () => {
    const h = weeklyHealth();
    h.activitySkipped = 1;
    const out = await coachSession(h).ok("metric_series", args("2026-10-13", "2026-10-15", "total_calories"));
    expect(out.quality_flags).toEqual(["unreadable_records"]);
  });

  it("follows nutrition_day's rule for each logged day", async () => {
    const h = weeklyHealth();
    // kcal missing on one item.
    h.nutritionDays.set("2026-10-12", foodDay("2026-10-12", food(12, "LUNCH", { kcal: 900, protein_g: 60 }), food(20, "DINNER", { protein_g: 40 })));
    let out = await coachSession(h).ok("metric_series", args("2026-10-08", "2026-10-12", "kcal_in"));
    // A day whose kcal would show a deficit that did not happen is null: food
    // from another platform (10-08), a log that looks incomplete (10-11) and a
    // partial kcal total (10-12).
    expect(render(out)).toBe(
      "2026-10-08=null/0/other_source_food 2026-10-09=2100/1 2026-10-10=2100/1 2026-10-11=null/0/log_likely_incomplete 2026-10-12=null/0/intake_partial",
    );
    expect(out.quality_flags).toEqual(["other_source_food_excluded"]);
    // Without a kcal target the log check needs the calories burned.
    expect(h.calls).toEqual(["nutrition 2026-10-08..2026-10-12", ...burnCalls("2026-10-08", "2026-10-12")]);

    // A partial protein total is shown as a lower bound, with the reason.
    out = await coachSession(h).ok("metric_series", args("2026-10-08", "2026-10-12", "protein_g"));
    expect(render(out)).toBe(
      "2026-10-08=130/1/partial/other_source_food 2026-10-09=50/1/partial/items_missing_protein " +
        "2026-10-10=160/1/partial/items_missing_protein 2026-10-11=30/1/partial/log_likely_incomplete " +
        "2026-10-12=100/1/partial/log_likely_incomplete",
    );
    expect(out.quality_flags).toEqual(["other_source_food_excluded", "partial_nutrient_totals"]);
    // (130·4 + 50 + 160 + 30) / 7
    out = await coachSession(h).ok("metric_series", args("2026-10-05", "2026-10-11", "protein_g", "week"));
    expect(render(out)).toBe("2026-10-05=108.6/7/partial");
    // (2200·3 + 2100·2) / 5; 10-08 and 10-11 are left out.
    out = await coachSession(h).ok("metric_series", args("2026-10-05", "2026-10-11", "kcal_in", "week"));
    expect(render(out)).toBe("2026-10-05=2160/5/-2");

    // Today's log is still growing: left out.
    h.nutritionDays.set(COACH_TODAY, fullDay(COACH_TODAY));
    for (const metric of ["protein_g", "kcal_in"]) {
      out = await coachSession(h).ok("metric_series", args("2026-10-15", COACH_TODAY, metric));
      expect(render(out), metric).toBe("2026-10-15=null/0 2026-10-16=null/0/partial_day");
      expect(out.quality_flags, metric).toEqual(["partial_day"]);
    }
  });

  it("reads no calories burned when every logged day has a kcal target", async () => {
    const h = weeklyHealth();
    const out = await coachSession(h, { targets: REPORT_TARGETS }).ok("metric_series", args("2026-10-09", "2026-10-11", "kcal_in"));
    // 10-11 is under half the 2000 kcal target.
    expect(render(out)).toBe("2026-10-09=2100/1 2026-10-10=2100/1 2026-10-11=null/0/log_likely_incomplete");
    expect(h.calls).toEqual(["nutrition 2026-10-09..2026-10-11"]);
  });

  it("reads the calories burned only over the logged days without a kcal target", async () => {
    const h = weeklyHealth();
    // A kcal target from 10-08: the logged days before it are 10-05 to 10-07.
    const targets = fakeTargets({ effective_from: "2026-10-08", kcal: 2000 });
    const out = await coachSession(h, { targets }).ok("metric_series", args("2026-09-20", "2026-10-11", "kcal_in", "week"));
    expect(h.calls).toEqual(["nutrition 2026-09-20..2026-10-11", ...burnCalls("2026-10-05", "2026-10-07")]);
    expect(render(out)).toBe("2026-09-14=null/0 2026-09-21=null/0 2026-09-28=null/0 2026-10-05=2160/5/-2");
  });

  it("takes the calories burned as the reference only on a day with the band", async () => {
    const h = weeklyHealth();
    // One lunch of 550 kcal: a main meal, so only the kcal check can call the log incomplete.
    h.nutritionDays.set("2026-10-11", foodDay("2026-10-11", food(12, "LUNCH", { kcal: 550, protein_g: 30 })));
    const point = async () => render(await coachSession(h).ok("metric_series", args("2026-10-11", "2026-10-11", "kcal_in")));
    // Under half the 2600 kcal burned.
    expect(await point()).toBe("2026-10-11=null/0/log_likely_incomplete");
    expect(h.calls).toEqual(["nutrition 2026-10-11..2026-10-11", ...burnCalls("2026-10-11", "2026-10-11")]);
    // Without the band the total is mostly a resting estimate: it is no
    // reference, and it is not read.
    h.calls = [];
    h.activityDays.set("2026-10-11", activityDay({ steps: 300, azm: 0, totalKcal: 2600, worn: false }));
    expect(await point()).toBe("2026-10-11=550/1");
    expect(h.calls).toEqual(["nutrition 2026-10-11..2026-10-11", "activity 2026-10-11..2026-10-11 values=worn days=2026-10-11"]);
  });

  it("reads total calories only for the days the band was worn", async () => {
    const h = weeklyHealth();
    // The band stays off the wrist on 10-06 and 10-07: these logged days have no burn to read.
    for (const d of ["2026-10-06", "2026-10-07"]) h.activityDays.set(d, activityDay({ steps: 300, totalKcal: 1700, worn: false }));
    const out = await coachSession(h).ok("metric_series", args("2026-10-05", "2026-10-11", "kcal_in"));
    expect(h.calls).toEqual([
      "nutrition 2026-10-05..2026-10-11",
      "activity 2026-10-05..2026-10-11 values=worn days=2026-10-05..2026-10-11",
      // The two days in the middle are left out of the read, not only of the result.
      "activity 2026-10-05..2026-10-11 values=total_calories days=2026-10-05,2026-10-08..2026-10-11",
    ]);
    expect(render(out)).toBe(
      "2026-10-05=2200/1 2026-10-06=2200/1 2026-10-07=2200/1 2026-10-08=null/0/other_source_food 2026-10-09=2100/1 2026-10-10=2100/1 2026-10-11=null/0/log_likely_incomplete",
    );
  });

  it("asks whether the band was worn only for the logged days without a kcal target", async () => {
    const h = weeklyHealth();
    // A kcal target on 10-08 and 10-09 only: the days before and after need the calories burned.
    const targets = fakeTargets({ effective_from: "2026-10-08", kcal: 2000 }, { effective_from: "2026-10-10", protein_g: 150 });
    await coachSession(h, { targets }).ok("metric_series", args("2026-10-05", "2026-10-11", "kcal_in"));
    const days = "2026-10-05..2026-10-07,2026-10-10..2026-10-11";
    expect(h.calls).toEqual([
      "nutrition 2026-10-05..2026-10-11",
      `activity 2026-10-05..2026-10-11 values=worn days=${days}`,
      `activity 2026-10-05..2026-10-11 values=total_calories days=${days}`,
    ]);
  });

  it("withholds every kcal total when a food record of the range is unreadable", async () => {
    const h = weeklyHealth();
    h.nutritionSkip = 1;
    // The unreadable record has no known day: any day may miss it.
    let out = await coachSession(h, { targets: REPORT_TARGETS }).ok("metric_series", args("2026-10-05", "2026-10-06", "kcal_in"));
    expect(render(out)).toBe("2026-10-05=null/0/unreadable_food 2026-10-06=null/0/unreadable_food");
    expect(out.quality_flags).toEqual(["unreadable_records"]);
    out = await coachSession(h, { targets: REPORT_TARGETS }).ok("metric_series", args("2026-10-05", "2026-10-06", "protein_g"));
    expect(render(out)).toBe("2026-10-05=130/1/partial/unreadable_food 2026-10-06=130/1/partial/unreadable_food");
  });

  it("bounds the range and the number of points", async () => {
    const c = coachSession(new FakeHealth());
    // 180 daily points pass, 181 do not.
    expect((await c.ok("metric_series", args("2026-04-20", "2026-10-16", "steps"))).data.points).toHaveLength(180);
    expect(await c.fails("metric_series", args("2026-04-19", "2026-10-16", "steps"))).toMatchObject({
      code: "invalid_input",
      message: "the series would have 181 points, more than 180",
      hint: "use granularity week or a shorter range",
    });
    // A year by week is 53 points; past 366 days the range is too long.
    expect((await c.ok("metric_series", args("2025-10-16", "2026-10-16", "steps", "week"))).data.points).toHaveLength(53);
    expect(await c.fails("metric_series", args("2025-10-15", "2026-10-16", "steps", "week")), "367 days").toMatchObject({
      code: "invalid_input",
      message: "a range spans at most 366 days",
      hint: "split it in two calls",
    });
    const reversed = await c.fails("metric_series", args("2026-10-10", "2026-10-09", "steps"));
    expect(reversed).toMatchObject({ code: "invalid_input", message: "from is after to" });
    expect(reversed).not.toHaveProperty("hint");
    expect(await c.fails("metric_series", args("2026-10-10", "2026-10-17", "steps")), "after today").toMatchObject({
      code: "invalid_input",
      message: "date is after today",
      hint: "omit date for today",
    });
    expect([MAX_SERIES_POINTS, MAX_RANGE_DAYS]).toEqual([180, 366]);
  });

  it("refuses arguments outside its input schema before it reads anything", async () => {
    const h = new FakeHealth();
    const c = coachSession(h);
    for (const bad of [
      { from: "2026-10-01", to: "2026-10-02" },
      { metric: "heart_rate", from: "2026-10-01", to: "2026-10-02" },
      { metric: "steps", to: "2026-10-02" },
      { metric: "steps", from: "2026-10-01" },
      { metric: "steps", from: "", to: "2026-10-02" },
      { metric: "steps", from: "2026-02-30", to: "2026-10-02" },
      { metric: "steps", from: "2026-10-01", to: "2026-10-02", granularity: "month" },
      { metric: "steps", from: "2026-10-01", to: "2026-10-02", points: 10 },
    ]) {
      expect(await c.fails("metric_series", bad), JSON.stringify(bad)).toMatchObject({ code: "invalid_input", schema: true });
    }
    expect(h.calls).toEqual([]);
  });

  it("hides a failing source behind internal_error, and passes its ToolError on", async () => {
    for (const [metric, method] of [
      ["weight", "body"],
      ["hrv", "recovery"],
      ["steps", "activity"],
      ["protein_g", "nutrition"],
      // The calories burned of a logged day without a kcal target.
      ["kcal_in", "activity"],
    ] as const) {
      const h = weeklyHealth();
      h.errs = { [method]: new Error("synthetic failure 7711") };
      const error = await coachSession(h).fails("metric_series", args("2026-10-01", "2026-10-10", metric));
      expect(error, metric).toMatchObject({ code: "internal_error", message: "unexpected internal error" });
      expect(error.text, metric).not.toContain("7711");
    }
    const failing = () => {
      throw new Error("synthetic failure 7711");
    };
    expect(await coachSession(weeklyHealth(), { targets: failing }).fails("metric_series", args("2026-10-01", "2026-10-10", "kcal_in"))).toMatchObject({
      code: "internal_error",
    });
    // The budget error of the Google Health client reaches the client as it is.
    const h = weeklyHealth();
    h.errs = { activity: new ToolError("invalid_input", "the date range holds more total-calories data than one call reads", "use a shorter date range") };
    expect(await coachSession(h).fails("metric_series", args("2026-10-01", "2026-10-10", "total_calories"))).toMatchObject({
      code: "invalid_input",
      message: "the date range holds more total-calories data than one call reads",
      hint: "use a shorter date range",
    });
  });

  it.each<[string, (h: FakeHealth) => void]>([
    ["steps", (h) => void (h.activitySkipped = 1)],
    ["weight", (h) => void (h.bodySkipped = 1)],
    ["hrv", (h) => void (h.recoveryExtra.skipped = 1)],
  ])("raises unreadable_records for %s", async (metric, set) => {
    const h = weeklyHealth();
    set(h);
    const out = await coachSession(h).ok("metric_series", args("2026-10-01", "2026-10-10", metric));
    expect(out.quality_flags).toContain("unreadable_records");
  });
});

describe("the metric_series definition", () => {
  const tool = COACH_TOOLS.find((one) => one.name === "metric_series");

  it("takes a closed metric list, two required days and an optional granularity", () => {
    expect(tool?.inputSchema.required).toEqual(["metric", "from", "to"]);
    expect(tool?.inputSchema.properties?.metric).toEqual({ type: "string", description: "the metric", enum: SERIES_METRICS });
    expect(tool?.inputSchema.properties?.granularity).toEqual({ type: ["null", "string"], description: "day (default) or week", enum: ["day", "week", null, ""] });
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  });

  it("promises no raw samples, and null for a missing day", () => {
    for (const phrase of ["at most 366 days, at most 180 points", "A day without a value is null, never 0", "Never raw heart-rate samples"]) {
      expect(tool?.description).toContain(phrase);
    }
  });
});

// R3: the text is a literal copy of the Go server's, and travels in every series.
describe("the series notice", () => {
  it("keeps the text word for word", () => {
    expect(SERIES_NOTICE).toBe(
      "Values compare the user with their own history; a series is not a diagnosis. A week point is the mean of the days with a value (n_days). Weight swings from day to day with water and food: read the trend over weeks, not single days. Do not encourage losing weight faster than about 1% of body weight per week or eating far below the targets. If weight falls fast without trying, intake stays very low, or resting heart rate stays up for days, suggest seeing a doctor (a registered dietitian for eating).",
    );
  });

  it.each(["not a diagnosis", "1% of body weight", "doctor", "dietitian", "swings"])("keeps %j", (phrase) => {
    expect(SERIES_NOTICE).toContain(phrase);
  });

  it("says nothing about a medication or a supplement", () => {
    expect(SERIES_NOTICE).not.toMatch(/\b(take|start|stop|dose|medication|supplement)\b/i);
  });
});
