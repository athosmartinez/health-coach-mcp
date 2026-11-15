// Ports of internal/healthdata/recovery_test.go: the nights, the HRV rules,
// resting heart rate and what is cached.
import { describe, expect, it } from "vitest";

import { UTC, Zone, addDays } from "../src/coach/date";
import { ToolError, toWire } from "../src/coach/errors";
import {
  ACTIVITY_KEYS,
  BODY_KEYS,
  type Excluded,
  HealthData,
  KEY_ASLEEP,
  KEY_DEEP,
  KEY_HRV,
  KEY_REM,
  KEY_RESTING_HR,
  KEY_SLEEP_END,
  KEY_SLEEP_START,
  MAX_RANGE_DAYS,
  type Night,
  RECOVERY_KEYS,
  Recovery,
  type RecoveryKey,
  SLEEP_KEYS,
  dbCache,
  hrvWithheld,
  restingStandard,
} from "../src/healthdata";
import type { Fetcher } from "../src/healthdata/cache";
import { coverage, coveredSlots, median, nightWindow, slotCount } from "../src/healthdata/recovery";
import { ALGO_VERSION, baseline } from "../src/metrics/stats";
import { METRIC_KEYS, clearMetrics, deleteMetric, metricRange, putMetric } from "../src/store/metrics";
import {
  type CacheFailures,
  DiskError,
  MINUTE,
  NOW,
  SECOND,
  SP,
  assertSame,
  at,
  cachedKeys,
  failingCache,
  harness,
  hrvEvery,
  hrvNight,
  hrvRec,
  inStore,
  newData,
  oneNight,
  plus,
  render,
  restingRec,
  rfc3339,
  sleepRec,
  week,
} from "./healthdata-helpers";
import { SAO_PAULO } from "./memory-helpers";

const h = harness();

const NO_EXCLUDED: Excluded = { otherSource: 0, naps: 0, extraSessions: 0, noHRVValue: 0, unknownSleepType: 0 };

const D10 = "2026-10-10";

/** The night of a day, which must exist. */
function nightOf(r: Recovery, date: string): Night {
  const night = r.nights.get(date);
  if (!night) throw new Error(`no night on ${date}`);
  return night;
}

