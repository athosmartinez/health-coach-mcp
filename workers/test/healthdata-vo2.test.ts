// Daily VO2 max: the daily-vo2-max summary, one list, not cached.
import { describe, expect, it } from "vitest";

import { parseVo2 } from "../src/healthdata";

type Json = Record<string, any>;
import { harness, inStore, newData } from "./healthdata-helpers";

function civilParts(date: string): Json {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

const h = harness();

function vo2Rec(date: string, value: number | string, options: { estimated?: boolean; platform?: string; level?: string } = {}): Json {
  const daily: Json = { date: civilParts(date), vo2Max: value };
  if (options.estimated) daily.estimated = true;
  if (options.level) daily.cardioFitnessLevel = options.level;
  return {
    dataSource: { platform: options.platform ?? "FITBIT", device: { displayName: "Synthetic Band" } },
    dailyVo2Max: daily,
  };
}

describe("daily vo2 max", () => {
  it("keeps the Fitbit summary of each day and drops the rest", () =>
    inStore(async (db) => {
      h.google.add("daily-vo2-max", vo2Rec("2026-10-10", 45.2, { level: "GOOD" }));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-11", 40, { estimated: true }));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-12", 50, { platform: "HEALTH_CONNECT" }));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-09", 101));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-08", 0));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-07", "nope"));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-01", 30));
      const out = await newData(db).vo2("2026-10-07", "2026-10-12");
      expect([...out.days.entries()]).toEqual([
        ["2026-10-08", { value: 0, estimated: false, source: "Synthetic Band" }],
        ["2026-10-10", { value: 45.2, estimated: false, source: "Synthetic Band" }],
        ["2026-10-11", { value: 40, estimated: true, source: "Synthetic Band" }],
      ]);
      // 101 is outside the documented range; a string is not the documented number.
      expect(out.skipped).toBe(2);
      expect(out.otherSource).toBe(1);
      expect(out.series().map((point) => point.value)).toEqual([null, 0, null, 45.2, 40, null]);
      expect(h.google.takeRequests()).toEqual({ total: 1, "daily-vo2-max": 1 });
      // The vendor category is not a value the tools keep.
      expect(parseVo2(vo2Rec("2026-10-10", 45.2, { level: "EXCELLENT" }))).toEqual({
        kind: "value",
        date: "2026-10-10",
        value: 45.2,
        estimated: false,
        source: "Synthetic Band",
      });
      expect(JSON.stringify(h.warnings())).not.toContain("45.2");
      expect(JSON.stringify(h.warnings())).not.toContain("EXCELLENT");
    }));

  it("keeps one reading when two agree, and leaves the day unread when they do not", () =>
    inStore(async (db) => {
      h.google.add("daily-vo2-max", vo2Rec("2026-10-10", 44, { estimated: true }));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-10", 46));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-11", 42));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-11", 42));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-12", 41));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-12", 43));
      const out = await newData(db).vo2("2026-10-10", "2026-10-12");
      expect(out.days.get("2026-10-10")).toEqual({ value: 46, estimated: false, source: "Synthetic Band" });
      expect(out.days.get("2026-10-11")).toEqual({ value: 42, estimated: false, source: "Synthetic Band" });
      expect(out.days.has("2026-10-12")).toBe(false);
      expect(out.skipped).toBe(1);
    }));

  it("makes the same choice for a day in every order of its records", () =>
    inStore(async (db) => {
      const estimatedLow = (day: string) => vo2Rec(day, 40, { estimated: true });
      const estimatedHigh = (day: string) => vo2Rec(day, 42, { estimated: true });
      const measured = (day: string) => vo2Rec(day, 45);
      // Two estimated readings that differ, and one that is not estimated, in three orders.
      for (const record of [estimatedLow, estimatedHigh, measured]) h.google.add("daily-vo2-max", record("2026-10-10"));
      for (const record of [measured, estimatedLow, estimatedHigh]) h.google.add("daily-vo2-max", record("2026-10-11"));
      for (const record of [estimatedLow, measured, estimatedHigh]) h.google.add("daily-vo2-max", record("2026-10-12"));
      // Only estimated readings, and they differ: the day is unread.
      for (const record of [estimatedLow, estimatedHigh]) h.google.add("daily-vo2-max", record("2026-10-13"));
      // Two readings that are not estimated differ: an estimated one does not settle the day.
      h.google.add("daily-vo2-max", vo2Rec("2026-10-14", 44));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-14", 45, { estimated: true }));
      h.google.add("daily-vo2-max", vo2Rec("2026-10-14", 46));
      const out = await newData(db).vo2("2026-10-10", "2026-10-14");
      const kept = { value: 45, estimated: false, source: "Synthetic Band" };
      expect([...out.days.entries()]).toEqual([
        ["2026-10-10", kept],
        ["2026-10-11", kept],
        ["2026-10-12", kept],
      ]);
      expect(out.skipped).toBe(2);
    }));

  it("is a miss with no records, and the next call asks again", () =>
    inStore(async (db) => {
      const data = newData(db);
      const first = await data.vo2("2026-10-01", "2026-10-16");
      expect(first.days.size).toBe(0);
      expect(first.skipped).toBe(0);
      expect(h.google.takeRequests()).toEqual({ total: 1, "daily-vo2-max": 1 });
      const second = await data.vo2("2026-10-01", "2026-10-16");
      expect(second.days.size).toBe(0);
      expect(h.google.takeRequests()).toEqual({ total: 1, "daily-vo2-max": 1 });
      expect(h.warnings()).toEqual([]);
    }));
});
