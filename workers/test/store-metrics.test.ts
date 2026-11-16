// The metrics cache.
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LocalDate, addDays } from "../src/coach/date";
import { CorruptRowError } from "../src/store/db";
import { queryLabs, recordLabs } from "../src/store/labs";
import { profile, updateProfile } from "../src/store/memory";
import {
  MAX_RANGE_DAYS,
  METRIC_KEYS,
  type Metric,
  clearMetrics,
  deleteMetric,
  getMetric,
  metricRange,
  putMetric,
} from "../src/store/metrics";
import { addNote, searchNotes } from "../src/store/notes";
import { FIXED_NOW, codeOf, toolError, withDb } from "./memory-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metrics cache", () => {
  it("has the Go store's final columns, in the same order", () =>
    withDb((_db, sql) => {
      const columns = sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('daily_metrics') ORDER BY cid")
        .toArray()
        .map((row) => row.name);
      expect(columns).toEqual(["date", "metric", "value", "n_samples", "source", "algo_version", "fetched_at", "zone"]);
    }));

  // Rows read are a daily quota of the plan (5 million on Workers Free), and
  // a recovery read asks for 10 keys, each over the whole range.
  it("reads one key over a year through its index: the rows of the other 14 keys are not read", () =>
    withDb((db, sql) => {
      const first: LocalDate = "2025-10-01";
      const days = 366;
      const exec = vi.spyOn(sql, "exec");
      for (let i = 0; i < days; i++) {
        const date = addDays(first, i) as LocalDate;
        for (const key of METRIC_KEYS) putMetric(db, { date, key, value: i, algoVersion: 3, zone: "America/Sao_Paulo" });
      }
      expect(db.count("SELECT COUNT(*) FROM daily_metrics")).toBe(days * METRIC_KEYS.length);
      // One cached value writes its row and its two index entries (the primary key and the index).
      expect(exec.mock.results.at(-2)?.value.rowsWritten).toBe(3);

      exec.mockClear();
      const last = addDays(first, days - 1) as LocalDate;
      const rows = metricRange(db, "hrv_rmssd_ms", first, last, 3);
      expect(rows).toHaveLength(days);
      expect(rows.map((row) => row.date)).toEqual(Array.from({ length: days }, (_unused, i) => addDays(first, i)));
      expect(exec).toHaveBeenCalledTimes(1);
      const [query, ...bindings] = exec.mock.calls[0] as [string, ...SqlStorageValue[]];
      // One row for each day of the key, and the step that finds the end of
      // the range: not the 5,490 rows of the table.
      expect(exec.mock.results[0]?.value.rowsRead).toBe(days + 1);

      const plan = sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
        .toArray()
        .map((step) => step.detail);
      // The index gives the days in order: no scan of the table and no sort.
      expect(plan).toEqual(["SEARCH daily_metrics USING INDEX daily_metrics_by_metric (metric=? AND date>? AND date<?)"]);

      // A short range of a full table reads only its own days.
      exec.mockClear();
      expect(metricRange(db, "steps", addDays(first, 100) as LocalDate, addDays(first, 106) as LocalDate, 3)).toHaveLength(7);
      expect(exec.mock.results[0]?.value.rowsRead).toBe(8);
    }));

  it("lists the Go server's closed metric keys", () => {
    expect(METRIC_KEYS).toEqual([
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
  });

  it("stores, replaces, lists and deletes values", () =>
    withDb((db) => {
      const metric: Metric = {
        date: "2026-10-10",
        key: "resting_hr_bpm",
        value: 57,
        nSamples: 3,
        source: "fitbit_air",
        zone: "America/Sao_Paulo",
        algoVersion: 1,
      };
      putMetric(db, metric);

      // The store's clock stamps a put without fetchedAt.
      expect(getMetric(db, "2026-10-10", "resting_hr_bpm", 1)).toEqual({ ...metric, fetchedAt: FIXED_NOW });
      // A different algo_version and a missing day are misses.
      expect(getMetric(db, "2026-10-10", "resting_hr_bpm", 2)).toBeUndefined();
      expect(getMetric(db, "2026-10-11", "resting_hr_bpm", 1)).toBeUndefined();

      // A recompute with a new algo_version replaces the row: v1 misses, v2 hits.
      putMetric(db, { ...metric, value: 58, algoVersion: 2 });
      expect(getMetric(db, "2026-10-10", "resting_hr_bpm", 1)).toBeUndefined();
      expect(getMetric(db, "2026-10-10", "resting_hr_bpm", 2)?.value).toBe(58);

      // Explicit fetchedAt is preserved; no n_samples, source or zone round-trip.
      const fetched = new Date("2026-10-09T08:00:00.123Z");
      for (const date of ["2026-10-08", "2026-10-12", "2026-10-13"]) {
        putMetric(db, { date, key: "resting_hr_bpm", value: 60, algoVersion: 2, fetchedAt: fetched });
      }
      const range = metricRange(db, "resting_hr_bpm", "2026-10-08", "2026-10-12", 2);
      // Both endpoints are included, oldest first.
      expect(range.map((row) => row.date)).toEqual(["2026-10-08", "2026-10-10", "2026-10-12"]);
      expect(range[0]).toEqual({ date: "2026-10-08", key: "resting_hr_bpm", value: 60, algoVersion: 2, fetchedAt: fetched });

      // deleteMetric removes one (date, metric); a missing row is not an error.
      deleteMetric(db, "2026-10-10", "resting_hr_bpm");
      expect(getMetric(db, "2026-10-10", "resting_hr_bpm", 2)).toBeUndefined();
      expect(getMetric(db, "2026-10-12", "resting_hr_bpm", 2)?.value).toBe(60);
      deleteMetric(db, "2026-10-10", "resting_hr_bpm");
      expect(codeOf(() => deleteMetric(db, "2026-10-10", "bogus"))).toBe("invalid_input");
      expect(codeOf(() => deleteMetric(db, "10/10/2026", "steps"))).toBe("invalid_input");
    }));

  it("keeps the values of other metrics on the same day apart", () =>
    withDb((db) => {
      putMetric(db, { date: "2026-10-10", key: "steps", value: 9000, algoVersion: 2 });
      putMetric(db, { date: "2026-10-10", key: "azm_min", value: 40, algoVersion: 2 });
      expect(metricRange(db, "steps", "2026-10-10", "2026-10-10", 2).map((row) => row.value)).toEqual([9000]);
      deleteMetric(db, "2026-10-10", "steps");
      expect(getMetric(db, "2026-10-10", "azm_min", 2)?.value).toBe(40);
    }));

  it.each<[string, string, string]>([
    ["mood", "2026-10-01", "2026-10-02"],
    ["steps", "garbage", "2026-10-02"],
    ["steps", "2026-10-01", "2026-13-01"],
    ["steps", "2026-10-02", "2026-10-01"],
    ["steps", "2026-01-01", "2027-03-01"],
  ])("rejects the range %s %s..%s", (key, from, to) =>
    withDb((db) => {
      expect(codeOf(() => metricRange(db, key, from, to, 1))).toBe("invalid_input");
    }));

  it("allows a range of exactly the maximum number of days", () =>
    withDb((db) => {
      expect(MAX_RANGE_DAYS).toBe(400);
      const last = addDays("2026-01-01", MAX_RANGE_DAYS - 1) as LocalDate;
      expect(metricRange(db, "steps", "2026-01-01", last, 1)).toEqual([]);
      const over = addDays("2026-01-01", MAX_RANGE_DAYS) as LocalDate;
      expect(toolError(() => metricRange(db, "steps", "2026-01-01", over, 1)).message).toBe(
        "a metric range spans at most 400 days",
      );
    }));

  it.each<[string, Metric]>([
    ["an unknown key", { date: "2026-10-10", key: "mood", value: 1, algoVersion: 1 }],
    ["a bad date", { date: "garbage", key: "steps", value: 1, algoVersion: 1 }],
    ["NaN", { date: "2026-10-10", key: "steps", value: NaN, algoVersion: 1 }],
    ["an infinite value", { date: "2026-10-10", key: "steps", value: Infinity, algoVersion: 1 }],
  ])("rejects a put with %s", (_name, metric) =>
    withDb((db) => {
      expect(codeOf(() => putMetric(db, metric))).toBe("invalid_input");
      expect(db.count("SELECT COUNT(*) FROM daily_metrics")).toBe(0);
    }));

  it("names the metric and the day in a rejection, never the value", () =>
    withDb((db) => {
      const error = toolError(() => putMetric(db, { date: "2026-10-10", key: "steps", value: -Infinity, algoVersion: 1 }));
      expect(error.message).toBe("metric steps on 2026-10-10: value is not finite");
      expect(error.hint).toBe("fix the value named in the message and retry");
    }));

  it("fails the read of a row whose timestamp is corrupt", () =>
    withDb((db, sql) => {
      putMetric(db, { date: "2026-10-10", key: "steps", value: 1, algoVersion: 1 });
      sql.exec("UPDATE daily_metrics SET fetched_at = 'yesterday'");
      expect(() => metricRange(db, "steps", "2026-10-01", "2026-10-31", 1)).toThrow(CorruptRowError);
    }));

  it("clears only the cache", () =>
    withDb((db) => {
      putMetric(db, { date: "2026-10-10", key: "steps", value: 1, algoVersion: 1 });
      updateProfile(db, { sex: "m" });
      addNote(db, { kind: "checkin", text: "keep me" });
      recordLabs(db, "2026-10-01", "", "chat", [{ analyte: "ldl", value: 1, unit: "mg/dL" }]);

      clearMetrics(db);
      expect(metricRange(db, "steps", "2026-10-01", "2026-10-31", 1)).toEqual([]);
      expect(profile(db)?.sex).toBe("m");
      expect(searchNotes(db, {}).notes).toHaveLength(1);
      expect(queryLabs(db).results).toHaveLength(1);
    }));
});
