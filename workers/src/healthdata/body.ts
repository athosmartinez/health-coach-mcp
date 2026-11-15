// Weight and body fat (Go: internal/healthdata/activity.go, the Body part).

import type { LocalDate } from "../coach/date";
import { compareText } from "../coach/text";
import type { DataType } from "../googlehealth/datatypes";
import type { Point } from "../metrics/stats";
import type { Context } from "./cache";
import { ZERO_TIME, dataSource, decode, float, label, object, root, time } from "./decode";
import { dayList, points, wanted } from "./plan";

// Daily body keys (CAPABILITY §5.3): also the cache row keys.
export const KEY_WEIGHT = "weight_kg";
export const KEY_BODY_FAT = "body_fat_pct";

export const BODY_KEYS = [KEY_WEIGHT, KEY_BODY_FAT] as const;

/** Names a Body series. */
export type BodyKey = (typeof BODY_KEYS)[number];

const MIN_WEIGHT_KG = 20;
const MAX_WEIGHT_KG = 400;
const MIN_BODY_FAT_PCT = 2;
const MAX_BODY_FAT_PCT = 75;

/** One body measurement. */
export interface Reading {
  /** undefined when read from the cache. */
  at: Date | undefined;
  /** kg for weight, percent for body fat. */
  value: number;
  source: string;
}

/** What a caller may ask Body for. */
export const BODY_VALUES = ["weight", "body_fat"] as const;
export type BodyValue = (typeof BODY_VALUES)[number];

export interface BodyOptions {
  /** The values the caller needs. Default: both, as the Go server reads. */
  values?: readonly BodyValue[];
}

/**
 * The weight and body fat of [from, to]: the first reading of each local day,
 * the usual morning weigh-in (an evening reading runs about a kilogram
 * higher, the size of a week's trend). Every platform counts (a scale may
 * sync through Apple Health).
 */
export class Body {
  weight = new Map<LocalDate, Reading>();
  bodyFat = new Map<LocalDate, Reading>();
  skipped = 0;

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
    /** The values that were read. A series of a value that was not read throws: it would be all null. */
    readonly values: ReadonlySet<BodyValue> = new Set(BODY_VALUES),
  ) {}

  /** One point per day for KEY_WEIGHT or KEY_BODY_FAT. */
  series(key: BodyKey): Point[] {
    let readings: Map<LocalDate, Reading>;
    let wasRead: boolean;
    switch (key) {
      case KEY_WEIGHT:
        [readings, wasRead] = [this.weight, this.values.has("weight")];
        break;
      case KEY_BODY_FAT:
        [readings, wasRead] = [this.bodyFat, this.values.has("body_fat")];
        break;
      default:
        throw new Error("healthdata: no such body series");
    }
    if (!wasRead) throw new Error("healthdata: the body series was not read");
    return points(this.from, this.to, (day) => readings.get(day)?.value ?? null);
  }
}

/** The latest day's reading, if any. */
export function last(readings: ReadonlyMap<LocalDate, Reading>): { day: LocalDate; reading: Reading } | undefined {
  let latest: { day: LocalDate; reading: Reading } | undefined;
  for (const [day, reading] of readings) if (!latest || day > latest.day) latest = { day, reading };
  return latest;
}

/** One reading, reduced: null for a record that cannot be read. */
type BodyRead = { day: LocalDate; at: number; value: number; source: string } | null;

/** A kind of reading: where its value is in the record, the factor to the coach's unit and the plausible range. */
interface Kind {
  value: BodyValue;
  key: BodyKey;
  dataType: DataType;
  record: string;
  field: string;
  divisor: number;
  min: number;
  max: number;
}

const WEIGHT: Kind = {
  value: "weight",
  key: KEY_WEIGHT,
  dataType: "weight",
  record: "weight",
  field: "weightGrams",
  divisor: 1000,
  min: MIN_WEIGHT_KG,
  max: MAX_WEIGHT_KG,
};

const BODY_FAT: Kind = {
  value: "body_fat",
  key: KEY_BODY_FAT,
  dataType: "body-fat",
  record: "bodyFat",
  field: "percentage",
  divisor: 1,
  min: MIN_BODY_FAT_PCT,
  max: MAX_BODY_FAT_PCT,
};

const KINDS = [WEIGHT, BODY_FAT] as const;

/** Reads one weight or body fat record: its time, its value in the coach's unit and its source. */
function parseReading(record: unknown, kind: Kind): { at: number; value: number; source: string } | null {
  const read = decode(() => {
    const r = root(record);
    const body = object(r, kind.record);
    return { source: dataSource(r), at: time(object(body, "sampleTime"), "physicalTime"), raw: float(body, kind.field) };
  });
  if (read === undefined || read.raw === undefined || read.at === ZERO_TIME) return null;
  const value = read.raw / kind.divisor;
  if (value < kind.min || value > kind.max) return null;
  return { at: read.at, value, source: label(read.source) };
}

export const parseWeight = (record: unknown) => parseReading(record, WEIGHT);
export const parseBodyFat = (record: unknown) => parseReading(record, BODY_FAT);

/**
 * The weight and body fat of [from, to].
 *
 * A day without a reading is never cached, so a value's range is fetched
 * whenever a day is missing: readings are sparse and one list request covers
 * the whole range (a page holds 10000 readings). So this source has one
 * window per value, and it never merges runs.
 */
export async function readBody(ctx: Context, from: LocalDate, to: LocalDate, options: BodyOptions = {}): Promise<Body> {
  const days = dayList(from, to);
  const values = wanted(options.values, BODY_VALUES);
  const { settled } = ctx.clock();
  const b = new Body(from, to, values);
  for (const kind of KINDS) {
    if (!values.has(kind.value)) continue;
    const out = new Map<LocalDate, Reading>();
    const cached = ctx.readCache(from, to, settled, [kind.key]).get(kind.key) ?? new Map();
    if (cached.size === days.length) {
      for (const [day, row] of cached) out.set(day, { at: undefined, value: row.value, source: row.source ?? "" });
    } else {
      const reads = await ctx.api.list(kind.dataType, from, to, (record): BodyRead | undefined => {
        const read = parseReading(record, kind);
        if (read === null) return null;
        const day = ctx.zone.dateOf(Math.floor(read.at));
        return day < from || day > to ? undefined : { day, ...read };
      });
      let skipped = 0;
      const firstAt = new Map<LocalDate, number>();
      for (const read of reads) {
        if (read === null) {
          skipped++;
          continue;
        }
        const current = firstAt.get(read.day);
        if (current === undefined || read.at < current) {
          firstAt.set(read.day, read.at);
          out.set(read.day, { at: new Date(read.at), value: read.value, source: read.source });
        }
      }
      b.skipped += skipped;
      // The dropped reading may have been a day's first: a run with one is
      // returned but not cached.
      if (skipped === 0) {
        for (const [day, reading] of out) {
          if (day <= settled) ctx.put({ date: day, key: kind.key, value: reading.value, source: reading.source });
        }
      }
    }
    const sorted = new Map([...out].sort(([x], [y]) => compareText(x, y)));
    if (kind.value === "weight") b.weight = sorted;
    else b.bodyFat = sorted;
  }
  if (b.skipped > 0) ctx.log.warn("unreadable body records", { from, to, skipped: b.skipped });
  return b;
}
