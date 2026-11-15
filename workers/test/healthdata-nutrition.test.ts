// Ports of internal/healthdata/nutrition_test.go: the food log.
import { describe, expect, it } from "vitest";

import {
  NUTRIENTS,
  NUTRIENT_CARB,
  NUTRIENT_FAT,
  NUTRIENT_FIBER,
  NUTRIENT_KCAL,
  NUTRIENT_PROTEIN,
  NUTRIENT_SODIUM,
  type Nutrient,
  dayComplete,
} from "../src/healthdata";
import { ALGO_VERSION } from "../src/metrics/stats";
import { METRIC_KEYS, metricRange } from "../src/store/metrics";
import { at, foodRec, harness, inStore, newData, render } from "./healthdata-helpers";

const h = harness();

const D10 = "2026-10-10";
const unavailable = () => Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });

describe("nutrition", () => {
  it("lists the nutrients in report order", () => {
    expect(NUTRIENTS).toEqual(["kcal", "protein_g", "carb_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg"]);
  });

  it("totals each nutrient over the items that report it", () =>
    inStore(async (db) => {
      h.google.add(
        "nutrition-log",
        foodRec(at(D10, 12, 30), {
          meal: "LUNCH",
          kcal: 600,
          carb: 70,
          fat: 20,
          // The list repeats the carbs and adds a fat subtype: neither is added again.
          list: { PROTEIN: 40, CARBOHYDRATES: 70, SATURATED_FAT: 6, SODIUM: 0.8, VITAMIN_C: 0.01 },
        }),
        foodRec(at(D10, 8, 0), { meal: "BREAKFAST", kcal: 300, carb: 40, fat: 8 }),
        foodRec(at(D10, 16, 0), { meal: "SNACK", kcal: 0, carb: 0, fat: 0 }), // black coffee
      );
      const n = await newData(db).nutrition(D10, D10);
      const day = n.days.get(D10);
      expect(day?.items.map((item) => item.meal)).toEqual(["BREAKFAST", "LUNCH", "SNACK"]);
      expect(day?.partial).toBe(false);
      expect(day?.totals).toEqual({
        [NUTRIENT_KCAL]: { value: 900, items: 3 },
        [NUTRIENT_CARB]: { value: 110, items: 3 },
        [NUTRIENT_FAT]: { value: 28, items: 3 },
        [NUTRIENT_PROTEIN]: { value: 40, items: 1 }, // protein in 1 of 3 items: a partial total
        [NUTRIENT_SODIUM]: { value: 800, items: 1 },
      });
      expect(dayComplete(day, NUTRIENT_KCAL)).toBe(true);
      expect(dayComplete(day, NUTRIENT_PROTEIN)).toBe(false);
      // A nutrient no item reports has no total.
      expect(dayComplete(day, NUTRIENT_FIBER)).toBe(false);
      expect(dayComplete(undefined, NUTRIENT_KCAL)).toBe(false);
      expect(dayComplete({ items: [], totals: {}, rejected: 0, partial: false }, NUTRIENT_KCAL)).toBe(false);
      expect(day?.items[1]).toEqual({
        id: `users/me/dataTypes/nutrition-log/dataPoints/syn-${at(D10, 12, 30).getTime() / 1000}`,
        name: "Synthetic food",
        meal: "LUNCH",
        at: at(D10, 12, 30),
        source: "FITBIT",
        nutrients: { kcal: 600, carb_g: 70, fat_g: 20, protein_g: 40, sodium_mg: 800 },
        rejected: [],
      });
      // Series only carry complete totals: protein known for 1 of 3 items
      // would read as a low day.
      expect(render(n.series(NUTRIENT_PROTEIN))).toBe("2026-10-10=nil ");
      expect(render(n.series(NUTRIENT_KCAL))).toBe("2026-10-10=900 ");
      expect(render(n.series(NUTRIENT_FIBER))).toBe("2026-10-10=nil ");
      expect(() => n.series("alcohol_g" as Nutrient)).toThrow("healthdata: no such nutrient");
    }));

  it("places items on their local day and marks today partial", () =>
    inStore(async (db) => {
      h.google.loose = true;
      h.google.add(
        "nutrition-log",
        foodRec(at("2026-10-13", 23, 50), { kcal: 200 }), // before the range
        foodRec(at("2026-10-15", 23, 50), { kcal: 200 }),
        foodRec(at("2026-10-16", 0, 10), { kcal: 300 }),
        foodRec(at("2026-10-14", 12, 0), { kcal: 700, meal: "DINNER" }),
        foodRec(at("2026-10-14", 13, 0), { kcal: 100, platform: "HEALTH_KIT" }),
        foodRec(at("2026-10-14", 14, 0), { kcal: 20_000, carb: 30 }), // implausible kcal, carbs kept
        foodRec(at("2026-10-17", 0, 30), { kcal: 400 }), // the margin day after
        { nutritionLog: {} },
      );
      const data = newData(db);
      const n = await data.nutrition("2026-10-14", "2026-10-16");
      expect([...n.days.keys()]).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
      expect(n).toMatchObject({ otherSource: 1, skipped: 1 });
      expect([...n.otherSourceDays]).toEqual([["2026-10-14", 1]]);
      // The implausible kcal is dropped alone: the item and its carbs stay,
      // and the day's kcal is no longer complete.
      const d14 = n.days.get("2026-10-14");
      expect(d14?.items).toHaveLength(2);
      expect(d14?.rejected).toBe(1);
      expect(dayComplete(d14, NUTRIENT_KCAL)).toBe(false);
      expect(d14?.totals[NUTRIENT_CARB]).toEqual({ value: 30, items: 1 });
      expect(d14?.totals[NUTRIENT_KCAL]).toEqual({ value: 700, items: 1 });
      expect(d14?.items[1]?.rejected).toEqual(["kcal"]);
      // Only today is partial.
      expect([...n.days].map(([date, day]) => [date, day.partial])).toEqual([
        ["2026-10-14", false],
        ["2026-10-15", false],
        ["2026-10-16", true],
      ]);
      expect(render(n.series(NUTRIENT_KCAL))).toBe("2026-10-14=nil 2026-10-15=200 2026-10-16=300 ");
      expect(render(n.baselineSeries(NUTRIENT_KCAL))).toBe("2026-10-14=nil 2026-10-15=200 2026-10-16=nil ");
      expect(h.google.takeCalls()).toEqual(["nutrition-log 2026-10-13..2026-10-17"]);
      expect(h.warnings()).toEqual([["unreadable nutrition records", { from: "2026-10-14", to: "2026-10-16", skipped: 1 }]]);
      await expect(data.nutrition("2026-10-14", "2026-10-13")).rejects.toThrow(/^healthdata: range ends/);
      h.google.fail = unavailable;
      await expect(data.nutrition("2026-10-14", "2026-10-14")).rejects.toMatchObject({ code: "upstream_unavailable" });
    }));

  it("keeps the API's order for items logged at the same instant", () =>
    inStore(async (db) => {
      const names = ["first", "second", "third"];
      for (const name of names) {
        const record = foodRec(at(D10, 12, 0), { kcal: 100 });
        record.nutritionLog.foodDisplayName = name;
        h.google.add("nutrition-log", record);
      }
      const n = await newData(db).nutrition(D10, D10);
      expect(n.days.get(D10)?.items.map((item) => item.name)).toEqual(names);
    }));

  it("is never cached", () =>
    inStore(async (db) => {
      h.google.add("nutrition-log", foodRec(at(D10, 12, 0), { kcal: 500 }));
      const data = newData(db);
      await data.nutrition(D10, D10);
      h.google.takeCalls();
      await data.nutrition(D10, D10);
      // The log is edited for days after the fact: a settled day is fetched again.
      expect(h.google.takeCalls()).toEqual(["nutrition-log 2026-10-09..2026-10-11"]);
      for (const key of METRIC_KEYS) expect(metricRange(db, key, D10, D10, ALGO_VERSION), key).toEqual([]);
    }));
});