describe("nights", () => {
  it("puts a night on the day it ends", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 23, 10), at(D10, 7, 40), { deep: 70 }),
        sleepRec(at(D10, 14, 0), at(D10, 14, 20), { nap: true }),
        // A longer copy from the phone is not the band's night.
        sleepRec(at("2026-10-09", 22, 0), at(D10, 8, 0), { platform: "HEALTH_KIT", deep: 10 }),
      );
      // The 23:30 samples belong to the night that ends the next morning.
      h.google.add("heart-rate-variability", ...hrvNight(at("2026-10-09", 23, 30), at(D10, 7, 30), 42));
      h.google.add("heart-rate-variability", hrvRec(at(D10, 14, 10), 99)); // during the nap
      const r = await newData(db).recovery("2026-10-09", D10);
      expect(r.nights.has("2026-10-09")).toBe(false);
      expect(nightOf(r, D10)).toEqual({
        asleepMin: 470,
        awakeMin: 40,
        inBedMin: 510,
        stages: { deepMin: 70, lightMin: 306, remMin: 94 },
        startMinOfDay: 23 * 60 + 10,
        endMinOfDay: 7 * 60 + 40,
        start: at("2026-10-09", 23, 10),
        end: at(D10, 7, 40),
        // 97 samples fill 97 of the night's 102 five-minute slots.
        hrv: { medianMs: 42, coverage: 97 / 102 },
        source: "Synthetic Band",
        provisional: false,
      } satisfies Night);
      expect(r.sources).toEqual(["Synthetic Band"]);
      expect(r.skipped).toBe(0);
      expect(r.empty).toEqual([]);
      expect(r.excluded).toEqual({ ...NO_EXCLUDED, otherSource: 1, naps: 1 });
    }));

  it("reads a cached night back with its window", () =>
    inStore(async (db) => {
      // One night starts before midnight, the other after it: both read back
      // on the right dates, to the minute.
      h.google.add(
        "sleep",
        sleepRec(plus(at("2026-10-09", 23, 50), 40 * SECOND), plus(at(D10, 7, 5), 20 * SECOND), { deep: 60 }),
        sleepRec(at("2026-10-11", 0, 30), at("2026-10-11", 8, 0), { deep: 60 }),
      );
      const data = newData(db);
      const live = await data.recovery(D10, "2026-10-11");
      expect(nightOf(live, D10).start).toEqual(at("2026-10-09", 23, 50));
      expect(nightOf(live, D10).end).toEqual(at(D10, 7, 5));
      h.google.takeCalls();
      const warm = await data.recovery(D10, "2026-10-11");
      // Resting HR has no records here, so only its fetch repeats.
      expect(h.google.takeCalls().filter((call) => call.startsWith("sleep "))).toEqual([]);
      assertSame(live, warm);
      expect(nightOf(warm, "2026-10-11").start).toEqual(at("2026-10-11", 0, 30));

      // A night cached before the end row existed is a miss, not a night without an end.
      deleteMetric(db, "2026-10-11", KEY_SLEEP_END);
      const again = await data.recovery("2026-10-11", "2026-10-11");
      expect(h.google.takeCalls()).toContain("sleep 2026-10-10..2026-10-12");
      expect(nightOf(again, "2026-10-11").end).toEqual(at("2026-10-11", 8, 0));

      // A stored minute outside a day is a miss too.
      putMetric(db, { date: "2026-10-11", key: KEY_SLEEP_END, value: 24 * 60, source: "Synthetic Band", algoVersion: ALGO_VERSION, zone: SP });
      await data.recovery("2026-10-11", "2026-10-11");
      expect(h.google.takeCalls()).toContain("sleep 2026-10-10..2026-10-12");

      // Stage rows are all or none: a night missing one is a miss, not a night
      // with partial stages.
      deleteMetric(db, D10, KEY_REM);
      const partial = await data.recovery(D10, D10);
      expect(h.google.takeCalls()).toContain("sleep 2026-10-09..2026-10-11");
      expect(nightOf(partial, D10).stages).not.toBeNull();
    }));

  it("takes the longest session as the night", () =>
    inStore(async (db) => {
      // An unflagged midday session and the real night end the same day, hours apart.
      h.google.add(
        "sleep",
        sleepRec(at(D10, 12, 0), at(D10, 13, 30), { deep: 5 }),
        sleepRec(at("2026-10-09", 22, 0), at(D10, 4, 30), { deep: 50 }),
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ inBedMin: 390, stages: { deepMin: 50 } });
      expect(r.excluded.extraSessions).toBe(1);
    }));

  it("keeps the later of two equal sessions", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at(D10, 0, 0), at(D10, 4, 0), { deep: 30 }), sleepRec(at(D10, 14, 0), at(D10, 18, 0), { deep: 40 }));
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).stages?.deepMin).toBe(40);
    }));

  it("joins a night split by a wake-up", () =>
    inStore(async (db) => {
      // A wake-up at 01:30 splits the night; 45 minutes later sleep resumes.
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 22, 30), at(D10, 1, 30), { deep: 40, asleep: 160 }),
        sleepRec(at(D10, 2, 15), at(D10, 7, 0), { deep: 30, asleep: 255 }),
      );
      h.google.add("heart-rate-variability", ...hrvNight(at("2026-10-09", 22, 30), at(D10, 1, 25), 40));
      h.google.add("heart-rate-variability", ...hrvNight(at(D10, 1, 35), at(D10, 2, 10), 99)); // awake between parts
      h.google.add("heart-rate-variability", ...hrvNight(at(D10, 2, 15), at(D10, 6, 55), 60));
      const data = newData(db);
      const r = await data.recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({
        inBedMin: 465,
        asleepMin: 415,
        awakeMin: 50,
        stages: { deepMin: 70, remMin: 32 + 51 },
        startMinOfDay: 22 * 60 + 30,
        start: at("2026-10-09", 22, 30),
        end: at(D10, 7, 0),
        // The median runs over both parts (36 samples at 40, 57 at 60), not the gap.
        hrv: { medianMs: 60, coverage: 1 },
      });
      expect(r.excluded.extraSessions).toBe(0);
      // A cached split night reads back the same.
      assertSame(r, await data.recovery(D10, D10));
    }));

  it("has no stages when a part of a split night has none", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 23, 0), at(D10, 2, 0), { deep: 40 }),
        sleepRec(at(D10, 3, 0), at(D10, 7, 0), { pending: true }),
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ inBedMin: 420, stages: null, provisional: true });
      // A night with a part still processing is not cached.
      expect(metricRange(db, KEY_ASLEEP, D10, D10, ALGO_VERSION)).toEqual([]);
    }));

  it("does not cache a split night whose first part is unprocessed", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 23, 0), at(D10, 2, 0), { deep: 40, unprocessed: true }),
        sleepRec(at(D10, 3, 0), at(D10, 7, 0), { deep: 40 }),
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).provisional).toBe(true);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("does not cache an unprocessed classic night", () =>
    inStore(async (db) => {
      oneNight(h.google, { classic: true, unprocessed: true });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).provisional).toBe(true);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("joins sessions that touch", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 22, 0), at(D10, 2, 0), { deep: 40 }),
        sleepRec(at(D10, 2, 0), at(D10, 6, 0), { deep: 30 }),
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ inBedMin: 480, stages: { deepMin: 70 } });
      expect(r.excluded.extraSessions).toBe(0);
    }));

  it("does not sum overlapping copies", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 23, 0), at(D10, 7, 0), { deep: 60 }),
        sleepRec(at("2026-10-09", 23, 30), at(D10, 6, 30), { deep: 10 }), // a reprocessed copy
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ inBedMin: 480, stages: { deepMin: 60 } });
      expect(r.excluded.extraSessions).toBe(1);
    }));

  it("keeps the longer copy even when it starts later", () =>
    inStore(async (db) => {
      h.google.add(
        "sleep",
        sleepRec(at("2026-10-09", 23, 0), at(D10, 6, 0), { deep: 10 }),
        sleepRec(at("2026-10-09", 23, 30), at(D10, 7, 30), { deep: 60 }),
      );
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ inBedMin: 480, stages: { deepMin: 60 } });
    }));

  it("has no night when the day holds only a nap", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at(D10, 14, 0), at(D10, 14, 20), { nap: true }));
      const data = newData(db);
      const r = await data.recovery(D10, D10);
      expect(r.nights.size).toBe(0);
      expect(r.empty).toEqual([]);
      expect(r.excluded.naps).toBe(1);
      // A missing value is never cached: the next call asks again.
      expect(metricRange(db, KEY_ASLEEP, D10, D10, ALGO_VERSION)).toEqual([]);
      h.google.takeCalls();
      await data.recovery(D10, D10);
      expect(h.google.takeCalls()).toHaveLength(3);
    }));

  it("leaves out the night after the range", () =>
    inStore(async (db) => {
      week(h.google);
      // The fetch reaches 10-11 for margin; that night is not part of the answer.
      const r = await newData(db).recovery(D10, D10);
      expect([...r.nights.keys()]).toEqual([D10]);
    }));

  it("reads nights in a zone ahead of UTC", () =>
    inStore(async (db) => {
      const tokyo = new Zone("Asia/Tokyo");
      // 23:00 → 06:30 Tokyo ends at 21:30Z the day before.
      const [start, end] = [new Date("2026-10-09T23:00:00+09:00"), new Date("2026-10-10T06:30:00+09:00")];
      h.google.add("sleep", sleepRec(start, end, { deep: 60 }));
      h.google.add("heart-rate-variability", ...hrvNight(start, plus(end, -5 * MINUTE), 50));
      h.google.loose = true; // the fake filters in São Paulo days
      const data = newData(db, { zone: tokyo });
      const r = await data.recovery(D10, D10);
      expect(nightOf(r, D10).startMinOfDay).toBe(23 * 60);
      expect(nightOf(r, D10).hrv.medianMs).not.toBeNull();
      h.google.takeCalls();
      const again = await data.recovery(D10, D10);
      // Only resting heart rate is asked again: the Tokyo night is a cache hit.
      expect(h.google.takeCalls()).toHaveLength(1);
      assertSame(r, again);
    }));

  it("gives the sleep end series as the minute of the day", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at("2026-10-09", 23, 0), at(D10, 7, 5), { deep: 60 }));
      const r = await newData(db).recovery(D10, D10);
      expect(render(r.baselineSeries(KEY_SLEEP_END))).toBe("2026-10-10=425 ");
    }));
});

