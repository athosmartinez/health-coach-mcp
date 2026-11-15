// Shared by the healthdata tests: synthetic records in the API's raw shapes
// (they mirror the fixtures of internal/healthdata/*_test.go), a fake Google
// Health API behind `fetch`, and the source as one MCP request builds it.
import { type MockInstance, afterEach, beforeEach, expect, vi } from "vitest";

import { type Zone, addDays } from "../src/coach/date";
import { RequestBudget } from "../src/googlehealth/budget";
import { GoogleHealthClient } from "../src/googlehealth/client";
import type { DataType } from "../src/googlehealth/datatypes";
import { type Cache, HealthData, RECOVERY_KEYS, type Recovery, type Source, dbCache } from "../src/healthdata";
import { ALGO_VERSION, type Point } from "../src/metrics/stats";
import type { Db } from "../src/store/db";
import { metricRange } from "../src/store/metrics";
import { SAO_PAULO, withDb } from "./memory-helpers";

// All values in the healthdata tests are synthetic.

/** 2026-10-16 10:00 in São Paulo: days up to 2026-10-13 are settled. */
export const NOW = new Date("2026-10-16T10:00:00-03:00");

export const SP = SAO_PAULO.name;

/** A wall-clock time in São Paulo (UTC−3 all year). */
export function at(day: string, hour: number, minute: number): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(`${day}T${pad(hour)}:${pad(minute)}:00-03:00`);
}

export const plus = (t: Date, ms: number) => new Date(t.getTime() + ms);
export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/** RFC 3339 in UTC without a fraction, as the Go fixtures write it. */
export function rfc3339(t: Date): string {
  return `${t.toISOString().slice(0, 19)}Z`;
}

/** Runs `body` inside a new store whose clock is NOW. */
export function inStore<T>(body: (db: Db) => Promise<T>, now: Date = NOW): Promise<T> {
  return withDb(body, () => now);
}

type Json = Record<string, any>;

export interface SleepOptions {
  platform?: string;
  /** Default STAGES. */
  type?: string;
  nap?: boolean;
  classic?: boolean;
  unprocessed?: boolean;
  /** Stages not computed yet. */
  pending?: boolean;
  asleep?: number;
  deep?: number;
}

/**
 * A consistent sleep record: awake = in bed − asleep, REM a fifth of asleep,
 * light the rest.
 */
export function sleepRec(start: Date, end: Date, options: SleepOptions = {}): Json {
  const inBed = Math.trunc((end.getTime() - start.getTime()) / MINUTE);
  const asleep = options.asleep || Math.max(inBed - 40, Math.trunc(inBed / 2));
  const deep = options.deep ?? 0;
  const awake = inBed - asleep;
  const rem = Math.trunc(asleep / 5);
  const light = asleep - deep - rem;
  const stages: Json[] = [
    { type: "LIGHT", minutes: String(light), count: "20" },
    { type: "REM", minutes: String(rem), count: "5" },
    { type: "AWAKE", minutes: String(awake), count: "12" },
  ];
  // proto3 JSON leaves a zero out
  if (deep !== 0) stages.push({ type: "DEEP", minutes: String(deep), count: "4" });
  const metadata: Json = { processed: !options.unprocessed, stagesStatus: options.pending ? "PENDING" : "SUCCEEDED", mainSleep: true };
  if (options.nap) metadata.nap = true;
  const sleep: Json = {
    type: options.type ?? "STAGES",
    interval: { startTime: rfc3339(start), endTime: rfc3339(end) },
    metadata,
    summary: {
      minutesAsleep: String(asleep),
      minutesAwake: String(awake),
      minutesInSleepPeriod: String(inBed),
      stagesSummary: stages,
    },
  };
  if (options.classic) {
    sleep.type = "CLASSIC";
    delete metadata.stagesStatus;
  }
  return {
    name: "users/me/dataTypes/sleep/dataPoints/synthetic",
    dataSource: { platform: options.platform ?? "FITBIT", device: { displayName: "Synthetic Band" } },
    sleep,
  };
}

