// Workout sessions (Go: internal/healthdata/exercise.go).

import type { LocalDate } from "../coach/date";
import { exerciseFlags } from "../metrics/quality";
import type { Context } from "./cache";
import { ZERO_TIME, clean, dataSource, decode, float, int64s, label, object, optionalInt64s, parseDuration, root, text, time } from "./decode";
import { PRIMARY_PLATFORM } from "./parse";
import { dayList, shift } from "./plan";
import { median } from "./recovery";

/** The time spent in each of the band's heart-rate zones, in minutes. */
export interface ZoneMinutes {
  light: number;
  moderate: number;
  vigorous: number;
  peak: number;
}

/** A session's heart rate. */
export interface ExerciseHR {
  avgBpm: number;
  /**
   * The highest median of MAX_HR_WINDOW consecutive band samples inside the
   * session, so one optical spike is not the max: null unless asked for,
   * beyond MAX_HR_SESSIONS, or with too few samples.
   */
  maxBpm: number | null;
  zoneMin: ZoneMinutes;
}

/** One workout session. */
export interface Exercise {
  /** The record's resource name, stable across calls ("" when the API sent an unexpected one). */
  id: string;
  /** The local day it started. */
  day: LocalDate;
  /** Google's exerciseType, e.g. JIU_JITSU. */
  type: string;
  /** Display name. */
  name: string;
  start: Date;
  end: Date;
  /** Without pauses. */
  activeMin: number;
  kcal: number | null;
  azm: number;
  /** null without heart rate. */
  hr: ExerciseHR | null;
  /**
   * Logged by hand. The band may still have measured its heart rate, so it is
   * a separate fact from `hr`.
   */
  manual: boolean;
  source: string;
  /** metrics.exerciseFlags */
  flags: string[];
}

/** The sessions that started in [from, to], oldest first. */
export class Exercises {
  sessions: Exercise[] = [];
  /** Records that could not be read. */
  skipped = 0;
  /** Records from another platform. */
  otherSource = 0;
  /**
   * Sessions with heart rate left without a max because the call asked for
   * more than MAX_HR_SESSIONS.
   */
  maxHROmitted = 0;

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
  ) {}
}

/**
 * Samples (about 10 s at the band's rate) that make one max HR reading:
 * optical HR spikes for a sample or two on motion.
 */
export const MAX_HR_WINDOW = 5;

/**
 * Bounds the heart-rate requests of one call (one per session), newest
 * sessions first.
 */
export const MAX_HR_SESSIONS = 31;

const MIN_HR_BPM = 20;
const MAX_HR_BPM = 250;
const MAX_SESSION_KCAL = 10_000;
const MINUTE_NS = 60e9;
const DAY_MS = 86_400_000;

/**
 * The shape of a record's name; anything else is not passed on as an ID.
 * Shared with the food log.
 */
export const RESOURCE_NAME = /^users\/[A-Za-z0-9_-]+\/dataTypes\/[a-z-]+\/dataPoints\/[A-Za-z0-9_.-]{1,128}$/;

/** A session before its day and flags are known. Times are epoch milliseconds. */
interface ParsedExercise extends Omit<Exercise, "day" | "flags" | "start" | "end"> {
  start: number;
  end: number;
}

/**
 * What an exercise record reduces to. "undated": the interval could not be
 * read. "other": from another platform. "bad": values that are not plausible.
 */
export type ExerciseRead = { kind: "undated" } | { kind: "other" | "bad"; start: number } | { kind: "session"; session: ParsedExercise };

function readExercise(record: unknown) {
  const r = root(record);
  const exercise = object(r, "exercise");
  const interval = object(exercise, "interval");
  const summary = object(exercise, "metricsSummary");
  const zones = object(summary, "heartRateZoneDurations");
  return {
    name: text(r, "name"),
    source: dataSource(r),
    present: exercise !== undefined,
    displayName: text(exercise, "displayName"),
    exerciseType: text(exercise, "exerciseType"),
    activeDuration: text(exercise, "activeDuration"),
    start: time(interval, "startTime"),
    end: time(interval, "endTime"),
    avgHR: int64s(summary, "averageHeartRateBeatsPerMinute"),
    kcal: float(summary, "caloriesKcal"),
    azm: int64s(summary, "activeZoneMinutes"),
    zones: [text(zones, "lightTime"), text(zones, "moderateTime"), text(zones, "vigorousTime"), text(zones, "peakTime")] as const,
  };
}

/** Reduces one exercise record. */
export function parseExercise(record: unknown): ExerciseRead {
  const r = decode(() => readExercise(record));
  if (r === undefined || !r.present || r.start === ZERO_TIME || !(r.end > r.start)) return { kind: "undated" };
  const { start, end } = r;
  if (r.source.platform !== PRIMARY_PLATFORM) return { kind: "other", start };
  const bad: ExerciseRead = { kind: "bad", start };
  const spanMs = end - start;
  // Every real session carries an active duration: none is a renamed field.
  const activeMin = minutes(r.activeDuration, spanMs);
  if (activeMin === undefined || r.activeDuration === "" || spanMs > DAY_MS) return bad;
  if (r.azm < 0 || r.azm > 2 * (spanMs / 60_000)) return bad;
  if (r.kcal !== undefined && (r.kcal < 0 || r.kcal > MAX_SESSION_KCAL)) return bad;
  let hr: ExerciseHR | null = null;
  if (r.avgHR !== 0) {
    // proto3 leaves out a zero: no heart rate
    if (r.avgHR < MIN_HR_BPM || r.avgHR > MAX_HR_BPM) return bad;
    // A session with heart rate always has its zone durations.
    if (r.zones.every((zone) => zone === "")) return bad;
    const [light, moderate, vigorous, peak] = r.zones.map((zone) => minutes(zone, spanMs));
    if (light === undefined || moderate === undefined || vigorous === undefined || peak === undefined) return bad;
    hr = { avgBpm: r.avgHR, maxBpm: null, zoneMin: { light, moderate, vigorous, peak } };
  }
  return {
    kind: "session",
    session: {
      id: RESOURCE_NAME.test(r.name) ? r.name : "",
      type: clean(r.exerciseType),
      name: clean(r.displayName),
      start,
      end,
      activeMin,
      kcal: r.kcal ?? null,
      azm: r.azm,
      hr,
      manual: r.source.recordingMethod === "MANUAL",
      source: label(r.source),
    },
  };
}

