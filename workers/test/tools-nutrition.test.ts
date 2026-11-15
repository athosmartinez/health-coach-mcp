// Ports of internal/tools/nutrition_test.go. Each test serves nutrition_day
// over a synthetic health source, with "now" at 2026-10-16 08:00 in São Paulo.
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalDate } from "../src/coach/date";
import { type ActivityDay, NUTRIENTS } from "../src/healthdata";
import { MAX_FOOD_ITEMS, NUTRITION_DAY, NUTRITION_NOTICE, STALE_WEIGHT_DAYS, checkFood, kcalGap, totalsOf, weightAge } from "../src/tools/nutrition";
import { COACH_TODAY, FakeHealth, type FoodSpec, activityDay, coachSession, fakeTargets, food, foodDay, fullDay, target } from "./coach-helpers";

// All values below are synthetic.

const CLOSED_DAY: LocalDate = "2026-10-14";

function nutritionHealth(): FakeHealth {
  const h = new FakeHealth();
  h.nutritionDays.set(CLOSED_DAY, fullDay(CLOSED_DAY));
  h.activityDays.set(CLOSED_DAY, activityDay({ totalKcal: 2600, worn: true }));
  h.activityDays.set(COACH_TODAY, activityDay({ totalKcal: 1500, worn: true, partial: true }));
  h.weight.set("2026-10-13", { at: undefined, value: 80, source: "Synthetic scale" });
  return h;
}

const nutritionTarget = fakeTargets({ effective_from: "2026-10-01", kcal: 2000, protein_g: 150 });

let errorLog: MockInstance;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const closed = (h: FakeHealth, targets = nutritionTarget) => coachSession(h, { targets }).ok("nutrition_day", { date: CLOSED_DAY });
const withFood = (...specs: FoodSpec[]): FakeHealth => {
  const h = nutritionHealth();
  h.nutritionDays.set(CLOSED_DAY, foodDay(CLOSED_DAY, ...specs));
  return h;
};
const mealsOf = (data: Record<string, any>): string[] => data.per_meal.map((meal: any) => `${meal.meal_type}x${meal.items.length}`);

