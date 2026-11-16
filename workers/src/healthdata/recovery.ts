// Nights and resting heart rate.

import { type LocalDate, type Zone, parseDate } from "../coach/date";
import { compareText } from "../coach/text";
import type { DataType } from "../googlehealth/datatypes";
import type { Point } from "../metrics/stats";
import type { CacheRows, Context, Row } from "./cache";
import { type RestingRead, type Session, type SleepRead, type Stages, parseHRV, parseResting, parseSleep } from "./parse";
import { DayIndex, NIGHT_WINDOW_DAYS, SLEEP_COST, dayList, points, ranges, runs, shift, wanted, windows } from "./plan";

// Daily value keys: the store's closed list (CAPABILITY §5.3). A key's text is
// also the cache row key, so it never changes: a renamed key turns every
// cached day into a miss.
export const KEY_ASLEEP = "sleep_asleep_min";
export const KEY_AWAKE = "sleep_awake_min";
export const KEY_IN_BED = "sleep_in_bed_min";
export const KEY_DEEP = "sleep_deep_min";
export const KEY_LIGHT = "sleep_light_min";
export const KEY_REM = "sleep_rem_min";
/** Wraps at midnight: only for metrics.sleepOnsetConsistency, never a linear mean. */
export const KEY_SLEEP_START = "sleep_start_min_of_day";
/** Wraps at midnight too. */
export const KEY_SLEEP_END = "sleep_end_min_of_day";
export const KEY_HRV = "hrv_rmssd_ms";
export const KEY_RESTING_HR = "resting_hr_bpm";

/**
 * The per-night rows. KEY_ASLEEP is written last and removed first, so a
 * night is a cache hit only when its write completed.
 */
export const SLEEP_KEYS = [KEY_ASLEEP, KEY_AWAKE, KEY_IN_BED, KEY_DEEP, KEY_LIGHT, KEY_REM, KEY_SLEEP_START, KEY_SLEEP_END] as const;

export const RECOVERY_KEYS = [...SLEEP_KEYS, KEY_HRV, KEY_RESTING_HR] as const;

/** Names a Recovery series. */
export type RecoveryKey = (typeof RECOVERY_KEYS)[number];

/** With KEY_ASLEEP, always present. */
const CORE_KEYS = [KEY_AWAKE, KEY_IN_BED, KEY_SLEEP_START, KEY_SLEEP_END] as const;
/** All or none. */
const STAGE_KEYS = [KEY_DEEP, KEY_LIGHT, KEY_REM] as const;

// The band records rMSSD about every 5 minutes of sleep. A nightly median
// needs at least MIN_HRV_SAMPLES samples covering MIN_HRV_COVERAGE of the
// night's slots, and MIN_HALF_COVERAGE of each half: a band worn for the last
// hour only would otherwise give a value that sits in the baselines.
const HRV_SLOT_MS = 5 * 60_000;
const MIN_HRV_SAMPLES = 12;
const MIN_HRV_COVERAGE = 0.5;
const MIN_HALF_COVERAGE = 0.25;

/**
 * Main-sleep records ending on the same day with at most this much awake time
 * between them are one night split by a wake-up.
 */
const MAX_SPLIT_GAP_MS = 3 * 3_600_000;

const RESTING_WITH_SLEEP = "WITH_SLEEP";

const DAY_MS = 86_400_000;

/** A night's heart rate variability. */
export interface HRVNight {
  /** Median rMSSD (ms); null when the samples cover too little of the night. */
  medianMs: number | null;
  /**
   * The share (0..1) of the night's 5-minute slots holding a sample. With
   * medianMs null and coverage above 0, the value was withheld for too little
   * coverage (on a recent night, possibly samples still syncing), not missing.
   */
  coverage: number;
}

/** Whether the night has samples but too few for a value. */
export function hrvWithheld(hrv: HRVNight): boolean {
  return hrv.medianMs === null && hrv.coverage > 0;
}

