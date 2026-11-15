// morning_briefing (Go: internal/tools/briefing.go, CAPABILITY §4.1).

import type { LocalDate } from "../coach/date";
import { ToolError } from "../coach/errors";
import {
  type Activity,
  type Exercises,
  KEY_ASLEEP,
  KEY_AWAKE,
  KEY_DEEP,
  KEY_IN_BED,
  KEY_LIGHT,
  KEY_REM,
  type Night,
  type Recovery,
  type RecoveryKey,
  last,
} from "../healthdata";
import { assessReadiness, defaultThresholds } from "../metrics/readiness";
import type { Point } from "../metrics/stats";
import {
  BASELINE_DAYS,
  type CoachDeps,
  FLAG_NOT_WORN,
  FLAG_OTHER_SOURCE_SESSIONS,
  FLAG_SESSIONS_TRUNCATED,
  FLAG_UNREADABLE_RECORDS,
  FlagSet,
  MAX_SESSIONS,
  READINESS_NOTICE,
  READ_ONLY,
  REASON_PROVISIONAL_SLEEP,
  SHORT_BASELINE_DAYS,
  SourceSet,
  VENDOR_NOTICE,
  type Versus,
  WEIGHT_LOOKBACK_DAYS,
  bandNotWorn,
  baselineOf,
  coachTool,
  dayOf,
  envelope,
  envelopeSchema,
  localTime,
  plusDays,
  round,
  round1,
  roundTo,
  signalsOf,
  versus,
} from "./coach";
import { inputSchema, s } from "./schema";

/** Compares the night with the average of the nights before it; each field is null when no earlier night has the value. */
interface SleepVs {
  asleep_min: Versus | null;
  awake_min: Versus | null;
  efficiency_pct: Versus | null;
  deep_min: Versus | null;
  light_min: Versus | null;
  rem_min: Versus | null;
}

/** The night, in minutes, against the averages before it. */
interface BriefingSleep {
  asleep_min: number;
  awake_min: number;
  /** Time asleep as a percent of time in bed. */
  efficiency_pct: number | null;
  /** Deep, light and REM are null on a night without final stages. */
  stages_min: { deep: number | null; light: number | null; rem: number | null; awake: number };
  start: string;
  end: string;
  vs_7d: SleepVs;
  vs_28d: SleepVs;
}

/** A session in a load summary: its type, never its free-text name. */
export interface LoadSession {
  type: string;
  minutes: number;
  avg_hr_bpm: number | null;
  quality_flags: string[];
}

/** One day's training load. */
export interface DayLoad {
  date: LocalDate;
  exercises: LoadSession[];
  azm_min: number | null;
  steps: number | null;
}

const VERSUS = s.nullable(s.object({ avg: s.number(), delta: s.nullable(s.number()), n_days: s.integer() }));

const SLEEP_VS = s.object({
  asleep_min: VERSUS,
  awake_min: VERSUS,
  efficiency_pct: VERSUS,
  deep_min: VERSUS,
  light_min: VERSUS,
  rem_min: VERSUS,
});

const nullableNumber = () => s.nullable(s.number());

const BRIEFING = s.object({
  sleep: s.object({
    asleep_min: s.number(),
    awake_min: s.number(),
    efficiency_pct: nullableNumber(),
    stages_min: s.object({ deep: nullableNumber(), light: nullableNumber(), rem: nullableNumber(), awake: s.number() }),
    start: s.string(),
    end: s.string(),
    vs_7d: SLEEP_VS,
    vs_28d: SLEEP_VS,
  }),
  hrv: s.object({ median_ms: nullableNumber(), delta_pct_vs_28d: nullableNumber(), z_score_vs_28d: nullableNumber() }),
  resting_hr: s.object({ bpm: nullableNumber(), delta_bpm_vs_28d: nullableNumber() }),
  yesterday_load: s.object({
    date: s.date(),
    exercises: s.list(
      s.object({ type: s.string(), minutes: s.number(), avg_hr_bpm: nullableNumber(), quality_flags: s.list(s.string()) }),
    ),
    azm_min: nullableNumber(),
    steps: nullableNumber(),
  }),
  readiness: s.object({ level: s.string(), reasons: s.list(s.string()), confidence: s.string() }),
  body: s.object({ weight_kg: nullableNumber(), date: s.nullable(s.date()) }),
  notice: s.string(),
});

