// What the Worker changes on purpose: how the data is fetched. The values a
// source returns stay the Go server's; these tests count the HTTP requests of
// the fake API per data type, and check the plan, the windows, the narrow
// options, the request budget and the log lines.
import { describe, expect, it, vi } from "vitest";

import { type LocalDate, Zone, addDays } from "../src/coach/date";
import { ToolError } from "../src/coach/errors";
import { HEALTH_REQUESTS, RequestBudget } from "../src/googlehealth/budget";
import { TYPE_TABLE } from "../src/googlehealth/datatypes";
import {
  ACTIVITY_KEYS,
  HealthData,
  KCAL_WINDOW_DAYS,
  KEY_ASLEEP,
  KEY_AZM,
  KEY_BODY_FAT,
  KEY_HRV,
  KEY_RESTING_HR,
  KEY_STEPS,
  KEY_TOTAL_CALORIES,
  KEY_WEIGHT,
  MAX_HR_SESSIONS,
  MAX_RANGE_DAYS,
  NIGHT_WINDOW_DAYS,
  RECOVERY_KEYS,
  ROLLUP_WINDOW_DAYS,
  SETTLE_DAYS,
  type Source,
  WORN_WINDOW_DAYS,
  dbCache,
} from "../src/healthdata";
import { DayIndex, SLEEP_COST, dayList, pagesOf, ranges, runOf, runs, wanted, windows } from "../src/healthdata/plan";
import { ALGO_VERSION } from "../src/metrics/stats";
import type { Db } from "../src/store/db";
import { deleteMetric, metricRange } from "../src/store/metrics";
import {
  FakeGoogle,
  NOW,
  assertSame,
  at,
  azmRollup,
  bodyFatRec,
  exerciseRec,
  foodRec,
  harness,
  hrvNight,
  inStore,
  kcalRollup,
  newClient,
  newData,
  render,
  restingRec,
  samplesEvery2s,
  sleepRec,
  stepRec,
  stepsRollup,
  weightRec,
} from "./healthdata-helpers";
import { SAO_PAULO } from "./memory-helpers";

const h = harness();

/** 60 days, all settled on NOW (2026-10-16). */
const FROM = "2026-08-01";
const TO = "2026-09-29";
const DAYS = dayList(FROM, TO);

interface Fill {
  /** Leave the zone-minutes row out of these days (the band still counted steps). */
  noZoneMinutes?: (index: number) => boolean;
}

/**
 * One night with HRV, one resting heart rate, the three daily rollups and one
 * weigh-in for each day of [from, to]. Every value depends on the day, so a
 * value read from the wrong day shows.
 */
function fill(google: FakeGoogle, from: LocalDate, to: LocalDate, options: Fill = {}): void {
  dayList(from, to).forEach((date, i) => {
    const before = addDays(date, -1) as string;
    google.add("sleep", sleepRec(at(before, 23, 0), at(date, 7, 0), { deep: 50 + (i % 30) }));
    google.add("heart-rate-variability", ...hrvNight(at(before, 23, 0), at(date, 7, 0), 30 + (i % 40)));
    google.add("daily-resting-heart-rate", restingRec(date, 48 + (i % 20), "WITH_SLEEP", "FITBIT"));
    google.addRollup("steps", stepsRollup(date, 6000 + i));
    google.addRollup("total-calories", kcalRollup(date, 2200 + i));
    if (options.noZoneMinutes?.(i)) google.add("steps", stepRec(date, "FITBIT"));
    else google.addRollup("active-zone-minutes", azmRollup(date, 10 + (i % 7), 4, 0));
    google.add("weight", weightRec(at(date, 7, 30), 80_000 + i * 10, "FITBIT"));
    google.add("body-fat", bodyFatRec(at(date, 7, 30), 18 + (i % 5) / 10));
  });
}

/** The source of one MCP request: every call shares one request budget. */
function oneRequest(db: Db, budget = new RequestBudget()): Source {
  return new HealthData(newClient(SAO_PAULO, budget), dbCache(db), SAO_PAULO, () => NOW);
}

/** Removes the cached rows of every second day: a cache with holes. */
function punchHoles(db: Db, keys: readonly string[]): void {
  DAYS.forEach((date, i) => {
    if (i % 2 === 1) for (const key of keys) deleteMetric(db, date, key);
  });
}

const BUDGET_ERROR = { code: "invalid_input", hint: "use a shorter date range" };

describe("the window sizes", () => {
  it("follow the page and rollup caps of the API", () => {
    // One rollup request per window: the windows are the API's caps.
    expect(KCAL_WINDOW_DAYS).toBe(TYPE_TABLE["total-calories"].rollupDays);
    expect(ROLLUP_WINDOW_DAYS).toBe(TYPE_TABLE.steps.rollupDays);
    expect(ROLLUP_WINDOW_DAYS).toBe(TYPE_TABLE["active-zone-minutes"].rollupDays);
    // 130 HRV samples a night for a window of nights stay inside one page.
    expect(NIGHT_WINDOW_DAYS * 130).toBeLessThanOrEqual(TYPE_TABLE["heart-rate-variability"].pageSize);
    // The sleep records of a window, with its two margin days, take 3 pages.
    expect(Math.ceil((NIGHT_WINDOW_DAYS + 2) / TYPE_TABLE.sleep.pageSize)).toBe(3);
    expect([NIGHT_WINDOW_DAYS, KCAL_WINDOW_DAYS, ROLLUP_WINDOW_DAYS, WORN_WINDOW_DAYS]).toEqual([63, 14, 90, 31]);
    expect([MAX_RANGE_DAYS, SETTLE_DAYS, MAX_HR_SESSIONS]).toEqual([366, 3, 31]);
  });
});