/**
 * The main sleep ending on a local day (CAPABILITY I4): of that day's
 * main-sleep sessions (overlapping copies merged, sessions at most
 * MAX_SPLIT_GAP_MS apart joined), the group with the most time in bed, and
 * the median HRV inside it.
 */
export interface Night {
  asleepMin: number;
  awakeMin: number;
  inBedMin: number;
  /** null without final stages. */
  stages: Stages | null;
  /** Local start time, minutes after midnight. */
  startMinOfDay: number;
  /** Local end time, minutes after midnight (the Go server reads it from `End`, which carries its zone). */
  endMinOfDay: number;
  /**
   * `start` and `end` bound the night, to the whole minute (the cache keeps
   * minutes); for a split night, the first part's start and the last part's end.
   */
  start: Date;
  end: Date;
  hrv: HRVNight;
  source: string;
  /**
   * Google has not finished processing the night (or sent it in a format the
   * coach does not know), so its values may still change. Baselines leave it
   * out. It says nothing about HRV still syncing: any night newer than the
   * settled days may still change.
   */
  provisional: boolean;
}

/** One day's resting heart rate. */
export interface RestingHR {
  bpm: number;
  /**
   * Google's calculation method. WITH_SLEEP is the band's standard one; other
   * values are shown for the day but kept out of baselines.
   */
  method: string;
}

/** Whether the value was computed with the band's standard method. */
export function restingStandard(hr: RestingHR): boolean {
  return hr.method === RESTING_WITH_SLEEP;
}

/**
 * Counts readable records the coach did not use as-is, by reason. Only days
 * fetched live in the call are counted (cached days add nothing), so two
 * calls over the same range can differ.
 */
export interface Excluded {
  /** Another platform, such as Apple Health copies. */
  otherSource: number;
  naps: number;
  /** Main-sleep records that were not part of the night, or duplicated it. */
  extraSessions: number;
  /** HRV samples inside a night without an rMSSD value. */
  noHRVValue: number;
  /** Sleep records in a format other than STAGES or CLASSIC: kept, read without stages, provisional. */
  unknownSleepType: number;
}

/** What a caller may ask Recovery for. "nights" reads sleep and HRV; "resting_hr" reads resting heart rate. */
export const RECOVERY_VALUES = ["nights", "resting_hr"] as const;
export type RecoveryValue = (typeof RECOVERY_VALUES)[number];

export interface RecoveryOptions {
  /** The values the caller needs. Default: all of them, as the Go server reads. */
  values?: readonly RecoveryValue[];
}

/** The nights and resting heart rates of [from, to]. */
export class Recovery {
  nights = new Map<LocalDate, Night>();
  restingHR = new Map<LocalDate, RestingHR>();
  /** Device or platform labels, sorted. */
  sources: string[] = [];
  /**
   * Counts records that could not be read. Tools report it as a data quality
   * flag; the day of one (or its whole fetch, when the day is unknown) is
   * never cached.
   */
  skipped = 0;
  excluded: Excluded = { otherSource: 0, naps: 0, extraSessions: 0, noHRVValue: 0, unknownSleepType: 0 };
  /**
   * The data types for which a live fetch returned records but none usable
   * (all from another platform or without a value): a source or format
   * change, not a lack of data.
   */
  empty: DataType[] = [];

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
    /** The values that were read. A series of a value that was not read throws: it would be all null. */
    readonly values: ReadonlySet<RecoveryValue> = new Set(RECOVERY_VALUES),
  ) {}

  /**
   * One point per day of [from, to] for `key`, null where the value is
   * missing: every value, for reporting the days themselves.
   */
  series(key: RecoveryKey): Point[] {
    return this.pointsOf(key, false);
  }

  /**
   * `series` without the values that must not shape a baseline: provisional
   * nights and resting heart rates from a non-standard method.
   */
  baselineSeries(key: RecoveryKey): Point[] {
    return this.pointsOf(key, true);
  }

  private pointsOf(key: RecoveryKey, baseline: boolean): Point[] {
    const night =
      (read: (n: Night) => number | null) =>
      (day: LocalDate): number | null => {
        const n = this.nights.get(day);
        return n && !(baseline && n.provisional) ? read(n) : null;
      };
    let get: (day: LocalDate) => number | null;
    switch (key) {
      case KEY_ASLEEP:
        get = night((n) => n.asleepMin);
        break;
      case KEY_AWAKE:
        get = night((n) => n.awakeMin);
        break;
      case KEY_IN_BED:
        get = night((n) => n.inBedMin);
        break;
      case KEY_DEEP:
        get = night((n) => (n.stages ? n.stages.deepMin : null));
        break;
      case KEY_LIGHT:
        get = night((n) => (n.stages ? n.stages.lightMin : null));
        break;
      case KEY_REM:
        get = night((n) => (n.stages ? n.stages.remMin : null));
        break;
      case KEY_SLEEP_START:
        get = night((n) => n.startMinOfDay);
        break;
      case KEY_SLEEP_END:
        get = night((n) => n.endMinOfDay);
        break;
      case KEY_HRV:
        get = night((n) => n.hrv.medianMs);
        break;
      case KEY_RESTING_HR:
        get = (day) => {
          const hr = this.restingHR.get(day);
          return hr && !(baseline && !restingStandard(hr)) ? hr.bpm : null;
        };
        break;
      default:
        throw new Error("healthdata: no such recovery series");
    }
    if (!this.values.has(key === KEY_RESTING_HR ? "resting_hr" : "nights")) {
      throw new Error("healthdata: the recovery series was not read");
    }
    return points(this.from, this.to, get);
  }
}

