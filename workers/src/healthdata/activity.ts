// Steps, Active Zone Minutes and total calories per day (Go:
// internal/healthdata/activity.go, the Activity part).

import type { LocalDate } from "../coach/date";
import { compareText } from "../coach/text";
import type { DataType } from "../googlehealth/datatypes";
import type { Point } from "../metrics/stats";
import type { Context } from "./cache";
import { type Obj, UNREADABLE, dataSource, decode, float, object, optionalInt64s, root } from "./decode";
import { PRIMARY_PLATFORM, civilDateTimeDay } from "./parse";
import {
  KCAL_WINDOW_DAYS,
  ROLLUP_WINDOW_DAYS,
  type Run,
  WORN_WINDOW_DAYS,
  type Window,
  dayList,
  points,
  runOf,
  runs,
  wanted,
  windows,
} from "./plan";

// Daily activity keys (CAPABILITY §5.3). As with the recovery keys, the text
// is also the cache row key and never changes.
export const KEY_STEPS = "steps";
export const KEY_AZM = "azm_min";
export const KEY_TOTAL_CALORIES = "total_calories_kcal";

export const ACTIVITY_KEYS = [KEY_STEPS, KEY_AZM, KEY_TOTAL_CALORIES] as const;

/** Names an Activity series. */
export type ActivityKey = (typeof ACTIVITY_KEYS)[number];

/**
 * Labels values taken from the API's daily rollup, which merges the band's
 * and the phone's records into one total per day (CAPABILITY I2).
 */
export const ROLLUP_SOURCE = "Google Health daily total";

const MAX_DAY_STEPS = 200_000;
const MAX_DAY_AZM = 2 * 24 * 60; // every minute in cardio or peak
const MAX_DAY_KCAL = 20_000;

/** One local day's totals; null is a day without data. */
export interface ActivityDay {
  steps: number | null;
  /**
   * Active Zone Minutes (fat burn counts 1 per minute, cardio and peak 2): 0
   * on a day the band recorded without any zone minutes.
   */
  azm: number | null;
  totalKcal: number | null;
  /**
   * The band recorded that day. Without it total calories is mostly an
   * estimate of the resting burn, not a measured one.
   */
  worn: boolean;
  /** Today, so the totals can still grow. Baselines leave it out. */
  partial: boolean;
}

/**
 * What a caller may ask Activity for. "azm" and "worn" read the same data:
 * the zone-minutes rollup, and the steps records of the days without a
 * zone-minutes row.
 */
export const ACTIVITY_VALUES = ["steps", "azm", "total_calories", "worn"] as const;
export type ActivityValue = (typeof ACTIVITY_VALUES)[number];

export interface ActivityOptions {
  /**
   * The values the caller needs. Default: all of them, as the Go server
   * reads. With fewer, a day holds only what was read: the other totals are
   * null, `worn` is false, and a day without any of the values read is absent
   * (a read of "worn" keeps every day the band recorded).
   */
  values?: readonly ActivityValue[];
  /**
   * Limits the read to these days of [from, to]. Default: every day of the
   * range. The windows are planned over the missing days of the list alone, a
   * row of another day is dropped as its page is read, and the result holds
   * only days of the list. An empty list makes no request. A day outside
   * [from, to] is an error.
   *
   * A caller uses it to leave out days that would be read again on every call
   * for nothing: a day without band data is never cached, and its total
   * calories are of no use to a caller that reads them as "calories burned".
   */
  days?: readonly LocalDate[];
}

/** Which data a set of values needs. */
function reads(values: ReadonlySet<ActivityValue>): { steps: boolean; azm: boolean; kcal: boolean } {
  return { steps: values.has("steps"), azm: values.has("azm") || values.has("worn"), kcal: values.has("total_calories") };
}