describe("the plan", () => {
  it("lists the days of a range", () => {
    expect(dayList("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(dayList("2026-10-10", "2026-10-10")).toEqual(["2026-10-10"]);
    expect(dayList("2025-10-16", "2026-10-16")).toHaveLength(MAX_RANGE_DAYS);
    expect(() => dayList("2025-10-15", "2026-10-16")).toThrow("healthdata: a range spans at most 366 days");
    expect(() => dayList("2026-10-10", "2026-10-09")).toThrow("healthdata: range ends (2026-10-09) before it starts (2026-10-10)");
    expect(() => dayList("2026-02-30", "2026-03-01")).toThrow("healthdata: from: invalid date, want YYYY-MM-DD");
    expect(() => dayList("2026-02-01", "tomorrow")).toThrow("healthdata: to: invalid date, want YYYY-MM-DD");
    expect(() => dayList(undefined as never, "2026-03-01")).toThrow("healthdata: from");
  });

  it("groups days into runs of consecutive days", () => {
    expect(runs([])).toEqual([]);
    expect(runs(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-31", "2026-11-01"])).toEqual([
      ["2026-10-01", "2026-10-02"],
      ["2026-10-04", "2026-10-04"],
      ["2026-10-31", "2026-11-01"],
    ]);
    const all = runs(["2026-10-01", "2026-10-02", "2026-10-04"]);
    expect(runOf(all).get("2026-10-02")).toBe(all[0]);
    expect(runOf(all).get("2026-10-04")).toBe(all[1]);
    expect(runOf(all).has("2026-10-03")).toBe(false);
  });

  it("covers the missing days with windows that start at a missing day", () => {
    expect(windows([], 4)).toEqual([]);
    // Windows of 4 days: 02–05 holds two missing days, 09–12 one.
    expect(windows(["2026-10-02", "2026-10-03", "2026-10-09"], 4)).toEqual([
      { days: ["2026-10-02", "2026-10-03"], first: "2026-10-02", last: "2026-10-03" },
      { days: ["2026-10-09"], first: "2026-10-09", last: "2026-10-09" },
    ]);
    // A window is fetched as one covering range, whatever the holes in it.
    expect(windows(["2026-10-01", "2026-10-10"], 10)).toEqual([{ days: ["2026-10-01", "2026-10-10"], first: "2026-10-01", last: "2026-10-10" }]);
    expect(windows(["2026-10-01", "2026-10-11"], 10)).toMatchObject([{ first: "2026-10-01", last: "2026-10-01" }, { first: "2026-10-11", last: "2026-10-11" }]);
    // A run that fits a window is never split, wherever it lies in the call.
    expect(windows(dayList("2026-10-14", "2026-10-16"), 14)).toMatchObject([{ first: "2026-10-14", last: "2026-10-16" }]);
    // A long run is cut from its first day.
    expect(windows(dayList("2026-10-01", "2026-10-10"), 4).map((window) => [window.first, window.last])).toEqual([
      ["2026-10-01", "2026-10-04"],
      ["2026-10-05", "2026-10-08"],
      ["2026-10-09", "2026-10-10"],
    ]);
  });

  it("never needs more windows for a part of the missing days than for all of them", () => {
    const all = dayList("2026-06-01", "2026-10-08");
    for (const size of [1, 14, 31, 63, 90]) {
      const cold = windows(all, size).length;
      expect(cold).toBe(Math.ceil(all.length / size));
      for (const keep of [2, 3, 7, 20, 64]) {
        for (let phase = 0; phase < keep; phase++) {
          const holes = all.filter((_, i) => i % keep === phase);
          expect(windows(holes, size).length, `size ${size}, every ${keep} from ${phase}`).toBeLessThanOrEqual(cold);
          // The Go server sends one request, or more, for each run.
          expect(windows(holes, size).length).toBeLessThanOrEqual(runs(holes).length);
        }
      }
    }
  });

  it("groups the missing nights of a window into the sleep lists that cost the fewest pages", () => {
    const days = dayList("2026-08-01", "2026-10-02"); // one window of 63 nights
    const pick = (...indexes: number[]) => indexes.map((i) => days[i] as string);
    const shape = (missing: string[]) => ranges(missing, SLEEP_COST).map((range) => [days.indexOf(range.first), days.indexOf(range.last)]);
    expect(SLEEP_COST).toEqual({ perDay: 1, pageSize: 25, marginDays: 2 });
    expect([pagesOf(1, SLEEP_COST), pagesOf(23, SLEEP_COST), pagesOf(24, SLEEP_COST), pagesOf(63, SLEEP_COST)]).toEqual([1, 1, 2, 3]);
    expect(ranges([], SLEEP_COST)).toEqual([]);
    // One run is one list, whatever its length.
    expect(shape(days)).toEqual([[0, 62]]);
    // Two nights 22 days apart fit one page: one list.
    expect(shape(pick(0, 22))).toEqual([[0, 22]]);
    // Two nights far apart: two lists of one page, not the 3 pages of the covering range.
    expect(shape(pick(0, 62))).toEqual([[0, 0], [62, 62]]);
    expect(shape(pick(0, 1, 61, 62))).toEqual([[0, 1], [61, 62]]);
    // The same number of requests either way: one covering list.
    expect(shape(pick(0, 47))).toEqual([[0, 47]]);
    expect(shape(pick(5, 30, 61, 62))).toEqual([[5, 62]]);
    // Every second night: the covering list costs 3 pages, as the cold window does.
    expect(shape(days.filter((_, i) => i % 2 === 1))).toEqual([[1, 61]]);
    // A range holds exactly its own missing days.
    expect(ranges(pick(0, 1, 61, 62), SLEEP_COST)[1]).toEqual({ days: pick(61, 62), first: days[61], last: days[62] });
  });

  it("never plans more sleep pages than the covering range, or than the runs fetched apart", () => {
    const days = dayList("2026-08-01", "2026-10-02");
    // A fixed pseudo-random sequence: the cases are the same on every run.
    let seed = 20261010;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 300; round++) {
      const keep = random();
      const missing = days.filter(() => random() < keep);
      if (missing.length === 0) continue;
      const planned = ranges(missing, SLEEP_COST);
      const cost = planned.reduce((sum, range) => sum + pagesOf(dayList(range.first, range.last).length, SLEEP_COST), 0);
      const covering = pagesOf(dayList(missing[0] as string, missing.at(-1) as string).length, SLEEP_COST);
      const apart = runs(missing).reduce((sum, [a, b]) => sum + pagesOf(dayList(a, b).length, SLEEP_COST), 0);
      expect(cost, missing.join(",")).toBeLessThanOrEqual(Math.min(covering, apart));
      // Every missing day is in one range, in order.
      expect(planned.flatMap((range) => range.days)).toEqual(missing);
    }
  });

  it("finds the local day of an instant without a zone lookup per instant", () => {
    const index = new DayIndex("2026-10-09", "2026-10-11", SAO_PAULO);
    expect(index.dayOf(at("2026-10-09", 0, 0).getTime())).toBe("2026-10-09");
    expect(index.dayOf(at("2026-10-09", 23, 59).getTime())).toBe("2026-10-09");
    expect(index.dayOf(at("2026-10-10", 0, 0).getTime())).toBe("2026-10-10");
    expect(index.dayOf(at("2026-10-11", 23, 59).getTime())).toBe("2026-10-11");
    expect(index.dayOf(at("2026-10-08", 23, 59).getTime())).toBeUndefined();
    expect(index.dayOf(at("2026-10-12", 0, 0).getTime())).toBeUndefined();
    expect(index.dayOf(Number.NaN)).toBeUndefined();
    // A day of 23 hours and a day of 25 hours.
    const newYork = new Zone("America/New_York");
    const dst = new DayIndex("2026-03-07", "2026-11-02", newYork);
    for (const text of ["2026-03-08T00:30:00-05:00", "2026-03-08T23:30:00-04:00", "2026-11-01T00:30:00-04:00", "2026-11-01T23:30:00-05:00", "2026-07-04T12:00:00-04:00"]) {
      const ms = Date.parse(text);
      expect(dst.dayOf(ms), text).toBe(newYork.dateOf(ms));
    }
  });

  it("reads which values a caller asked for", () => {
    const all = ["a", "b"] as const;
    expect([...wanted(undefined, all)]).toEqual(["a", "b"]);
    expect([...wanted(["b"], all)]).toEqual(["b"]);
    expect(() => wanted([], all)).toThrow("healthdata: the list of values to read is empty");
    expect(() => wanted(["c" as "a"], all)).toThrow("healthdata: unknown value to read");
  });
});

describe("request counts: recovery", () => {
  it("fetches a cold cache in windows, a warm cache not at all, and holes in no more requests than cold", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO);
      const data = newData(db);

      const cold = await data.recovery(FROM, TO);
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-07-31..2026-09-30",
        "heart-rate-variability 2026-07-31..2026-09-29",
        "daily-resting-heart-rate 2026-08-01..2026-09-29",
      ]);
      const coldCount = h.google.takeRequests();
      // 60 sleep records are 3 pages of 25.
      expect(coldCount).toEqual({ total: 5, sleep: 3, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
      expect(cold.nights.size).toBe(60);
      expect(cold.restingHR.size).toBe(60);

      const warm = await data.recovery(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 0 });
      assertSame(cold, warm);

      // Every second day missing: the Go server would send 30 × 3 = 90 requests.
      punchHoles(db, RECOVERY_KEYS);
      const holes = await data.recovery(FROM, TO);
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-08-01..2026-09-30",
        "heart-rate-variability 2026-08-01..2026-09-29",
        "daily-resting-heart-rate 2026-08-02..2026-09-29",
      ]);
      const holesCount = h.google.takeRequests();
      expect(holesCount).toEqual({ total: 5, sleep: 3, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
      expect(holesCount.total).toBeLessThanOrEqual(coldCount.total as number);
      assertSame(cold, holes);
      // The holes are filled: the next call asks nothing.
      await data.recovery(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 0 });
    }));

  it("fetches two missing nights far apart with two small sleep lists and one HRV list", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO);
      const data = newData(db);
      const cold = await data.recovery(FROM, TO);
      h.google.takeRequests();
      h.google.takeCalls();
      for (const date of [FROM, TO]) for (const key of RECOVERY_KEYS) deleteMetric(db, date, key);
      const again = await data.recovery(FROM, TO);
      // The covering sleep list would cost 3 pages; the Go server sends 6 requests.
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-07-31..2026-08-02",
        "sleep 2026-09-28..2026-09-30",
        "heart-rate-variability 2026-07-31..2026-09-29",
        "daily-resting-heart-rate 2026-08-01..2026-09-29",
      ]);
      expect(h.google.takeRequests()).toEqual({ total: 4, sleep: 2, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
      assertSame(cold, again);
    }));

  it("keeps the cached value of a day inside a covering range", () =>
    inStore(async (db) => {
      fill(h.google, "2026-09-01", "2026-09-07");
      const data = newData(db);
      const before = await data.recovery("2026-09-01", "2026-09-07");
      // The API now holds other records for the cached day 09-04, and the
      // days around it are missing from the cache.
      h.google.add("sleep", sleepRec(at("2026-09-04", 13, 0), at("2026-09-04", 13, 30), { nap: true }));
      h.google.add("sleep", sleepRec(at("2026-09-03", 22, 0), at("2026-09-04", 9, 0), { platform: "HEALTH_KIT" }));
      h.google.add("sleep", { dataSource: { platform: "FITBIT" }, sleep: { interval: { startTime: "2026-09-04T15:00:00Z", endTime: "2026-09-04T16:00:00Z" } } });
      h.google.add("daily-resting-heart-rate", restingRec("2026-09-04", 99, "WITH_SLEEP", "FITBIT"));
      for (const date of ["2026-09-03", "2026-09-05"]) for (const key of RECOVERY_KEYS) deleteMetric(db, date, key);
      h.google.takeCalls();
      const after = await data.recovery("2026-09-01", "2026-09-07");
      // One covering range for the two runs.
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-09-02..2026-09-06",
        "heart-rate-variability 2026-09-02..2026-09-05",
        "daily-resting-heart-rate 2026-09-03..2026-09-05",
      ]);
      assertSame(before, after);
      expect(after.restingHR.get("2026-09-04")?.bpm).toBe(before.restingHR.get("2026-09-04")?.bpm);
      // The records of the cached day count for nothing: not excluded, not skipped.
      expect(after.excluded).toEqual({ otherSource: 0, naps: 0, extraSessions: 0, noHRVValue: 0, unknownSleepType: 0 });
      expect(after.skipped).toBe(0);
      expect(after.empty).toEqual([]);
    }));

  it("judges an empty data type per run of missing days, as the Go server does", () =>
    inStore(async (db) => {
      // 09-01 and 09-02 hold only the phone's records; 09-04 and 09-05 hold
      // the band's. 09-03 is cached, so they are two runs in one request.
      fill(h.google, "2026-09-03", "2026-09-05");
      for (const date of ["2026-09-01", "2026-09-02"]) {
        h.google.add("sleep", sleepRec(at(addDays(date, -1) as string, 23, 0), at(date, 7, 0), { platform: "HEALTH_KIT" }));
        h.google.add("daily-resting-heart-rate", restingRec(date, 60, "", "HEALTH_KIT"));
      }
      const data = newData(db);
      await data.recovery("2026-09-03", "2026-09-03");
      h.google.takeCalls();
      const r = await data.recovery("2026-09-01", "2026-09-05");
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-08-31..2026-09-06",
        "heart-rate-variability 2026-08-31..2026-09-05",
        "daily-resting-heart-rate 2026-09-01..2026-09-05",
      ]);
      expect([...r.nights.keys()]).toEqual(["2026-09-03", "2026-09-04", "2026-09-05"]);
      expect(r.empty).toEqual(["daily-resting-heart-rate", "sleep"]);
      expect(r.excluded.otherSource).toBe(4);
      expect(h.warnings()).toEqual([
        ["google health records arrived but none were usable", { data_type: "sleep", from: "2026-09-01", to: "2026-09-02" }],
        ["google health records arrived but none were usable", { data_type: "daily-resting-heart-rate", from: "2026-09-01", to: "2026-09-02" }],
      ]);
    }));

  it("reads only resting heart rate, or only nights, in fewer requests and with the same values", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO);
      const full = await newData(db).recovery(FROM, TO);
      const fullCount = h.google.takeRequests();
      const resting = await inStore(async (other) => {
        const r = await newData(other).recovery(FROM, TO, { values: ["resting_hr"] });
        return { r, count: h.google.takeRequests(), cached: metricRange(other, KEY_ASLEEP, FROM, TO, ALGO_VERSION).length };
      });
      expect(resting.count).toEqual({ total: 1, "daily-resting-heart-rate": 1 });
      expect(resting.count.total).toBeLessThan(fullCount.total as number);
      expect([...resting.r.restingHR]).toEqual([...full.restingHR]);
      expect(render(resting.r.series(KEY_RESTING_HR))).toBe(render(full.series(KEY_RESTING_HR)));
      expect(render(resting.r.baselineSeries(KEY_RESTING_HR))).toBe(render(full.baselineSeries(KEY_RESTING_HR)));
      expect(resting.r.nights.size).toBe(0);
      expect(resting.cached).toBe(0);
      // A series of a value that was not read would be all null: it throws.
      expect(() => resting.r.series(KEY_HRV)).toThrow("healthdata: the recovery series was not read");

      const onlyNights = await inStore(async (other) => {
        const r = await newData(other).recovery(FROM, TO, { values: ["nights"] });
        return { r, count: h.google.takeRequests() };
      });
      expect(onlyNights.count).toEqual({ total: 4, sleep: 3, "heart-rate-variability": 1 });
      expect(onlyNights.count.total).toBeLessThan(fullCount.total as number);
      expect([...onlyNights.r.nights]).toEqual([...full.nights]);
      for (const key of RECOVERY_KEYS.filter((k) => k !== KEY_RESTING_HR)) {
        expect(render(onlyNights.r.series(key)), key).toBe(render(full.series(key)));
        expect(render(onlyNights.r.baselineSeries(key)), key).toBe(render(full.baselineSeries(key)));
      }
      expect(onlyNights.r.restingHR.size).toBe(0);
      expect(() => onlyNights.r.series(KEY_RESTING_HR)).toThrow("healthdata: the recovery series was not read");
    }));

  it("leaves the finished windows cached when the budget runs out, so the same call then needs fewer requests", () =>
    inStore(async (db) => {
      // 130 settled days: windows of 63, 63 and 4 nights. A cold call needs
      // 4 + 4 + 2 requests for the nights and 1 for resting heart rate.
      const [from, to] = ["2026-06-01", "2026-10-08"];
      fill(h.google, from, to);
      const cold = await inStore((other) => newData(other).recovery(from, to));
      expect(h.google.takeRequests()).toEqual({ total: 11, sleep: 7, "heart-rate-variability": 3, "daily-resting-heart-rate": 1 });
      h.google.takeCalls();

      // Each MCP request may send 6 requests.
      const first = await oneRequest(db, new RequestBudget(6))
        .recovery(from, to)
        .catch((e: unknown) => e);
      expect(first).toBeInstanceOf(ToolError);
      // The budget error of the client reaches the caller as it is.
      expect((first as ToolError).wire()).toEqual({ ...BUDGET_ERROR, message: "the date range holds more sleep data than one call reads" });
      expect(h.google.takeCalls()).toEqual(["sleep 2026-05-31..2026-08-03", "heart-rate-variability 2026-05-31..2026-08-02", "sleep 2026-08-02..2026-10-05"]);
      expect(h.google.takeRequests()).toEqual({ total: 6, sleep: 5, "heart-rate-variability": 1 });
      // The nights of the finished window are in the cache.
      expect(metricRange(db, KEY_ASLEEP, from, to, ALGO_VERSION)).toHaveLength(NIGHT_WINDOW_DAYS);
      expect(metricRange(db, KEY_RESTING_HR, from, to, ALGO_VERSION)).toHaveLength(0);

      // The same call again starts at the second window.
      const second = await oneRequest(db, new RequestBudget(6))
        .recovery(from, to)
        .catch((e: unknown) => e);
      expect((second as ToolError).wire()).toEqual({ ...BUDGET_ERROR, message: "the date range holds more daily-resting-heart-rate data than one call reads" });
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-08-02..2026-10-05",
        "heart-rate-variability 2026-08-02..2026-10-04",
        "sleep 2026-10-04..2026-10-09",
        "heart-rate-variability 2026-10-04..2026-10-08",
      ]);
      expect(h.google.takeRequests().total).toBe(6);
      expect(metricRange(db, KEY_ASLEEP, from, to, ALGO_VERSION)).toHaveLength(130);

      const third = await oneRequest(db, new RequestBudget(6)).recovery(from, to);
      expect(h.google.takeRequests()).toEqual({ total: 1, "daily-resting-heart-rate": 1 });
      assertSame(cold, third);
    }));
});