export function hrvRec(t: Date, rmssd: number, platform = "FITBIT"): Json {
  return {
    dataSource: { platform, device: { displayName: "Synthetic Band" } },
    heartRateVariability: {
      sampleTime: { physicalTime: rfc3339(t) },
      rootMeanSquareOfSuccessiveDifferencesMilliseconds: rmssd,
    },
  };
}

/** One sample every `stepMs` over [start, end], all equal to `value`. */
export function hrvEvery(start: Date, end: Date, stepMs: number, value: number, platform = "FITBIT"): Json[] {
  const out: Json[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) out.push(hrvRec(new Date(t), value, platform));
  return out;
}

/** The band's rate: one sample every 5 minutes. */
export const hrvNight = (start: Date, end: Date, value: number) => hrvEvery(start, end, 5 * MINUTE, value);

function civilParts(date: string): Json {
  const [year, month, dayOfMonth] = date.split("-").map(Number);
  return { year, month, day: dayOfMonth };
}

export function restingRec(date: string, bpm: number, method: string, platform: string): Json {
  const resting: Json = { beatsPerMinute: String(bpm), date: civilParts(date) };
  if (method !== "") resting.dailyRestingHeartRateMetadata = { calculationMethod: method };
  return { dataSource: { platform, device: { displayName: "Synthetic Band" } }, dailyRestingHeartRate: resting };
}

/** The API's CivilDateTime at a day's midnight. */
export const civil = (date: string): Json => ({ date: civilParts(date) });

export function rollupRow(date: string, key: string, value: Json): Json {
  return { civilStartTime: civil(date), civilEndTime: civil(addDays(date, 1) as string), [key]: value };
}

export const stepsRollup = (date: string, count: number) => rollupRow(date, "steps", { countSum: String(count) });

/** Leaves out zero zones, as proto3 JSON does. */
export function azmRollup(date: string, fatBurn: number, cardio: number, peak: number): Json {
  const zones: Json = {};
  if (fatBurn !== 0) zones.sumInFatBurnHeartZone = String(fatBurn);
  if (cardio !== 0) zones.sumInCardioHeartZone = String(cardio);
  if (peak !== 0) zones.sumInPeakHeartZone = String(peak);
  return rollupRow(date, "activeZoneMinutes", zones);
}

export const kcalRollup = (date: string, kcal: number) => rollupRow(date, "totalCalories", { kcalSum: kcal });

/** One raw steps record, enough for the "band worn" check. */
export function stepRec(date: string, platform: string): Json {
  return { dataSource: { platform }, steps: { count: "120", interval: { civilStartTime: civil(date) } } };
}

export function weightRec(t: Date, grams: number, platform: string): Json {
  return {
    dataSource: { platform, device: { displayName: "Synthetic Scale" } },
    weight: { sampleTime: { physicalTime: rfc3339(t) }, weightGrams: grams },
  };
}

export function bodyFatRec(t: Date, percentage: number): Json {
  return { dataSource: { platform: "FITBIT" }, bodyFat: { sampleTime: { physicalTime: rfc3339(t) }, percentage } };
}

export interface ExerciseOptions {
  type: string;
  method?: string;
  platform?: string;
  /** 0: left out, as proto3 does. */
  avgHR?: number;
  kcal?: number;
  azm?: number;
  /** light, moderate, vigorous, peak minutes */
  zones?: [number, number, number, number];
  /** Default: the whole session. */
  activeMin?: number;
  name?: string;
}

