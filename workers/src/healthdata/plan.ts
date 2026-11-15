// Which days a source fetches, and in which requests.
//
// The Go server fetches each run of consecutive missing days with its own
// requests, so a cache with holes can cost hundreds of requests. A Worker has
// a request budget (googlehealth/budget.ts), so a source here plans first:
//
// 1. The first missing day starts a window. The window holds every missing
//    day of the next `size` days, and the first missing day after it starts
//    the next window. No set of ranges of `size` days covers the missing days
//    with fewer ranges.
// 2. A window is fetched as ONE covering range, from its first missing day to
//    its last. Days of that range that are already cached keep their cached
//    value: their records are dropped unread.
// 3. Windows are fetched oldest first, and the settled days of a finished
//    window are written to the cache before the next window starts. A call
//    that ends with the budget error leaves its finished windows cached.
//
// So a run of missing days is never split while it fits one window, runs that
// lie within `size` days share one range, and a cache with holes never needs
// more windows than a cold one (its missing days are a part of the cold
// ones). A rollup window is exactly one request. A list window costs one
// request per page of its range; a range with few records still costs one
// request per window, where the Go server reads it all in one.
//
// The sleep list is the exception to rule 2: its page holds only 25 records,
// so the covering range of two nights far apart costs more pages than the two
// nights fetched apart. Its ranges are chosen by counting pages (`ranges`).

import { type LocalDate, type Zone, addDays, bounds, parseDate } from "../coach/date";
import { TYPE_TABLE } from "../googlehealth/datatypes";
import type { Point } from "../metrics/stats";

/**
 * Bounds one call: a year of daily points, enough for the 180-point metric
 * series and 28-day baselines with slack.
 */
export const MAX_RANGE_DAYS = 366;

/**
 * The band syncs late, so a day is cached only once it is this many days old;
 * the days after it are always fetched live.
 */
export const SETTLE_DAYS = 3;

/**
 * Nights per window: the most whose HRV samples fit one page. The band writes
 * an HRV sample about every 5 minutes of sleep, 100 to 130 a night, and a
 * page holds 10000: 63 nights are at most 8190 samples. The sleep records of
 * the window (one per night, 25 per page) take 3 pages, so a window costs
 * about 4 requests.
 */
export const NIGHT_WINDOW_DAYS = 63;

/** Days per total-calories request: the API's cap for that rollup. */
export const KCAL_WINDOW_DAYS = 14;

/** Days per steps and per zone-minutes rollup request: the API's cap for those rollups. */
export const ROLLUP_WINDOW_DAYS = 90;

/**
 * Days per steps list of the "band worn" check: the band writes a record
 * about every minute it counts steps, so a month is about one page.
 */
export const WORN_WINDOW_DAYS = 31;

/** The day `n` days from `d`. `d` is a valid date here: dayList checked the range. */
export function shift(d: LocalDate, n: number): LocalDate {
  const out = addDays(d, n);
  if (out === undefined) throw new Error("healthdata: invalid date, want YYYY-MM-DD");
  return out;
}

/** The days of [from, to], oldest first. Throws for a range that is not valid or is longer than MAX_RANGE_DAYS. */
export function dayList(from: LocalDate, to: LocalDate): LocalDate[] {
  if (typeof from !== "string" || parseDate(from) === undefined) throw new Error("healthdata: from: invalid date, want YYYY-MM-DD");
  if (typeof to !== "string" || parseDate(to) === undefined) throw new Error("healthdata: to: invalid date, want YYYY-MM-DD");
  if (to < from) throw new Error(`healthdata: range ends (${to}) before it starts (${from})`);
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) {
    if (out.length === MAX_RANGE_DAYS) throw new Error(`healthdata: a range spans at most ${MAX_RANGE_DAYS} days`);
    out.push(d);
  }
  return out;
}

/** What a list request costs, to count the requests of a range before it is fetched. */
export interface ListCost {
  /**
   * The records a day adds to the list. An estimate: it decides only how
   * missing days are grouped into requests, never a value.
   */
  perDay: number;
  /** The records of one page: one request. */
  pageSize: number;
  /** The days fetched around the missing days. */
  marginDays: number;
}

/**
 * The sleep list: the band writes one main-sleep record per night, a page
 * holds 25, and a range is fetched with a day of margin on each side.
 */
export const SLEEP_COST: ListCost = { perDay: 1, pageSize: TYPE_TABLE.sleep.pageSize, marginDays: 2 };

/** The requests a list of `days` days is expected to cost. */
export function pagesOf(days: number, cost: ListCost): number {
  return Math.max(1, Math.ceil(((days + cost.marginDays) * cost.perDay) / cost.pageSize));
}

const DAY_MS = 86_400_000;

/**
 * Splits the missing days of one window (sorted) into the list ranges that
 * are expected to cost the fewest requests: its runs are merged into one
 * covering range when that needs fewer requests than fetching them apart.
 * With the same number of requests they are merged too. So the plan of a
 * window with holes never counts more pages than its covering range, which
 * lies inside the range the same window has with a cold cache.
 */