describe("request counts: activity", () => {
  /** Zone-minutes rows are missing on days 5, 15, 25, ... : the band counted steps there. */
  const noZoneMinutes = (index: number) => index % 10 === 5;

  it("fetches a cold cache in windows, a warm cache not at all, and holes in no more requests than cold", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO, { noZoneMinutes });
      const data = newData(db);

      const cold = await data.activity(FROM, TO);
      expect(h.google.takeCalls()).toEqual([
        "rollup steps 2026-08-01..2026-09-29",
        "rollup active-zone-minutes 2026-08-01..2026-09-29",
        "rollup total-calories 2026-08-01..2026-08-14",
        // The "band worn" check: only the days without a zone-minutes row.
        "steps 2026-08-06..2026-09-05",
        "steps 2026-09-15..2026-09-25",
        "rollup total-calories 2026-08-15..2026-08-28",
        "rollup total-calories 2026-08-29..2026-09-11",
        "rollup total-calories 2026-09-12..2026-09-25",
        "rollup total-calories 2026-09-26..2026-09-29",
      ]);
      const coldCount = h.google.takeRequests();
      expect(coldCount).toEqual({ total: 9, "rollup steps": 1, "rollup active-zone-minutes": 1, "rollup total-calories": 5, steps: 2 });
      expect(cold.days.size).toBe(60);
      expect(cold.days.get("2026-08-06")).toEqual({ steps: 6005, azm: 0, totalKcal: 2205, worn: true, partial: false });
      expect(cold.days.get("2026-08-07")).toEqual({ steps: 6006, azm: 20, totalKcal: 2206, worn: true, partial: false });

      const warm = await data.activity(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 0 });
      expect([...warm.days]).toEqual([...cold.days]);

      // Every second day missing: the Go server would send at least 30 × 3 = 90 requests.
      punchHoles(db, ACTIVITY_KEYS);
      const holes = await data.activity(FROM, TO);
      const holesCount = h.google.takeRequests();
      expect(holesCount).toEqual({ total: 9, "rollup steps": 1, "rollup active-zone-minutes": 1, "rollup total-calories": 5, steps: 2 });
      expect(holesCount.total).toBeLessThanOrEqual(coldCount.total as number);
      expect([...holes.days]).toEqual([...cold.days]);
      await data.activity(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 0 });
    }));

  it("lists steps only for the days that have no zone-minutes row", () =>
    inStore(async (db) => {
      // Zone-minutes rows on every day but 09-03 and 09-07.
      fill(h.google, "2026-09-01", "2026-09-10", { noZoneMinutes: (index) => index === 2 || index === 6 });
      const a = await newData(db).activity("2026-09-01", "2026-09-10");
      // The Go server lists the whole run, 09-01..09-10.
      expect(h.google.takeCalls().filter((call) => call.startsWith("steps "))).toEqual(["steps 2026-09-03..2026-09-07"]);
      expect([...a.days.values()].map((day) => day.azm)).toEqual([14, 15, 0, 17, 18, 19, 0, 14, 15, 16]);
      expect([...a.days.values()].every((day) => day.worn)).toBe(true);
    }));

  it("takes the days of a run out of the cache when a later window drops a row of that run", () =>
    inStore(async (db) => {
      // One run of 20 missing days: two total-calories windows. The band
      // counted steps on 09-03 without zone minutes.
      fill(h.google, "2026-09-01", "2026-09-20", { noZoneMinutes: (index) => index === 2 });
      // A row of the second window cannot be read.
      h.google.addRollup("total-calories", { civilStartTime: { date: { year: 2026, month: 9, day: 18 } }, totalCalories: { kcalSum: "a lot" } });
      const a = await newData(db).activity("2026-09-01", "2026-09-20");
      expect(h.google.takeCalls().filter((call) => call.startsWith("rollup total-calories"))).toEqual([
        "rollup total-calories 2026-09-01..2026-09-14",
        "rollup total-calories 2026-09-15..2026-09-20",
      ]);
      expect(a.skipped).toBe(1);
      // As in the Go server: the run gets no 0 for its zone minutes, and none of its days is cached.
      expect(a.days.get("2026-09-03")).toEqual({ steps: 6002, azm: null, totalKcal: 2202, worn: true, partial: false });
      expect(a.days.get("2026-09-18")?.totalKcal).toBe(2217);
      for (const key of ACTIVITY_KEYS) expect(metricRange(db, key, "2026-09-01", "2026-09-20", ALGO_VERSION), key).toEqual([]);
    }));

  describe("when a later window fails", () => {
    const [from, to] = ["2026-09-01", "2026-10-10"];
    const cachedDays = (db: Db, key: string) => metricRange(db, key, from, to, ALGO_VERSION).map((row) => row.date);
    const kcalCalls = () => h.google.takeCalls().filter((call) => call.startsWith("rollup total-calories"));

    /**
     * 40 settled days with 09-10 cached: two runs of missing days, and three
     * total-calories windows (09-01, 09-15 and 09-29). The band counted steps
     * on 09-12 without zone minutes.
     */
    async function twoRuns(db: Db): Promise<void> {
      fill(h.google, from, to, { noZoneMinutes: (index) => index === 11 });
      await newData(db).activity("2026-09-10", "2026-09-10");
      h.google.takeCalls();
    }

    /** Answers 503 to every total-calories rollup that starts on 2026-09-29: the third window. */
    function failThirdWindow(): void {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST" && request.url.includes("/total-calories/")) {
          const body = (await request.clone().json()) as { range: { start: { date: { month: number; day: number } } } };
          const start = body.range.start.date;
          if (start.month === 9 && start.day === 29) return Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });
        }
        return h.google.respond(request);
      });
    }

    const unreadableRow = { civilStartTime: { date: { year: 2026, month: 9, day: 18 } }, totalCalories: { kcalSum: "a lot" } };
    const firstRun = dayList("2026-09-01", "2026-09-10");

    it.each([
      ["a request that stays unavailable", (db: Db) => newData(db), { code: "upstream_unavailable" }],
      // The steps and zone-minutes rollups, the steps list of 09-12 and two
      // total-calories windows: the third window is not sent.
      ["the budget error", (db: Db) => oneRequest(db, new RequestBudget(5)), { ...BUDGET_ERROR, message: "the date range holds more total-calories data than one call reads" }],
    ])("takes the days of an unclean run out of the cache also when the call ends with %s", (name, source, error) =>
      inStore(async (db) => {
        await twoRuns(db);
        // A row of the second window cannot be read: the second run is unclean.
        h.google.addRollup("total-calories", unreadableRow);
        if (name !== "the budget error") failThirdWindow();
        const failed = await source(db)
          .activity(from, to)
          .catch((e: unknown) => e);
        expect(failed).toBeInstanceOf(ToolError);
        expect((failed as ToolError).wire()).toMatchObject(error);
        // The windows that the fake API answered: the third one got no answer from it.
        expect(kcalCalls()).toEqual(["rollup total-calories 2026-09-01..2026-09-14", "rollup total-calories 2026-09-15..2026-09-28"]);
        // The first window cached 09-11..09-14 before the second one dropped
        // the row. They are gone; the clean run before them stays.
        for (const key of ACTIVITY_KEYS) expect(cachedDays(db, key), key).toEqual(firstRun);

        // The same call again reads the whole unclean run from Google.
        vi.restoreAllMocks();
        h.google.install();
        const again = await newData(db).activity(from, to);
        expect(kcalCalls()).toEqual([
          "rollup total-calories 2026-09-11..2026-09-24",
          "rollup total-calories 2026-09-25..2026-10-08",
          "rollup total-calories 2026-10-09..2026-10-10",
        ]);
        expect(again.skipped).toBe(1);
        // As in the Go server: a run with a dropped row gets no 0 for its zone minutes.
        expect(again.days.get("2026-09-12")).toEqual({ steps: 6011, azm: null, totalKcal: 2211, worn: true, partial: false });
        expect(again.days.size).toBe(40);
        for (const key of ACTIVITY_KEYS) expect(cachedDays(db, key), key).toEqual(firstRun);
      }),
    );

    it("keeps the days of the finished windows in the cache when every row was readable", () =>
      inStore(async (db) => {
        await twoRuns(db);
        failThirdWindow();
        await expect(newData(db).activity(from, to)).rejects.toMatchObject({ code: "upstream_unavailable" });
        const finished = dayList(from, "2026-09-28");
        for (const key of ACTIVITY_KEYS) expect(cachedDays(db, key), key).toEqual(finished);
        // The same call again starts at the third window.
        vi.restoreAllMocks();
        h.google.install();
        h.google.takeCalls();
        const again = await newData(db).activity(from, to);
        expect(h.google.takeCalls()).toEqual([
          "rollup steps 2026-09-29..2026-10-10",
          "rollup active-zone-minutes 2026-09-29..2026-10-10",
          "rollup total-calories 2026-09-29..2026-10-10",
        ]);
        expect(again.days.get("2026-09-12")).toEqual({ steps: 6011, azm: 0, totalKcal: 2211, worn: true, partial: false });
        expect(h.logged()).not.toContain("6011");
      }));
  });

  it("applies a dropped row without a day to every run of its request", () =>
    inStore(async (db) => {
      const noRow = (index: number) => index === 1 || index === 5;
      fill(h.google, "2026-09-01", "2026-09-07", { noZoneMinutes: noRow });
      const data = newData(db);
      await data.activity("2026-09-04", "2026-09-04");
      // The day of the row is unknown: it may belong to either run.
      h.google.addRollup("total-calories", { totalCalories: { kcalSum: 2000 } });
      const a = await data.activity("2026-09-01", "2026-09-07");
      expect(a.skipped).toBe(1);
      expect([a.days.get("2026-09-02")?.azm, a.days.get("2026-09-06")?.azm]).toEqual([null, null]);
      expect(a.days.get("2026-09-06")).toMatchObject({ steps: 6005, totalKcal: 2205, worn: true });
      // Only the day cached before stays cached.
      expect(metricRange(db, KEY_STEPS, "2026-09-01", "2026-09-07", ALGO_VERSION).map((row) => row.date)).toEqual(["2026-09-04"]);
      expect(h.warnings()).toEqual([["unreadable daily rollup rows", { data_type: "total-calories", from: "2026-09-01", to: "2026-09-07", skipped: 1 }]]);
    }));

  it("applies a dropped row to its run of missing days, not to the whole request", () =>
    inStore(async (db) => {
      const noRow = (index: number) => index === 1 || index === 5;
      fill(h.google, "2026-09-01", "2026-09-07", { noZoneMinutes: noRow });
      const data = newData(db);
      // 09-04 is cached, so 09-01..09-03 and 09-05..09-07 are two runs.
      await data.activity("2026-09-04", "2026-09-04");
      // A steps row of the first run cannot be read.
      h.google.addRollup("steps", { civilStartTime: { date: { year: 2026, month: 9, day: 2 } }, steps: { countSum: "many" } });
      h.google.takeCalls();
      const a = await data.activity("2026-09-01", "2026-09-07");
      expect(h.google.takeCalls()).toEqual([
        "rollup steps 2026-09-01..2026-09-07",
        "rollup active-zone-minutes 2026-09-01..2026-09-07",
        "rollup total-calories 2026-09-01..2026-09-07",
        "steps 2026-09-02..2026-09-06",
      ]);
      expect(a.skipped).toBe(1);
      // First run: no 0 for the day without a zone-minutes row, and nothing cached.
      expect(a.days.get("2026-09-02")).toMatchObject({ steps: 6001, azm: null, worn: true });
      for (const date of ["2026-09-01", "2026-09-02", "2026-09-03"]) expect(metricRange(db, KEY_STEPS, date, date, ALGO_VERSION), date).toEqual([]);
      // Second run: the day without a row is 0, and its days are cached.
      expect(a.days.get("2026-09-06")).toMatchObject({ steps: 6005, azm: 0, worn: true });
      for (const date of ["2026-09-05", "2026-09-06", "2026-09-07"]) expect(metricRange(db, KEY_AZM, date, date, ALGO_VERSION), date).toHaveLength(1);
    }));

  it.each([
    { values: ["steps"] as const, count: { total: 1, "rollup steps": 1 } },
    { values: ["azm"] as const, count: { total: 3, "rollup active-zone-minutes": 1, steps: 2 } },
    { values: ["worn"] as const, count: { total: 3, "rollup active-zone-minutes": 1, steps: 2 } },
    { values: ["total_calories"] as const, count: { total: 5, "rollup total-calories": 5 } },
    { values: ["total_calories", "worn"] as const, count: { total: 8, "rollup active-zone-minutes": 1, "rollup total-calories": 5, steps: 2 } },
  ])("reads only $values in fewer requests and with the same values", ({ values, count }) =>
    inStore(async (db) => {
      fill(h.google, FROM, TO, { noZoneMinutes });
      const full = await newData(db).activity(FROM, TO);
      const fullCount = h.google.takeRequests();
      const narrow = await inStore((other) => newData(other).activity(FROM, TO, { values }));
      const narrowCount = h.google.takeRequests();
      expect(narrowCount).toEqual(count);
      expect(narrowCount.total).toBeLessThan(fullCount.total as number);
      const read = new Set<string>(values);
      const wants = { steps: read.has("steps"), azm: read.has("azm") || read.has("worn"), kcal: read.has("total_calories") };
      for (const date of DAYS) {
        const [a, b] = [full.days.get(date), narrow.days.get(date)];
        if (wants.steps) expect(b?.steps, date).toBe(a?.steps);
        if (wants.azm) expect([b?.azm, b?.worn], date).toEqual([a?.azm, a?.worn]);
        if (wants.kcal) expect(b?.totalKcal, date).toBe(a?.totalKcal);
      }
      const series: [boolean, (typeof ACTIVITY_KEYS)[number]][] = [
        [wants.steps, KEY_STEPS],
        [wants.azm, KEY_AZM],
        [wants.kcal, KEY_TOTAL_CALORIES],
      ];
      for (const [wanted, key] of series) {
        if (wanted) {
          expect(render(narrow.series(key)), key).toBe(render(full.series(key)));
          expect(render(narrow.baselineSeries(key)), key).toBe(render(full.baselineSeries(key)));
        } else {
          // A series of a value that was not read would be all null: it throws.
          expect(() => narrow.series(key), key).toThrow("healthdata: the activity series was not read");
        }
      }
    }),
  );

  it("serves a narrow read from the cache once the zone minutes of its days are known, and a full read still fetches the whole day", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO, { noZoneMinutes });
      const data = newData(db);
      const first = await data.activity(FROM, TO, { values: ["steps"] });
      h.google.takeRequests();
      // No zone-minutes value is known yet, so no steps row was kept: the read is sent again.
      expect(metricRange(db, KEY_STEPS, FROM, TO, ALGO_VERSION)).toEqual([]);
      const second = await data.activity(FROM, TO, { values: ["steps"] });
      expect(h.google.takeRequests()).toEqual({ total: 1, "rollup steps": 1 });
      expect(render(second.series(KEY_STEPS))).toBe(render(first.series(KEY_STEPS)));
      // A day is a hit for the Go server only with all three rows.
      const full = await data.activity(FROM, TO);
      expect(h.google.takeRequests().total).toBe(9);
      expect([...full.days]).toEqual([...(await inStore((other) => newData(other).activity(FROM, TO))).days]);
      h.google.takeRequests();
      // Now every day has its zone-minutes row: a narrow read comes from the cache.
      for (const values of [["steps"], ["total_calories"], ["azm"], ["total_calories", "worn"]] as const) {
        const narrow = await data.activity(FROM, TO, { values });
        expect(h.google.takeRequests(), values.join()).toEqual({ total: 0 });
        expect(narrow.days.size, values.join()).toBe(60);
      }
      expect(render((await data.activity(FROM, TO, { values: ["steps"] })).series(KEY_STEPS))).toBe(render(first.series(KEY_STEPS)));
    }));

  it("caches a steps or total-calories row only for a day whose zone-minutes row is in the cache", () =>
    inStore(async (db) => {
      fill(h.google, "2026-09-01", "2026-09-10");
      const data = newData(db);
      const cachedDays = (key: string) => metricRange(db, key, "2026-09-01", "2026-09-10", ALGO_VERSION).map((row) => row.date);
      // Zone minutes are read for the first five days only.
      await data.activity("2026-09-01", "2026-09-05", { values: ["azm"] });
      expect(cachedDays(KEY_AZM)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
      h.google.takeCalls();

      for (const [values, key, rollup] of [
        [["steps"], KEY_STEPS, "rollup steps"],
        [["total_calories"], KEY_TOTAL_CALORIES, "rollup total-calories"],
      ] as const) {
        const first = await data.activity("2026-09-01", "2026-09-10", { values });
        expect(h.google.takeCalls(), key).toEqual([`${rollup} 2026-09-01..2026-09-10`]);
        // The read caches the days the band is known to have recorded, and no other day.
        expect(cachedDays(key), key).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
        // It did not write a zone-minutes row itself.
        expect(cachedDays(KEY_AZM), key).toHaveLength(5);
        // The next read asks only for the days without a zone-minutes row.
        const second = await data.activity("2026-09-01", "2026-09-10", { values });
        expect(h.google.takeCalls(), key).toEqual([`${rollup} 2026-09-06..2026-09-10`]);
        expect(render(second.series(key)), key).toBe(render(first.series(key)));
        expect(second.days.size, key).toBe(10);
        // A narrow read never reports zone minutes or "worn" from the rows it only looked at.
        expect([...second.days.values()].every((day) => day.azm === null && !day.worn), key).toBe(true);
      }
    }));

  // Band data can reach Google days later (the band syncs after the day
  // settled). A day without band data is never a cached day, so the next read
  // of any kind gets the new totals.
  it.each([
    { name: "steps alone", values: ["steps"] as const },
    { name: "total calories alone", values: ["total_calories"] as const },
    { name: "every value", values: undefined },
  ])("reads $name again for a settled day whose band data arrived late", ({ values }) =>
    inStore(async (db) => {
      const day = "2026-09-10";
      // Before the sync: steps of another source and a resting estimate; no zone-minutes row, no step record of the band.
      h.google.addRollup("steps", stepsRollup(day, 3000));
      h.google.addRollup("total-calories", kcalRollup(day, 1700));
      const data = newData(db);
      const before = (await data.activity(day, day, values ? { values } : {})).days.get(day);
      if (!values || values[0] === "steps") expect(before?.steps).toBe(3000);
      if (!values || values[0] === "total_calories") expect(before?.totalKcal).toBe(1700);
      if (!values) expect(before).toEqual({ steps: 3000, azm: null, totalKcal: 1700, worn: false, partial: false });
      // Nothing of the day is cached: the band did not record it.
      for (const key of ACTIVITY_KEYS) expect(metricRange(db, key, day, day, ALGO_VERSION), key).toEqual([]);

      // After the sync: a zone-minutes row, and new totals.
      const synced = new FakeGoogle();
      synced.addRollup("steps", stepsRollup(day, 9000));
      synced.addRollup("total-calories", kcalRollup(day, 2600));
      synced.addRollup("active-zone-minutes", azmRollup(day, 20, 5, 0));
      synced.install();
      const after = (await data.activity(day, day, values ? { values } : {})).days.get(day);
      if (!values || values[0] === "steps") expect(after?.steps).toBe(9000);
      if (!values || values[0] === "total_calories") expect(after?.totalKcal).toBe(2600);
      if (!values) expect(after).toEqual({ steps: 9000, azm: 25, totalKcal: 2600, worn: true, partial: false });
      expect(synced.takeRequests().total).toBeGreaterThan(0);
      // The band recorded the day now: the full read caches all three rows.
      if (!values) {
        for (const key of ACTIVITY_KEYS) expect(metricRange(db, key, day, day, ALGO_VERSION), key).toHaveLength(1);
        await data.activity(day, day);
        expect(synced.takeRequests()).toEqual({ total: 0 });
      }
    }),
  );

  describe("the days option", () => {
    const [first, last] = ["2026-09-01", "2026-09-20"];

    it("reads only the listed days, in windows planned over them", () =>
      inStore(async (db) => {
        fill(h.google, first, last);
        const data = newData(db);
        // Unsorted, with a day twice: the list is a set of days.
        const days = ["2026-09-18", "2026-09-02", "2026-09-05", "2026-09-02"];
        const a = await data.activity(first, last, { values: ["total_calories"], days });
        // One 14-day window from 09-02 holds 09-02 and 09-05; 09-18 starts the next one.
        expect(h.google.takeCalls()).toEqual(["rollup total-calories 2026-09-02..2026-09-05", "rollup total-calories 2026-09-18..2026-09-18"]);
        // The rows of 09-03 and 09-04 came back in the first page and were dropped.
        expect([...a.days.keys()]).toEqual(["2026-09-02", "2026-09-05", "2026-09-18"]);
        expect([...a.days.values()].map((day) => day.totalKcal)).toEqual([2201, 2204, 2217]);
        // The series covers the range: a day that was not asked for is null.
        expect(a.series(KEY_TOTAL_CALORIES).filter((point) => point.value !== null).map((point) => point.date)).toEqual([
          "2026-09-02",
          "2026-09-05",
          "2026-09-18",
        ]);
        expect(a.series(KEY_TOTAL_CALORIES)).toHaveLength(20);
      }));

    it("reads every value of the listed days, and caches only them", () =>
      inStore(async (db) => {
        fill(h.google, first, last);
        const data = newData(db);
        const some = await data.activity(first, last, { days: ["2026-09-03", "2026-09-04", "2026-09-10"] });
        expect(h.google.takeCalls()).toEqual([
          "rollup steps 2026-09-03..2026-09-10",
          "rollup active-zone-minutes 2026-09-03..2026-09-10",
          "rollup total-calories 2026-09-03..2026-09-10",
        ]);
        expect([...some.days]).toEqual([
          ["2026-09-03", { steps: 6002, azm: 16, totalKcal: 2202, worn: true, partial: false }],
          ["2026-09-04", { steps: 6003, azm: 17, totalKcal: 2203, worn: true, partial: false }],
          ["2026-09-10", { steps: 6009, azm: 16, totalKcal: 2209, worn: true, partial: false }],
        ]);
        for (const key of ACTIVITY_KEYS) {
          expect(metricRange(db, key, first, last, ALGO_VERSION).map((row) => row.date), key).toEqual(["2026-09-03", "2026-09-04", "2026-09-10"]);
        }
        // The listed days now come from the cache; a read of the whole range fetches the others.
        h.google.takeRequests();
        await data.activity(first, last, { days: ["2026-09-10", "2026-09-03"] });
        expect(h.google.takeRequests()).toEqual({ total: 0 });
        const all = await data.activity(first, last);
        expect(h.google.takeCalls()).toEqual([
          "rollup steps 2026-09-01..2026-09-20",
          "rollup active-zone-minutes 2026-09-01..2026-09-20",
          "rollup total-calories 2026-09-01..2026-09-14",
          "rollup total-calories 2026-09-15..2026-09-20",
        ]);
        expect([...all.days]).toEqual([...(await inStore((other) => newData(other).activity(first, last))).days]);
      }));

    it("checks the band only for the listed days without a zone-minutes row", () =>
      inStore(async (db) => {
        // No zone-minutes row on 09-03, 09-07 and 09-11: the band counted steps there.
        fill(h.google, first, last, { noZoneMinutes: (index) => index % 4 === 2 && index < 12 });
        const a = await newData(db).activity(first, last, { values: ["worn"], days: ["2026-09-06", "2026-09-07", "2026-09-08"] });
        expect(h.google.takeCalls()).toEqual(["rollup active-zone-minutes 2026-09-06..2026-09-08", "steps 2026-09-07..2026-09-07"]);
        expect([...a.days].map(([day, value]) => [day, value.azm, value.worn])).toEqual([
          ["2026-09-06", 19, true],
          ["2026-09-07", 0, true],
          ["2026-09-08", 14, true],
        ]);
      }));

    it("makes no request for an empty list", () =>
      inStore(async (db) => {
        fill(h.google, first, last);
        const a = await newData(db).activity(first, last, { days: [] });
        expect(h.google.takeRequests()).toEqual({ total: 0 });
        expect(a.days.size).toBe(0);
        expect(a.series(KEY_STEPS).every((point) => point.value === null)).toBe(true);
      }));

    it("refuses a day outside the range, before any request", () =>
      inStore(async (db) => {
        fill(h.google, first, last);
        const data = newData(db);
        for (const day of ["2026-08-31", "2026-09-21", "2026-09-31", "soon", ""]) {
          await expect(data.activity(first, last, { days: ["2026-09-05", day] }), day).rejects.toThrow("healthdata: a day to read is outside the range");
        }
        // The range itself is still checked.
        await expect(data.activity(last, first, { days: [] })).rejects.toThrow();
        expect(h.google.takeRequests()).toEqual({ total: 0 });
      }));
  });

  it("keeps a day the band recorded in a read of worn alone, also when a dropped row hides its zone minutes", () =>
    inStore(async (db) => {
      // The band counted steps on 09-03 without zone minutes.
      fill(h.google, "2026-09-01", "2026-09-07", { noZoneMinutes: (index) => index === 2 });
      // A zone-minutes row of the same run cannot be read: the run gets no 0.
      h.google.addRollup("active-zone-minutes", { civilStartTime: { date: { year: 2026, month: 9, day: 5 } }, activeZoneMinutes: {} });
      const data = newData(db);
      const band = await data.activity("2026-09-01", "2026-09-07", { values: ["worn"] });
      expect(band.skipped).toBe(1);
      // The day has no value this read asked for, but it is a day with the band.
      expect(band.days.get("2026-09-03")).toEqual({ steps: null, azm: null, totalKcal: null, worn: true, partial: false });
      expect(band.days.size).toBe(7);
      // The run is not cached, as in the Go server.
      expect(metricRange(db, KEY_AZM, "2026-09-01", "2026-09-07", ALGO_VERSION)).toEqual([]);
      // The read of every value is the Go server's: the day shows its totals.
      const full = await data.activity("2026-09-01", "2026-09-07");
      expect(full.days.get("2026-09-03")).toEqual({ steps: 6002, azm: null, totalKcal: 2202, worn: true, partial: false });
    }));

  it("leaves the finished windows cached when the budget runs out, so the same call then needs fewer requests", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO);
      const totals: number[] = [];
      let result: Awaited<ReturnType<Source["activity"]>> | undefined;
      // Each MCP request may send 4 requests. The cold call needs 7.
      for (let request = 0; request < 3 && !result; request++) {
        try {
          result = await oneRequest(db, new RequestBudget(4)).activity(FROM, TO);
        } catch (error) {
          expect((error as ToolError).wire()).toEqual({ ...BUDGET_ERROR, message: "the date range holds more total-calories data than one call reads" });
        }
        totals.push(h.google.takeRequests().total as number);
      }
      // Steps, zone minutes and two windows; then two more windows; then the last one.
      expect(totals).toEqual([4, 4, 3]);
      expect([...(result?.days ?? [])]).toEqual([...(await inStore((other) => newData(other).activity(FROM, TO))).days]);
    }));
});

