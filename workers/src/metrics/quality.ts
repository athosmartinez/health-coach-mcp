// Data-quality flags (Go: internal/metrics/quality.go). They travel with the
// data they describe; suspicious data is flagged, never hidden or corrected.

import { type LocalDate, parseDate } from "../coach/date";
import { trimSpace } from "../coach/text";
import { finite } from "./stats";

export const FLAG_LOW_HR_FOR_ACTIVITY = "low_hr_for_activity";
export const FLAG_NO_HR_DATA = "no_hr_data";
export const FLAG_MANUAL_ENTRY = "manual_entry";
/**
 * A session logged through this server covers time that a session of the
 * band also covers: the same workout may be counted twice. The two stay
 * separate records, each with its own values. The Go server has no such
 * flag: it logs no session.
 */
export const FLAG_OVERLAPS_BAND_SESSION = "overlaps_band_session";
export const FLAG_PARTIAL_DAY = "partial_day";
export const FLAG_LIKELY_INCOMPLETE_NUTRITION = "likely_incomplete_nutrition";

/**
 * The exercise types whose average heart rate is expected to reach LOW_HR_BPM
 * over a long session. Strength training is left out: with rests between sets
 * a correct average under 100 bpm is normal. Matching ignores case and treats
 * spaces and hyphens as underscores ("Jiu-jitsu" = JIU_JITSU).
 */
const VIGOROUS_TYPES = new Set(["JIU_JITSU", "MARTIAL_ARTS", "BOXING", "KICKBOXING", "RUNNING", "RUN", "HIIT", "CROSSFIT"]);

/**
 * An average below this in a vigorous session suggests the band missed the
 * effort (loose strap, wrist position), not an easy session.
 */
export const LOW_HR_BPM = 100;

/** The shortest session the low-HR check applies to, in milliseconds. */
export const LOW_HR_MIN_DURATION_MS = 30 * 60_000;

/** The meal types that count as a main meal. */
const MAIN_MEALS = new Set(["BREAKFAST", "LUNCH", "DINNER"]);

/** Whether an exercise type is in the low-HR check's list. */
export function isVigorous(exerciseType: string): boolean {
  return VIGOROUS_TYPES.has(normalize(exerciseType));
}

/** Whether a meal type counts as a main meal. */
export function isMainMeal(mealType: string): boolean {
  return MAIN_MEALS.has(normalize(mealType));
}

/**
 * The form meal types are compared in: upper case, with spaces and hyphens as
 * underscores ("Late snack" = LATE_SNACK).
 */
export function normalizeMealType(mealType: string): string {
  return normalize(mealType);
}

/** The part of a session the quality checks read. */
export interface Exercise {
  type: string;
  /** Active time, in milliseconds. */
  durationMs: number;
  /** null, 0 or not finite when the session has no heart rate. */
  avgHR: number | null;
  manualEntry: boolean;
}

/** The session's quality flags in a fixed order. */
export function exerciseFlags(exercise: Exercise): string[] {
  const flags: string[] = [];
  if (exercise.manualEntry) flags.push(FLAG_MANUAL_ENTRY);
  if (!finite(exercise.avgHR) || exercise.avgHR <= 0) {
    flags.push(FLAG_NO_HR_DATA);
  } else if (exercise.avgHR < LOW_HR_BPM && exercise.durationMs >= LOW_HR_MIN_DURATION_MS && isVigorous(exercise.type)) {
    flags.push(FLAG_LOW_HR_FOR_ACTIVITY);
  }
  return flags;
}

/** Whether `date` is today or later, so its totals can still grow. */
export function partialDay(date: LocalDate, today: LocalDate): boolean {
  for (const d of [date, today]) {
    if (typeof d !== "string" || parseDate(d) === undefined) {
      throw new Error(`invalid date ${JSON.stringify(d)}, want YYYY-MM-DD`);
    }
  }
  return date >= today;
}

/** How complete a day's food log looks. The field names are the ones the tool outputs carry. */
export interface Logging {
  likely_incomplete: boolean;
  has_main_meal: boolean;
  /**
   * Intake as a percent of the target in force, so a very low day stays
   * visible whether it is a gap in the log or real under-eating.
   */
  kcal_pct_of_target: number | null;
}

/**
 * Flags a food log that likely misses meals: nothing (or 0 kcal) logged, no
 * main meal, or kcal strictly below half the target in force. A missing or
 * non-positive target only drops the kcal check. Callers pair it with
 * partialDay: today's log is not finished yet.
 */
export function checkLogging(kcal: number | null, targetKcal: number | null, mealTypes: readonly string[]): Logging {
  const hasMainMeal = mealTypes.some(isMainMeal);
  const hasTarget = finite(targetKcal) && targetKcal > 0;
  return {
    likely_incomplete: !finite(kcal) || kcal <= 0 || !hasMainMeal || (hasTarget && kcal < targetKcal / 2),
    has_main_meal: hasMainMeal,
    kcal_pct_of_target: finite(kcal) && hasTarget ? (kcal / targetKcal) * 100 : null,
  };
}

/**
 * Go's strings.ToUpper maps each code point on its own. JavaScript's
 * toUpperCase also expands some letters into several ("ß" → "SS", "ﬁ" → "FI");
 * those keep their own form here, as they do in Go.
 */
function upper(s: string): string {
  let out = "";
  for (const char of s) {
    const mapped = char.toUpperCase();
    out += mapped.length === char.length ? mapped : char;
  }
  return out;
}

function normalize(s: string): string {
  return upper(trimSpace(s).replace(/[ -]/g, "_"));
}
