// Workout sessions.

import type { LocalDate } from "../coach/date";
import { MAX_NOTES_CHARS, pointId } from "../googlehealth/exerciselog";
import { FLAG_OVERLAPS_BAND_SESSION, exerciseFlags } from "../metrics/quality";
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
  /** The record's notes, or null when it has none. */
  notes: string | null;
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
  /** Records from another platform that this server did not create. */
  otherSource = 0;
  /**
   * Sessions with heart rate left without a max because the call asked for
   * more than MAX_HR_SESSIONS.
   */
  maxHROmitted = 0;
  /**
   * Stored names of the sessions this server created for the account that was
   * linked when this read started, keyed by data point id. Taken before the
   * list request. Empty when the source has no such table.
   */
  ownNames: ReadonlyMap<string, string> = new Map();

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
/**
 * The most calories one session can plausibly report: a session with more is
 * dropped as unreadable. The tool that logs a session takes the same bound,
 * so every value it accepts is a value this reader keeps.
 */
export const MAX_SESSION_KCAL = 10_000;
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

/**
 * What a read keeps of a record: its reduction with the local day of a record
 * of the range, or "near", the time span of a session of a margin day.
 */
type Kept =
  | { kind: "undated" }
  | { kind: "other" | "bad"; start: number; day: LocalDate }
  | { kind: "session"; session: ParsedExercise; day: LocalDate }
  | { kind: "near"; start: number; end: number; mine: boolean };

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
    notes: text(exercise, "notes"),
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

/**
 * Whether the record is a session this server created: its data point ID is
 * one of `own`. The comparison is by ID (the last part of the name): a create
 * answers `users/<user id>/…`, and a list can name the user in another form.
 */
function createdHere(name: string, own: ReadonlySet<string> | undefined): boolean {
  if (own === undefined || own.size === 0) return false;
  const id = pointId(name);
  return id !== undefined && own.has(id);
}

/**
 * Reduces one exercise record.
 *
 * `own` holds the data point IDs of the sessions this server created. Such a
 * session is kept next to the band's own, although its platform is the API's
 * (GOOGLE_WEB_API): the coach must count the workouts it logged itself. It
 * was entered by hand, so it is `manual`, and it has no heart rate: the tool
 * sends none, and a heart rate of another platform is not the band's reading.
 * The Go server writes nothing to Google Health, so it has no such rule; a
 * record of any other platform is still left out as "other".
 */
export function parseExercise(record: unknown, own?: ReadonlySet<string>): ExerciseRead {
  const r = decode(() => readExercise(record));
  if (r === undefined || !r.present || r.start === ZERO_TIME || !(r.end > r.start)) return { kind: "undated" };
  const { start, end } = r;
  const mine = createdHere(r.name, own);
  const band = r.source.platform === PRIMARY_PLATFORM;
  if (!band && !mine) return { kind: "other", start };
  const bad: ExerciseRead = { kind: "bad", start };
  const spanMs = end - start;
  // Every real session carries an active duration: none is a renamed field.
  const activeMin = minutes(r.activeDuration, spanMs);
  if (activeMin === undefined || r.activeDuration === "" || spanMs > DAY_MS) return bad;
  if (r.azm < 0 || r.azm > 2 * (spanMs / 60_000)) return bad;
  if (r.kcal !== undefined && (r.kcal < 0 || r.kcal > MAX_SESSION_KCAL)) return bad;
  let hr: ExerciseHR | null = null;
  if (band && r.avgHR !== 0) {
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
      notes: clean(r.notes, MAX_NOTES_CHARS) || null,
      start,
      end,
      activeMin,
      kcal: r.kcal ?? null,
      azm: r.azm,
      hr,
      manual: mine || r.source.recordingMethod === "MANUAL",
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
 * With `only`, a session's ID, the samples are read for that session alone:
 * the caller shows one session, so the other requests would be for nothing.
 * The cap still counts every session with heart rate, newest first. So that
 * session's max and `maxHROmitted` are what a read of all the sessions gives;
 * the max of every other session is null.
 *
 * Sessions are never cached, so the range is one list call: windows would
 * only add requests.
 */
export async function readExercises(ctx: Context, from: LocalDate, to: LocalDate, maxHR: boolean, only?: string): Promise<Exercises> {
  dayList(from, to);
  const out = new Exercises(from, to);
  // The sessions this server created, with the same day of margin as the
  // list. The stored names are read here, before the list request: a relink
  // while that request is in flight must not swap in the new account's name
  // for a point id the two accounts share.
  let own: ReadonlySet<string> | undefined;
  try {
    const names = ctx.cache.createdExerciseNames?.(shift(from, -1), shift(to, 1));
    if (names !== undefined) {
      out.ownNames = names;
      own = new Set(names.keys());
    }
  } catch (cause) {
    throw new Error("healthdata: read created entries", { cause });
  }
  const logged = own !== undefined && own.size > 0;
  // The API filters on the device's local start time; a day of margin keeps
  // a session near midnight in the configured zone.
  const reads = await ctx.api.list("exercise", shift(from, -1), shift(to, 1), (record): Kept | undefined => {
    const read = parseExercise(record, own);
    if (read.kind === "undated") return read;
    const day = ctx.zone.dateOf(Math.floor(read.kind === "session" ? read.session.start : read.start));
    if (day >= from && day <= to) return { ...read, day };
    // A session of a margin day is not a session of the range. Its time span
    // is kept when this server created sessions near the range: a session
    // can overlap one that starts on the other side of midnight.
    if (!logged || read.kind !== "session") return undefined;
    return { kind: "near", start: read.session.start, end: read.session.end, mine: createdHere(read.session.id, own) };
  });
  const sessions: (ParsedExercise & { day: LocalDate })[] = [];
  /** The time spans of the band's sessions, the margin days included. */
  const bandSpans: { start: number; end: number }[] = [];
  for (const read of reads) {
    switch (read.kind) {
      case "other":
        out.otherSource++;
        break;
      case "session":
        sessions.push({ ...read.session, day: read.day });
        if (logged && !createdHere(read.session.id, own)) bandSpans.push(read.session);
        break;
      case "near":
        if (!read.mine) bandSpans.push(read);
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
    if (only !== undefined && session.id !== only) continue;
    session.hr.maxBpm = await maxHeartRate(ctx, session.start, session.end);
  }
  out.sessions = sessions.map((session) => {
    const flags = exerciseFlags({
      type: session.type,
      durationMs: session.activeMin * 60_000,
      avgHR: session.hr ? session.hr.avgBpm : null,
      manualEntry: session.manual,
    });
    // A session this server created stays a record of its own next to the
    // band's: nothing of the two is merged or summed. When both cover the
    // same time, the same workout may be there twice, and the flag says so.
    const overlaps = createdHere(session.id, own) && bandSpans.some((band) => band.start < session.end && band.end > session.start);
    if (overlaps) flags.push(FLAG_OVERLAPS_BAND_SESSION);
    return { ...session, start: new Date(session.start), end: new Date(session.end), flags };
  });
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