describe("request counts: body and exercises", () => {
  it("reads only weight, or only body fat, in fewer requests and with the same values", () =>
    inStore(async (db) => {
      fill(h.google, FROM, TO);
      const full = await newData(db).body(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 2, weight: 1, "body-fat": 1 });
      const weight = await inStore((other) => newData(other).body(FROM, TO, { values: ["weight"] }));
      expect(h.google.takeRequests()).toEqual({ total: 1, weight: 1 });
      expect([...weight.weight]).toEqual([...full.weight]);
      expect(render(weight.series(KEY_WEIGHT))).toBe(render(full.series(KEY_WEIGHT)));
      expect(weight.bodyFat.size).toBe(0);
      expect(() => weight.series(KEY_BODY_FAT)).toThrow("healthdata: the body series was not read");
      const bodyFat = await inStore((other) => newData(other).body(FROM, TO, { values: ["body_fat"] }));
      expect(h.google.takeRequests()).toEqual({ total: 1, "body-fat": 1 });
      expect([...bodyFat.bodyFat]).toEqual([...full.bodyFat]);
      expect(render(bodyFat.series(KEY_BODY_FAT))).toBe(render(full.series(KEY_BODY_FAT)));
      expect(() => bodyFat.series(KEY_WEIGHT)).toThrow("healthdata: the body series was not read");
      // A warm cache: every day of the range has a reading.
      await newData(db).body(FROM, TO);
      expect(h.google.takeRequests()).toEqual({ total: 0 });
    }));

  it("reads sessions without their max heart rate in fewer requests and with the same values", () =>
    inStore(async (db) => {
      for (let i = 0; i < 6; i++) {
        const start = at(addDays("2026-09-01", i) as string, 19, 0);
        const end = new Date(start.getTime() + 3_600_000);
        h.google.add("exercise", exerciseRec(start, end, { type: "RUNNING", avgHR: 150, zones: [10, 20, 20, 10] }));
        h.google.add("heart-rate", ...samplesEvery2s(start, new Date(start.getTime() + 60_000), 160 + i));
      }
      const data = newData(db);
      const withMax = await data.exercises("2026-09-01", "2026-09-06", true);
      expect(h.google.takeRequests()).toEqual({ total: 7, exercise: 1, "heart-rate": 6 });
      const without = await data.exercises("2026-09-01", "2026-09-06", false);
      expect(h.google.takeRequests()).toEqual({ total: 1, exercise: 1 });
      expect(withMax.sessions.map((session) => session.hr?.maxBpm)).toEqual([160, 161, 162, 163, 164, 165]);
      const strip = (sessions: typeof withMax.sessions) => sessions.map((session) => ({ ...session, hr: session.hr && { ...session.hr, maxBpm: null } }));
      expect(without.sessions).toEqual(strip(withMax.sessions));
    }));

  it("passes the budget error on when the max heart rate lookups use the budget up", () =>
    inStore(async (db) => {
      for (let i = 0; i < 6; i++) {
        const start = at(addDays("2026-09-01", i) as string, 19, 0);
        h.google.add("exercise", exerciseRec(start, new Date(start.getTime() + 3_600_000), { type: "RUNNING", avgHR: 150, zones: [10, 20, 20, 10] }));
      }
      const error = await oneRequest(db, new RequestBudget(4))
        .exercises("2026-09-01", "2026-09-06", true)
        .catch((e: unknown) => e);
      expect((error as ToolError).wire()).toEqual({ ...BUDGET_ERROR, message: "the date range holds more heart-rate data than one call reads" });
      expect(h.google.takeRequests()).toEqual({ total: 4, exercise: 1, "heart-rate": 3 });
    }));
});