describe("the cache", () => {
  it("serves settled days from the cache", () =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db);
      const first = await data.recovery("2026-10-07", "2026-10-15");
      expect(h.google.takeCalls()).toHaveLength(3);
      const second = await data.recovery("2026-10-07", "2026-10-15");
      // D-3 (10-13) and older come from the cache; D-2 onward is fetched live.
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-10-13..2026-10-16",
        "heart-rate-variability 2026-10-13..2026-10-15",
        "daily-resting-heart-rate 2026-10-14..2026-10-15",
      ]);
      assertSame(first, second);
      expect(nightOf(second, D10)).toMatchObject({ hrv: { coverage: 1, medianMs: 50 }, source: "Synthetic Band" });
      const resting = second.restingHR.get(D10);
      expect(resting).toEqual({ bpm: 60, method: "WITH_SLEEP" });
      expect(resting && restingStandard(resting)).toBe(true);
    }));

  it("returns the same values with the cache deleted", () =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db);
      const warm = await data.recovery("2026-10-07", "2026-10-15");
      const cached = await data.recovery("2026-10-07", "2026-10-15");
      clearMetrics(db);
      const cold = await data.recovery("2026-10-07", "2026-10-15");
      assertSame(warm, cached);
      assertSame(warm, cold);
    }));

  it("treats a row of another algo version as a miss", () =>
    inStore(async (db) => {
      week(h.google);
      // A row from another derivation of the same day.
      putMetric(db, { date: D10, key: KEY_RESTING_HR, value: 99, zone: SP, algoVersion: ALGO_VERSION + 1 });
      const r = await newData(db).recovery(D10, D10);
      expect(r.restingHR.get(D10)?.bpm).toBe(60);
    }));

  it("treats a row of another zone as a miss", () =>
    inStore(async (db) => {
      week(h.google);
      await newData(db).recovery(D10, D10);
      h.google.takeCalls();
      // The same cache read in another zone: the sleep start minute and the
      // night's day would differ, so every row is fetched again.
      const r = await newData(db, { zone: UTC }).recovery(D10, D10);
      expect(h.google.takeCalls()).toHaveLength(3);
      expect(nightOf(r, D10).startMinOfDay).toBe(2 * 60); // 23:00 −03:00
    }));

  it("treats a row without a zone as a miss", () =>
    inStore(async (db) => {
      week(h.google);
      // Rows written before zones were stored.
      for (const key of SLEEP_KEYS) putMetric(db, { date: D10, key, value: 1, algoVersion: ALGO_VERSION });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).asleepMin).toBe(440);
    }));

  it("fetches only the gap", () =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db);
      // Cache every settled day of 10-07..10-12 except 10-09.
      for (const date of ["2026-10-07", "2026-10-08", "2026-10-10", "2026-10-11", "2026-10-12"]) await data.recovery(date, date);
      h.google.takeCalls();
      await data.recovery("2026-10-07", "2026-10-12");
      expect(h.google.takeCalls()).toEqual([
        "sleep 2026-10-08..2026-10-10",
        "heart-rate-variability 2026-10-08..2026-10-09",
        "daily-resting-heart-rate 2026-10-09..2026-10-09",
      ]);
    }));

  it("does not cache an unprocessed night", () =>
    inStore(async (db) => {
      oneNight(h.google, { deep: 60, unprocessed: true });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).provisional).toBe(true);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("does not cache a night whose stages are still being computed", () =>
    inStore(async (db) => {
      oneNight(h.google, { deep: 60, pending: true });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ stages: null, provisional: true, asleepMin: 440 });
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("caches a classic night without stages", () =>
    inStore(async (db) => {
      oneNight(h.google, { classic: true });
      const data = newData(db);
      const r = await data.recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ stages: null, asleepMin: 440, provisional: false });
      expect(cachedKeys(db, D10)).toEqual(["sleep_asleep_min", "sleep_awake_min", "sleep_in_bed_min", "sleep_start_min_of_day", "sleep_end_min_of_day"]);
      h.google.takeCalls();
      const again = await data.recovery(D10, D10);
      expect(h.google.takeCalls()).toEqual(["daily-resting-heart-rate 2026-10-10..2026-10-10"]);
      assertSame(r, again);
    }));

  it("reads an unknown sleep type without stages and does not cache it", () =>
    inStore(async (db) => {
      oneNight(h.google, { type: "SEGMENTS", deep: 60 });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10)).toMatchObject({ stages: null, provisional: true });
      expect(r.excluded.unknownSleepType).toBe(1);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("reads a stage of zero minutes", () =>
    inStore(async (db) => {
      oneNight(h.google); // no DEEP entry: the API omits zero
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).stages).toEqual({ deepMin: 0, lightMin: 352, remMin: 88 });
    }));

  it("never reads the rows of live days", () =>
    inStore(async (db) => {
      week(h.google);
      // Rows already in the cache for D-2 and D-1 are never read.
      for (const date of ["2026-10-14", "2026-10-15"]) {
        for (const key of [...SLEEP_KEYS, KEY_RESTING_HR]) putMetric(db, { date, key, value: 1, zone: SP, algoVersion: ALGO_VERSION });
      }
      const r = await newData(db).recovery("2026-10-13", "2026-10-15");
      expect(nightOf(r, "2026-10-15").asleepMin).toBe(440);
      expect(r.restingHR.get("2026-10-14")?.bpm).toBe(64);
      expect(cachedKeys(db, "2026-10-13")).toHaveLength(SLEEP_KEYS.length + 2);
    }));

  it("removes a stale HRV row", () =>
    inStore(async (db) => {
      oneNight(h.google, { deep: 60 });
      // An HRV row from an earlier fetch, now gone from the API.
      putMetric(db, { date: D10, key: KEY_HRV, value: 77, nSamples: 90, zone: SP, algoVersion: ALGO_VERSION });
      const data = newData(db);
      const r = await data.recovery(D10, D10);
      expect(nightOf(r, D10).hrv.medianMs).toBeNull();
      expect(metricRange(db, KEY_HRV, D10, D10, ALGO_VERSION)).toEqual([]);
      const again = await data.recovery(D10, D10);
      expect(nightOf(again, D10).hrv.medianMs).toBeNull();
    }));

  it("stamps each row with the zone, the algo version and the clock", () =>
    inStore(async (db) => {
      week(h.google);
      await newData(db).recovery(D10, D10);
      for (const key of RECOVERY_KEYS) {
        expect(metricRange(db, key, D10, D10, ALGO_VERSION), key).toMatchObject([{ zone: SP, source: "Synthetic Band", fetchedAt: NOW }]);
      }
      // The HRV row holds the covered slot count; the other rows hold none.
      expect(metricRange(db, KEY_HRV, D10, D10, ALGO_VERSION)[0]?.nSamples).toBe(96);
      expect(metricRange(db, KEY_ASLEEP, D10, D10, ALGO_VERSION)[0]?.nSamples).toBeUndefined();
    }));

  it("keeps the key texts stable", () => {
    // The key text is also the cache row key: a changed or swapped text would
    // read existing rows as another metric.
    expect([...RECOVERY_KEYS, ...ACTIVITY_KEYS, ...BODY_KEYS]).toEqual([
      "sleep_asleep_min",
      "sleep_awake_min",
      "sleep_in_bed_min",
      "sleep_deep_min",
      "sleep_light_min",
      "sleep_rem_min",
      "sleep_start_min_of_day",
      "sleep_end_min_of_day",
      "hrv_rmssd_ms",
      "resting_hr_bpm",
      "steps",
      "azm_min",
      "total_calories_kcal",
      "weight_kg",
      "body_fat_pct",
    ]);
    // Every key is a key of the store, and the store has no other.
    expect([...RECOVERY_KEYS, ...ACTIVITY_KEYS, ...BODY_KEYS]).toEqual([...METRIC_KEYS]);
  });
});

