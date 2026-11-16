// Sleep, HRV and resting heart rate records.
// Each parser is a page-reduction function of the API client: it keeps only
// the fields the source uses, and it never throws for a record it cannot read.

import type { LocalDate } from "../coach/date";
import { type Obj, ZERO_TIME, civilDay, clean, dataSource, decode, flag, float, int64s, label, object, objects, root, text, time } from "./decode";

/**
 * The source the coach trusts for sleep, HRV and resting HR. Apple Health
 * copies of the same nights arrive as HEALTH_KIT records and are dropped, so a
 * night is never counted twice or taken from the phone.
 */
export const PRIMARY_PLATFORM = "FITBIT";

/**
 * A night's final stage minutes. Deep, light and REM add up to the time
 * asleep, within a couple of minutes per sleep record: each record is checked
 * when it is parsed.
 */
export interface Stages {
  deepMin: number;
  lightMin: number;
  remMin: number;
}

/** One sleep record, checked and in the coach's units. Times are epoch milliseconds. */
export interface Session {
  start: number;
  end: number;
  asleep: number;
  awake: number;
  inBed: number;
  /** null without final stages. */
  stages: Stages | null;
  /**
   * Processed, with final stages or a classic record. A night that is not
   * settled may still change and is never cached.
   */
  settled: boolean;
  /** A sleep type other than STAGES or CLASSIC, read without stages. */
  unknownType: boolean;
  source: string;
}

/**
 * What a sleep record reduces to. "undated": the interval could not be read,
 * so its day is unknown. "other": left out on purpose, from another platform.
 * "bad": its day is known and its values are not usable.
 */
export type SleepRead =
  | { kind: "undated" }
  | { kind: "other" | "bad" | "nap"; end: number }
  | { kind: "session"; session: Session };

const UNDATED = { kind: "undated" } as const;

const MAX_SESSION_MINUTES = 24 * 60;

/**
 * Absorbs rounding between Fitbit's separately rounded minute fields when
 * checking that the parts fit the whole.
 */
const MINUTE_SLACK = 2;

interface StageEntry {
  type: string;
  minutes: number;
}

function readSleep(record: unknown) {
  const r = root(record);
  const sleep = object(r, "sleep");
  const interval = object(sleep, "interval");
  const metadata = object(sleep, "metadata");
  const summary = object(sleep, "summary");
  return {
    source: dataSource(r),
    present: sleep !== undefined,
    type: text(sleep, "type"),
    start: time(interval, "startTime"),
    end: time(interval, "endTime"),
    nap: flag(metadata, "nap"),
    processed: flag(metadata, "processed"),
    stagesStatus: text(metadata, "stagesStatus"),
    summary:
      summary === undefined
        ? undefined
        : {
            asleep: int64s(summary, "minutesAsleep"),
            awake: int64s(summary, "minutesAwake"),
            inBed: int64s(summary, "minutesInSleepPeriod"),
            stages: objects(summary, "stagesSummary").map(
              (stage): StageEntry => ({ type: text(stage, "type"), minutes: int64s(stage, "minutes") }),
            ),
          },
  };
}

/** Reduces one sleep record. */
export function parseSleep(record: unknown): SleepRead {
  const r = decode(() => readSleep(record));
  if (r === undefined || !r.present || r.start === ZERO_TIME || !(r.end > r.start)) return UNDATED;
  if (r.source.platform !== PRIMARY_PLATFORM) return { kind: "other", end: r.end };
  if (r.summary === undefined) return { kind: "bad", end: r.end };
  const { asleep, awake, inBed } = r.summary;
  if (inBed <= 0 || inBed > MAX_SESSION_MINUTES || asleep <= 0 || awake < 0 || asleep + awake > inBed + MINUTE_SLACK) {
    return { kind: "bad", end: r.end };
  }
  let stages: Stages | null = null;
  let settled = false;
  let unknownType = false;
  switch (r.type) {
    case "STAGES":
      // Stages still being computed may be missing or zero: leave them out
      // and check only final ones.
      if (r.stagesStatus === "SUCCEEDED") {
        stages = stageMinutes(r.summary.stages, asleep, inBed);
        if (stages === null) return { kind: "bad", end: r.end };
      }
      settled = r.processed && stages !== null;
      break;
    case "CLASSIC":
      settled = r.processed;
      break;
    default:
      unknownType = true;
  }
  // The checks come first: a nap with implausible minutes is an unreadable record.
  if (r.nap) return { kind: "nap", end: r.end };
  return {
    kind: "session",
    session: { start: r.start, end: r.end, asleep, awake, inBed, stages, settled, unknownType, source: label(r.source) },
  };
}