describe("one MCP request over a year", () => {
  const [YEAR_FROM, YEAR_TO] = ["2025-10-16", "2026-10-16"];

  it("reads a year in windows, and a year of recovery and activity in three requests", () =>
    inStore(async (db) => {
      fill(h.google, YEAR_FROM, YEAR_TO);
      // Request 1: recovery reads the whole year; activity stops at the budget.
      const first = oneRequest(db);
      const recovery = await first.recovery(YEAR_FROM, YEAR_TO);
      expect(h.google.takeRequests()).toEqual({ total: 25, sleep: 18, "heart-rate-variability": 6, "daily-resting-heart-rate": 1 });
      expect(recovery.nights.size).toBe(MAX_RANGE_DAYS);
      const error = await first.activity(YEAR_FROM, YEAR_TO).catch((e: unknown) => e);
      expect((error as ToolError).wire()).toEqual({ ...BUDGET_ERROR, message: "the date range holds more total-calories data than one call reads" });
      expect(h.google.takeRequests()).toEqual({ total: 20, "rollup steps": 3, "rollup active-zone-minutes": 3, "rollup total-calories": 14 });

      // Request 2: only the live days of recovery, and the rest of activity.
      const second = oneRequest(db);
      assertSame(recovery, await second.recovery(YEAR_FROM, YEAR_TO));
      expect(h.google.takeRequests()).toEqual({ total: 3, sleep: 1, "heart-rate-variability": 1, "daily-resting-heart-rate": 1 });
      const activity = await second.activity(YEAR_FROM, YEAR_TO);
      expect(h.google.takeRequests()).toEqual({ total: 17, "rollup steps": 2, "rollup active-zone-minutes": 2, "rollup total-calories": 13 });
      expect(activity.days.size).toBe(MAX_RANGE_DAYS);

      // Every day holds the values of its own records, whatever window read it.
      dayList(YEAR_FROM, YEAR_TO).forEach((date, i) => {
        expect(recovery.nights.get(date), date).toMatchObject({ asleepMin: 440, stages: { deepMin: 50 + (i % 30) }, hrv: { medianMs: 30 + (i % 40), coverage: 1 } });
        expect(recovery.restingHR.get(date), date).toEqual({ bpm: 48 + (i % 20), method: "WITH_SLEEP" });
        expect(activity.days.get(date), date).toEqual({ steps: 6000 + i, azm: 14 + (i % 7), totalKcal: 2200 + i, worn: true, partial: date === YEAR_TO });
      });

      // Request 3: the live days only.
      const third = oneRequest(db);
      await third.recovery(YEAR_FROM, YEAR_TO);
      const again = await third.activity(YEAR_FROM, YEAR_TO);
      expect(h.google.takeRequests()).toEqual({
        total: 6,
        sleep: 1,
        "heart-rate-variability": 1,
        "daily-resting-heart-rate": 1,
        "rollup steps": 1,
        "rollup active-zone-minutes": 1,
        "rollup total-calories": 1,
      });
      expect([...again.days]).toEqual([...activity.days]);
    }));

  it.each([
    { name: "resting heart rate", count: { total: 1, "daily-resting-heart-rate": 1 }, read: (data: Source) => data.recovery(YEAR_FROM, YEAR_TO, { values: ["resting_hr"] }) },
    { name: "steps", count: { total: 5, "rollup steps": 5 }, read: (data: Source) => data.activity(YEAR_FROM, YEAR_TO, { values: ["steps"] }) },
    { name: "total calories", count: { total: 27, "rollup total-calories": 27 }, read: (data: Source) => data.activity(YEAR_FROM, YEAR_TO, { values: ["total_calories"] }) },
    { name: "the whole activity", count: { total: 37, "rollup steps": 5, "rollup active-zone-minutes": 5, "rollup total-calories": 27 }, read: (data: Source) => data.activity(YEAR_FROM, YEAR_TO) },
    { name: "weight", count: { total: 1, weight: 1 }, read: (data: Source) => data.body(YEAR_FROM, YEAR_TO, { values: ["weight"] }) },
  ])("reads a year of $name inside the budget of one request", ({ count, read }) =>
    inStore(async (db) => {
      fill(h.google, YEAR_FROM, YEAR_TO);
      await read(oneRequest(db));
      const requests = h.google.takeRequests();
      expect(requests).toEqual(count);
      expect(requests.total).toBeLessThanOrEqual(HEALTH_REQUESTS);
    }),
  );
});