async function morningBriefing(deps: CoachDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const day = dayOf(deps, args.date);
  // One recovery call covers both baselines; the night judged is not in them.
  const rec = await deps.health.recovery(plusDays(day, -BASELINE_DAYS), day);
  const night = rec.nights.get(day);
  if (!night) throw noNight(rec);
  const yesterday = plusDays(day, -1);
  // The load shows steps and zone minutes: the total-calories rollup is not read.
  const act = await deps.health.activity(yesterday, yesterday, { values: ["steps", "azm", "worn"] });
  const notWorn = await bandNotWorn(deps, act, yesterday, "total_calories");
  const ex = await deps.health.exercises(yesterday, yesterday, false);
  const body = await deps.health.body(plusDays(day, -(WEIGHT_LOOKBACK_DAYS - 1)), day, { values: ["weight"] });

  const flags = new FlagSet();
  const sources = new SourceSet();
  sources.add(...rec.sources);
  const sleep = sleepOf(deps, rec, night, day);
  const sig = signalsOf(rec, day, flags);

  const readiness = assessReadiness(
    defaultThresholds(),
    { value: sig.hrvZ, nights: sig.hrvN },
    { value: sig.rhrDelta, nights: sig.rhrN },
    night.asleepMin,
  );
  if (night.provisional) {
    // Minutes asleep and HRV may still change after the next sync.
    readiness.reasons.push(REASON_PROVISIONAL_SLEEP);
    readiness.confidence = "low";
  }

  const nDays = Math.min(baselineOf(rec, KEY_ASLEEP, day).n, sig.hrvN, sig.rhrN);

  const load = loadOf(act, notWorn, ex, yesterday, flags, sources);
  const weighed = last(body.weight);
  if (weighed) sources.add(weighed.reading.source);
  flags.add(FLAG_UNREADABLE_RECORDS, act.skipped + ex.skipped + body.skipped > 0);
  // Exercise flags last, after the day-level ones.
  for (const session of load.exercises) for (const flag of session.quality_flags) flags.add(flag, true);

  const data = {
    sleep,
    hrv: { median_ms: round(sig.hrv), delta_pct_vs_28d: round(sig.hrvDeltaPct), z_score_vs_28d: roundTo(sig.hrvZ, 2) },
    resting_hr: { bpm: round(sig.rhr), delta_bpm_vs_28d: round(sig.rhrDelta) },
    yesterday_load: load,
    readiness,
    body: { weight_kg: weighed ? round(weighed.reading.value) : null, date: weighed ? weighed.day : null },
    notice: `${READINESS_NOTICE} ${VENDOR_NOTICE}`,
  };
  return envelope(deps, data, nDays, sources, flags);
}

/** Explains a missing night by its likely cause. */
function noNight(rec: Recovery): ToolError {
  let hint = "the band may not have synced yet: open the Fitbit app, then call again";
  if (rec.skipped > 0) {
    hint = "some sleep or heart records could not be read; call again later, and report it if it persists";
  } else if (rec.empty.includes("sleep")) {
    hint =
      "sleep arrived only from another platform (such as Apple Health); the coach reads the band's sleep: " +
      "check that the band was worn and has synced";
  }
  return new ToolError("no_data", "no main sleep recorded for the night ending on that date", hint);
}

