// Shared by the coach-moment tool tests: a health source over synthetic values
// (it mirrors fakeHealth of internal/tools/coach_test.go), the fixtures of the
// Go tool tests, and a session that serves the tools as the Worker does.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect } from "vitest";

import { type LocalDate, type Zone, addDays, bounds } from "../src/coach/date";
import type { WireError } from "../src/coach/errors";
import type { DataType } from "../src/googlehealth/datatypes";
import {
  ACTIVITY_VALUES,
  Activity,
  type ActivityDay,
  type ActivityOptions,
  BODY_VALUES,
  Body,
  type BodyOptions,
  type Exercise,
  type ExerciseHR,
  Exercises,
  type FoodItem,
  type Night,
  type Nutrient,
  Nutrition,
  type NutritionDay,
  type Reading,
  Recovery,
  type RecoveryOptions,
  type RestingHR,
  type Source,
} from "../src/healthdata";
import type { Target } from "../src/store/memory";
import type { CoachDeps, Notes, Targets } from "../src/tools/coach";
import { COACH_TOOLS, runCoachTool } from "../src/tools/moments";
import { invoke } from "../src/tools/register";
import { SAO_PAULO, SCHEMA_HINT } from "./memory-helpers";

// All values in the coach tool tests are synthetic.

/** 2026-10-16 08:00 in São Paulo. */
export const COACH_NOW = new Date("2026-10-16T11:00:00Z");
export const COACH_TODAY: LocalDate = "2026-10-16";

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export function plus(day: LocalDate, n: number): LocalDate {
  const out = addDays(day, n);
  if (out === undefined) throw new Error(`not a date: ${day}`);
  return out;
}

/** Local midnight of a day in São Paulo. */
export function midnight(day: LocalDate): Date {
  const range = bounds(day, SAO_PAULO);
  if (!range) throw new Error(`not a date: ${day}`);
  return range.start;
}