/** The daily totals of [from, to]. */
export class Activity {
  days = new Map<LocalDate, ActivityDay>();
  /** Rollup rows that could not be read. */
  skipped = 0;

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
    /** The values that were read. A series of a value that was not read throws: it would be all null. */
    readonly values: ReadonlySet<ActivityValue> = new Set(ACTIVITY_VALUES),
  ) {}

  /** One point per day for `key`, null where the value is missing. */
  series(key: ActivityKey): Point[] {
    return this.pointsOf(key, false);
  }

  /** `series` without partial days. */
  baselineSeries(key: ActivityKey): Point[] {
    return this.pointsOf(key, true);
  }

  private pointsOf(key: ActivityKey, baseline: boolean): Point[] {
    const read = reads(this.values);
    let get: (day: ActivityDay) => number | null;
    let wasRead: boolean;
    switch (key) {
      case KEY_STEPS:
        [get, wasRead] = [(day) => day.steps, read.steps];
        break;
      case KEY_AZM:
        [get, wasRead] = [(day) => day.azm, read.azm];
        break;
      case KEY_TOTAL_CALORIES:
        [get, wasRead] = [(day) => day.totalKcal, read.kcal];
        break;
      default:
        throw new Error("healthdata: no such activity series");
    }
    if (!wasRead) throw new Error("healthdata: the activity series was not read");
    return points(this.from, this.to, (date) => {
      const day = this.days.get(date);
      return day && !(baseline && day.partial) ? get(day) : null;
    });
  }
}

/** One rollup row, reduced: its day when readable, its value when usable. */
interface RollupRead {
  day: LocalDate | undefined;
  value: number | undefined;
}

/**
 * Steps, Active Zone Minutes and total calories for each day of [from, to],
 * from the API's daily rollups. A settled day comes from the cache when every
 * value the caller asked for is there. Only a day the band recorded (a day
 * with a zone-minutes value) is ever cached, so a day without band data is
 * read again on every call.
 *
 * The missing days are fetched in windows (plan.ts): one steps and one
 * zone-minutes rollup request per 90 days, and one total-calories request per
 * 14 days. The days of a total-calories window are cached as soon as its rows
 * are read.
 */