describe("nutrition_day", () => {
  it("reviews a closed day", async () => {
    const h = nutritionHealth();
    const out = await closed(h);
    const data = out.data;
    expect(data).toMatchObject({ date: CLOSED_DAY, items_logged: 4, items_omitted: 0 });
    expect(data.totals).toEqual({
      kcal: { value: 2200, items_reporting: 4, complete: true },
      protein_g: { value: 130, items_reporting: 4, complete: true },
      carb_g: { value: 240, items_reporting: 4, complete: true },
      fat_g: { value: 68, items_reporting: 4, complete: true },
      fiber_g: { value: 10, items_reporting: 1, complete: false },
      // A nutrient no item reports is unknown, not zero.
      sugar_g: null,
      sodium_mg: null,
    });

    expect(data.per_meal.map((meal: any) => meal.meal_type)).toEqual(["BREAKFAST", "LUNCH", "DINNER", "SNACK"]);
    const lunch = data.per_meal[1];
    expect(lunch.totals.kcal.value).toBe(800);
    expect(lunch.items[0]).toEqual({
      name: "Synthetic food 1",
      time: "2026-10-14T12:00:00-03:00",
      nutrients: { kcal: 800, protein_g: 50, carb_g: 90, fat_g: 25, fiber_g: 10, sugar_g: null, sodium_mg: null },
      rejected_nutrients: [],
    });

    expect(data.targets).toEqual({
      effective_from: "2026-10-01",
      kcal_target: 2000,
      kcal_delta: 200,
      protein_g_target: 150,
      protein_g_delta: -20,
      protein_g_per_kg: 1.63,
      protein_g_lower_bound: false,
      weight_kg: 80,
      weight_date: "2026-10-13",
      weight_age_days: 1,
      // No target_hint and no kcal_delta_unavailable with a full day and a target.
    });
    expect(data.energy_balance).toEqual({ intake_kcal: 2200, total_calories_kcal: 2600, balance_kcal: -400 });
    expect(data.logging_completeness).toEqual({ meals_logged: 4, has_main_meal: true, likely_incomplete: false, kcal_pct_of_target: 110 });
    // Fiber in one item only is visible in its total; only kcal and protein
    // raise the flag, since targets and the balance read them.
    expect(out.quality_flags).toEqual([]);
    expect(out.sources).toEqual(["Google Fitbit Air", "Synthetic scale"]);
    expect(out.coverage).toEqual({ n_days: 1, confidence: "low" });
    expect(data.notice).toBe(NUTRITION_NOTICE);
    // The balance reads total calories and the worn flag only, and the body only the weight.
    expect(h.calls).toEqual([
      "nutrition 2026-10-14..2026-10-14",
      "activity 2026-10-14..2026-10-14 values=total_calories,worn",
      "body 2026-07-17..2026-10-14 values=weight",
    ]);
  });

  it.each([
    ["no store", undefined],
    ["never set", fakeTargets()],
  ])("reports targets as not set: %s", async (_name, targets) => {
    const out = await coachSession(nutritionHealth(), { targets }).ok("nutrition_day", { date: CLOSED_DAY });
    const tg = out.data.targets;
    expect(tg).toMatchObject({ effective_from: null, kcal_target: null, kcal_delta: null, protein_g_target: null, protein_g_delta: null });
    // Intake per kilogram does not need a target.
    expect(tg.protein_g_per_kg).toBe(1.63);
    expect(tg.target_hint).toBe("No kcal or protein target is set. Ask the user and, once they confirm, record it with targets_set.");
    expect(out.data.logging_completeness).toMatchObject({ kcal_pct_of_target: null, likely_incomplete: false });
  });

  it("uses the target in force on the day", async () => {
    const h = nutritionHealth();
    h.nutritionDays.set("2026-10-12", fullDay("2026-10-12"));
    const c = coachSession(h, {
      targets: fakeTargets(
        { effective_from: "2026-10-01", kcal: 2000, protein_g: 150 },
        { effective_from: "2026-10-13", kcal: 2400 }, // protein dropped from the new version
      ),
    });
    const monday = (await c.ok("nutrition_day", { date: "2026-10-12" })).data.targets;
    expect(monday).toMatchObject({ effective_from: "2026-10-01", kcal_delta: 200, protein_g_delta: -20 });
    const wednesday = (await c.ok("nutrition_day", { date: CLOSED_DAY })).data.targets;
    expect(wednesday).toMatchObject({ effective_from: "2026-10-13", kcal_delta: -200, protein_g_target: null, protein_g_delta: null });
    expect(wednesday.target_hint).toBe("No protein target is in force on that day. Ask the user and, once they confirm, record it with targets_set.");
  });

  it("gives a lower bound for protein when an item lacks it", async () => {
    const out = await closed(
      withFood(food(8, "BREAKFAST", { kcal: 500, protein_g: 30 }), food(12, "LUNCH", { kcal: 800, protein_g: 50 }), food(20, "DINNER", { kcal: 700 })),
    );
    const data = out.data;
    expect(data.totals.protein_g).toEqual({ value: 80, items_reporting: 2, complete: false });
    // Items without protein are mostly low-kcal ones: the partial total is a
    // lower bound, not a missing value.
    expect(data.targets).toMatchObject({ protein_g_delta: -70, protein_g_per_kg: 1, protein_g_lower_bound: true, kcal_delta: 0 });
    expect(data.energy_balance.balance_kcal).toBe(-600);
    expect(out.quality_flags).toContain("partial_nutrient_totals");
  });

  it("leaves the kcal delta and the balance null when an item lacks kcal", async () => {
    const out = await closed(withFood(food(12, "LUNCH", { kcal: 1200, protein_g: 50 }), food(20, "DINNER", { protein_g: 40 }, ["kcal"])));
    const data = out.data;
    expect(data.energy_balance).toEqual({ intake_kcal: null, total_calories_kcal: 2600, balance_kcal: null, unavailable: "intake_partial" });
    expect(data.targets).toMatchObject({
      kcal_delta: null,
      kcal_delta_unavailable: "intake_partial",
      protein_g_delta: -60,
      protein_g_lower_bound: false,
    });
    // The partial kcal still counts toward the logging check: 1200 of 2000.
    expect(data.logging_completeness.kcal_pct_of_target).toBe(60);
    expect(data.per_meal[1].items[0].rejected_nutrients).toEqual(["kcal"]);
    expect(out.quality_flags).toContain("partial_nutrient_totals");
    expect(out.quality_flags).toContain("rejected_nutrient_values");
  });

  it("marks a day of snacks only as likely incomplete", async () => {
    const out = await closed(withFood(food(10, "SNACK", { kcal: 300, protein_g: 20 }), food(15, "SNACK", { kcal: 250, protein_g: 10 })));
    const data = out.data;
    expect(data.logging_completeness).toEqual({ meals_logged: 1, has_main_meal: false, likely_incomplete: true, kcal_pct_of_target: 27.5 });
    // The intake behind a likely incomplete log is too low: its balance would
    // read as a large deficit.
    expect(data.energy_balance).toEqual({
      intake_kcal: 550,
      total_calories_kcal: 2600,
      balance_kcal: null,
      unavailable: "log_likely_incomplete",
    });
    expect(data.targets).toMatchObject({ kcal_delta: null, kcal_delta_unavailable: "log_likely_incomplete" });
    expect(out.quality_flags).toContain("likely_incomplete_nutrition");
    expect(out.quality_flags).not.toContain("partial_day");
  });

  it("treats today as a partial day", async () => {
    const h = nutritionHealth();
    h.nutritionDays.set(COACH_TODAY, foodDay(COACH_TODAY, food(7, "SNACK", { kcal: 200, protein_g: 10 })));
    const out = await coachSession(h, { targets: nutritionTarget }).ok("nutrition_day");
    const data = out.data;
    expect(data.date).toBe(COACH_TODAY);
    // The day is not over: no main meal yet is not a failure.
    expect(data.logging_completeness).toMatchObject({ likely_incomplete: false, has_main_meal: false, kcal_pct_of_target: 10 });
    // Intake and burn are running totals: no deficit until the day closes.
    expect(data.energy_balance).toEqual({ intake_kcal: 200, total_calories_kcal: 1500, balance_kcal: null, unavailable: "partial_day" });
    expect(data.targets).toMatchObject({ kcal_delta: null, kcal_delta_unavailable: "partial_day" });
    expect(out.quality_flags).toContain("partial_day");
    expect(out.quality_flags).not.toContain("likely_incomplete_nutrition");
  });

  it.each<[string, Partial<ActivityDay> | undefined]>([
    ["not worn", { totalKcal: 1700 }],
    ["no activity", undefined],
  ])("gives no balance for a day off the wrist: %s", async (_name, day) => {
    const h = nutritionHealth();
    h.activityDays.clear();
    if (day) h.activityDays.set(CLOSED_DAY, activityDay(day));
    const out = await closed(h);
    // Without the band, total calories is mostly a resting estimate.
    expect(out.data.energy_balance).toEqual({ intake_kcal: 2200, total_calories_kcal: null, balance_kcal: null, unavailable: "band_not_worn" });
    expect(out.quality_flags).toContain("band_not_worn");
  });

  it("does not read an unreadable activity row as a day off the wrist", async () => {
    const h = nutritionHealth();
    h.activityDays.clear();
    h.activitySkipped = 1;
    const out = await closed(h);
    expect(out.data.energy_balance.unavailable).toBe("no_total_calories");
    expect(out.quality_flags).not.toContain("band_not_worn");
    expect(out.quality_flags).toContain("unreadable_records");
  });

  it("names a worn day without total calories", async () => {
    const h = nutritionHealth();
    // A worn day has zone minutes, 0 without a row, as healthdata gives it.
    h.activityDays.set(CLOSED_DAY, activityDay({ azm: 0, worn: true }));
    expect((await closed(h)).data.energy_balance).toEqual({
      intake_kcal: 2200,
      total_calories_kcal: null,
      balance_kcal: null,
      unavailable: "no_total_calories",
    });
  });

  it("keeps the protein delta without a weight", async () => {
    const h = nutritionHealth();
    h.weight.clear();
    expect((await closed(h)).data.targets).toMatchObject({
      protein_g_per_kg: null,
      weight_kg: null,
      weight_date: null,
      weight_age_days: null,
      protein_g_delta: -20,
    });
  });

  it("orders the meals: the four known types, other types, then UNSPECIFIED", async () => {
    const kcal = { kcal: 100 };
    const data = (
      await closed(
        withFood(
          food(6, "SNACK", kcal),
          food(7, "", kcal),
          food(8, "BRUNCH", kcal),
          food(9, "DINNER", kcal),
          food(10, "BREAKFAST", kcal),
          food(11, "AFTERNOON", kcal),
          food(12, "SNACK", kcal),
        ),
      )
    ).data;
    expect(mealsOf(data)).toEqual(["BREAKFASTx1", "DINNERx1", "SNACKx2", "AFTERNOONx1", "BRUNCHx1", "UNSPECIFIEDx1"]);
    // Distinct meal types, the unspecified bucket included.
    expect(data.logging_completeness.meals_logged).toBe(6);
  });

  it("lists at most 60 items, with totals over all of them", async () => {
    const specs: FoodSpec[] = [];
    for (let i = 0; i < MAX_FOOD_ITEMS + 5; i++) specs.push(food(i % 24, i % 2 === 1 ? "SNACK" : "LUNCH", { kcal: 10, protein_g: 1 }));
    const out = await closed(withFood(...specs));
    const data = out.data;
    expect(MAX_FOOD_ITEMS).toBe(60);
    const listed = data.per_meal.reduce((sum: number, meal: any) => sum + meal.items.length, 0);
    expect(listed).toBe(MAX_FOOD_ITEMS);
    expect(data.items_omitted).toBe(5);
    expect(data.items_logged).toBe(MAX_FOOD_ITEMS + 5);
    // The items past the cap are counted in their own meal.
    expect(data.per_meal.map((meal: any) => meal.items_omitted)).toEqual([3, 2]);
    // Totals still cover every item.
    expect(data.totals.kcal.value).toBe(10 * (MAX_FOOD_ITEMS + 5));
    expect(data.per_meal[0].totals.kcal.value).toBe(10 * 33);
    expect(out.quality_flags).toContain("food_items_truncated");
  });

  it.each([
    ["nothing", 0, 0, "ask the user to log meals in the Fitbit app, or call again with another date"],
    ["other source", 0, 2, "food was logged only in another app (such as Apple Health); the coach reads the Fitbit food log"],
    ["unreadable", 1, 0, "some food records could not be read; call again later, and report it if it persists"],
    ["unreadable and other source", 1, 2, "some food records could not be read; call again later, and report it if it persists"],
  ])("answers no_data for a day without food: %s", async (_name, skipped, other, hint) => {
    const h = nutritionHealth();
    h.nutritionDays.clear();
    h.nutritionSkip = skipped;
    h.nutritionOther = other;
    const error = await coachSession(h, { targets: nutritionTarget }).fails("nutrition_day", { date: CLOSED_DAY });
    expect(error).toMatchObject({ code: "no_data", message: "no food logged on that day", hint });
    // Nothing else is read for a day without a log.
    expect(h.calls).toEqual(["nutrition 2026-10-14..2026-10-14"]);
  });

  it("answers no_data for a logged day without items", async () => {
    const h = nutritionHealth();
    h.nutritionDays.set(CLOSED_DAY, foodDay(CLOSED_DAY));
    expect((await coachSession(h).fails("nutrition_day", { date: CLOSED_DAY })).code).toBe("no_data");
  });

  it.each([
    ["both", 1, 1, "other_source_food"],
    ["other source", 0, 1, "other_source_food"],
    ["unreadable", 1, 0, "unreadable_food"],
  ])("gives no balance when food is missing from the log: %s", async (_name, skipped, other, reason) => {
    const h = nutritionHealth();
    h.nutritionSkip = skipped;
    h.nutritionOther = other;
    const out = await closed(h);
    // Food missing from the log would read as a deficit.
    expect(out.data.energy_balance).toMatchObject({ balance_kcal: null, unavailable: reason });
    expect(out.data.targets).toMatchObject({ kcal_delta: null, kcal_delta_unavailable: reason });
    expect(out.quality_flags.includes("unreadable_records")).toBe(skipped > 0);
    expect(out.quality_flags.includes("other_source_food_excluded")).toBe(other > 0);
  });

  it("flags an unreadable weight record", async () => {
    const h = nutritionHealth();
    h.bodySkipped = 1;
    expect((await closed(h)).quality_flags).toContain("unreadable_records");
  });

  it("rejects a date after today", async () => {
    const h = nutritionHealth();
    const error = await coachSession(h, { targets: nutritionTarget }).fails("nutrition_day", { date: "2026-10-17" });
    expect(error).toMatchObject({ code: "invalid_input", message: "date is after today" });
    expect(h.calls).toEqual([]);
  });

  it.each(["nutrition", "activity", "body"])("hides an unexpected error of the %s source behind internal_error", async (method) => {
    const h = nutritionHealth();
    h.errs[method] = new Error("synthetic failure: Synthetic food 1");
    const error = await coachSession(h, { targets: nutritionTarget }).fails("nutrition_day", { date: CLOSED_DAY });
    expect(error.text).toBe('{"code":"internal_error","message":"unexpected internal error"}');
    expect(errorLog.mock.calls).toEqual([["tool_internal_error", { tool: "nutrition_day", error_types: "Error" }]]);
  });

  it("answers internal_error for a failing target store", async () => {
    const failing = () => {
      throw new Error("synthetic failure");
    };
    const error = await coachSession(nutritionHealth(), { targets: failing }).fails("nutrition_day", { date: CLOSED_DAY });
    expect(error.code).toBe("internal_error");
  });

  describe("the reason a balance is unavailable", () => {
    const snacks = (kcalOnEveryItem: boolean) =>
      foodDay(
        CLOSED_DAY,
        food(10, "SNACK", { kcal: 300, protein_g: 20 }),
        food(15, "SNACK", kcalOnEveryItem ? { protein_g: 10, kcal: 250 } : { protein_g: 10 }),
      );

    it.each<[string, boolean, Partial<ActivityDay>, number, string]>([
      ["partial intake over not worn", false, { totalKcal: 1700 }, 0, "intake_partial"],
      ["partial intake over incomplete log", false, { totalKcal: 2600, worn: true }, 0, "intake_partial"],
      ["other source over not worn", true, { totalKcal: 1700 }, 1, "other_source_food"],
      ["not worn over incomplete log", true, { totalKcal: 1700 }, 0, "band_not_worn"],
      ["no burn over incomplete log", true, { azm: 0, worn: true }, 0, "no_total_calories"],
    ])("follows the fixed order: %s", async (_name, kcalOnEveryItem, day, other, want) => {
      const h = nutritionHealth();
      h.nutritionDays.set(CLOSED_DAY, snacks(kcalOnEveryItem));
      h.activityDays.set(CLOSED_DAY, activityDay(day));
      h.nutritionOther = other;
      expect((await closed(h)).data.energy_balance.unavailable).toBe(want);
    });
  });

  it("checks a small log against half the calories burned without a kcal target", async () => {
    // One coffee logged as breakfast passes the main-meal check.
    const out = await coachSession(withFood(food(8, "BREAKFAST", { kcal: 30, protein_g: 1 }))).ok("nutrition_day", { date: CLOSED_DAY });
    const data = out.data;
    expect(data.logging_completeness).toMatchObject({ likely_incomplete: true, kcal_pct_of_target: null });
    expect(data.energy_balance).toMatchObject({ balance_kcal: null, unavailable: "log_likely_incomplete" });
    // Without a target there is no delta, so no reason for one either.
    expect(data.targets).not.toHaveProperty("kcal_delta_unavailable");
    expect(out.quality_flags).toContain("likely_incomplete_nutrition");
    // The full day stays complete without a target: 2200 of 2600 burned.
    const full = (await coachSession(nutritionHealth()).ok("nutrition_day", { date: CLOSED_DAY })).data;
    expect(full.logging_completeness.likely_incomplete).toBe(false);
    expect(full.energy_balance.balance_kcal).toBe(-400);
  });

  it("keeps protein null when no item reports it", async () => {
    const out = await closed(withFood(food(12, "LUNCH", { kcal: 1100 }), food(20, "DINNER", { kcal: 1000 })));
    const data = out.data;
    expect(data.totals.protein_g).toBeNull();
    expect(data.targets).toMatchObject({ protein_g_delta: null, protein_g_per_kg: null, protein_g_lower_bound: false, kcal_delta: 100 });
    expect(out.quality_flags).toContain("partial_nutrient_totals");
  });

  it.each([
    ["protein only", { effective_from: "2026-10-01", protein_g: 150 }, "No kcal target is in force on that day.", true],
    ["neither", { effective_from: "2026-10-01", weekly_sessions: 4 }, "No kcal or protein target is in force on that day.", false],
  ])("names the targets that are not in force: %s", async (_name, version, hint, proteinDelta) => {
    const out = await closed(nutritionHealth(), fakeTargets(version));
    const tg = out.data.targets;
    expect(tg.target_hint).toBe(`${hint} Ask the user and, once they confirm, record it with targets_set.`);
    expect(tg).toMatchObject({ kcal_target: null, kcal_delta: null });
    expect(out.data.logging_completeness.kcal_pct_of_target).toBeNull();
    expect(tg.protein_g_delta !== null).toBe(proteinDelta);
  });

  it("rounds to one decimal, the balance to 50 kcal and protein per kg to two", async () => {
    const h = withFood(food(12, "LUNCH", { kcal: 1100.04, protein_g: 0.1 }), food(20, "DINNER", { kcal: 1000.06, protein_g: 0.2 }));
    h.activityDays.set(CLOSED_DAY, activityDay({ totalKcal: 2626.4, worn: true }));
    h.weight.clear();
    h.weight.set("2026-10-13", { at: undefined, value: 80.04, source: "" });
    const data = (await closed(h)).data;
    expect(data.totals.kcal.value).toBe(2100.1);
    expect(data.totals.protein_g.value).toBe(0.3);
    expect(data.per_meal[0].items[0].nutrients.kcal).toBe(1100);
    expect(data.targets).toMatchObject({ kcal_delta: 100.1, protein_g_delta: -149.7, weight_kg: 80 });
    // The nearest 50; the balance is 2100.1 − 2626.4 = −526.3.
    expect(data.energy_balance).toMatchObject({ total_calories_kcal: 2650, balance_kcal: -550 });
    expect(data.logging_completeness.kcal_pct_of_target).toBe(105);
  });

  it("writes an item's time in the coach's zone", async () => {
    // The API sends UTC instants: 15:00 UTC is 12:00 in São Paulo.
    const h = nutritionHealth();
    const day = fullDay(CLOSED_DAY);
    expect(day.items[1]?.at.toISOString()).toBe("2026-10-14T15:00:00.000Z");
    h.nutritionDays.set(CLOSED_DAY, day);
    expect((await closed(h)).data.per_meal[1].items[0].time).toBe("2026-10-14T12:00:00-03:00");
  });

  it("groups meal types by their normalized spelling", async () => {
    const kcal = { kcal: 100 };
    const data = (
      await closed(
        withFood(
          food(8, "lunch", kcal),
          food(9, " LUNCH ", kcal),
          food(10, "Late snack", kcal),
          food(11, "LATE-SNACK", kcal),
          food(12, "ZZZ", kcal),
          food(13, "  ", kcal),
        ),
      )
    ).data;
    expect(mealsOf(data)).toEqual(["LUNCHx2", "LATE_SNACKx2", "ZZZx1", "UNSPECIFIEDx1"]);
  });

  it("has a slot for every nutrient and for no other", async () => {
    const properties = (schema: unknown) => Object.keys((schema as { properties: object }).properties);
    const data = NUTRITION_DAY.tool.outputSchema.properties?.data?.properties;
    expect(properties(data?.totals)).toEqual([...NUTRIENTS]);
    const item = data?.per_meal?.items?.properties?.items?.items?.properties?.nutrients;
    expect(properties(item)).toEqual([...NUTRIENTS]);
    // An unknown nutrient of an item is left out, not an error.
    const h = withFood(food(12, "LUNCH", { kcal: 500, alcohol_g: 12 } as never));
    const out = (await closed(h)).data;
    expect(Object.keys(out.totals)).toEqual([...NUTRIENTS]);
    expect(Object.keys(out.per_meal[0].items[0].nutrients)).toEqual([...NUTRIENTS]);
  });

  it.each([
    ["2026-09-30", 14, false],
    ["2026-09-29", 15, true],
  ])("raises stale_weight past 14 days: weighed on %s", async (weighed, age, stale) => {
    const h = nutritionHealth();
    h.weight.clear();
    h.weight.set(weighed, { at: undefined, value: 80, source: "" });
    const out = await closed(h);
    expect(STALE_WEIGHT_DAYS).toBe(14);
    expect(out.data.targets.weight_age_days).toBe(age);
    expect(out.quality_flags.includes("stale_weight")).toBe(stale);
  });
});

