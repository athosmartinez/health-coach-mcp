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
import { HealthData, dbCache } from "../src/healthdata";
import { parseFood } from "../src/healthdata/nutrition";
import { ALGO_VERSION } from "../src/metrics/stats";
import { recordEntry } from "../src/store/entries";
import { METRIC_KEYS, metricRange } from "../src/store/metrics";
import { SAO_PAULO } from "./memory-helpers";
import { DiskError, at, foodRec, harness, inStore, newClient, newData, render } from "./healthdata-helpers";

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

// The Go server has no such rule: it writes nothing to Google Health. An entry
// that nutrition_log_add created has the platform of the API (GOOGLE_WEB_API),
// and the food log keeps it when its data point id is in the table of the
// entries this server created.
describe("the food entries this server created", () => {
  const listed = (id: string) => `users/me/dataTypes/nutrition-log/dataPoints/${id}`;
  /** The name as the create answered it: under the user's ID. */
  const answered = (id: string) => `users/1122334455/dataTypes/nutrition-log/dataPoints/${id}`;
  /** A record written through the API, as a list returns it. */
  const viaApi = (hour: number, id: string, options: Parameters<typeof foodRec>[1] = {}) =>
    foodRec(at(D10, hour, 0), { ...options, platform: "GOOGLE_WEB_API", name: listed(id) });

  /** A band item, an item this server created and an item another app wrote through the API. */
  function threeSources(): void {
    h.google.add(
      "nutrition-log",
      foodRec(at(D10, 8, 0), { meal: "BREAKFAST", kcal: 300, list: { PROTEIN: 20 } }),
      viaApi(12, "syn-own-1", { meal: "LUNCH", kcal: 600, carb: 70, list: { PROTEIN: 40 } }),
      viaApi(19, "syn-other-app", { meal: "DINNER", kcal: 900, list: { PROTEIN: 50 } }),
    );
  }

  it("counts the band's item and the server's own item, and leaves the item of another app out", () =>
    inStore(async (db) => {
      threeSources();
      recordEntry(db, answered("syn-own-1"), D10);
      const n = await newData(db).nutrition(D10, D10);
      const day = n.days.get(D10);
      expect(day?.items.map((item) => [item.meal, item.source])).toEqual([
        ["BREAKFAST", "FITBIT"],
        ["LUNCH", "GOOGLE_WEB_API"],
      ]);
      // Totals over the two items.
      expect(day?.totals).toEqual({
        [NUTRIENT_KCAL]: { value: 900, items: 2 },
        [NUTRIENT_PROTEIN]: { value: 60, items: 2 },
        [NUTRIENT_CARB]: { value: 70, items: 1 },
      });
      expect(dayComplete(day, NUTRIENT_KCAL)).toBe(true);
      // The item of the other app is still "other source".
      expect(n.otherSource).toBe(1);
      expect([...n.otherSourceDays]).toEqual([[D10, 1]]);
      expect(n.skipped).toBe(0);
      expect(day?.items[1]).toEqual({
        id: listed("syn-own-1"),
        name: "Synthetic food",
        meal: "LUNCH",
        at: at(D10, 12, 0),
        source: "GOOGLE_WEB_API",
        nutrients: { kcal: 600, carb_g: 70, protein_g: 40 },
        rejected: [],
      });
      // One list request, as before: the table is read in the store.
      expect(h.google.takeRequests()).toEqual({ total: 1, "nutrition-log": 1 });
      expect(h.logged()).toBe("[]");
    }));

  it("gives the Go server's result for the same day without the row in the table", () =>
    inStore(async (db) => {
      threeSources();
      const n = await newData(db).nutrition(D10, D10);
      const day = n.days.get(D10);
      // Only the band's item: both items of the API are left out.
      expect(day?.items.map((item) => item.meal)).toEqual(["BREAKFAST"]);
      expect(day?.totals).toEqual({ [NUTRIENT_KCAL]: { value: 300, items: 1 }, [NUTRIENT_PROTEIN]: { value: 20, items: 1 } });
      expect(n.otherSource).toBe(2);
      expect([...n.otherSourceDays]).toEqual([[D10, 2]]);
    }));

  it("gives the Go server's result for a source that has no table", () =>
    inStore(async (db) => {
      threeSources();
      recordEntry(db, answered("syn-own-1"), D10);
      const { metricRange: range, putMetric, deleteMetric } = dbCache(db);
      const source = new HealthData(newClient(), { metricRange: range, putMetric, deleteMetric }, SAO_PAULO, () => new Date("2026-10-16T13:00:00Z"));
      const n = await source.nutrition(D10, D10);
      expect(n.days.get(D10)?.items).toHaveLength(1);
      expect(n.otherSource).toBe(2);
    }));

  it("knows an entry by its data point id, whatever the form of the user in its name", () =>
    inStore(async (db) => {
      // The table holds the name under `me`; the list names the user by an ID.
      h.google.add("nutrition-log", foodRec(at(D10, 12, 0), { kcal: 600, platform: "GOOGLE_WEB_API", name: answered("syn-own-2") }));
      recordEntry(db, listed("syn-own-2"), D10);
      const n = await newData(db).nutrition(D10, D10);
      expect(n.days.get(D10)?.items).toHaveLength(1);
      expect(n.otherSource).toBe(0);
    }));

  it.each([
    ["another data point id", listed("syn-own-10")],
    ["the id as a part of a longer id", listed("xsyn-own-1")],
    ["the same id under another data type", "users/me/dataTypes/hydration-log/dataPoints/syn-own-1"],
    ["the same id with one more path part", `${listed("syn-own-1")}/x`],
    ["the id without its path", "syn-own-1"],
    ["an empty name", ""],
  ])("leaves out a record of the API with %s", (_name, name) =>
    inStore(async (db) => {
      h.google.add("nutrition-log", foodRec(at(D10, 12, 0), { kcal: 600, platform: "GOOGLE_WEB_API", name }));
      recordEntry(db, answered("syn-own-1"), D10);
      const n = await newData(db).nutrition(D10, D10);
      expect(n.days.size).toBe(0);
      expect(n.otherSource).toBe(1);
    }));

  it("leaves out a record without a name, and one whose name is not a text is unreadable as before", () =>
    inStore(async (db) => {
      const unnamed = foodRec(at(D10, 12, 0), { kcal: 600, platform: "GOOGLE_WEB_API" });
      delete unnamed.name;
      const numbered = { ...foodRec(at(D10, 13, 0), { kcal: 100, platform: "GOOGLE_WEB_API" }), name: 7 };
      h.google.add("nutrition-log", unnamed, numbered);
      recordEntry(db, answered("syn-own-1"), D10);
      const n = await newData(db).nutrition(D10, D10);
      expect(n).toMatchObject({ otherSource: 1, skipped: 1 });
      expect(n.days.size).toBe(0);
    }));

  it("looks the entries up by their day, with one day of margin on each side", () =>
    inStore(async (db) => {
      h.google.add("nutrition-log", viaApi(12, "syn-near"), viaApi(13, "syn-far"));
      // Recorded on the day before the item's day (a changed time zone can move a day by one): still known.
      recordEntry(db, answered("syn-near"), "2026-10-09");
      // Recorded two days away: not looked up for this day.
      recordEntry(db, answered("syn-far"), "2026-10-12");
      const n = await newData(db).nutrition(D10, D10);
      expect(n.days.get(D10)?.items.map((item) => item.id)).toEqual([listed("syn-near")]);
      expect(n.otherSource).toBe(1);
    }));

  it("does not count an entry that was created for another Google account than the linked one", () =>
    inStore(async (db) => {
      threeSources();
      recordEntry(db, answered("syn-own-1"), D10);
      const relink = (sub: string) => db.all("UPDATE google_account SET sub = ? WHERE id = 1", sub);

      // Another account is linked: the entry of the account before is food of another source, as in the Go server.
      relink("200000000000000000002");
      const other = await newData(db).nutrition(D10, D10);
      expect(other.days.get(D10)?.items.map((item) => item.meal)).toEqual(["BREAKFAST"]);
      expect(other.otherSource).toBe(2);

      // The first account is linked again: its entry counts again.
      relink("100000000000000000001");
      const again = await newData(db).nutrition(D10, D10);
      expect(again.days.get(D10)?.items.map((item) => item.meal)).toEqual(["BREAKFAST", "LUNCH"]);
      expect(again.otherSource).toBe(1);
    }));

  it("still rejects an implausible value of an entry of its own", () =>
    inStore(async (db) => {
      h.google.add("nutrition-log", viaApi(12, "syn-own-1", { kcal: 20_000, carb: 30 }));
      recordEntry(db, answered("syn-own-1"), D10);
      const day = (await newData(db).nutrition(D10, D10)).days.get(D10);
      expect(day?.items[0]?.rejected).toEqual(["kcal"]);
      expect(day?.totals).toEqual({ [NUTRIENT_CARB]: { value: 30, items: 1 } });
    }));

  it("fails the read when the table cannot be read, and sends no request", () =>
    inStore(async (db) => {
      threeSources();
      const cache = {
        ...dbCache(db),
        createdFoodIds: () => {
          throw new DiskError();
        },
      };
      const source = new HealthData(newClient(), cache, SAO_PAULO, () => new Date("2026-10-16T13:00:00Z"));
      await expect(source.nutrition(D10, D10)).rejects.toThrow("healthdata: read created entries");
      expect(h.google.takeRequests()).toEqual({ total: 0 });
    }));

  it("parseFood keeps a record of another platform only when its id is one of the server's", () => {
    const record = viaApi(12, "syn-own-1", { kcal: 600 });
    expect(parseFood(record)).toEqual({ kind: "other", at: at(D10, 12, 0).getTime() });
    expect(parseFood(record, new Set())).toMatchObject({ kind: "other" });
    expect(parseFood(record, new Set(["syn-own-2"]))).toMatchObject({ kind: "other" });
    expect(parseFood(record, new Set(["syn-own-1"]))).toMatchObject({ kind: "item", item: { id: listed("syn-own-1"), source: "GOOGLE_WEB_API" } });
    // A record of the band needs no row.
    expect(parseFood(foodRec(at(D10, 12, 0), { kcal: 600 }), new Set())).toMatchObject({ kind: "item", item: { source: "FITBIT" } });
    // Another app's platform with an id of the server's: the id decides, not the platform.
    expect(parseFood(foodRec(at(D10, 12, 0), { kcal: 600, platform: "HEALTH_KIT", name: listed("syn-own-1") }), new Set(["syn-own-1"]))).toMatchObject({ kind: "item" });
  });
});