export function exerciseRec(start: Date, end: Date, options: ExerciseOptions): Json {
  const method = options.method ?? "ACTIVELY_MEASURED";
  const activeMin = options.activeMin || Math.trunc((end.getTime() - start.getTime()) / MINUTE);
  const zones = options.zones ?? [0, 0, 0, 0];
  const summary: Json = {
    caloriesKcal: options.kcal ?? 0,
    heartRateZoneDurations: {
      lightTime: `${zones[0] * 60}s`,
      moderateTime: `${zones[1] * 60}s`,
      vigorousTime: `${zones[2] * 60}s`,
      peakTime: `${zones[3] * 60}s`,
    },
  };
  if (options.avgHR) summary.averageHeartRateBeatsPerMinute = String(options.avgHR);
  if (options.azm) summary.activeZoneMinutes = String(options.azm);
  const source: Json = { platform: options.platform ?? "FITBIT", recordingMethod: method };
  if (method !== "MANUAL") source.device = { displayName: "Synthetic Band", formFactor: "FITNESS_BAND" };
  return {
    name: options.name ?? `users/me/dataTypes/exercise/dataPoints/syn-${Math.trunc(start.getTime() / 1000)}`,
    dataSource: source,
    exercise: {
      displayName: options.type.replaceAll("_", " "),
      exerciseType: options.type,
      activeDuration: `${activeMin * 60}s`,
      interval: { startTime: rfc3339(start), endTime: rfc3339(end) },
      metricsSummary: summary,
    },
  };
}

export function hrSample(t: Date, bpm: number, platform = "FITBIT"): Json {
  return { dataSource: { platform }, heartRate: { beatsPerMinute: String(bpm), sampleTime: { physicalTime: rfc3339(t) } } };
}

/** Band heart rate at its real rate over [start, end). */
export function samplesEvery2s(start: Date, end: Date, bpm: number, platform = "FITBIT"): Json[] {
  const out: Json[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += 2 * SECOND) out.push(hrSample(new Date(t), bpm, platform));
  return out;
}

export interface FoodOptions {
  platform?: string;
  meal?: string;
  /** undefined: no energy field */
  kcal?: number;
  carb?: number;
  fat?: number;
  /** nutrients[] entries, grams */
  list?: Record<string, number>;
  name?: string;
}

const LIST_ORDER = ["PROTEIN", "CARBOHYDRATES", "DIETARY_FIBER", "SUGAR", "SODIUM", "SATURATED_FAT", "VITAMIN_C"];

export function foodRec(t: Date, options: FoodOptions = {}): Json {
  const log: Json = {
    foodDisplayName: "Synthetic food",
    mealType: options.meal ?? "LUNCH",
    interval: { startTime: rfc3339(t), endTime: rfc3339(t) },
    serving: { amount: 1, foodMeasurementUnitDisplayName: "portion" },
  };
  if (options.kcal !== undefined) {
    // proto3 leaves out a zero
    log.energy = options.kcal === 0 ? { userProvidedUnit: "kcal" } : { userProvidedUnit: "kcal", kcal: options.kcal };
  }
  if (options.carb !== undefined) log.totalCarbohydrate = { grams: options.carb };
  if (options.fat !== undefined) log.totalFat = { grams: options.fat };
  const list = LIST_ORDER.filter((nutrient) => options.list && nutrient in options.list).map((nutrient) => ({
    nutrient,
    quantity: { grams: options.list?.[nutrient] },
  }));
  if (list.length > 0) log.nutrients = list;
  return {
    name: options.name ?? `users/me/dataTypes/nutrition-log/dataPoints/syn-${Math.trunc(t.getTime() / 1000)}`,
    dataSource: { platform: options.platform ?? "FITBIT", recordingMethod: "MANUAL" },
    nutritionLog: log,
  };
}