describe("HRV", () => {
  it("tells a withheld value from a missing one", () => {
    expect(hrvWithheld({ medianMs: null, coverage: 0 })).toBe(false); // no samples
    expect(hrvWithheld({ medianMs: null, coverage: 0.3 })).toBe(true); // too little coverage
    expect(hrvWithheld({ medianMs: 40, coverage: 1 })).toBe(false); // a value
  });

  const START = at("2026-10-09", 23, 0);
  it.each([
    { name: "every 10 minutes", samples: () => hrvEvery(START, at(D10, 6, 55), 10 * MINUTE, 50), hrv: true, coverage: 0.5, cached: true },
    // 12 samples, enough by count alone
    { name: "only the last hour", samples: () => hrvNight(at(D10, 6, 0), at(D10, 6, 55), 50), hrv: false, coverage: 12 / 96, cached: false },
    // half the slots, none in the second half
    { name: "only the first half", samples: () => hrvNight(START, at(D10, 2, 55), 50), hrv: false, coverage: 0.5, cached: false },
    // Apple Health HRV inside the night is not the band's; not "no HRV" either
    { name: "phone samples", samples: () => hrvEvery(START, at(D10, 7, 0), 5 * MINUTE, 50, "HEALTH_KIT"), hrv: false, coverage: 0, cached: false },
    { name: "only the second half", samples: () => hrvNight(at(D10, 3, 0), at(D10, 6, 55), 50), hrv: false, coverage: 0.5, cached: false },
    { name: "no samples", samples: () => [], hrv: false, coverage: 0, cached: true },
  ])("checks the coverage: $name", ({ name, samples, hrv, coverage: want, cached }) =>
    inStore(async (db) => {
      oneNight(h.google, { deep: 60 });
      h.google.add("heart-rate-variability", ...samples());
      const r = await newData(db).recovery(D10, D10);
      const night = nightOf(r, D10);
      expect(night.hrv.medianMs !== null).toBe(hrv);
      expect(night.hrv.coverage).toBe(want);
      expect(cachedKeys(db, D10).length > 0).toBe(cached);
      if (name === "phone samples") {
        expect(r.excluded.otherSource).toBe(97);
        expect(r.empty).toEqual(["heart-rate-variability"]);
      }
    }),
  );

  it("gives a value for exactly 12 samples", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at(D10, 1, 0), at(D10, 2, 0), { deep: 10 }));
      h.google.add("heart-rate-variability", ...hrvNight(at(D10, 1, 0), at(D10, 1, 55), 50));
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).hrv).toEqual({ medianMs: 50, coverage: 1 });
    }));

  it("rounds the slots up and reads the same coverage back", () =>
    inStore(async (db) => {
      // 62 minutes is 13 slots; a sample every 10 minutes fills 7 of them.
      h.google.add("sleep", sleepRec(at(D10, 1, 0), at(D10, 2, 2), { deep: 10 }));
      h.google.add("heart-rate-variability", ...hrvEvery(at(D10, 1, 0), at(D10, 2, 0), 10 * MINUTE, 50));
      h.google.add("heart-rate-variability", ...hrvEvery(at(D10, 1, 1), at(D10, 2, 1), 10 * MINUTE, 50));
      const data = newData(db);
      const live = await data.recovery(D10, D10);
      expect(nightOf(live, D10).hrv).toEqual({ medianMs: 50, coverage: 7 / 13 });
      assertSame(live, await data.recovery(D10, D10));
    }));

  it("withholds the value of a short night with too few samples", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at(D10, 1, 0), at(D10, 1, 55), { deep: 10 }));
      h.google.add("heart-rate-variability", ...hrvNight(at(D10, 1, 0), at(D10, 1, 50), 50)); // 11 samples, all slots
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).hrv).toEqual({ medianMs: null, coverage: 1 });
    }));

  it("does not cache a night whose samples have no value as a night without HRV", () =>
    inStore(async (db) => {
      // HRV samples of the night that arrive without a value are a format
      // change, not a night without HRV: counted, and the night stays out of
      // the cache.
      const noValue = (t: Date) => ({ dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: { physicalTime: rfc3339(t) } } });
      oneNight(h.google, { deep: 60 });
      h.google.add("heart-rate-variability", noValue(at(D10, 1, 0)), noValue(at(D10, 2, 0)), noValue(at(D10, 3, 0)));
      h.google.add("heart-rate-variability", noValue(at(D10, 12, 0))); // outside the night
      const r = await newData(db).recovery(D10, D10);
      expect(r.excluded.noHRVValue).toBe(3);
      expect(r.empty).toEqual(["heart-rate-variability"]);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("does not cache a night with a sample without a value next to valid ones", () =>
    inStore(async (db) => {
      // Counted, but the night is still not cached: the value may be missing
      // from the median.
      oneNight(h.google, { deep: 60 });
      h.google.add("heart-rate-variability", ...hrvNight(at("2026-10-09", 23, 0), at(D10, 7, 0), 50));
      h.google.add("heart-rate-variability", { dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: { physicalTime: rfc3339(at(D10, 1, 1)) } } });
      const r = await newData(db).recovery(D10, D10);
      expect(nightOf(r, D10).hrv.medianMs).toBe(50);
      expect(r.excluded.noHRVValue).toBe(1);
      expect(r.empty).toEqual([]);
      expect(cachedKeys(db, D10)).toEqual([]);
    }));

  it("reads the covered slot count back from the coverage", () => {
    for (let inBed = 1; inBed <= 1440; inBed++) {
      const total = slotCount(inBed);
      for (let covered = 0; covered <= total; covered++) {
        const back = coveredSlots({ inBedMin: inBed, hrv: { medianMs: null, coverage: coverage(covered, inBed) } });
        if (back !== covered) throw new Error(`in bed ${inBed}, ${covered} of ${total} slots: read back ${back}`);
      }
    }
  });

  it("computes the median", () => {
    expect(median([1])).toBe(1);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("unreadable and left-out records", () => {
  const BAD_RESTING = { dataSource: { platform: "FITBIT" }, dailyRestingHeartRate: { beatsPerMinute: "9000", date: { year: 2026, month: 10, day: 10 } } };

  it("does not cache the whole fetch when a record has no day", () =>
    inStore(async (db) => {
      oneNight(h.google, { deep: 60 });
      h.google.add("sleep", { dataSource: { platform: "FITBIT" }, sleep: { summary: { minutesAsleep: "x" } } });
      h.google.add("heart-rate-variability", ...hrvNight(at("2026-10-09", 23, 0), at(D10, 7, 0), 50));
      h.google.add("daily-resting-heart-rate", restingRec(D10, 55, "WITH_SLEEP", "FITBIT"), BAD_RESTING);
      const r = await newData(db).recovery(D10, D10);
      expect(r.skipped).toBe(2);
      expect(nightOf(r, D10).asleepMin).toBe(440);
      expect(r.restingHR.get(D10)?.bpm).toBe(55);
      expect(cachedKeys(db, D10)).toEqual([]);
      expect(h.warnings()).toEqual([
        ["unreadable records in a recovery fetch", { from: D10, to: D10, skipped: 1 }],
        ["unreadable resting heart rate records", { from: D10, to: D10, skipped: 1 }],
      ]);
    }));

  it("does not cache the nights of a fetch with an HRV sample without a time", () =>
    inStore(async (db) => {
      week(h.google);
      h.google.add("heart-rate-variability", { dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: {}, rootMeanSquareOfSuccessiveDifferencesMilliseconds: 50 } });
      const r = await newData(db).recovery(D10, "2026-10-11");
      expect(r.skipped).toBe(1);
      expect(nightOf(r, D10).hrv.medianMs).toBe(50);
      // Resting heart rate is another fetch: its clean days are cached.
      expect(cachedKeys(db, D10)).toEqual([KEY_RESTING_HR]);
      expect(cachedKeys(db, "2026-10-11")).toEqual([KEY_RESTING_HR]);
      expect(h.warnings()).toEqual([["unreadable records in a recovery fetch", { from: D10, to: "2026-10-11", skipped: 1 }]]);
    }));

  it("does not cache only the day of an unreadable record with a day", () =>
    inStore(async (db) => {
      week(h.google);
      // Implausible minutes on records ending 10-09 (in range) and 10-12 (the margin).
      const bad = (end: string) => ({
        dataSource: { platform: "FITBIT" },
        sleep: {
          type: "STAGES",
          interval: { startTime: rfc3339(at(end, 12, 0)), endTime: rfc3339(at(end, 13, 0)) },
          summary: { minutesAsleep: "500", minutesInSleepPeriod: "60" },
        },
      });
      h.google.add("sleep", bad("2026-10-09"), bad("2026-10-12"));
      h.google.add("heart-rate-variability", hrvRec(at("2026-10-08", 3, 0), -5)); // inside the 10-08 night
      h.google.add("daily-resting-heart-rate", BAD_RESTING);
      const r = await newData(db).recovery("2026-10-08", "2026-10-11");
      expect(r.skipped).toBe(3);
      expect(r.nights.size).toBe(4);
      const cached = Object.fromEntries(["2026-10-08", "2026-10-09", D10, "2026-10-11"].map((date) => [date, cachedKeys(db, date).length]));
      expect(cached).toEqual({ "2026-10-08": 1, "2026-10-09": 1, [D10]: SLEEP_KEYS.length + 1, "2026-10-11": SLEEP_KEYS.length + 2 });
    }));

  it("marks a data type empty when its records are only from another platform", () =>
    inStore(async (db) => {
      h.google.add("sleep", sleepRec(at("2026-10-09", 23, 0), at(D10, 7, 0), { platform: "HEALTH_KIT", deep: 60 }));
      h.google.add("heart-rate-variability", { dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: { physicalTime: "2026-10-10T06:00:00Z" } } });
      h.google.add("daily-resting-heart-rate", restingRec(D10, 55, "", "HEALTH_KIT"));
      const r = await newData(db).recovery(D10, D10);
      expect(r.nights.size).toBe(0);
      expect(r.restingHR.size).toBe(0);
      expect(r.empty).toEqual(["daily-resting-heart-rate", "heart-rate-variability", "sleep"]);
      expect(r.excluded.otherSource).toBe(2);
      expect(h.warnings()).toEqual([
        ["google health records arrived but none were usable", { data_type: "sleep", from: D10, to: D10 }],
        ["google health records arrived but none were usable", { data_type: "heart-rate-variability", from: D10, to: D10 }],
        ["google health records arrived but none were usable", { data_type: "daily-resting-heart-rate", from: D10, to: D10 }],
      ]);
    }));

  it("does not mark a data type empty when sources are mixed", () =>
    inStore(async (db) => {
      week(h.google);
      h.google.add("heart-rate-variability", hrvRec(at(D10, 3, 0), 50, "HEALTH_KIT"));
      h.google.add("daily-resting-heart-rate", restingRec(D10, 49, "", "HEALTH_KIT"));
      const r = await newData(db).recovery(D10, D10);
      expect(r.empty).toEqual([]);
      expect(r.excluded.otherSource).toBe(2);
    }));

  it("does not list an empty label as a source", () =>
    inStore(async (db) => {
      h.google.add("daily-resting-heart-rate", {
        dataSource: { platform: "FITBIT", device: { displayName: "‮" } },
        dailyRestingHeartRate: { beatsPerMinute: "55", date: { year: 2026, month: 10, day: 10 } },
      });
      const r = await newData(db).recovery(D10, D10);
      expect(r.sources).toEqual(["FITBIT"]);
    }));
});

describe("resting heart rate", () => {
  it("picks one value per day and caches only a single standard one", () =>
    inStore(async (db) => {
      h.google.add(
        "daily-resting-heart-rate",
        restingRec("2026-10-08", 54, "WITH_SLEEP", "FITBIT"),
        restingRec("2026-10-08", 49, "", "HEALTH_KIT"), // the phone's copy is ignored
        restingRec("2026-10-09", 52, "", "FITBIT"),
        restingRec("2026-10-09", 56, "WITH_SLEEP", "FITBIT"), // the band's standard method wins
        restingRec(D10, 51, "", "FITBIT"), // a lone value from another method
        restingRec("2026-10-11", 58, "WITH_SLEEP", "FITBIT"),
        restingRec("2026-10-11", 57, "WITH_SLEEP", "FITBIT"), // two standard values: the lower
        restingRec("2026-10-30", 70, "WITH_SLEEP", "FITBIT"), // outside the range
      );
      const r = await newData(db).recovery("2026-10-08", "2026-10-12");
      expect([...r.restingHR]).toEqual([
        ["2026-10-08", { bpm: 54, method: "WITH_SLEEP" }],
        ["2026-10-09", { bpm: 56, method: "WITH_SLEEP" }],
        [D10, { bpm: 51, method: "" }],
        ["2026-10-11", { bpm: 57, method: "WITH_SLEEP" }],
      ]);
      expect(render(r.series(KEY_RESTING_HR))).toBe("2026-10-08=54 2026-10-09=56 2026-10-10=51 2026-10-11=57 2026-10-12=nil ");
      expect(render(r.baselineSeries(KEY_RESTING_HR))).toBe("2026-10-08=54 2026-10-09=56 2026-10-10=nil 2026-10-11=57 2026-10-12=nil ");
      // Only a day's single standard value is cached.
      expect(metricRange(db, KEY_RESTING_HR, "2026-10-08", "2026-10-12", ALGO_VERSION)).toMatchObject([{ date: "2026-10-08", zone: SP }]);
      expect(r.excluded.otherSource).toBe(1);
    }));

  it("ignores a value outside the range", () =>
    inStore(async (db) => {
      h.google.loose = true;
      h.google.add("daily-resting-heart-rate", restingRec("2026-10-09", 55, "WITH_SLEEP", "FITBIT"), restingRec(D10, 56, "WITH_SLEEP", "FITBIT"));
      const r = await newData(db).recovery(D10, D10);
      expect([...r.restingHR]).toEqual([[D10, { bpm: 56, method: "WITH_SLEEP" }]]);
    }));

  it("cleans the method", () =>
    inStore(async (db) => {
      h.google.add("daily-resting-heart-rate", restingRec(D10, 55, "NEW\nMETHOD", "FITBIT"));
      const r = await newData(db).recovery(D10, D10);
      const resting = r.restingHR.get(D10);
      expect(resting).toEqual({ bpm: 55, method: "NEWMETHOD" });
      expect(resting && restingStandard(resting)).toBe(false);
    }));
});

describe("series", () => {
  it("gives one point per day", () => {
    const r = new Recovery("2026-10-01", "2026-10-03");
    const night = (fields: Partial<Night>): Night => ({
      asleepMin: 0,
      awakeMin: 0,
      inBedMin: 0,
      stages: null,
      startMinOfDay: 0,
      endMinOfDay: 0,
      start: new Date(0),
      end: new Date(0),
      hrv: { medianMs: null, coverage: 0 },
      source: "",
      provisional: false,
      ...fields,
    });
    r.nights.set("2026-10-02", night({ asleepMin: 400, startMinOfDay: 1380 }));
    r.nights.set("2026-10-03", night({ asleepMin: 300, provisional: true }));
    const cases: [RecoveryKey, string][] = [
      [KEY_ASLEEP, "2026-10-01=nil 2026-10-02=400 2026-10-03=300 "],
      [KEY_SLEEP_START, "2026-10-01=nil 2026-10-02=1380 2026-10-03=0 "],
      [KEY_DEEP, "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil "],
      [KEY_HRV, "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil "],
      [KEY_RESTING_HR, "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil "],
    ];
    for (const [key, want] of cases) {
      const series = r.series(key);
      expect(render(series), key).toBe(want);
      // metrics.baseline accepts it: one point per day, no duplicates.
      expect(() => baseline(series, "2026-10-04", 3)).not.toThrow();
    }
    // A provisional night is reported for its day but kept out of baselines.
    expect(render(r.baselineSeries(KEY_ASLEEP))).toBe("2026-10-01=nil 2026-10-02=400 2026-10-03=nil ");
    expect(() => r.series("steps" as RecoveryKey)).toThrow();
  });
});

describe("cache failures", () => {
  it("fails the call when the cache cannot be read", () =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db, { cache: failingCache(db, { read: true }) });
      const error = await data.recovery(D10, D10).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(DiskError);
      expect(toWire(error).code).toBe("internal_error");
      expect(h.google.takeCalls()).toEqual([]);
    }));

  const cases: [string, CacheFailures][] = [
    ["every write", { put: true }],
    ["every delete", { del: true }],
    ["the stage write", { put: true, failKey: KEY_REM }],
    ["the commit row write", { put: true, failKey: KEY_ASLEEP }],
  ];
  it.each(cases)("returns the live values when %s fails", (_name, fail) =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db, { cache: failingCache(db, fail) });
      const r = await data.recovery(D10, D10);
      // The live values are returned whatever the cache does.
      expect(nightOf(r, D10).asleepMin).toBe(440);
      expect(nightOf(r, D10).hrv.medianMs).toBe(50);
      // A failed night write leaves a miss, never a partial hit.
      h.google.takeCalls();
      const again = await data.recovery(D10, D10);
      expect(nightOf(again, D10).asleepMin).toBe(440);
      const calls = h.google.takeCalls();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]).toMatch(/^sleep /);
      // The log names the row and the error type, never the error text or a value.
      const failures = h.warnings().filter(([message]) => message === "cache write failed" || message === "cache delete failed");
      expect(failures.length).toBeGreaterThan(0);
      for (const [, fields] of failures) {
        expect(Object.keys(fields as object).sort()).toEqual(["date", "error_types", "metric"]);
        expect(fields).toMatchObject({ date: D10, error_types: "DiskError" });
      }
      expect(h.logged()).not.toContain("4242");
      expect(h.logged()).not.toContain("440");
    }),
  );
});