function sleepOf(deps: CoachDeps, rec: Recovery, night: Night, day: LocalDate): BriefingSleep {
  const stages = night.stages;
  const [deep, light, rem] = stages ? [stages.deepMin, stages.lightMin, stages.remMin] : [null, null, null];
  const tonight = efficiency(night.asleepMin, night.inBedMin);
  const eff = efficiencySeries(rec);
  const window = (days: number): SleepVs => {
    const of = (key: RecoveryKey, value: number | null) => versus(rec.baselineSeries(key), value, day, days);
    return {
      asleep_min: of(KEY_ASLEEP, night.asleepMin),
      awake_min: of(KEY_AWAKE, night.awakeMin),
      efficiency_pct: versus(eff, tonight, day, days),
      deep_min: of(KEY_DEEP, deep),
      light_min: of(KEY_LIGHT, light),
      rem_min: of(KEY_REM, rem),
    };
  };
  return {
    asleep_min: round1(night.asleepMin),
    awake_min: round1(night.awakeMin),
    efficiency_pct: round(tonight),
    stages_min: { deep: round(deep), light: round(light), rem: round(rem), awake: round1(night.awakeMin) },
    start: localTime(night.start, deps.zone),
    end: localTime(night.end, deps.zone),
    vs_7d: window(SHORT_BASELINE_DAYS),
    vs_28d: window(BASELINE_DAYS),
  };
}

export function efficiency(asleep: number, inBed: number): number | null {
  return inBed <= 0 ? null : (asleep / inBed) * 100;
}

/** Asleep / in bed per night, over the baseline nights. */
export function efficiencySeries(rec: Recovery): Point[] {
  const asleep = rec.baselineSeries(KEY_ASLEEP);
  const inBed = rec.baselineSeries(KEY_IN_BED);
  return asleep.map((point, i): Point => {
    const bed = inBed[i];
    const both = point.value !== null && bed !== undefined && bed.date === point.date && bed.value !== null;
    return { date: point.date, value: both ? efficiency(point.value as number, bed.value as number) : null };
  });
}

/** Summarizes a day's sessions, zone minutes and steps. `notWorn` is what bandNotWorn decided for the day. */
export function loadOf(act: Activity, notWorn: boolean, ex: Exercises, day: LocalDate, flags: FlagSet, sources: SourceSet): DayLoad {
  const load: DayLoad = { date: day, exercises: [], azm_min: null, steps: null };
  const a = act.days.get(day);
  if (a) {
    load.azm_min = round(a.azm);
    load.steps = round(a.steps);
  }
  flags.add(FLAG_NOT_WORN, notWorn);
  flags.add(FLAG_OTHER_SOURCE_SESSIONS, ex.otherSource > 0);
  for (const [i, session] of ex.sessions.entries()) {
    if (i === MAX_SESSIONS) {
      flags.add(FLAG_SESSIONS_TRUNCATED, true);
      break;
    }
    load.exercises.push({
      type: session.type,
      minutes: round1(session.activeMin),
      avg_hr_bpm: session.hr ? round(session.hr.avgBpm) : null,
      quality_flags: [...session.flags],
    });
    sources.add(session.source);
  }
  return load;
}

export const MORNING_BRIEFING = coachTool(
  {
    name: "morning_briefing",
    description:
      "Morning recovery check for the night that ended on date (default today): sleep (minutes asleep " +
      "and awake, efficiency, stages, bedtime and wake time, each against the 7- and 28-day averages), overnight " +
      "HRV and resting heart rate against the 28-day baseline, yesterday's training load (sessions, Active Zone " +
      "Minutes, steps), the last weight, and a readiness level (green, yellow or red) with reason codes. Readiness " +
      "compares the user with their own recent baseline; it is a training cue, not a medical assessment. Reasons " +
      "such as missing:hrv mean that signal was left out, so a green with missing reasons rests only on the " +
      "signals left: say so. provisional:sleep means Google is still processing the night and the level may " +
      "change. unknown means no signal was usable: do not infer a level. readiness.confidence qualifies the " +
      "level; coverage qualifies the averages. Values are null when not recorded. Mention quality_flags and " +
      "follow the notice.",
    annotations: READ_ONLY,
    inputSchema: inputSchema(s.object({ "date?": s.date("local day the night ended (YYYY-MM-DD); omitted means today") })),
    outputSchema: envelopeSchema(BRIEFING),
  },
  morningBriefing,
);