const API = "https://health.googleapis.com";
const PATH = /^\/v4\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints(:dailyRollUp)?$/;
const FILTER = /^([a-z_]+)\.([a-z_.]+) >= "([^"]+)" AND \1\.\2 < "([^"]+)"$/;

function dateText(date: Json | undefined): string {
  const pad = (n: unknown, width: number) => String(n ?? 0).padStart(width, "0");
  return date ? `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}` : "";
}

/** The local day (São Paulo) a list filter places a record on; "" when it has no readable day. */
function recordDay(dataType: string, record: Json | null): string {
  const local = (text: unknown) => {
    const ms = typeof text === "string" ? Date.parse(text) : Number.NaN;
    return Number.isNaN(ms) ? "" : SAO_PAULO.dateOf(ms);
  };
  switch (dataType) {
    case "sleep":
      return local(record?.sleep?.interval?.endTime);
    case "exercise":
      return local(record?.exercise?.interval?.startTime);
    case "nutrition-log":
      return local(record?.nutritionLog?.interval?.startTime);
    case "daily-resting-heart-rate":
      return dateText(record?.dailyRestingHeartRate?.date);
    case "steps":
      return dateText(record?.steps?.interval?.civilStartTime?.date);
  }
  return "";
}

const SAMPLE_FIELD: Record<string, string> = {
  "heart-rate": "heartRate",
  "heart-rate-variability": "heartRateVariability",
  weight: "weight",
  "body-fat": "bodyFat",
};

function sampleMs(dataType: string, record: Json | null): number {
  const text = record?.[SAMPLE_FIELD[dataType] ?? ""]?.sampleTime?.physicalTime;
  return typeof text === "string" ? Date.parse(text) : Number.NaN;
}

/**
 * A fake Google Health API v4 behind `fetch`. It filters records as the API
 * does (a record without a readable time or day always comes back, so the
 * tests can send unreadable records), pages them by the page size of the
 * request, and counts every HTTP request per data type.
 */
export class FakeGoogle {
  private readonly records = new Map<string, Json[]>();
  private readonly rollups = new Map<string, Json[]>();
  /** Return every record, ignoring the range, like a sloppy filter. */
  loose = false;
  /** When set, every request gets this answer. */
  fail: (() => Response) | undefined;
  private calls: string[] = [];
  private sent: string[] = [];

  add(dataType: DataType, ...records: unknown[]): void {
    this.records.set(dataType, [...(this.records.get(dataType) ?? []), ...(records as Json[])]);
  }

  /** Stores daily rollup rows, filtered by their civil start date. */
  addRollup(dataType: DataType, ...rows: unknown[]): void {
    this.rollups.set(dataType, [...(this.rollups.get(dataType) ?? []), ...(rows as Json[])]);
  }

  /**
   * The calls since the last take, one per range asked (the first page of a
   * list or of a rollup chunk), in the form of the Go tests:
   * "sleep 2026-10-13..2026-10-16", "rollup steps 2026-10-14..2026-10-16",
   * "between heart-rate 2026-10-10T22:00:00Z..2026-10-10T23:00:01Z".
   */
  takeCalls(): string[] {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }

  /** The HTTP requests since the last take, counted per data type ("rollup …" for a daily rollup), with their total. */
  takeRequests(): Record<string, number> {
    const counts: Record<string, number> = { total: this.sent.length };
    for (const key of this.sent) counts[key] = (counts[key] ?? 0) + 1;
    this.sent = [];
    return counts;
  }

  install(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const match = PATH.exec(url.pathname);
      if (url.origin !== API || !match) throw new Error(`unexpected fetch in test: ${request.method} ${url.origin}${url.pathname}`);
      const dataType = match[1] as string;
      const rollup = match[2] !== undefined;
      this.sent.push(rollup ? `rollup ${dataType}` : dataType);
      if (this.fail) return this.fail();
      return rollup ? this.rollup(dataType, (await request.json()) as Json) : this.list(dataType, url.searchParams);
    });
  }

  private page(key: string, items: Json[], size: number, token: string | null): Response {
    const offset = Number(token ?? 0);
    const page = items.slice(offset, offset + size);
    const body: Json = {};
    // The API leaves an empty list out.
    if (page.length > 0) body[key] = page;
    if (offset + size < items.length) body.nextPageToken = String(offset + size);
    return Response.json(body);
  }

  private rollup(dataType: string, body: Json): Response {
    const from = dateText(body.range?.start?.date);
    const to = addDays(dateText(body.range?.end?.date), -1) as string;
    if (body.pageToken === undefined) this.calls.push(`rollup ${dataType} ${from}..${to}`);
    const rows = (this.rollups.get(dataType) ?? []).filter((row) => {
      const date = row?.civilStartTime?.date;
      const rowDay = date && Number.isInteger(date.year) && date.year > 0 ? dateText(date) : "";
      return this.loose || rowDay === "" || (rowDay >= from && rowDay <= to);
    });
    return this.page("rollupDataPoints", rows, Number(body.pageSize), body.pageToken ?? null);
  }

  private list(dataType: string, query: URLSearchParams): Response {
    const [, , field, low, high] = FILTER.exec(query.get("filter") ?? "") ?? [];
    if (field === undefined || low === undefined || high === undefined) throw new Error("unexpected filter in test");
    const all = this.records.get(dataType) ?? [];
    const first = query.get("pageToken") === null;
    let items: Json[];
    if (field === "sample_time.physical_time") {
      const [start, end] = [Date.parse(low), Date.parse(high)];
      if (first) {
        this.calls.push(
          dataType === "heart-rate"
            ? `between ${dataType} ${low}..${high}`
            : `${dataType} ${SAO_PAULO.dateOf(start)}..${SAO_PAULO.dateOf(end - 1)}`,
        );
      }
      items = all.filter((record) => {
        const ms = sampleMs(dataType, record);
        // Heart rate has no "always comes back": the Go fake drops a sample without a time.
        if (dataType === "heart-rate") return ms >= start && ms < end;
        return this.loose || Number.isNaN(ms) || (ms >= start && ms < end);
      });
    } else {
      const [from, to] = [low.slice(0, 10), addDays(high.slice(0, 10), -1) as string];
      if (first) this.calls.push(`${dataType} ${from}..${to}`);
      items = all.filter((record) => {
        const recordOn = recordDay(dataType, record);
        return this.loose || recordOn === "" || (recordOn >= from && recordOn <= to);
      });
    }
    return this.page("dataPoints", items, Number(query.get("pageSize")), query.get("pageToken"));
  }
}