export async function readActivity(ctx: Context, from: LocalDate, to: LocalDate, options: ActivityOptions = {}): Promise<Activity> {
  const days = listed(dayList(from, to), options.days);
  const values = wanted(options.values, ACTIVITY_VALUES);
  const read = reads(values);
  const { today, settled } = ctx.clock();
  const a = new Activity(from, to, values);

  const keys: ActivityKey[] = [];
  if (read.steps) keys.push(KEY_STEPS);
  if (read.azm) keys.push(KEY_AZM);
  if (read.kcal) keys.push(KEY_TOTAL_CALORIES);
  // The zone-minutes rows are loaded also for a caller that did not ask for
  // zone minutes: a cached one says that the band recorded the day, which
  // decides if a steps or total-calories row may be cached (see below).
  const cached = ctx.readCache(from, to, settled, read.azm ? keys : [...keys, KEY_AZM]);
  const need: LocalDate[] = [];
  for (const day of days) {
    const s = cached.get(KEY_STEPS)?.get(day);
    const z = cached.get(KEY_AZM)?.get(day);
    const k = cached.get(KEY_TOTAL_CALORIES)?.get(day);
    if ((!read.steps || s) && (!read.azm || z) && (!read.kcal || k)) {
      // An AZM value, even 0, means the band recorded the day.
      a.days.set(day, { steps: s?.value ?? null, azm: read.azm ? (z?.value ?? null) : null, totalKcal: k?.value ?? null, worn: read.azm, partial: false });
      continue;
    }
    need.push(day);
  }
  if (need.length === 0) return a;

  const needed = new Set(need);
  const allRuns = runs(need);
  const runOfDay = runOf(allRuns);
  // Like a night fetched with an unreadable record, a run of missing days
  // with a dropped row is returned but not cached, and gets no 0 for its zone
  // minutes: the dropped row may have been that day's.
  const dirty = new Set<Run>();
  const steps = new Map<LocalDate, number>();
  const azm = new Map<LocalDate, number>();
  const kcal = new Map<LocalDate, number>();
  const worn = new Set<LocalDate>();

  const rollup = async (
    dataType: DataType,
    first: LocalDate,
    last: LocalDate,
    value: (row: Obj | undefined) => number,
    high: number,
    into: Map<LocalDate, number>,
  ): Promise<void> => {
    const rows = await ctx.api.dailyRollup(dataType, first, last, (record): RollupRead | undefined => {
      const day = decode(() => civilDateTimeDay(object(root(record), "civilStartTime")));
      // A row of a day that is not missing is ignored, not counted.
      if (day !== undefined && !needed.has(day)) return undefined;
      const v = decode(() => value(root(record)));
      return { day, value: day !== undefined && v !== undefined && v >= 0 && v <= high ? v : undefined };
    });
    let skipped = 0;
    for (const row of rows) {
      if (row.day !== undefined && row.value !== undefined) {
        into.set(row.day, row.value);
        continue;
      }
      skipped++;
      const run = row.day === undefined ? undefined : runOfDay.get(row.day);
      if (run) dirty.add(run);
      // The day of the row is unknown: it may belong to any run of the request.
      else for (const other of allRuns) if (other[1] >= first && other[0] <= last) dirty.add(other);
    }
    if (skipped > 0) {
      a.skipped += skipped;
      ctx.log.warn("unreadable daily rollup rows", { data_type: dataType, from: first, to: last, skipped });
    }
  };

  const dayOf = (day: LocalDate, clean: boolean): ActivityDay | undefined => {
    const [s, z, k] = [steps.get(day) ?? null, azm.get(day) ?? null, kcal.get(day) ?? null];
    const bandDay = worn.has(day);
    // The rollup leaves out a day without zone minutes. On a day the band
    // recorded steps that is 0 minutes; on a day it was not worn, no data.
    const zone = z === null && bandDay && clean ? 0 : z;
    // A day without any value is no day, as in the Go server, which reads all
    // three totals. A read of fewer totals cannot tell that the day is empty:
    // when the band's step records say it was worn, the day is kept (its zone
    // minutes are unknown in a run with a dropped row).
    const known = bandDay && read.azm && !(read.steps && read.kcal);
    if (s === null && zone === null && k === null && !known) return undefined;
    return { steps: s, azm: zone, totalKcal: k, worn: z !== null || bandDay, partial: day >= today };
  };
  const isClean = (day: LocalDate) => !dirty.has(runOfDay.get(day) as Run);

  // The steps and zone-minutes rollups are read in windows of 90 days, and
  // total calories in windows of 14. The days are cached per window of the
  // smallest kind that is read, as soon as every value of its days is there.
  const wide = windows(need, ROLLUP_WINDOW_DAYS);
  let nextWide = 0;
  const unchecked: Window[] = []; // wide windows whose "band worn" check is still to do
  const written: LocalDate[] = []; // days this call cached
  for (const window of read.kcal ? windows(need, KCAL_WINDOW_DAYS) : wide) {
    for (let w = wide[nextWide]; w !== undefined && w.first <= window.last; w = wide[++nextWide]) {
      if (read.steps) {
        // A row is sent only for a day with steps: a missing count is a
        // renamed field, not zero steps.
        await rollup("steps", w.first, w.last, (row) => required(optionalInt64s(object(row, "steps"), "countSum")), MAX_DAY_STEPS, steps);
      }
      if (read.azm) {
        await rollup("active-zone-minutes", w.first, w.last, zoneMinutes, MAX_DAY_AZM, azm);
        unchecked.push(w);
      }
    }
    if (read.kcal) {
      await rollup("total-calories", window.first, window.last, (row) => required(float(object(row, "totalCalories"), "kcalSum")), MAX_DAY_KCAL, kcal);
    }
    for (const w of unchecked.splice(0)) {
      // The steps records are listed only for the days without a
      // zone-minutes row.
      const lacking = w.days.filter((day) => !azm.has(day));
      for (const list of windows(lacking, WORN_WINDOW_DAYS)) {
        for (const day of await wornDays(ctx, list.first, list.last)) worn.add(day);
      }
    }
    for (const day of window.days) {
      const clean = isClean(day);
      const v = dayOf(day, clean);
      if (!v || day > settled || !clean) continue;
      // A steps or total-calories row is cached only for a day the band
      // recorded: its zone-minutes value was read now (a row, or the 0 of a
      // worn day), or its row is already in the cache. A day without band
      // data is read again on every call, as in the Go server, which serves a
      // cached day only with its zone-minutes row. So band data that arrives
      // after the day settled (a late sync) replaces the totals, also for a
      // caller that reads steps or total calories alone.
      const recorded = v.azm !== null || cached.get(KEY_AZM)?.has(day) === true;
      if (read.steps && v.steps !== null && recorded) ctx.put({ date: day, key: KEY_STEPS, value: v.steps, source: ROLLUP_SOURCE });
      if (read.azm && v.azm !== null) ctx.put({ date: day, key: KEY_AZM, value: v.azm, source: ROLLUP_SOURCE });
      if (read.kcal && v.totalKcal !== null && recorded) ctx.put({ date: day, key: KEY_TOTAL_CALORIES, value: v.totalKcal, source: ROLLUP_SOURCE });
      written.push(day);
    }
  }

  // A row dropped in a later window makes its whole run of missing days
  // unclean. So the days are built once every window is read, and the days
  // of that run that an earlier window cached are taken out of the cache.
  for (const day of written) {
    if (!isClean(day)) for (const key of keys) ctx.del(day, key);
  }
  for (const day of need) {
    const v = dayOf(day, isClean(day));
    if (v) a.days.set(day, v);
  }
  a.days = new Map([...a.days].sort(([x], [y]) => compareText(x, y)));
  return a;
}

