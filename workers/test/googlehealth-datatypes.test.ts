// The type table, filter and rollup chunk cases.
import { describe, expect, it } from "vitest";

import { Zone } from "../src/coach/date";
import {
  DATA_TYPES,
  type DataType,
  type FilterKind,
  MAX_WINDOW_MS,
  type Operation,
  TYPE_TABLE,
  filter,
  lookup,
  rollupChunks,
  windowFilter,
} from "../src/googlehealth/datatypes";

const SAO_PAULO = new Zone("America/Sao_Paulo");

const L: Operation[] = ["list", "reconcile"];
const LD: Operation[] = ["list", "reconcile", "dailyRollup"];

describe("type table", () => {
  const want: Record<DataType, { kind: FilterKind; ops: Operation[]; page: number; cap: number }> = {
    sleep: { kind: "civilEnd", ops: L, page: 25, cap: 0 },
    "heart-rate": { kind: "physical", ops: L, page: 10000, cap: 0 },
    "heart-rate-variability": { kind: "physical", ops: L, page: 10000, cap: 0 },
    "daily-heart-rate-variability": { kind: "date", ops: L, page: 10000, cap: 0 },
    "daily-resting-heart-rate": { kind: "date", ops: L, page: 10000, cap: 0 },
    steps: { kind: "civilStart", ops: LD, page: 10000, cap: 90 },
    "active-zone-minutes": { kind: "civilStart", ops: LD, page: 10000, cap: 90 },
    exercise: { kind: "civilStart", ops: L, page: 25, cap: 0 },
    "nutrition-log": { kind: "civilStart", ops: LD, page: 10000, cap: 90 },
    "total-calories": { kind: "civilStart", ops: ["dailyRollup"], page: 10000, cap: 14 },
    weight: { kind: "physical", ops: LD, page: 10000, cap: 90 },
    "body-fat": { kind: "physical", ops: LD, page: 10000, cap: 90 },
    "daily-vo2-max": { kind: "date", ops: L, page: 10000, cap: 0 },
  };

  it("holds the thirteen types the coach reads", () => {
    expect(Object.keys(TYPE_TABLE).sort()).toEqual(Object.keys(want).sort());
    expect([...DATA_TYPES].sort()).toEqual(Object.keys(want).sort());
  });

  it.each(Object.entries(want))("%s", (dataType, expected) => {
    const info = TYPE_TABLE[dataType as DataType];
    expect({ kind: info.kind, ops: [...info.ops], page: info.pageSize, cap: info.rollupDays }).toEqual(expected);
    expect(info.filterName).toBe(dataType.replaceAll("-", "_"));
    // A rollup type needs a range cap.
    expect(info.ops.includes("dailyRollup")).toBe(info.rollupDays > 0);
  });

  it("refuses an unknown type or an operation the type does not have", () => {
    expect(lookup("steps", "dailyRollup")).toBe(TYPE_TABLE.steps);
    expect(() => lookup("sleep", "dailyRollup")).toThrow("googlehealth: sleep does not support daily rollup");
    expect(() => lookup("total-calories", "list")).toThrow("does not support list");
    expect(() => lookup("total-calories", "reconcile")).toThrow("does not support reconcile");
    expect(() => lookup("blood-glucose", "list")).toThrow('unknown data type "blood-glucose"');
    expect(() => lookup("steps/../x", "list")).toThrow("unknown data type");
    // A name every object has is not a data type.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => lookup(name, "list")).toThrow("unknown data type");
    }
  });
});

describe("filter", () => {
  it("selects inclusive local days by the field of the type", () => {
    expect(filter(TYPE_TABLE.sleep, "2026-10-01", "2026-10-07", SAO_PAULO)).toBe(
      'sleep.interval.civil_end_time >= "2026-10-01T00:00:00" AND sleep.interval.civil_end_time < "2026-10-08T00:00:00"',
    );
    expect(filter(TYPE_TABLE.weight, "2026-10-01", "2026-10-07", SAO_PAULO)).toBe(
      'weight.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND weight.sample_time.physical_time < "2026-10-08T03:00:00Z"',
    );
    expect(filter(TYPE_TABLE["daily-resting-heart-rate"], "2026-12-31", "2026-12-31", SAO_PAULO)).toBe(
      'daily_resting_heart_rate.date >= "2026-12-31" AND daily_resting_heart_rate.date < "2027-01-01"',
    );
    expect(filter(TYPE_TABLE["daily-vo2-max"], "2026-10-05", "2026-10-11", SAO_PAULO)).toBe(
      'daily_vo2_max.date >= "2026-10-05" AND daily_vo2_max.date < "2026-10-12"',
    );
  });

  it("follows a day that is 23 or 25 hours long", () => {
    const newYork = new Zone("America/New_York");
    // DST starts on 2026-03-08 and ends on 2026-11-01 in New York.
    expect(filter(TYPE_TABLE.weight, "2026-03-08", "2026-03-08", newYork)).toBe(
      'weight.sample_time.physical_time >= "2026-03-08T05:00:00Z" AND weight.sample_time.physical_time < "2026-03-09T04:00:00Z"',
    );
    expect(filter(TYPE_TABLE.weight, "2026-11-01", "2026-11-01", newYork)).toBe(
      'weight.sample_time.physical_time >= "2026-11-01T04:00:00Z" AND weight.sample_time.physical_time < "2026-11-02T05:00:00Z"',
    );
  });

  it.each<[string, string, string]>([
    ["to before from", "2026-10-02", "2026-10-01"],
    ["an invalid from", "2026-13-01", "2026-10-01"],
    ["an invalid to", "2026-10-01", "2026-02-30"],
    ["an empty date", "", "2026-10-01"],
  ])("refuses %s", (_name, from, to) => {
    for (const info of [TYPE_TABLE.steps, TYPE_TABLE.sleep, TYPE_TABLE.weight, TYPE_TABLE["daily-resting-heart-rate"]]) {
      expect(() => filter(info, from, to, SAO_PAULO)).toThrow("googlehealth:");
    }
    expect(() => rollupChunks(TYPE_TABLE.steps, from, to)).toThrow("googlehealth:");
  });
});