/** The API client of one MCP request: a new request budget, no real waits. */
export function newClient(zone: Zone = SAO_PAULO, budget = new RequestBudget()): GoogleHealthClient {
  return new GoogleHealthClient({
    tokens: { accessToken: async () => ({ ok: true, accessToken: "at-synthetic" }), invalidate: () => false },
    zone,
    budget,
    wait: async () => undefined,
    jitter: (ms) => ms,
  });
}

export interface DataOptions {
  zone?: Zone;
  cache?: Cache;
  now?: Date;
}

/**
 * The source over the fake API and the store. Every call is its own MCP
 * request, as in production: a new client with a new request budget.
 */
export function newData(db: Db, options: DataOptions = {}): Source {
  const zone = options.zone ?? SAO_PAULO;
  const one = () => new HealthData(newClient(zone), options.cache ?? dbCache(db), zone, () => options.now ?? NOW);
  return {
    recovery: (...args) => one().recovery(...args),
    activity: (...args) => one().activity(...args),
    body: (...args) => one().body(...args),
    exercises: (...args) => one().exercises(...args),
    nutrition: (...args) => one().nutrition(...args),
  };
}

export interface CacheFailures {
  read?: boolean;
  put?: boolean;
  del?: boolean;
  /** put and del fail only for this key when set */
  failKey?: string;
}

/** Thrown by a failing cache. Its text must never reach a log line. */
export class DiskError extends Error {
  constructor() {
    super("disk full: synthetic secret 4242");
    this.name = "DiskError";
  }
}