/** What one Recovery call accumulates across its API ranges. */
interface Call {
  ctx: Context;
  r: Recovery;
  settled: LocalDate;
  sources: Set<string>;
  empty: Set<DataType>;
}

/**
 * The nights and resting heart rates of [from, to]. Settled days come from
 * the cache when complete; the rest is fetched live, in windows (plan.ts).
 */
export async function readRecovery(ctx: Context, from: LocalDate, to: LocalDate, options: RecoveryOptions = {}): Promise<Recovery> {
  const days = dayList(from, to);
  const values = wanted(options.values, RECOVERY_VALUES);
  const { settled } = ctx.clock();
  const r = new Recovery(from, to, values);
  const call: Call = { ctx, r, settled, sources: new Set(), empty: new Set() };

  const keys: RecoveryKey[] = [];
  if (values.has("nights")) keys.push(...SLEEP_KEYS, KEY_HRV);
  if (values.has("resting_hr")) keys.push(KEY_RESTING_HR);
  const cached = ctx.readCache(from, to, settled, keys);
  const needSleep: LocalDate[] = [];
  const needResting: LocalDate[] = [];
  for (const day of days) {
    if (values.has("nights")) {
      const night = cachedNight(cached, day, ctx.zone);
      if (night) {
        r.nights.set(day, night);
        call.sources.add(night.source);
      } else {
        needSleep.push(day);
      }
    }
    if (values.has("resting_hr")) {
      const row = cached.get(KEY_RESTING_HR)?.get(day);
      if (row) {
        // Only standard-method values are cached.
        r.restingHR.set(day, { bpm: row.value, method: RESTING_WITH_SLEEP });
        call.sources.add(row.source ?? "");
      } else {
        needResting.push(day);
      }
    }
  }
  await fetchNights(call, needSleep);
  await fetchResting(call, needResting);

  r.nights = byDay(r.nights);
  r.restingHR = byDay(r.restingHR);
  call.sources.delete("");
  r.sources = [...call.sources].sort(compareText);
  r.empty = [...call.empty].sort(compareText);
  return r;
}

function byDay<V>(map: Map<LocalDate, V>): Map<LocalDate, V> {
  return new Map([...map].sort(([a], [b]) => compareText(a, b)));
}

