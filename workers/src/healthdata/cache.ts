// What every source shares: the API client, the daily_metrics cache, the zone
// and the clock (Go: the Data struct of internal/healthdata/recovery.go).

import { type LocalDate, type Zone, today } from "../coach/date";
import { errorTypes } from "../coach/errors";
import type { Reduce } from "../googlehealth/client";
import type { DataType } from "../googlehealth/datatypes";
import { ALGO_VERSION } from "../metrics/stats";
import type { Db } from "../store/db";
import { entryNamesBetween } from "../store/entries";
import { type Metric, type StoredMetric, deleteMetric, metricRange, putMetric } from "../store/metrics";
import { SETTLE_DAYS, shift } from "./plan";

/**
 * The part of GoogleHealthClient this package uses. Every call reduces each
 * record as its page is read (the `reduce` argument). A source never catches
 * an error of these calls: the budget error of the client reaches the tool as
 * it is.
 */
export interface Fetcher {
  list<T>(dataType: DataType, from: LocalDate, to: LocalDate, reduce: Reduce<T>): Promise<T[]>;
  dailyRollup<T>(dataType: DataType, from: LocalDate, to: LocalDate, reduce: Reduce<T>): Promise<T[]>;
  listBetween<T>(dataType: DataType, start: Date, end: Date, reduce: Reduce<T>): Promise<T[]>;
}

/** The part of the store this package uses: the daily_metrics cache, and the list of the food entries this server created. */
export interface Cache {
  metricRange(key: string, from: LocalDate, to: LocalDate, algoVersion: number): StoredMetric[];
  putMetric(metric: Metric): void;
  deleteMetric(day: LocalDate, key: string): void;
  /**
   * The data point IDs of the food entries this server created in Google
   * Health on the local days [from, to]. Absent when `createdFoodNames` is
   * set: the ids are that map's keys. Absent with no names either: the
   * server created none, and the food log holds the band's own items only.
   */
  createdFoodIds?(from: LocalDate, to: LocalDate): ReadonlySet<string>;
  /**
   * The stored name of each food entry this server created on [from, to] for
   * the account that is linked now, keyed by data point id. One indexed read.
   * The food log takes it before any Google request, and uses its keys as the
   * ids. Absent: `createdFoodIds` decides which items are kept, and no name
   * is known.
   */
  createdFoodNames?(from: LocalDate, to: LocalDate): ReadonlyMap<string, string>;
}

/** The daily_metrics table of the coach store. */
export function dbCache(db: Db): Cache {
  return {
    metricRange: (key, from, to, algoVersion) => metricRange(db, key, from, to, algoVersion),
    putMetric: (metric) => putMetric(db, metric),
    deleteMetric: (day, key) => deleteMetric(db, day, key),
    createdFoodNames: (from, to) => entryNamesBetween(db, from, to),
  };
}

/** The cached rows of some keys: key, then day. */
export type CacheRows<K extends string> = Map<K, Map<LocalDate, StoredMetric>>;

/** One cache row before the source stamps it. */
export interface Row {
  date: LocalDate;
  key: string;
  value: number;
  nSamples?: number;
  source?: string;
}

export interface Logger {
  warn(message: string, fields: Record<string, unknown>): void;
}

const consoleLogger: Logger = { warn: (message, fields) => console.warn(message, fields) };

export class Context {
  /** The zone's name, stored with each row: another zone is a miss. */
  readonly zoneName: string;
  readonly log: Logger;

  constructor(
    readonly api: Fetcher,
    readonly cache: Cache,
    readonly zone: Zone,
    /** The clock that decides which days are settled. */
    readonly now: () => Date,
    log?: Logger,
  ) {
    if (!api || !cache || !zone || !now) throw new Error("healthdata: api, cache, time zone and clock are required");
    this.zoneName = zone.name;
    this.log = log ?? consoleLogger;
  }

  today(): LocalDate {
    return today(this.now(), this.zone);
  }

  /** Today and the newest day that may be cached, read from the clock once per call. */
  clock(): { today: LocalDate; settled: LocalDate } {
    const day = this.today();
    return { today: day, settled: shift(day, -SETTLE_DAYS) };
  }

  /**
   * Loads `keys` for the days [from, settled] of a call that ends on `to`,
   * keeping only rows computed in the configured zone. A range that holds no
   * settled day reads nothing.
   */
  readCache<K extends string>(from: LocalDate, to: LocalDate, settled: LocalDate, keys: readonly K[]): CacheRows<K> {
    const rows: CacheRows<K> = new Map();
    for (const key of keys) rows.set(key, new Map());
    const last = to < settled ? to : settled;
    if (last < from) return rows;
    for (const key of keys) {
      let metrics: StoredMetric[];
      try {
        metrics = this.cache.metricRange(key, from, last, ALGO_VERSION);
      } catch (cause) {
        throw new Error("healthdata: read cache", { cause });
      }
      const byDay = rows.get(key) as Map<LocalDate, StoredMetric>;
      for (const metric of metrics) if (metric.zone === this.zoneName) byDay.set(metric.date, metric);
    }
    return rows;
  }

  /**
   * Writes one cache row. The cache is disposable, so a failed write is
   * logged (key, day and the error's types, never the value) and the live
   * value is still returned.
   */
  put(row: Row): boolean {
    try {
      this.cache.putMetric({ ...row, algoVersion: ALGO_VERSION, zone: this.zoneName, fetchedAt: this.now() });
      return true;
    } catch (error) {
      this.log.warn("cache write failed", { metric: row.key, date: row.date, error_types: errorTypes(error) });
      return false;
    }
  }

  del(day: LocalDate, key: string): boolean {
    try {
      this.cache.deleteMetric(day, key);
      return true;
    } catch (error) {
      this.log.warn("cache delete failed", { metric: key, date: day, error_types: errorTypes(error) });
      return false;
    }
  }
}