function within<V>(values: ReadonlyMap<LocalDate, V>, from: LocalDate, to: LocalDate): Map<LocalDate, V> {
  return new Map([...values].filter(([day]) => day >= from && day <= to).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** An activity day as healthdata gives it: a value that is not set is null. */
export function activityDay(day: Partial<ActivityDay>): ActivityDay {
  return { steps: null, azm: null, totalKcal: null, worn: false, partial: false, ...day };
}

/** What a fake Exercises result carries next to its sessions. */
export interface ExercisesExtra {
  skipped?: number;
  otherSource?: number;
  maxHROmitted?: number;
}

/**
 * A healthdata Source over synthetic values. Each method returns its stored
 * values clipped to the requested range, or throws errs[method]. It narrows
 * an activity or body read as the real source does, so a tool that asks for
 * too few values fails its test.
 */
export class FakeHealth implements Source {
  nights = new Map<LocalDate, Night>();
  resting = new Map<LocalDate, RestingHR>();
  activityDays = new Map<LocalDate, ActivityDay>();
  weight = new Map<LocalDate, Reading>();
  bodyFat = new Map<LocalDate, Reading>();
  sessions: Exercise[] = [];
  /** Copied into every Recovery result. */
  recoveryExtra: { sources?: string[]; skipped?: number; empty?: DataType[] } = {};
  /** Copied into every Exercises result. */
  exercisesExtra: ExercisesExtra = {};
  /** Overrides exercisesExtra for one requested range ("from..to"). */
  byRange = new Map<string, ExercisesExtra>();
  nutritionDays = new Map<LocalDate, NutritionDay>();
  nutritionSkip = 0;
  nutritionOther = 0;
  /** Sets Nutrition.otherSourceDays. */
  nutritionOtherDays = new Map<LocalDate, number>();
  activitySkipped = 0;
  bodySkipped = 0;
  errs: Record<string, unknown> = {};
  /** Every call, with its range and its narrow option: the request plan of a tool. */
  calls: string[] = [];

  private call(name: string, from: LocalDate, to: LocalDate, extra = ""): void {
    this.calls.push(`${name} ${from}..${to}${extra}`);
    if (name in this.errs) throw this.errs[name];
  }

  async recovery(from: LocalDate, to: LocalDate, options?: RecoveryOptions): Promise<Recovery> {
    this.call("recovery", from, to, options?.values ? ` values=${options.values.join(",")}` : "");
    const r = new Recovery(from, to, options?.values ? new Set(options.values) : undefined);
    r.nights = within(this.nights, from, to);
    r.restingHR = within(this.resting, from, to);
    r.sources = [...(this.recoveryExtra.sources ?? [])];
    r.skipped = this.recoveryExtra.skipped ?? 0;
    r.empty = [...(this.recoveryExtra.empty ?? [])];
    return r;
  }

  async activity(from: LocalDate, to: LocalDate, options?: ActivityOptions): Promise<Activity> {
    this.call("activity", from, to, options?.values ? ` values=${options.values.join(",")}` : "");
    const values = new Set(options?.values ?? ACTIVITY_VALUES);
    const read = { steps: values.has("steps"), azm: values.has("azm") || values.has("worn"), kcal: values.has("total_calories") };
    const a = new Activity(from, to, values);
    for (const [day, stored] of within(this.activityDays, from, to)) {
      const narrowed: ActivityDay = {
        steps: read.steps ? stored.steps : null,
        azm: read.azm ? stored.azm : null,
        totalKcal: read.kcal ? stored.totalKcal : null,
        worn: read.azm && stored.worn,
        partial: stored.partial,
      };
      // A day without any of the values read is absent.
      if (narrowed.steps === null && narrowed.azm === null && narrowed.totalKcal === null) continue;
      a.days.set(day, narrowed);
    }
    a.skipped = this.activitySkipped;
    return a;
  }

  async body(from: LocalDate, to: LocalDate, options?: BodyOptions): Promise<Body> {
    this.call("body", from, to, options?.values ? ` values=${options.values.join(",")}` : "");
    const values = new Set(options?.values ?? BODY_VALUES);
    const b = new Body(from, to, values);
    if (values.has("weight")) b.weight = within(this.weight, from, to);
    if (values.has("body_fat")) b.bodyFat = within(this.bodyFat, from, to);
    b.skipped = this.bodySkipped;
    return b;
  }

  async exercises(from: LocalDate, to: LocalDate, maxHR: boolean): Promise<Exercises> {
    this.call("exercises", from, to, ` maxHR=${maxHR}`);
    const extra = this.byRange.get(`${from}..${to}`) ?? this.exercisesExtra;
    const e = new Exercises(from, to);
    e.skipped = extra.skipped ?? 0;
    e.otherSource = extra.otherSource ?? 0;
    e.maxHROmitted = extra.maxHROmitted ?? 0;
    for (const session of this.sessions) {
      if (session.day < from || session.day > to) continue;
      e.sessions.push(maxHR || !session.hr ? session : { ...session, hr: { ...session.hr, maxBpm: null } });
    }
    return e;
  }

  async nutrition(from: LocalDate, to: LocalDate): Promise<Nutrition> {
    this.call("nutrition", from, to);
    const n = new Nutrition(from, to);
    n.days = within(this.nutritionDays, from, to);
    n.skipped = this.nutritionSkip;
    // As in healthdata, the range count includes the per-day ones.
    n.otherSourceDays = within(this.nutritionOtherDays, from, to);
    n.otherSource = this.nutritionOther + [...n.otherSourceDays.values()].reduce((sum, count) => sum + count, 0);
    return n;
  }
}

/** A target version; created_at is not read by the coach tools. */
export function target(version: Omit<Target, "created_at">): Target {
  return { ...version, created_at: "2026-10-01T00:00:00Z" };
}

/** Returns the latest version on or before the day, as the store does. */
export function fakeTargets(...versions: Omit<Target, "created_at">[]): Targets {
  return (day) => {
    let best: Target | undefined;
    for (const version of versions) {
      if (version.effective_from <= day && (!best || version.effective_from > best.effective_from)) best = target(version);
    }
    return best;
  };
}

/** A synthetic night ending on `day` at 07:00 after `inBed` minutes. */
export function night(day: LocalDate, asleep: number, inBed: number, hrv: number | null): Night {
  const wake = new Date(midnight(day).getTime() + 7 * HOUR);
  const start = new Date(wake.getTime() - inBed * MINUTE);
  const deep = asleep / 5;
  const rem = asleep / 5;
  return {
    asleepMin: asleep,
    awakeMin: inBed - asleep,
    inBedMin: inBed,
    stages: { deepMin: deep, lightMin: asleep - deep - rem, remMin: rem },
    startMinOfDay: (((7 * 60 - inBed) % 1440) + 1440) % 1440,
    endMinOfDay: 7 * 60,
    start,
    end: wake,
    hrv: { medianMs: hrv, coverage: 1 },
    source: "Synthetic Band",
    provisional: false,
  };
}

/**
 * `n` nights before today: asleep 450 of 500 min in bed, HRV alternating
 * 48/52 ms (mean 50, sd 2.04) and resting HR 58/62 (mean 60). Today's night
 * is asleep 480 of 520 min with HRV 50 and resting HR 60.
 */
export function history(n: number): FakeHealth {
  const h = new FakeHealth();
  h.recoveryExtra.sources = ["Synthetic Band"];
  for (let i = 1; i <= n; i++) {
    const day = plus(COACH_TODAY, -i);
    h.nights.set(day, night(day, 450, 500, 48 + 4 * (i % 2)));
    h.resting.set(day, { bpm: 58 + 4 * (i % 2), method: "WITH_SLEEP" });
  }
  h.nights.set(COACH_TODAY, night(COACH_TODAY, 480, 520, 50));
  h.resting.set(COACH_TODAY, { bpm: 60, method: "WITH_SLEEP" });
  return h;
}

/** A synthetic session starting at hh:00 local on `day`. */
export function session(id: string, day: LocalDate, hh: number, type: string, minutes: number, hr: ExerciseHR | null, ...flags: string[]): Exercise {
  const start = new Date(midnight(day).getTime() + hh * HOUR);
  return {
    id: `users/me/dataTypes/exercise/dataPoints/${id}`,
    day,
    type,
    name: `Session ${id}`,
    start,
    end: new Date(start.getTime() + minutes * MINUTE),
    activeMin: minutes,
    kcal: minutes * 8,
    azm: minutes / 2,
    hr,
    manual: false,
    source: "Synthetic Band",
    flags: [...flags],
  };
}

export const heartRate = (avgBpm: number, maxBpm: number | null = null, zones: [number, number, number, number] = [0, 0, 0, 0]): ExerciseHR => ({
  avgBpm,
  maxBpm,
  zoneMin: { light: zones[0], moderate: zones[1], vigorous: zones[2], peak: zones[3] },
});

export interface FoodSpec {
  hour: number;
  meal: string;
  nutrients: Partial<Record<Nutrient, number>>;
  rejected?: Nutrient[];
}

export const food = (hour: number, meal: string, nutrients: Partial<Record<Nutrient, number>>, rejected?: Nutrient[]): FoodSpec => ({
  hour,
  meal,
  nutrients,
  rejected,
});

/**
 * A logged day the way healthdata builds it: items in time order, totals over
 * the items that report each nutrient.
 */
export function foodDay(day: LocalDate, ...specs: FoodSpec[]): NutritionDay {
  const logged: NutritionDay = { items: [], totals: {}, rejected: 0, partial: day >= COACH_TODAY };
  for (const [i, spec] of specs.entries()) {
    const item: FoodItem = {
      id: `users/me/dataTypes/nutrition-log/dataPoints/syn-${i}`,
      name: `Synthetic food ${i}`,
      meal: spec.meal,
      at: new Date(midnight(day).getTime() + spec.hour * HOUR),
      source: "Google Fitbit Air",
      nutrients: spec.nutrients,
      rejected: spec.rejected ?? [],
    };
    logged.items.push(item);
    logged.rejected += item.rejected.length;
    for (const [nutrient, value] of Object.entries(spec.nutrients) as [Nutrient, number][]) {
      const total = logged.totals[nutrient] ?? { value: 0, items: 0 };
      logged.totals[nutrient] = { value: total.value + value, items: total.items + 1 };
    }
  }
  return logged;
}

export interface CoachSessionOptions {
  targets?: Targets;
  notes?: Notes;
  now?: Date;
  zone?: Zone;
}

export interface CoachSession {
  /** Calls a tool that must succeed and returns its structured result. */
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Calls a tool that must fail and returns the {code,message,hint} it sent. */
  fails(name: string, args?: Record<string, unknown>): Promise<WireError & { text: string; schema: boolean }>;
  /** The raw result of a call. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * Serves the coach-moment tools as the Worker does (argument check, body,
 * output check, log line) over a health source, with "now" at COACH_NOW in
 * São Paulo. It is the Worker form of coachSession in the Go tests.
 */
export function coachSession(health: Source, options: CoachSessionOptions = {}): CoachSession {
  const deps: CoachDeps = {
    health,
    targets: options.targets,
    notes: options.notes,
    now: () => options.now ?? COACH_NOW,
    zone: options.zone ?? SAO_PAULO,
  };
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = COACH_TOOLS.find((one) => one.name === name);
    if (!tool) throw new Error(`no coach tool named ${name}`);
    return invoke(tool, (checked) => runCoachTool(deps, name, checked), args);
  };
  const textOf = (result: CallToolResult) => {
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    return block?.type === "text" ? block.text : "";
  };
  return {
    call,
    async ok(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name}(${JSON.stringify(args)}) failed: ${textOf(result)}`).not.toBe(true);
      // The text content is the same JSON as the structured content.
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
      return result.structuredContent as Record<string, any>;
    },
    async fails(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name}(${JSON.stringify(args)}) succeeded, want an error`).toBe(true);
      // An error never carries structured content.
      expect(result.structuredContent).toBeUndefined();
      const text = textOf(result);
      const wire = JSON.parse(text) as WireError;
      expect(Object.keys(wire).sort()).toEqual(wire.hint === undefined ? ["code", "message"] : ["code", "hint", "message"]);
      return { ...wire, text, schema: wire.hint === SCHEMA_HINT };
    },
  };
}