/** The days to read: all of `range`, or the days of `only` in date order, each once. */
function listed(range: readonly LocalDate[], only: readonly LocalDate[] | undefined): LocalDate[] {
  if (only === undefined) return [...range];
  const inRange = new Set(range);
  for (const day of only) if (!inRange.has(day)) throw new Error("healthdata: a day to read is outside the range");
  return [...new Set(only)].sort(compareText);
}

function required(value: number | undefined): number {
  if (value === undefined) throw UNREADABLE;
  return value;
}

/** The zone sums as the rollup reports them: cardio and peak already count double. */
function zoneMinutes(row: Obj | undefined): number {
  const zones = object(row, "activeZoneMinutes");
  const [fatBurn, cardio, peak] = [
    optionalInt64s(zones, "sumInFatBurnHeartZone"),
    optionalInt64s(zones, "sumInCardioHeartZone"),
    optionalInt64s(zones, "sumInPeakHeartZone"),
  ];
  // A row is sent only for a day with zone minutes: no zone at all is a
  // renamed field.
  if (zones === undefined || (fatBurn === undefined && cardio === undefined && peak === undefined)) throw UNREADABLE;
  return (fatBurn ?? 0) + (cardio ?? 0) + (peak ?? 0);
}

/** The days of [first, last] with step records of the band. Each day is kept once, as its page is read. */
async function wornDays(ctx: Context, first: LocalDate, last: LocalDate): Promise<LocalDate[]> {
  const seen = new Set<LocalDate>();
  return ctx.api.list("steps", first, last, (record) => {
    const day = decode(() => {
      const r = root(record);
      const source = dataSource(r);
      const steps = object(r, "steps");
      const start = civilDateTimeDay(object(object(steps, "interval"), "civilStartTime"));
      return steps !== undefined && source.platform === PRIMARY_PLATFORM ? start : undefined;
    });
    if (day === undefined || seen.has(day)) return undefined;
    seen.add(day);
    return day;
  });
}
