// Ports of internal/healthdata/activity_test.go: daily activity totals, and
// weight and body fat.
import { describe, expect, it } from "vitest";

import { toWire } from "../src/coach/errors";
import {
  ACTIVITY_KEYS,
  type ActivityKey,
  type BodyKey,
  KEY_AZM,
  KEY_BODY_FAT,
  KEY_STEPS,
  KEY_TOTAL_CALORIES,
  KEY_WEIGHT,
  ROLLUP_SOURCE,
  last,
} from "../src/healthdata";
import { ALGO_VERSION } from "../src/metrics/stats";
import { metricRange, putMetric } from "../src/store/metrics";
import {
  DiskError,
  SP,
  activityWeek,
  at,
  azmRollup,
  bodyFatRec,
  failingCache,
  harness,
  inStore,
  kcalRollup,
  newData,
  render,
  rollupRow,
  stepRec,
  stepsRollup,
  weightRec,
} from "./healthdata-helpers";

const h = harness();

const D10 = "2026-10-10";

const unavailable = () => Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });

describe("activity", () => {
  it("reads the totals of each day", () =>
    inStore(async (db) => {
      activityWeek(h.google);
      const a = await newData(db).activity("2026-10-14", "2026-10-16");
      // Active Zone Minutes are the zone sums as reported: cardio and peak
      // already count double. Zone minutes come from the band: the day was
      // worn without a steps list.
      expect(a.days.get("2026-10-15")).toEqual({ steps: 8015, azm: 26, totalKcal: 2400.5, worn: true, partial: false });
      // Only today is partial.
      expect([...a.days].map(([date, value]) => [date, value.partial])).toEqual([
        ["2026-10-14", false],
        ["2026-10-15", false],
        ["2026-10-16", true],
      ]);
      expect(render(a.series(KEY_STEPS))).toBe("2026-10-14=8014 2026-10-15=8015 2026-10-16=8016 ");
      expect(render(a.baselineSeries(KEY_STEPS))).toBe("2026-10-14=8014 2026-10-15=8015 2026-10-16=nil ");
      expect(render(a.series(KEY_AZM))).toBe("2026-10-14=25 2026-10-15=26 2026-10-16=25 ");
      expect(render(a.series(KEY_TOTAL_CALORIES))).toBe("2026-10-14=2400.5 2026-10-15=2400.5 2026-10-16=2400.5 ");
      expect(() => a.series("weight_kg" as ActivityKey)).toThrow();
      // All zones present on every day: no extra request for worn days.
      expect(h.google.takeCalls()).toEqual([
        "rollup steps 2026-10-14..2026-10-16",
        "rollup active-zone-minutes 2026-10-14..2026-10-16",
        "rollup total-calories 2026-10-14..2026-10-16",
      ]);
    }));

  it("gives 0 zone minutes only on a day the band recorded", () =>
    inStore(async (db) => {
      for (const date of [D10, "2026-10-11", "2026-10-12"]) h.google.addRollup("steps", stepsRollup(date, 5000));
      h.google.addRollup("active-zone-minutes", azmRollup(D10, 12, 0, 0));
      // 10-11: the band recorded steps but no zone minutes. 10-12: only the phone.
      h.google.add("steps", stepRec("2026-10-11", "FITBIT"), stepRec("2026-10-12", "HEALTH_KIT"));
      const a = await newData(db).activity(D10, "2026-10-12");
      expect([...a.days]).toEqual([
        [D10, { steps: 5000, azm: 12, totalKcal: null, worn: true, partial: false }],
        ["2026-10-11", { steps: 5000, azm: 0, totalKcal: null, worn: true, partial: false }],
        ["2026-10-12", { steps: 5000, azm: null, totalKcal: null, worn: false, partial: false }],
      ]);
    }));

  it("serves settled days from the cache", () =>
    inStore(async (db) => {
      activityWeek(h.google);
      const data = newData(db);
      const first = await data.activity("2026-10-07", "2026-10-16");
      h.google.takeCalls();
      const second = await data.activity("2026-10-07", "2026-10-16");
      // D-3 (10-13) and older from the cache; the rest live.
      expect(h.google.takeCalls()).toEqual([
        "rollup steps 2026-10-14..2026-10-16",
        "rollup active-zone-minutes 2026-10-14..2026-10-16",
        "rollup total-calories 2026-10-14..2026-10-16",
      ]);
      for (const key of ACTIVITY_KEYS) expect(render(second.series(key)), key).toBe(render(first.series(key)));
      expect([...second.days]).toEqual([...first.days]);
      const rows = metricRange(db, KEY_STEPS, "2026-10-07", "2026-10-16", ALGO_VERSION);
      expect(rows).toHaveLength(7);
      expect(rows[0]).toMatchObject({ source: ROLLUP_SOURCE, zone: SP, value: 8007 });
    }));

  it("skips rows it cannot read and does not cache their run", () =>
    inStore(async (db) => {
      h.google.loose = true;
      h.google.addRollup(
        "steps",
        stepsRollup(D10, 9000),
        stepsRollup("2026-10-11", 500_000), // implausible
        stepsRollup("2026-10-20", 7000), // outside the range
        { steps: { countSum: "10" } }, // no date
        rollupRow("2026-10-12", "steps", { countSum: "many" }),
      );
      h.google.addRollup("total-calories", rollupRow(D10, "totalCalories", {}));
      h.google.addRollup("active-zone-minutes", azmRollup(D10, 1, 0, 0), azmRollup("2026-10-11", 1, 0, 0), azmRollup("2026-10-12", 1, 0, 0));
      const data = newData(db);
      const a = await data.activity(D10, "2026-10-12");
      // The row outside the range is ignored, not counted.
      expect(a.skipped).toBe(4);
      expect(a.days.get(D10)).toMatchObject({ steps: 9000, totalKcal: null });
      expect(a.days.get("2026-10-11")?.steps).toBeNull();
      // A run with dropped rows is returned but not cached.
      for (const key of ACTIVITY_KEYS) expect(metricRange(db, key, D10, "2026-10-12", ALGO_VERSION), key).toEqual([]);
      h.google.takeCalls();
      await data.activity(D10, "2026-10-12");
      expect(h.google.takeCalls()).not.toEqual([]);
      // The log lines count the rows and name the type and the range: no value.
      expect(h.warnings().slice(0, 2)).toEqual([
        ["unreadable daily rollup rows", { data_type: "steps", from: D10, to: "2026-10-12", skipped: 3 }],
        ["unreadable daily rollup rows", { data_type: "total-calories", from: D10, to: "2026-10-12", skipped: 1 }],
      ]);
    }));

  it("keeps real zone minutes in a run with a gap", () =>
    inStore(async (db) => {
      h.google.addRollup("steps", stepsRollup(D10, 9000), stepsRollup("2026-10-11", 4000));
      h.google.addRollup("active-zone-minutes", azmRollup(D10, 20, 5, 0));
      h.google.add("steps", stepRec(D10, "FITBIT"), stepRec("2026-10-11", "FITBIT"));
      const a = await newData(db).activity(D10, "2026-10-11");
      expect(a.days.get(D10)).toMatchObject({ azm: 25, worn: true });
      expect(a.days.get("2026-10-11")).toMatchObject({ azm: 0, worn: true });
    }));

  it("does not read a dropped zone-minutes row as zero", () =>
    inStore(async (db) => {
      h.google.addRollup("steps", stepsRollup(D10, 9000));
      h.google.addRollup("total-calories", kcalRollup(D10, 2500));
      h.google.addRollup("active-zone-minutes", azmRollup(D10, 3000, 0, 0)); // implausible
      h.google.add("steps", stepRec(D10, "FITBIT"));
      const a = await newData(db).activity(D10, D10);
      expect(a.days.get(D10)).toEqual({ steps: 9000, azm: null, totalKcal: 2500, worn: true, partial: false });
      expect(a.skipped).toBe(1);
      expect(metricRange(db, KEY_STEPS, D10, D10, ALGO_VERSION)).toEqual([]);
    }));

  it("does not read renamed rollup fields as zero", () =>
    inStore(async (db) => {
      h.google.addRollup("steps", rollupRow(D10, "steps", { stepCount: "9000" }));
      h.google.addRollup("active-zone-minutes", rollupRow(D10, "activeZoneMinutes", { fatBurn: "20" }));
      h.google.addRollup("total-calories", rollupRow(D10, "totalCalories", { kcal: 2400 }));
      const a = await newData(db).activity(D10, D10);
      expect(a.skipped).toBe(3);
      expect(a.days.size).toBe(0);
    }));

  it.each<[string, unknown, "steps" | "active-zone-minutes" | "total-calories", boolean]>([
    ["0 steps", stepsRollup(D10, 0), "steps", true],
    ["200000 steps", stepsRollup(D10, 200_000), "steps", true],
    ["200001 steps", stepsRollup(D10, 200_001), "steps", false],
    ["2880 AZM", azmRollup(D10, 2880, 0, 0), "active-zone-minutes", true],
    ["2881 AZM", azmRollup(D10, 2881, 0, 0), "active-zone-minutes", false],
    ["20000 kcal", kcalRollup(D10, 20_000), "total-calories", true],
    ["20001 kcal", kcalRollup(D10, 20_001), "total-calories", false],
    ["negative kcal", kcalRollup(D10, -1), "total-calories", false],
    ["before the range", stepsRollup("2026-10-09", 10), "steps", false],
  ])("checks the bounds of a row: %s", (_name, row, dataType, keep) =>
    inStore(async (db) => {
      h.google.loose = true;
      h.google.addRollup(dataType, row);
      const a = await newData(db).activity(D10, D10);
      expect(a.days.has(D10)).toBe(keep);
    }),
  );

  it("tells a day the band was not worn", () =>
    inStore(async (db) => {
      h.google.addRollup("steps", stepsRollup(D10, 3000));
      h.google.addRollup("total-calories", kcalRollup(D10, 1700)); // mostly the resting burn
      h.google.add("steps", stepRec(D10, "HEALTH_KIT"));
      const a = await newData(db).activity(D10, D10);
      expect(a.days.get(D10)).toEqual({ steps: 3000, azm: null, totalKcal: 1700, worn: false, partial: false });
    }));

  it("keeps a cached day worn", () =>
    inStore(async (db) => {
      // A cached day had an AZM value, so the band recorded it.
      activityWeek(h.google);
      const data = newData(db);
      await data.activity(D10, D10);
      h.google.takeCalls();
      const again = await data.activity(D10, D10);
      expect(h.google.takeCalls()).toEqual([]);
      expect(again.days.get(D10)).toEqual({ steps: 8010, azm: 25, totalKcal: 2400.5, worn: true, partial: false });
    }));

  it("refuses a reversed range and passes API and cache errors on", () =>
    inStore(async (db) => {
      const data = newData(db);
      await expect(data.activity(D10, "2026-10-09")).rejects.toThrow(/^healthdata: range ends/);
      await expect(data.body(D10, "2026-10-09")).rejects.toThrow(/^healthdata: range ends/);
      h.google.fail = unavailable;
      expect(toWire(await data.activity(D10, D10).catch((e: unknown) => e)).code).toBe("upstream_unavailable");
      expect(toWire(await data.body(D10, D10).catch((e: unknown) => e)).code).toBe("upstream_unavailable");
      const broken = newData(db, { cache: failingCache(db, { read: true }) });
      for (const call of [broken.activity(D10, D10), broken.body(D10, D10)]) {
        const error = await call.catch((e: unknown) => e);
        expect((error as Error).cause).toBeInstanceOf(DiskError);
      }
    }));
});