function cachedNight(rows: CacheRows<RecoveryKey>, day: LocalDate, zone: Zone): Night | undefined {
  const row = (key: RecoveryKey) => rows.get(key)?.get(day);
  const asleep = row(KEY_ASLEEP);
  const [awake, inBed, startRow, endRow] = CORE_KEYS.map(row);
  if (!asleep || !awake || !inBed || !startRow || !endRow) return undefined;
  const startMin = Math.trunc(startRow.value);
  const window = nightWindow(day, startMin, Math.trunc(endRow.value), zone);
  if (!window) return undefined;
  const [deep, light, rem] = STAGE_KEYS.map(row);
  let stages: Stages | null = null;
  if (deep && light && rem) stages = { deepMin: deep.value, lightMin: light.value, remMin: rem.value };
  else if (deep || light || rem) return undefined; // stage rows are all or none
  let hrv: HRVNight = { medianMs: null, coverage: 0 };
  const hrvRow = row(KEY_HRV);
  if (hrvRow) {
    if (hrvRow.nSamples === undefined) return undefined;
    hrv = { medianMs: hrvRow.value, coverage: coverage(hrvRow.nSamples, inBed.value) };
  }
  return {
    asleepMin: asleep.value,
    awakeMin: awake.value,
    inBedMin: inBed.value,
    stages,
    startMinOfDay: startMin,
    endMinOfDay: minuteOfDay(window.end, zone),
    start: new Date(window.start),
    end: new Date(window.end),
    hrv,
    source: asleep.source ?? "",
    provisional: false,
  };
}

/** A sleep record with the local day it ends on. */
type DatedSleep = { kind: "undated" } | (Exclude<SleepRead, { kind: "undated" }> & { day: LocalDate });

interface Sample {
  at: number;
  rmssd: number;
}

/** The HRV samples of one window. Only the samples inside a night are counted. */
interface HrvSpan {
  samples: Sample[];
  bad: number[];
  noValue: number[];
  foreign: number[];
  /** Samples without a readable time: they taint every night of the window. */
  undated: number;
}

/**
 * Reads the sleep sessions and HRV samples of the missing nights and fills
 * them in, one window (plan.ts) after the other: the sleep lists and one HRV
 * list of the window, then its settled nights go to the cache. Sessions are
 * fetched with a day of margin on each side: the API filters on the device's
 * local end time, while a night belongs to the day it ends in the configured
 * zone. HRV starts the day before, for a night that begins in the evening.
 * Records of a day that is not missing count for nothing.
 */