export function ranges(missing: readonly LocalDate[], cost: ListCost): Window[] {
  const all = runs(missing);
  const span = (from: number, to: number) => (Date.parse((all[to] as Run)[1]) - Date.parse((all[from] as Run)[0])) / DAY_MS + 1;
  // best[i]: the cheapest split of the first i runs, and where its last range starts.
  const best: { pages: number; count: number; start: number }[] = [{ pages: 0, count: 0, start: 0 }];
  for (let end = 1; end <= all.length; end++) {
    let pick = { pages: Number.POSITIVE_INFINITY, count: 0, start: 0 };
    for (let start = 0; start < end; start++) {
      const before = best[start] as (typeof best)[number];
      const candidate = { pages: before.pages + pagesOf(span(start, end - 1), cost), count: before.count + 1, start };
      if (candidate.pages < pick.pages || (candidate.pages === pick.pages && candidate.count < pick.count)) pick = candidate;
    }
    best.push(pick);
  }
  const out: Window[] = [];
  for (let end = all.length; end > 0; end = (best[end] as (typeof best)[number]).start) {
    const start = (best[end] as (typeof best)[number]).start;
    const [first, last] = [(all[start] as Run)[0], (all[end - 1] as Run)[1]];
    out.unshift({ days: missing.filter((d) => d >= first && d <= last), first, last });
  }
  return out;
}

/** One metrics point per day of [from, to]. */
export function points(from: LocalDate, to: LocalDate, get: (day: LocalDate) => number | null): Point[] {
  return dayList(from, to).map((date) => ({ date, value: get(date) }));
}

/** A run of consecutive days: [first, last]. */
export type Run = readonly [first: LocalDate, last: LocalDate];

/**
 * Groups sorted days into runs of consecutive days. A run is what the Go
 * server fetches in one go, so the rules it applies per fetch (what a dropped
 * record taints, when a data type is "empty") are applied per run here.
 */
export function runs(days: readonly LocalDate[]): Run[] {
  const out: [LocalDate, LocalDate][] = [];
  for (const d of days) {
    const current = out.at(-1);
    if (current && shift(current[1], 1) === d) current[1] = d;
    else out.push([d, d]);
  }
  return out;
}

/** The run that holds each day. */
export function runOf(all: readonly Run[]): Map<LocalDate, Run> {
  const out = new Map<LocalDate, Run>();
  for (const run of all) for (let d = run[0]; d <= run[1]; d = shift(d, 1)) out.set(d, run);
  return out;
}

/** The missing days of one window, oldest first: never empty. `first` to `last` is the range to fetch. */
export interface Window {
  days: LocalDate[];
  first: LocalDate;
  last: LocalDate;
}

/**
 * Covers the missing days (sorted, oldest first) with windows of at most
 * `size` days, each starting at a missing day.
 */
export function windows(missing: readonly LocalDate[], size: number): Window[] {
  const out: Window[] = [];
  let end = "";
  for (const d of missing) {
    const current = out.at(-1);
    if (current && d <= end) {
      current.days.push(d);
      current.last = d;
    } else {
      out.push({ days: [d], first: d, last: d });
      end = shift(d, size - 1);
    }
  }
  return out;
}

/**
 * Finds the local day of an instant among consecutive days. It reads the zone
 * once per day instead of once per instant: an HRV page holds 10000 samples.
 */
export class DayIndex {
  private readonly days: LocalDate[] = [];
  /** The first instant of each day, and after the last one the end of the range. */
  private readonly starts: number[] = [];

  constructor(first: LocalDate, last: LocalDate, zone: Zone) {
    for (let d = first; d <= last; d = shift(d, 1)) {
      const day = bounds(d, zone);
      if (!day) throw new Error("healthdata: invalid date, want YYYY-MM-DD");
      this.days.push(d);
      this.starts.push(day.start.getTime());
      if (d === last) this.starts.push(day.end.getTime());
    }
  }

  /** The day `ms` falls on, or undefined outside the range. */
  dayOf(ms: number): LocalDate | undefined {
    const starts = this.starts;
    if (!(ms >= (starts[0] as number) && ms < (starts.at(-1) as number))) return undefined;
    let low = 0;
    let high = this.days.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] as number) <= ms) low = mid;
      else high = mid - 1;
    }
    return this.days[low];
  }
}

/** Reads which values a caller asked for: all of them when it names none. */
export function wanted<T extends string>(values: readonly T[] | undefined, all: readonly T[]): ReadonlySet<T> {
  if (values === undefined) return new Set(all);
  if (values.length === 0) throw new Error("healthdata: the list of values to read is empty");
  for (const value of values) if (!all.includes(value)) throw new Error("healthdata: unknown value to read");
  return new Set(values);
}