describe("body", () => {
  it("takes the first reading of each day, from every platform", () =>
    inStore(async (db) => {
      h.google.add(
        "weight",
        weightRec(at(D10, 7, 0), 80500, "FITBIT"),
        weightRec(at(D10, 21, 0), 81200, "FITBIT"), // an evening reading the same day
        weightRec(at("2026-10-12", 8, 0), 80100, "HEALTH_KIT"), // a scale synced through the phone counts
        weightRec(at("2026-10-11", 8, 0), 5000, "FITBIT"), // implausible
        { weight: {} },
      );
      h.google.add("body-fat", bodyFatRec(at("2026-10-12", 8, 0), 18.5));
      const b = await newData(db).body(D10, "2026-10-12");
      // The day's first reading: the morning weigh-in.
      expect([...b.weight]).toEqual([
        [D10, { at: at(D10, 7, 0), value: 80.5, source: "Synthetic Scale" }],
        ["2026-10-12", { at: at("2026-10-12", 8, 0), value: 80.1, source: "Synthetic Scale" }],
      ]);
      expect(b.skipped).toBe(2);
      expect([...b.bodyFat]).toEqual([["2026-10-12", { at: at("2026-10-12", 8, 0), value: 18.5, source: "FITBIT" }]]);
      expect(last(b.weight)).toMatchObject({ day: "2026-10-12", reading: { value: 80.1 } });
      expect(last(new Map())).toBeUndefined();
      expect(render(b.series(KEY_WEIGHT))).toBe("2026-10-10=80.5 2026-10-11=nil 2026-10-12=80.1 ");
      expect(render(b.series(KEY_BODY_FAT))).toBe("2026-10-10=nil 2026-10-11=nil 2026-10-12=18.5 ");
      expect(() => b.series("steps" as BodyKey)).toThrow();
      // The dropped readings may have been a day's first: nothing is cached.
      expect(metricRange(db, KEY_WEIGHT, D10, "2026-10-12", ALGO_VERSION)).toEqual([]);
      // Body fat read cleanly: its settled day is cached.
      expect(metricRange(db, KEY_BODY_FAT, "2026-10-12", "2026-10-12", ALGO_VERSION)).toMatchObject([{ value: 18.5, source: "FITBIT", zone: SP }]);
      expect(h.warnings()).toEqual([["unreadable body records", { from: D10, to: "2026-10-12", skipped: 2 }]]);
    }));

  it("keeps the earlier reading whatever the order of the records", () =>
    inStore(async (db) => {
      h.google.add("weight", weightRec(at(D10, 21, 0), 81200, "FITBIT"), weightRec(at(D10, 7, 0), 80500, "FITBIT"));
      const b = await newData(db).body(D10, D10);
      expect(b.weight.get(D10)?.value).toBe(80.5);
    }));

  it("caches only settled days", () =>
    inStore(async (db) => {
      for (const date of ["2026-10-13", "2026-10-14", "2026-10-16"]) h.google.add("weight", weightRec(at(date, 7, 0), 80000, "FITBIT"));
      await newData(db).body("2026-10-13", "2026-10-16");
      // 10-13 is D-3, the last settled day; 10-14 and today stay live.
      expect(metricRange(db, KEY_WEIGHT, "2026-10-13", "2026-10-16", ALGO_VERSION)).toMatchObject([{ date: "2026-10-13" }]);
    }));

  it("reads a range from the cache when every day has a row", () =>
    inStore(async (db) => {
      for (const key of [KEY_WEIGHT, KEY_BODY_FAT]) {
        for (const date of ["2026-10-09", D10]) putMetric(db, { date, key, value: 50, source: "Synthetic Scale", zone: SP, algoVersion: ALGO_VERSION });
      }
      const b = await newData(db).body("2026-10-09", D10);
      expect(h.google.takeCalls()).toEqual([]);
      expect(b.weight.get(D10)).toEqual({ at: undefined, value: 50, source: "Synthetic Scale" });
      expect(b.bodyFat.get("2026-10-09")?.source).toBe("Synthetic Scale");
    }));

  it("lists the whole range again when a day has no row", () =>
    inStore(async (db) => {
      // A day without a reading is never cached, so a gap means a fetch, and
      // the live readings replace the cached ones.
      putMetric(db, { date: "2026-10-09", key: KEY_WEIGHT, value: 50, source: "Synthetic Scale", zone: SP, algoVersion: ALGO_VERSION });
      h.google.add("weight", weightRec(at("2026-10-09", 7, 0), 80000, "FITBIT"));
      const b = await newData(db).body("2026-10-09", D10);
      expect(h.google.takeCalls()).toEqual(["weight 2026-10-09..2026-10-10", "body-fat 2026-10-09..2026-10-10"]);
      expect([...b.weight.keys()]).toEqual(["2026-10-09"]);
      expect(b.weight.get("2026-10-09")?.value).toBe(80);
    }));
});