async function fetchNights(call: Call, need: readonly LocalDate[]): Promise<void> {
  if (need.length === 0) return;
  const { ctx, r } = call;
  // Counts per day, for the rule that the Go server applies per run of
  // missing days: a data type is "empty" when a run got records and none of
  // them was usable.
  const sleepOther = new Map<LocalDate, number>();
  const sleepDays = new Set<LocalDate>();
  const hrvUsable = new Map<LocalDate, number>();
  const hrvLeftOut = new Map<LocalDate, number>();

  for (const window of windows(need, NIGHT_WINDOW_DAYS)) {
    const sleep: DatedSleep[] = [];
    for (const range of ranges(window.days, SLEEP_COST)) {
      const inRange = new Set(range.days);
      const reads = await ctx.api.list("sleep", shift(range.first, -1), shift(range.last, 1), (record): DatedSleep | undefined => {
        const read = parseSleep(record);
        if (read.kind === "undated") return read;
        const day = ctx.zone.dateOf(Math.floor(read.kind === "session" ? read.session.end : read.end));
        return inRange.has(day) ? { ...read, day } : undefined;
      });
      for (const read of reads) sleep.push(read);
    }
    const hrv = await loadHrv(ctx, window.first, window.last, hrvUsable, hrvLeftOut);
    // An unreadable record taints its day, or the whole window when its day
    // is unknown: a tainted day is returned but not cached.
    let skipped = hrv.undated;
    let tainted = hrv.undated > 0;
    const taintedDays = new Set<LocalDate>();
    const sessions = new Map<LocalDate, Session[]>();
    for (const read of sleep) {
      switch (read.kind) {
        case "undated":
          tainted = true;
          skipped++;
          break;
        case "other":
          r.excluded.otherSource++;
          sleepOther.set(read.day, (sleepOther.get(read.day) ?? 0) + 1);
          break;
        case "bad":
          skipped++;
          taintedDays.add(read.day);
          break;
        case "nap":
          r.excluded.naps++;
          break;
        case "session": {
          if (read.session.unknownType) r.excluded.unknownSleepType++;
          const list = sessions.get(read.day);
          if (list) list.push(read.session);
          else sessions.set(read.day, [read.session]);
          sleepDays.add(read.day);
        }
      }
    }
    for (const day of window.days) {
      const ofDay = sessions.get(day);
      if (!ofDay) continue;
      const { parts, extra } = nightParts(ofDay);
      r.excluded.extraSessions += extra;
      const { night, settled } = buildNight(parts, hrv.samples, ctx.zone);
      const bad = countWithin(parts, hrv.bad);
      if (bad > 0) {
        skipped += bad;
        taintedDays.add(day);
      }
      const noValueIn = countWithin(parts, hrv.noValue);
      const foreignIn = countWithin(parts, hrv.foreign);
      r.excluded.noHRVValue += noValueIn;
      r.excluded.otherSource += foreignIn;
      r.nights.set(day, night);
      call.sources.add(night.source);
      // Only settled nights from a clean fetch are cached, and only with a
      // final HRV value or none at all: partial samples may still be
      // syncing. A night whose own samples were all left out (another
      // platform, no value) is not "no HRV" but a format change: caching it
      // would keep the gap after the parsing is fixed.
      const finalHRV = !hrvWithheld(night.hrv) && (night.hrv.medianMs !== null || foreignIn === 0);
      if (day <= call.settled && !tainted && !taintedDays.has(day) && settled && finalHRV && noValueIn === 0) {
        putNight(ctx, day, night);
      }
    }
    r.skipped += skipped;
    if (skipped > 0) {
      ctx.log.warn("unreadable records in a recovery fetch", { from: window.first, to: window.last, skipped });
    }
  }

  for (const [a, b] of runs(need)) {
    let other = 0;
    let anySession = false;
    for (let d = a; d <= b; d = shift(d, 1)) {
      other += sleepOther.get(d) ?? 0;
      anySession ||= sleepDays.has(d);
    }
    if (other > 0 && !anySession) markEmpty(call, "sleep", a, b);
    let leftOut = 0;
    let usable = 0;
    for (let d = shift(a, -1); d <= b; d = shift(d, 1)) {
      leftOut += hrvLeftOut.get(d) ?? 0;
      usable += hrvUsable.get(d) ?? 0;
    }
    if (leftOut > 0 && usable === 0) markEmpty(call, "heart-rate-variability", a, b);
  }
}

/**
 * Reads the HRV samples for the missing nights [first, last] of one window,
 * and records how many samples each local day got. A day read by two windows
 * gets the same counts twice, so they are set, not added.
 */
async function loadHrv(
  ctx: Context,
  first: LocalDate,
  last: LocalDate,
  usable: Map<LocalDate, number>,
  leftOut: Map<LocalDate, number>,
): Promise<HrvSpan> {
  const from = shift(first, -1);
  const reads = await ctx.api.list("heart-rate-variability", from, last, parseHRV);
  const span: HrvSpan = { samples: [], bad: [], noValue: [], foreign: [], undated: 0 };
  const index = new DayIndex(from, last, ctx.zone);
  const usableHere = new Map<LocalDate, number>();
  const leftOutHere = new Map<LocalDate, number>();
  const count = (counts: Map<LocalDate, number>, at: number) => {
    const day = index.dayOf(at);
    if (day !== undefined) counts.set(day, (counts.get(day) ?? 0) + 1);
  };
  for (const read of reads) {
    switch (read.kind) {
      case "undated":
        span.undated++;
        break;
      case "other":
        span.foreign.push(read.at);
        count(leftOutHere, read.at);
        break;
      case "no_value":
        span.noValue.push(read.at);
        count(leftOutHere, read.at);
        break;
      case "bad":
        span.bad.push(read.at);
        break;
      case "sample":
        span.samples.push({ at: read.at, rmssd: read.rmssd });
        count(usableHere, read.at);
    }
  }
  for (let d = from; d <= last; d = shift(d, 1)) {
    usable.set(d, usableHere.get(d) ?? 0);
    leftOut.set(d, leftOutHere.get(d) ?? 0);
  }
  return span;
}