/** The store's cache with the named operations failing. */
export function failingCache(db: Db, fail: CacheFailures): Cache {
  const real = dbCache(db);
  return {
    metricRange: (...args) => {
      if (fail.read) throw new DiskError();
      return real.metricRange(...args);
    },
    putMetric: (metric) => {
      if (fail.put && (fail.failKey === undefined || fail.failKey === metric.key)) throw new DiskError();
      real.putMetric(metric);
    },
    deleteMetric: (date, key) => {
      if (fail.del && (fail.failKey === undefined || fail.failKey === key)) throw new DiskError();
      real.deleteMetric(date, key);
    },
  };
}

/** Points as the Go tests print them: "2026-10-08=54 2026-10-09=nil ". */
export function render(points: readonly Point[]): string {
  return points.map((point) => `${point.date}=${point.value === null ? "nil" : point.value} `).join("");
}

/** The recovery keys with a cached row on `date`. */
export function cachedKeys(db: Db, date: string): string[] {
  return RECOVERY_KEYS.filter((key) => metricRange(db, key, date, date, ALGO_VERSION).length > 0);
}

/** Checks that two reads of the same range hold the same values. */
export function assertSame(a: Recovery, b: Recovery): void {
  for (const key of RECOVERY_KEYS) expect(render(b.series(key)), key).toBe(render(a.series(key)));
  for (const [date, night] of a.nights) {
    const other = b.nights.get(date);
    expect(other?.hrv.coverage, `${date} coverage`).toBe(night.hrv.coverage);
    expect(other?.provisional, `${date} provisional`).toBe(night.provisional);
    expect(other?.start, `${date} start`).toEqual(night.start);
    expect(other?.end, `${date} end`).toEqual(night.end);
  }
  expect(b.sources).toEqual(a.sources);
  expect([...b.restingHR]).toEqual([...a.restingHR]);
}

/** 2026-10-07..2026-10-15: a full night and resting HR on each day. */
export function week(google: FakeGoogle): void {
  for (let i = 7; i <= 15; i++) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const [end, start] = [`2026-10-${pad(i)}`, `2026-10-${pad(i - 1)}`];
    google.add("sleep", sleepRec(at(start, 23, 0), at(end, 7, 0), { deep: 60 + i }));
    google.add("heart-rate-variability", ...hrvNight(at(start, 23, 0), at(end, 7, 0), 40 + i));
    google.add("daily-resting-heart-rate", restingRec(end, 50 + i, "WITH_SLEEP", "FITBIT"));
  }
}

/** The 2026-10-09 23:00 → 10-10 07:00 night: 480 minutes, 96 slots. */
export function oneNight(google: FakeGoogle, options: SleepOptions = {}): void {
  google.add("sleep", sleepRec(at("2026-10-09", 23, 0), at("2026-10-10", 7, 0), options));
}

/** 2026-10-07..2026-10-16: steps, zone minutes and total calories on each day. */
export function activityWeek(google: FakeGoogle): void {
  for (let i = 7; i <= 16; i++) {
    const date = `2026-10-${String(i).padStart(2, "0")}`;
    google.addRollup("steps", stepsRollup(date, 8000 + i));
    google.addRollup("active-zone-minutes", azmRollup(date, 20, 5, i % 2));
    google.addRollup("total-calories", kcalRollup(date, 2400.5));
  }
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

export interface Harness {
  google: FakeGoogle;
  /** Every console line of the test so far, as JSON. */
  logged(): string;
  /** The console.warn calls of the test so far. */
  warnings(): unknown[][];
}

/**
 * Registers the per-test setup: a new fake API behind `fetch`, and a spy on
 * every console level (a log line must never carry a health value).
 */
export function harness(): Harness {
  const spies = new Map<string, MockInstance>();
  const state: Harness = {
    google: new FakeGoogle(),
    logged: () => JSON.stringify(LEVELS.flatMap((level) => spies.get(level)?.mock.calls ?? [])),
    warnings: () => spies.get("warn")?.mock.calls ?? [],
  };
  beforeEach(() => {
    for (const level of LEVELS) spies.set(level, vi.spyOn(console, level).mockImplementation(() => undefined));
    state.google = new FakeGoogle();
    state.google.install();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return state;
}