describe("calls", () => {
  it("serves concurrent calls on one store", () =>
    inStore(async (db) => {
      week(h.google);
      const data = newData(db);
      const want = await data.recovery("2026-10-07", "2026-10-15");
      const all = await Promise.all(Array.from({ length: 8 }, () => data.recovery("2026-10-07", "2026-10-15")));
      for (const got of all) assertSame(want, got);
    }));

  it("refuses a range that is not valid, before any request", () =>
    inStore(async (db) => {
      const data = newData(db);
      const ranges: Record<string, [string, string]> = {
        reversed: [D10, "2026-10-09"],
        invalid: ["2026-10-32", "2026-10-09"],
        "too long": ["2025-01-01", "2026-12-31"],
        "bad to": ["2026-10-01", "x"],
      };
      for (const [name, [from, to]] of Object.entries(ranges)) {
        await expect(data.recovery(from, to), name).rejects.toThrow(/^healthdata: /);
      }
      expect(h.google.takeCalls()).toEqual([]);
    }));

  it("accepts MAX_RANGE_DAYS days and no more", () =>
    inStore(async (db) => {
      const data = newData(db);
      const last = addDays("2026-01-01", MAX_RANGE_DAYS - 1) as string;
      await expect(data.recovery("2026-01-01", last)).resolves.toBeInstanceOf(Recovery);
      await expect(data.recovery("2026-01-01", addDays(last, 1) as string)).rejects.toThrow("healthdata: a range spans at most 366 days");
    }));

  it("passes an API error on unchanged", () =>
    inStore(async (db) => {
      const want = new ToolError("auth_expired", "not signed in");
      const failing: Fetcher = {
        list: () => Promise.reject(want),
        dailyRollup: () => Promise.reject(want),
        listBetween: () => Promise.reject(want),
      };
      const data = new HealthData(failing, dbCache(db), SAO_PAULO, () => NOW);
      await expect(data.recovery(D10, D10)).rejects.toBe(want);
    }));

  it("answers the client's tool error when the API refuses the sign-in", () =>
    inStore(async (db) => {
      h.google.fail = () => Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
      const error = await newData(db)
        .recovery(D10, D10)
        .catch((e: unknown) => e);
      expect(toWire(error).code).toBe("auth_expired");
    }));

  it("needs an API client, a cache, a zone and a clock", () => {
    expect(() => new HealthData(undefined as never, undefined as never, SAO_PAULO, () => NOW)).toThrow("healthdata: api, cache, time zone and clock are required");
  });
});