/** Flags a data type whose records were all left out. */
function markEmpty(call: Call, dataType: DataType, a: LocalDate, b: LocalDate): void {
  call.empty.add(dataType);
  call.ctx.log.warn("google health records arrived but none were usable", { data_type: dataType, from: a, to: b });
}

/**
 * Picks the night among one day's main-sleep sessions: records that overlap
 * are copies of one session (the longer is kept), sessions at most
 * MAX_SPLIT_GAP_MS apart are parts of one night, and the night with the most
 * time in bed wins (a tie keeps the later end). `extra` counts the rest.
 */
export function nightParts(sessions: readonly Session[]): { parts: Session[]; extra: number } {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  const kept: Session[] = [];
  let extra = 0;
  for (const session of sorted) {
    const previous = kept.at(-1);
    if (previous && session.start < previous.end) {
      extra++;
      if (longer(session, previous)) kept[kept.length - 1] = session;
      continue;
    }
    kept.push(session);
  }
  const groups: Session[][] = [];
  kept.forEach((session, i) => {
    const previous = kept[i - 1];
    const group = groups.at(-1);
    if (previous && group && session.start - previous.end <= MAX_SPLIT_GAP_MS) group.push(session);
    else groups.push([session]);
  });
  const inBed = (group: readonly Session[]) => group.reduce((sum, session) => sum + session.inBed, 0);
  const lastEnd = (group: readonly Session[]) => (group.at(-1) as Session).end;
  let best = groups[0] as Session[];
  for (const group of groups.slice(1)) {
    const [bestInBed, groupInBed] = [inBed(best), inBed(group)];
    if (groupInBed > bestInBed || (groupInBed === bestInBed && !(lastEnd(group) < lastEnd(best)))) best = group;
  }
  return { parts: best, extra: kept.length - best.length + extra };
}

function longer(session: Session, than: Session): boolean {
  const [a, b] = [session.end - session.start, than.end - than.start];
  return a > b || (a === b && session.end > than.end);
}

const contains = (part: Session, at: number) => at >= part.start && at <= part.end;

/** Counts the times inside any of the parts. */
function countWithin(parts: readonly Session[], times: readonly number[]): number {
  let count = 0;
  for (const at of times) if (parts.some((part) => contains(part, at))) count++;
  return count;
}

/**
 * Joins the parts and computes the HRV median over the samples inside them.
 * `settled` is false when any part may still change.
 */
function buildNight(parts: readonly Session[], samples: readonly Sample[], zone: Zone): { night: Night; settled: boolean } {
  const [first, last] = [parts[0] as Session, parts.at(-1) as Session];
  let [asleepMin, awakeMin, inBedMin] = [0, 0, 0];
  let settled = true;
  let staged = true;
  const stages: Stages = { deepMin: 0, lightMin: 0, remMin: 0 };
  for (const part of parts) {
    asleepMin += part.asleep;
    awakeMin += part.awake;
    inBedMin += part.inBed;
    settled &&= part.settled;
    if (part.stages === null) {
      staged = false;
      continue;
    }
    stages.deepMin += part.stages.deepMin;
    stages.lightMin += part.stages.lightMin;
    stages.remMin += part.stages.remMin;
  }

  const values: number[] = [];
  const slots: boolean[] = []; // each part's 5-minute slots, in order
  for (const part of parts) {
    const own = new Array<boolean>(slotCount(part.inBed)).fill(false);
    for (const sample of samples) {
      if (contains(part, sample.at)) {
        values.push(sample.rmssd);
        own[Math.min(Math.floor((sample.at - part.start) / HRV_SLOT_MS), own.length - 1)] = true;
      }
    }
    for (const slot of own) slots.push(slot);
  }
  const hrv: HRVNight = { medianMs: null, coverage: coverage(countTrue(slots), inBedMin) };
  const half = Math.floor(slots.length / 2);
  if (
    values.length >= MIN_HRV_SAMPLES &&
    hrv.coverage >= MIN_HRV_COVERAGE &&
    share(slots.slice(0, half)) >= MIN_HALF_COVERAGE &&
    share(slots.slice(half)) >= MIN_HALF_COVERAGE
  ) {
    hrv.medianMs = median(values);
  }
  const end = floorMinute(last.end);
  return {
    night: {
      asleepMin,
      awakeMin,
      inBedMin,
      stages: staged ? stages : null,
      startMinOfDay: minuteOfDay(first.start, zone),
      endMinOfDay: minuteOfDay(end, zone),
      start: new Date(floorMinute(first.start)),
      end: new Date(end),
      hrv,
      source: first.source,
      provisional: !settled,
    },
    settled,
  };
}