describe("log lines and errors", () => {
  it("carry no health value, token or response body", () =>
    inStore(async (db) => {
      // Values with digits that appear nowhere else, and records that cannot be read.
      const [from, to] = ["2026-10-08", "2026-10-10"];
      h.google.add("sleep", sleepRec(at("2026-10-09", 23, 0), at("2026-10-10", 7, 0), { deep: 77, asleep: 431 }));
      h.google.add("sleep", { dataSource: { platform: "FITBIT" }, sleep: { summary: { minutesAsleep: "7391 secret" } } });
      h.google.add("heart-rate-variability", ...hrvNight(at("2026-10-09", 23, 0), at("2026-10-10", 7, 0), 73.91));
      h.google.add("heart-rate-variability", { dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: {}, note: "7391" } });
      h.google.add("daily-resting-heart-rate", restingRec("2026-10-10", 7391, "WITH_SLEEP", "FITBIT"), restingRec("2026-10-09", 57, "WITH_SLEEP", "FITBIT"));
      h.google.addRollup("steps", stepsRollup("2026-10-10", 739_100), stepsRollup("2026-10-09", 7391));
      h.google.addRollup("total-calories", kcalRollup("2026-10-10", 73_910));
      h.google.add("weight", weightRec(at("2026-10-10", 7, 0), 7391, "FITBIT"), weightRec(at("2026-10-09", 7, 0), 73_910, "FITBIT"));
      h.google.add("exercise", exerciseRec(at("2026-10-10", 19, 0), at("2026-10-10", 20, 0), { type: "SECRET_SPORT_7391", avgHR: 7391 }));
      h.google.add("nutrition-log", foodRec(at("2026-10-10", 12, 0), { kcal: 739.1, name: "users/me/dataTypes/nutrition-log/dataPoints/7391" }), { nutritionLog: { foodDisplayName: "secret 7391" } });
      const data = newData(db, { cache: { ...dbCache(db), putMetric: () => { throw new RangeError("value 7391 refused"); } } });

      const results = [
        await data.recovery(from, to),
        await data.activity(from, to),
        await data.body(from, to),
        await data.exercises(from, to, true),
        await data.nutrition(from, to),
      ] as const;
      // The values were read: they are in the results, not in the logs.
      const [recovery, activity, body, exercises, nutrition] = results;
      expect(recovery.nights.get("2026-10-10")?.hrv.medianMs).toBe(73.91);
      expect(activity.days.get("2026-10-09")?.steps).toBe(7391);
      expect(body.weight.get("2026-10-09")?.value).toBe(73.91);
      expect(nutrition.days.get("2026-10-10")?.totals.kcal?.value).toBe(739.1);
      expect([recovery.skipped, activity.skipped, body.skipped, exercises.skipped, nutrition.skipped]).toEqual([3, 2, 1, 1, 1]);
      const lines = h.warnings();
      expect(lines).toEqual([
        ["unreadable records in a recovery fetch", { from, to, skipped: 2 }],
        ["unreadable resting heart rate records", { from, to, skipped: 1 }],
        ["cache write failed", { metric: "resting_hr_bpm", date: "2026-10-09", error_types: "RangeError" }],
        ["unreadable daily rollup rows", { data_type: "steps", from, to, skipped: 1 }],
        ["unreadable daily rollup rows", { data_type: "total-calories", from, to, skipped: 1 }],
        ["unreadable body records", { from, to, skipped: 1 }],
        ["unreadable exercise records", { from, to, skipped: 1 }],
        ["unreadable nutrition records", { from, to, skipped: 1 }],
      ]);
      for (const text of ["7391", "73.91", "739", "secret", "SECRET", "at-synthetic", "Synthetic", "dataSource", "refused"]) {
        expect(h.logged(), text).not.toContain(text);
      }
    }));

  it("an API error body never reaches the error of a source", () =>
    inStore(async (db) => {
      h.google.fail = () => Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "user 7391 has weight 80.5 kg" } }, { status: 403 });
      const data = newData(db);
      for (const call of [
        () => data.recovery(FROM, TO),
        () => data.activity(FROM, TO),
        () => data.body(FROM, TO),
        () => data.exercises(FROM, TO, true),
        () => data.nutrition(FROM, TO),
      ]) {
        const error = (await call().catch((e: unknown) => e)) as ToolError;
        expect(error.code).toBe("scope_missing");
        for (let link: unknown = error; link instanceof Error; link = link.cause) {
          expect(`${link.message} ${link instanceof ToolError ? link.hint : ""}`).not.toMatch(/7391|80\.5/);
        }
      }
      expect(h.logged()).not.toMatch(/7391|80\.5/);
    }));
});