describe("checkFood, the day rule shared with weekly_report", () => {
  const items = (...specs: FoodSpec[]) => foodDay(CLOSED_DAY, ...specs).items;
  const full = fullDay(CLOSED_DAY).items;
  const kcalTarget = target({ effective_from: "2026-10-01", kcal: 2000 });

  it("judges a complete day", () => {
    const check = checkFood(full, 0, 0, kcalTarget, 2600, false);
    expect(check).toEqual({
      kcal: 2200,
      protein: 130,
      proteinComplete: true,
      logging: { likely_incomplete: false, has_main_meal: true, kcal_pct_of_target: 110.00000000000001 },
      intakeGap: "",
      dayGap: "",
    });
    expect(kcalGap(check)).toBe("");
  });

  it.each<[string, Parameters<typeof checkFood>, string, string]>([
    ["an item lacks kcal", [items(food(12, "LUNCH", { kcal: 1200 }), food(20, "DINNER", {})), 3, 3, kcalTarget, 2600, false], "intake_partial", ""],
    ["an item lacks kcal in a small log", [items(food(12, "LUNCH", { kcal: 900 }), food(20, "DINNER", {})), 0, 0, kcalTarget, 2600, false], "intake_partial", "log_likely_incomplete"],
    ["food from another platform", [full, 1, 1, kcalTarget, 2600, false], "other_source_food", ""],
    ["unreadable food", [full, 0, 1, kcalTarget, 2600, false], "unreadable_food", ""],
    ["today", [full, 0, 0, kcalTarget, 2600, true], "", "partial_day"],
    ["a log under half the target", [items(food(12, "LUNCH", { kcal: 900 })), 0, 0, kcalTarget, 2600, false], "", "log_likely_incomplete"],
    ["today before an incomplete log", [items(food(12, "SNACK", { kcal: 100 })), 0, 0, kcalTarget, 2600, true], "", "partial_day"],
    ["under half the burn without a target", [items(food(8, "BREAKFAST", { kcal: 30 })), 0, 0, undefined, 2600, false], "", "log_likely_incomplete"],
    ["no target and no burn", [items(food(8, "BREAKFAST", { kcal: 30 })), 0, 0, undefined, null, false], "", ""],
    ["a target without kcal", [items(food(8, "BREAKFAST", { kcal: 30 })), 0, 0, target({ effective_from: "2026-10-01", protein_g: 150 }), 2600, false], "", "log_likely_incomplete"],
  ])("names the gap: %s", (_name, args, intakeGap, dayGap) => {
    const check = checkFood(...args);
    expect(check.intakeGap).toBe(intakeGap);
    expect(check.dayGap).toBe(dayGap);
    // The intake reason comes first.
    expect(kcalGap(check)).toBe(intakeGap || dayGap);
  });

  it("keeps a partial protein total as a lower bound", () => {
    const check = checkFood(items(food(12, "LUNCH", { kcal: 900, protein_g: 40 }), food(20, "DINNER", { kcal: 900 })), 0, 0, kcalTarget, 2600, false);
    expect(check).toMatchObject({ protein: 40, proteinComplete: false, kcal: 1800 });
    expect(checkFood(items(food(12, "LUNCH", { kcal: 900 })), 0, 0, kcalTarget, 2600, false)).toMatchObject({ protein: null, proteinComplete: false });
  });

  it("sums totals over the items that report a nutrient", () => {
    expect(totalsOf([]).kcal).toBeNull();
    expect(totalsOf(full).fiber_g).toEqual({ value: 10, items_reporting: 1, complete: false });
  });

  it("counts the days from a weigh-in to the day", () => {
    expect(weightAge("2026-10-14", "2026-10-14")).toBe(0);
    expect(weightAge("2026-09-30", "2026-10-14")).toBe(14);
    expect(weightAge("2025-12-31", "2026-01-01")).toBe(1);
  });
});