export function slotCount(inBedMin: number): number {
  return Math.max(1, Math.ceil(inBedMin / (HRV_SLOT_MS / 60_000)));
}

/**
 * The share of a night's slots holding a sample. It depends only on what the
 * cache stores (the covered slot count and the time in bed), so a cached
 * night reports the same value as a live one.
 */
export function coverage(covered: number, inBedMin: number): number {
  return Math.min(1, covered / slotCount(inBedMin));
}

/** The covered slot count the cache stores: `coverage` reads it back exactly. */
export function coveredSlots(night: Pick<Night, "hrv" | "inBedMin">): number {
  return Math.round(night.hrv.coverage * slotCount(night.inBedMin));
}

function countTrue(slots: readonly boolean[]): number {
  let count = 0;
  for (const slot of slots) if (slot) count++;
  return count;
}

function share(slots: readonly boolean[]): number {
  return slots.length === 0 ? 1 : countTrue(slots) / slots.length;
}

/**
 * Writes a night: the commit row (KEY_ASLEEP) is removed first and written
 * last, so a write that fails halfway leaves a miss, never a night mixing old
 * and new rows. Stage and HRV rows are written or removed.
 */
function putNight(ctx: Context, day: LocalDate, night: Night): void {
  if (!ctx.del(day, KEY_ASLEEP)) return;
  const row = (key: RecoveryKey, value: number): Row => ({ date: day, key, value, source: night.source });
  const stages = night.stages;
  const optional: [RecoveryKey, Row | undefined][] = [
    [KEY_DEEP, stages ? row(KEY_DEEP, stages.deepMin) : undefined],
    [KEY_LIGHT, stages ? row(KEY_LIGHT, stages.lightMin) : undefined],
    [KEY_REM, stages ? row(KEY_REM, stages.remMin) : undefined],
    [KEY_HRV, night.hrv.medianMs === null ? undefined : { ...row(KEY_HRV, night.hrv.medianMs), nSamples: coveredSlots(night) }],
  ];
  for (const [key, value] of optional) {
    if (!(value ? ctx.put(value) : ctx.del(day, key))) return;
  }
  const core: [RecoveryKey, number][] = [
    [KEY_AWAKE, night.awakeMin],
    [KEY_IN_BED, night.inBedMin],
    [KEY_SLEEP_START, night.startMinOfDay],
    [KEY_SLEEP_END, night.endMinOfDay],
  ];
  for (const [key, value] of core) {
    if (!ctx.put(row(key, value))) return;
  }
  ctx.put(row(KEY_ASLEEP, night.asleepMin));
}

type RestingValue = Extract<RestingRead, { kind: "value" }>;

/**
 * Reads the daily resting heart rates of the missing days. Two Fitbit values
 * for one day keep the one computed with sleep (the band's standard method),
 * then the lower. Only a day's single standard value is cached, so a later
 * fetch can settle a duplicate or a non-standard method.
 *
 * One request covers every missing day: the API sends one record per day, and
 * a page holds 10000.
 */