/**
 * The deep, light and REM minutes, or null. Every type must be known and
 * appear once, and the three must add up to the time asleep (Fitbit's asleep
 * minutes are their sum): a renamed or split stage would otherwise read as
 * zero minutes and be cached as final.
 */
function stageMinutes(list: readonly StageEntry[], asleep: number, inBed: number): Stages | null {
  if (list.length === 0) return null;
  const out: Stages = { deepMin: 0, lightMin: 0, remMin: 0 };
  const seen = new Set<string>();
  for (const stage of list) {
    if (seen.has(stage.type) || stage.minutes < 0 || stage.minutes > inBed) return null;
    seen.add(stage.type);
    switch (stage.type) {
      case "DEEP":
        out.deepMin = stage.minutes;
        break;
      case "LIGHT":
        out.lightMin = stage.minutes;
        break;
      case "REM":
        out.remMin = stage.minutes;
        break;
      case "AWAKE":
        break;
      default:
        return null;
    }
  }
  if (Math.abs(out.deepMin + out.lightMin + out.remMin - asleep) > MINUTE_SLACK) return null;
  return out;
}

/**
 * What an HRV sample reduces to: as SleepRead, plus "no_value" for a sample
 * of the band without an rMSSD (the field is optional).
 */
export type HrvRead =
  | { kind: "undated" }
  | { kind: "other" | "no_value" | "bad"; at: number }
  | { kind: "sample"; at: number; rmssd: number };

const MAX_RMSSD = 500;

function readHRV(record: unknown) {
  const r = root(record);
  const hrv = object(r, "heartRateVariability");
  return {
    source: dataSource(r),
    present: hrv !== undefined,
    at: time(object(hrv, "sampleTime"), "physicalTime"),
    rmssd: float(hrv, "rootMeanSquareOfSuccessiveDifferencesMilliseconds"),
  };
}

/** Reduces one HRV sample. */
export function parseHRV(record: unknown): HrvRead {
  const r = decode(() => readHRV(record));
  if (r === undefined || !r.present || r.at === ZERO_TIME) return UNDATED;
  if (r.source.platform !== PRIMARY_PLATFORM) return { kind: "other", at: r.at };
  if (r.rmssd === undefined) return { kind: "no_value", at: r.at };
  if (r.rmssd <= 0 || r.rmssd > MAX_RMSSD) return { kind: "bad", at: r.at };
  return { kind: "sample", at: r.at, rmssd: r.rmssd };
}

/** What a resting heart rate record reduces to: as SleepRead, by date. */
export type RestingRead =
  | { kind: "undated" }
  | { kind: "other" | "bad"; date: LocalDate }
  | { kind: "value"; date: LocalDate; bpm: number; method: string; source: string };

const MIN_RESTING_BPM = 20;
const MAX_RESTING_BPM = 250;

function readResting(record: unknown) {
  const r = root(record);
  const resting = object(r, "dailyRestingHeartRate");
  return {
    source: dataSource(r),
    present: resting !== undefined,
    bpm: int64s(resting, "beatsPerMinute"),
    date: civilDay(object(resting, "date")),
    method: text(object(resting, "dailyRestingHeartRateMetadata"), "calculationMethod"),
  };
}

/** Reduces one resting heart rate record. */
export function parseResting(record: unknown): RestingRead {
  const r = decode(() => readResting(record));
  if (r === undefined || !r.present || r.date === undefined) return UNDATED;
  if (r.source.platform !== PRIMARY_PLATFORM) return { kind: "other", date: r.date };
  if (r.bpm < MIN_RESTING_BPM || r.bpm > MAX_RESTING_BPM) return { kind: "bad", date: r.date };
  return { kind: "value", date: r.date, bpm: r.bpm, method: clean(r.method), source: label(r.source) };
}

/** The day of the API's CivilDateTime ({date: {year, month, day}}), or undefined. */
export function civilDateTimeDay(civil: Obj | undefined): LocalDate | undefined {
  return civilDay(object(civil, "date"));
}
