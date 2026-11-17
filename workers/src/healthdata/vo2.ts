// Daily VO2 max (Google Health data type `daily-vo2-max`).
//
// The shapes come from Google's documentation:
//   - https://developers.google.com/health/data-types (`daily-vo2-max`,
//     filter `daily_vo2_max`, record type Daily, operations list and
//     reconcile, scope activity_and_fitness.readonly)
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
//     (DailyVO2Max: date, estimated, cardioFitnessLevel, vo2Max in [0, 100],
//     vo2MaxCovariance)
//
// `vo2-max` and `run-vo2-max` are sample records (one measurement, one run).
// The daily type is already one summary per day, which is what a week and a
// series need, so those two are not read. The data-type page gives this type
// list and reconcile only, so the read is a list filtered on `date`.

import type { LocalDate } from "../coach/date";
import { compareText } from "../coach/text";
import type { Point } from "../metrics/stats";
import type { Context } from "./cache";
import { civilDay, dataSource, decode, flag, float, label, object, root } from "./decode";
import { PRIMARY_PLATFORM } from "./parse";
import { dayList, points } from "./plan";

/** Google documents vo2Max in [0, 100], in ml/kg/min. */
export const MIN_VO2 = 0;
export const MAX_VO2 = 100;

/** One day's VO2 max. */
export interface Vo2Reading {
  /** ml/kg/min. */
  value: number;
  /** The record's `estimated` field: confidence in the value has dropped. */
  estimated: boolean;
  source: string;
}

/** The daily VO2 max of [from, to]. A day without a reading is absent. */
export class Vo2 {
  days = new Map<LocalDate, Vo2Reading>();
  /** Records that could not be read, and days whose readings disagree. */
  skipped = 0;
  /** Records from a platform other than Fitbit. */
  otherSource = 0;

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
  ) {}

  /** One point per day. A day without a reading is null. */
  series(): Point[] {
    return points(this.from, this.to, (day) => this.days.get(day)?.value ?? null);
  }
}

/**
 * What a daily VO2 max record reduces to. "undated": no usable day.
 * "other": another platform. "bad": a value outside the documented range.
 */
export type Vo2Read =
  | { kind: "undated" }
  | { kind: "other"; date: LocalDate }
  | { kind: "bad"; date: LocalDate }
  | { kind: "value"; date: LocalDate; value: number; estimated: boolean; source: string };

/** Reduces one daily-vo2-max record. The vendor's fitness category is not kept. */
export function parseVo2(record: unknown): Vo2Read {
  const r = decode(() => {
    const body = root(record);
    const daily = object(body, "dailyVo2Max");
    return {
      source: dataSource(body),
      present: daily !== undefined,
      date: civilDay(object(daily, "date")),
      value: float(daily, "vo2Max"),
      estimated: flag(daily, "estimated"),
    };
  });
  if (r === undefined || !r.present || r.date === undefined) return { kind: "undated" };
  if (r.source.platform !== PRIMARY_PLATFORM) return { kind: "other", date: r.date };
  if (r.value === undefined || r.value < MIN_VO2 || r.value > MAX_VO2) return { kind: "bad", date: r.date };
  return { kind: "value", date: r.date, value: r.value, estimated: r.estimated, source: label(r.source) };
}

/**
 * The daily VO2 max of [from, to]. One list: a page holds 10000 points and a
 * day has one summary, so a year is one request. Days are not cached. The
 * value is sparse, and a day without a reading must stay a miss.
 *
 * Several readings of one day: the ones that are not estimated are used, and
 * the estimated ones only when the day has no other. The readings used must
 * agree: when they differ, the day is left unread. The order of the records
 * does not change the choice.
 */
export async function readVo2(ctx: Context, from: LocalDate, to: LocalDate): Promise<Vo2> {
  dayList(from, to);
  const out = new Vo2(from, to);
  const reads = await ctx.api.list("daily-vo2-max", from, to, (record): Vo2Read | undefined => {
    const read = parseVo2(record);
    if (read.kind === "undated") return read;
    return read.date < from || read.date > to ? undefined : read;
  });
  // The readings of each day, by kind. The choice is made on the whole day,
  // so it does not depend on the order of the records.
  const byDay = new Map<LocalDate, { measured: Vo2Reading[]; estimated: Vo2Reading[] }>();
  for (const read of reads) {
    if (read.kind === "undated" || read.kind === "bad") {
      out.skipped++;
      continue;
    }
    if (read.kind === "other") {
      out.otherSource++;
      continue;
    }
    let day = byDay.get(read.date);
    if (day === undefined) {
      day = { measured: [], estimated: [] };
      byDay.set(read.date, day);
    }
    (read.estimated ? day.estimated : day.measured).push({ value: read.value, estimated: read.estimated, source: read.source });
  }
  const chosen = new Map<LocalDate, Vo2Reading>();
  for (const [date, day] of byDay) {
    const kind = day.measured.length > 0 ? day.measured : day.estimated;
    const first = kind[0];
    if (first !== undefined && kind.every((reading) => reading.value === first.value)) chosen.set(date, first);
    else out.skipped++;
  }
  out.days = new Map([...chosen].sort(([left], [right]) => compareText(left, right)));
  if (out.skipped > 0) ctx.log.warn("unreadable daily vo2 max records", { from, to, skipped: out.skipped });
  return out;
}