async function fetchResting(call: Call, need: readonly LocalDate[]): Promise<void> {
  const [first, last] = [need[0], need.at(-1)];
  if (first === undefined || last === undefined) return;
  const { ctx, r } = call;
  const needed = new Set(need);
  const reads = await ctx.api.list("daily-resting-heart-rate", first, last, (record): RestingRead | undefined => {
    const read = parseResting(record);
    return read.kind === "undated" || needed.has(read.date) ? read : undefined;
  });
  let tainted = false;
  let skipped = 0;
  const taintedDays = new Set<LocalDate>();
  const other = new Map<LocalDate, number>();
  const values = new Map<LocalDate, RestingValue[]>();
  for (const read of reads) {
    switch (read.kind) {
      case "undated":
        tainted = true;
        skipped++;
        break;
      case "other":
        other.set(read.date, (other.get(read.date) ?? 0) + 1);
        r.excluded.otherSource++;
        break;
      case "bad":
        skipped++;
        taintedDays.add(read.date);
        break;
      case "value": {
        const list = values.get(read.date);
        if (list) list.push(read);
        else values.set(read.date, [read]);
      }
    }
  }
  r.skipped += skipped;
  if (skipped > 0) ctx.log.warn("unreadable resting heart rate records", { from: first, to: last, skipped });
  for (const [a, b] of runs(need)) {
    let otherInRun = 0;
    let anyValue = false;
    for (let d = a; d <= b; d = shift(d, 1)) {
      otherInRun += other.get(d) ?? 0;
      anyValue ||= values.has(d);
    }
    if (otherInRun > 0 && !anyValue) markEmpty(call, "daily-resting-heart-rate", a, b);
  }
  for (const day of need) {
    const ofDay = values.get(day);
    if (!ofDay) continue;
    ofDay.sort((x, y) => {
      const [standardX, standardY] = [x.method === RESTING_WITH_SLEEP, y.method === RESTING_WITH_SLEEP];
      if (standardX !== standardY) return standardX ? -1 : 1;
      return x.bpm - y.bpm;
    });
    const value = ofDay[0] as RestingValue;
    const hr: RestingHR = { bpm: value.bpm, method: value.method };
    r.restingHR.set(day, hr);
    call.sources.add(value.source);
    if (day <= call.settled && !tainted && !taintedDays.has(day) && ofDay.length === 1 && restingStandard(hr)) {
      ctx.put({ date: day, key: KEY_RESTING_HR, value: value.bpm, source: value.source });
    }
  }
}

/** The wall clock of an instant in `zone`, read as if it were UTC. */
function wall(ms: number, zone: Zone): number {
  return Math.floor(ms / 1000) * 1000 + zone.offsetMs(ms);
}

function minuteOfDay(ms: number, zone: Zone): number {
  const inDay = ((wall(ms, zone) % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.floor(inDay / 60_000);
}

function floorMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant of a wall-clock time in `zone`. A time that a clock change
 * skips or repeats has no single answer: as Go's time.Date, this takes the
 * offset in force at the wall time read as UTC, unless the instant it gives
 * lies under another offset.
 */
function fromWall(wallMs: number, zone: Zone): number {
  const guess = wallMs - zone.offsetMs(wallMs);
  const offset = zone.offsetMs(guess);
  return wallMs - offset === guess ? guess : wallMs - offset;
}

/**
 * Rebuilds a cached night's bounds: it ends on `day` at `endMin`, and starts
 * at `startMin` less than a day before (on `day` itself when `startMin` is
 * earlier than `endMin`). Undefined for minutes outside a day. In the hour a
 * fall-back clock change repeats, the earlier of the two instants is taken.
 */
export function nightWindow(day: LocalDate, startMin: number, endMin: number, zone: Zone): { start: number; end: number } | undefined {
  if (!(startMin >= 0 && startMin < 24 * 60 && endMin >= 0 && endMin < 24 * 60)) return undefined;
  if (typeof day !== "string" || parseDate(day) === undefined) return undefined;
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const at = (base: number, minutes: number) => fromWall(base + minutes * 60_000, zone);
  const end = at(midnight, endMin);
  let start = at(midnight, startMin);
  if (!(start < end)) start = at(midnight - DAY_MS, startMin);
  return { start, end };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2] as number;
  return ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
}