describe("nightWindow", () => {
  const NEW_YORK = new Zone("America/New_York");
  const LISBON = new Zone("Europe/Lisbon");
  /** The instant of a wall-clock time with its UTC offset written out. */
  const wall = (text: string) => new Date(text).getTime();

  it.each([
    // The clocks change during these nights: the bounds keep their wall-clock times.
    { name: "fall back", zone: NEW_YORK, date: "2026-11-01", startMin: 23 * 60, endMin: 7 * 60, start: "2026-10-31T23:00:00-04:00", end: "2026-11-01T07:00:00-05:00" },
    { name: "spring forward", zone: NEW_YORK, date: "2026-03-08", startMin: 23 * 60, endMin: 7 * 60, start: "2026-03-07T23:00:00-05:00", end: "2026-03-08T07:00:00-04:00" },
    { name: "lisbon spring forward", zone: LISBON, date: "2026-03-29", startMin: 22 * 60 + 30, endMin: 6 * 60 + 45, start: "2026-03-28T22:30:00Z", end: "2026-03-29T06:45:00+01:00" },
    { name: "after midnight", zone: SAO_PAULO, date: "2026-10-11", startMin: 30, endMin: 8 * 60, start: "2026-10-11T00:30:00-03:00", end: "2026-10-11T08:00:00-03:00" },
    // Equal minutes are a whole day, never an empty night.
    { name: "start equals end", zone: SAO_PAULO, date: "2026-10-11", startMin: 7 * 60, endMin: 7 * 60, start: "2026-10-10T07:00:00-03:00", end: "2026-10-11T07:00:00-03:00" },
  ])("rebuilds wall-clock times: $name", ({ zone, date, startMin, endMin, start, end }) => {
    expect(nightWindow(date, startMin, endMin, zone)).toEqual({ start: wall(start), end: wall(end) });
  });

  it("takes the earlier instant in the hour a fall-back change repeats", () => {
    // 01:30 happens twice on 2026-11-01 in New York: at −04:00, then at −05:00.
    expect(nightWindow("2026-11-01", 23 * 60, 90, NEW_YORK)?.end).toBe(wall("2026-11-01T01:30:00-04:00"));
  });

  it.each([
    { name: "start past a day", date: "2026-10-11", startMin: 24 * 60, endMin: 7 * 60 },
    { name: "negative start", date: "2026-10-11", startMin: -1, endMin: 7 * 60 },
    { name: "negative end", date: "2026-10-11", startMin: 0, endMin: -1 },
    { name: "end past a day", date: "2026-10-11", startMin: 0, endMin: 24 * 60 },
    { name: "bad day", date: "2026-02-30", startMin: 0, endMin: 60 },
    { name: "a minute that is not a number", date: "2026-10-11", startMin: Number.NaN, endMin: 60 },
  ])("refuses $name", ({ date, startMin, endMin }) => {
    expect(nightWindow(date, startMin, endMin, SAO_PAULO)).toBeUndefined();
  });
});