/**
 * Parses a protobuf Duration ("3600s"; "" is zero) bounded by the session's
 * span, with a minute of slack for rounding. Undefined when it is not
 * plausible.
 */
export function minutes(s: string, spanMs: number): number | undefined {
  if (s === "") return 0;
  const ns = parseDuration(s);
  if (ns === undefined || ns < 0 || ns > spanMs * 1e6 + MINUTE_NS) return undefined;
  // The whole minutes and the rest are divided apart, as the Go server does.
  return Math.trunc(ns / MINUTE_NS) + (ns % MINUTE_NS) / MINUTE_NS;
}

/**
 * The sessions that started in [from, to]. With `maxHR`, each session with
 * heart rate costs one more request for its samples.
 *
 * Sessions are never cached, so the range is one list call: windows would
 * only add requests.
 */
export async function readExercises(ctx: Context, from: LocalDate, to: LocalDate, maxHR: boolean): Promise<Exercises> {
  dayList(from, to);
  const out = new Exercises(from, to);
  // The API filters on the device's local start time; a day of margin keeps
  // a session near midnight in the configured zone.
  const reads = await ctx.api.list("exercise", shift(from, -1), shift(to, 1), (record) => {
    const read = parseExercise(record);
    if (read.kind === "undated") return read;
    const day = ctx.zone.dateOf(Math.floor(read.kind === "session" ? read.session.start : read.start));
    return day < from || day > to ? undefined : { ...read, day };
  });
  const sessions: (ParsedExercise & { day: LocalDate })[] = [];
  for (const read of reads) {
    switch (read.kind) {
      case "other":
        out.otherSource++;
        break;
      case "session":
        sessions.push({ ...read.session, day: read.day });
        break;
      default:
        out.skipped++;
    }
  }
  sessions.sort((a, b) => a.start - b.start);
  let lookups = 0;
  for (const session of sessions.toReversed()) {
    // newest first, for the cap
    if (!maxHR || session.hr === null) continue;
    if (lookups === MAX_HR_SESSIONS) {
      out.maxHROmitted++;
      continue;
    }
    lookups++;
    session.hr.maxBpm = await maxHeartRate(ctx, session.start, session.end);
  }
  out.sessions = sessions.map((session) => ({
    ...session,
    start: new Date(session.start),
    end: new Date(session.end),
    flags: exerciseFlags({
      type: session.type,
      durationMs: session.activeMin * 60_000,
      avgHR: session.hr ? session.hr.avgBpm : null,
      manualEntry: session.manual,
    }),
  }));
  if (out.skipped > 0) ctx.log.warn("unreadable exercise records", { from, to, skipped: out.skipped });
  return out;
}

/** One heart-rate sample of the band, reduced: null for a record that cannot be read. */
type HeartRateRead = { at: number; bpm: number } | null;

/**
 * The highest median of MAX_HR_WINDOW consecutive Fitbit heart-rate samples
 * in [start, end], or null with fewer samples.
 */
async function maxHeartRate(ctx: Context, start: number, end: number): Promise<number | null> {
  // The last second is included; a session of a full day keeps the request
  // within the API client's one-day window.
  const stop = Math.min(end + 1000, start + DAY_MS);
  const reads = await ctx.api.listBetween("heart-rate", new Date(start), new Date(stop), (record): HeartRateRead | undefined => {
    const r = decode(() => {
      const rec = root(record);
      const heartRate = object(rec, "heartRate");
      return {
        platform: dataSource(rec).platform,
        bpm: optionalInt64s(heartRate, "beatsPerMinute"),
        at: time(object(heartRate, "sampleTime"), "physicalTime"),
      };
    });
    if (r === undefined || r.bpm === undefined) return null;
    if (r.platform !== PRIMARY_PLATFORM || r.bpm < MIN_HR_BPM || r.bpm > MAX_HR_BPM) return undefined;
    return { at: r.at, bpm: r.bpm };
  });
  const samples = reads.filter((read) => read !== null);
  const unreadable = reads.length - samples.length;
  if (unreadable > 0 && samples.length === 0) {
    ctx.log.warn("heart rate samples arrived but none were usable", { unreadable });
  }
  if (samples.length < MAX_HR_WINDOW) return null;
  samples.sort((a, b) => a.at - b.at);
  let best = 0;
  for (let i = 0; i + MAX_HR_WINDOW <= samples.length; i++) {
    best = Math.max(best, median(samples.slice(i, i + MAX_HR_WINDOW).map((sample) => sample.bpm)));
  }
  return best;
}
