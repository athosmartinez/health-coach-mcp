// The daily_metrics cache. The cache is
// disposable: the source of truth is the Google Health API.

import { type LocalDate, addDays } from "../coach/date";
import { type Db, type Row, formatStamp, invalid, nullable, numberOrUndefined, oneOf, readStamp, text, validDate } from "./db";

/** Bounds one metricRange call (a year of baselines plus slack). */
export const MAX_RANGE_DAYS = 400;

/** The closed list of cacheable daily scalars (CAPABILITY §5.3). */
export const METRIC_KEYS = [
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
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * One cached daily value. Deciding what to cache (settled days only, never
 * null or partial) is the caller's job.
 */
export interface Metric {
  date: LocalDate;
  key: string;
  value: number;
  /**
   * An optional count stored with the value; for hrv_rmssd_ms it is the number
   * of 5-minute slots holding a sample.
   */
  nSamples?: number;
  source?: string;
  /**
   * The IANA time zone the value was computed in (healthdata always sets it
   * and treats another zone, or none, as a miss).
   */
  zone?: string;
  algoVersion: number;
  /** When the value was fetched. Omitted on a put: the store's clock. */
  fetchedAt?: Date;
}

/** A cached value as the store returns it: `fetchedAt` is always set. */
export type StoredMetric = Metric & { fetchedAt: Date };

/** Stores or replaces the value for (date, metric). */
export function putMetric(db: Db, metric: Metric): void {
  oneOf("metric", metric.key, METRIC_KEYS, false);
  validDate("metric date", metric.date, false);
  // Never echo the value: it is a health measurement.
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    throw invalid(`metric ${metric.key} on ${metric.date}: value is not finite`);
  }
  db.all(
    `INSERT INTO daily_metrics (date, metric, value, n_samples, source, zone, algo_version, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (date, metric) DO UPDATE SET value = excluded.value, n_samples = excluded.n_samples,
       source = excluded.source, zone = excluded.zone, algo_version = excluded.algo_version,
       fetched_at = excluded.fetched_at`,
    metric.date,
    metric.key,
    metric.value,
    metric.nSamples ?? null,
    nullable(metric.source),
    nullable(metric.zone),
    metric.algoVersion,
    formatStamp(metric.fetchedAt ?? db.now()),
  );
}

/**
 * The cached value, or undefined on a miss. A row computed by a different
 * algo_version counts as a miss, so it gets recomputed.
 */
export function getMetric(db: Db, day: LocalDate, key: string, algoVersion: number): StoredMetric | undefined {
  return metricRange(db, key, day, day, algoVersion)[0];
}

/** Cached values for `key` on [from, to], oldest first, skipping rows from another algo_version. */
export function metricRange(db: Db, key: string, from: LocalDate, to: LocalDate, algoVersion: number): StoredMetric[] {
  oneOf("metric", key, METRIC_KEYS, false);
  validDate("from", from, false);
  validDate("to", to, false);
  if (to < from) throw invalid("to is before from");
  if (to > (addDays(from, MAX_RANGE_DAYS - 1) as LocalDate)) {
    throw invalid(`a metric range spans at most ${MAX_RANGE_DAYS} days`);
  }
  const rows = db.all(
    `SELECT date, value, n_samples, source, zone, fetched_at FROM daily_metrics
     WHERE metric = ? AND date >= ? AND date <= ? AND algo_version = ? ORDER BY date`,
    key,
    from,
    to,
    algoVersion,
  );
  return rows.map((row) => readMetric(row, key, algoVersion));
}

/** Removes the value for (date, metric), if any. */
export function deleteMetric(db: Db, day: LocalDate, key: string): void {
  oneOf("metric", key, METRIC_KEYS, false);
  validDate("metric date", day, false);
  db.all("DELETE FROM daily_metrics WHERE date = ? AND metric = ?", day, key);
}

/** Empties the cache; the source of truth is the API. */
export function clearMetrics(db: Db): void {
  db.all("DELETE FROM daily_metrics");
}

function readMetric(row: Row, key: string, algoVersion: number): StoredMetric {
  // readStamp checks the stored text; the fixed-width stamp is cut at the
  // milliseconds a Date holds.
  readStamp(row.fetched_at);
  const metric: StoredMetric = {
    date: text(row.date),
    key,
    value: row.value as number,
    algoVersion,
    fetchedAt: new Date(`${text(row.fetched_at).slice(0, 23)}Z`),
  };
  const nSamples = numberOrUndefined(row.n_samples);
  if (nSamples !== undefined) metric.nSamples = nSamples;
  if (text(row.source) !== "") metric.source = text(row.source);
  if (text(row.zone) !== "") metric.zone = text(row.zone);
  return metric;
}