describe("windowFilter", () => {
  const start = new Date("2026-10-10T22:00:00.750Z");

  it("selects instants to the second", () => {
    const end = new Date(start.getTime() + 97 * 60_000);
    expect(windowFilter("heart-rate", TYPE_TABLE["heart-rate"], start, end)).toBe(
      'heart_rate.sample_time.physical_time >= "2026-10-10T22:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-10T23:37:00Z"',
    );
  });

  it("refuses a type without instants and a window that is empty, too long or not a time", () => {
    const hour = new Date(start.getTime() + 3_600_000);
    expect(() => windowFilter("steps", TYPE_TABLE.steps, start, hour)).toThrow("steps is not filtered by instant");
    expect(() => windowFilter("daily-resting-heart-rate", TYPE_TABLE["daily-resting-heart-rate"], start, hour)).toThrow(
      "not filtered by instant",
    );
    const heartRate = TYPE_TABLE["heart-rate"];
    expect(() => windowFilter("heart-rate", heartRate, start, start)).toThrow("a window must end after it starts");
    expect(() => windowFilter("heart-rate", heartRate, hour, start)).toThrow("a window must end after it starts");
    expect(() => windowFilter("heart-rate", heartRate, start, new Date(start.getTime() + MAX_WINDOW_MS + 1))).toThrow("at most 24h");
    expect(() => windowFilter("heart-rate", heartRate, start, new Date(NaN))).toThrow("a window must end after it starts");
    // Exactly a day is allowed.
    expect(windowFilter("heart-rate", heartRate, start, new Date(start.getTime() + MAX_WINDOW_MS))).toContain("2026-10-11T22:00:00Z");
  });
});

describe("rollupChunks", () => {
  const ranges = (dataType: DataType, from: string, to: string) =>
    rollupChunks(TYPE_TABLE[dataType], from, to)
      .map((chunk) => {
        const day = (d: { year: number; month: number; day: number }) =>
          `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
        return `${day(chunk.range.start.date)}..${day(chunk.range.end.date)}`;
      })
      .join(" ");

  it.each<[DataType, string, string, string]>([
    ["total-calories", "2026-10-01", "2026-10-01", "2026-10-01..2026-10-02"],
    ["total-calories", "2026-10-01", "2026-10-14", "2026-10-01..2026-10-15"],
    ["total-calories", "2026-10-01", "2026-10-15", "2026-10-01..2026-10-15 2026-10-15..2026-10-16"],
    ["total-calories", "2026-12-25", "2027-01-10", "2026-12-25..2027-01-08 2027-01-08..2027-01-11"],
    ["total-calories", "2028-02-20", "2028-03-05", "2028-02-20..2028-03-05 2028-03-05..2028-03-06"],
    ["steps", "2026-01-01", "2026-04-01", "2026-01-01..2026-04-01 2026-04-01..2026-04-02"],
  ])("%s %s..%s", (dataType, from, to, want) => {
    expect(ranges(dataType, from, to)).toBe(want);
  });

  it("writes the body in the Go server's shape", () => {
    expect(JSON.stringify(rollupChunks(TYPE_TABLE.steps, "2026-10-01", "2026-10-07"))).toBe(
      '[{"range":{"start":{"date":{"year":2026,"month":10,"day":1}},"end":{"date":{"year":2026,"month":10,"day":8}}},' +
        '"windowSizeDays":1,"pageSize":10000}]',
    );
  });

  it("refuses a type without a rollup", () => {
    expect(() => rollupChunks(TYPE_TABLE.sleep, "2026-10-01", "2026-10-07")).toThrow("no daily rollup");
  });
});
