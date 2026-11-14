// The morning readiness rule (Go: internal/metrics/readiness.go).

import { type ConfidenceLevel, confidence } from "../coach/envelope";
import { MIN_BASELINE_NIGHTS, REL_TOL, finite } from "./stats";

/** The readiness traffic light. */
export type Level = "green" | "yellow" | "red" | "unknown";

/**
 * The readiness rule's lines. HRV z-score and sleep lines are strict
 * (z < line, minutes < line); resting-HR lines are inclusive (delta ≥ line, in
 * bpm above the 28-day mean).
 */
export interface ReadinessThresholds {
  hrvZRed: number;
  hrvZYellow: number;
  restingHRRed: number;
  restingHRYellow: number;
  asleepMinRed: number;
  asleepMinYellow: number;
}

/**
 * The readiness rule's lines. They live only here, so tuning them is a
 * one-line change; callers get a copy, so nothing shares state.
 */
export function defaultThresholds(): ReadinessThresholds {
  return {
    hrvZRed: -1.5,
    hrvZYellow: -0.5,
    restingHRRed: 5,
    restingHRYellow: 3,
    asleepMinRed: 360,
    asleepMinYellow: 420,
  };
}

/** A value judged against a baseline, with the number of nights in that baseline. */
export interface Signal {
  value: number | null;
  nights: number;
}

/** The morning traffic light with the codes that explain it. */
export interface Readiness {
  level: Level;
  reasons: string[];
  confidence: ConfidenceLevel;
}

/**
 * Applies the readiness rule to last night's HRV z-score and resting-HR delta
 * (bpm), each against its own 28-day baseline, and minutes asleep. The worst
 * signal sets the level.
 *
 * A signal that is missing, not a finite number, or whose baseline has fewer
 * than MIN_BASELINE_NIGHTS nights counts neither way: it is listed as
 * missing:<signal> and lowers confidence. With no usable signal the level is
 * unknown. Confidence follows the smaller baseline in use (coach confidence),
 * is capped at medium with one signal missing and is low with two or more.
 *
 * Reasons are stable codes in a fixed order (hrv, resting_hr, sleep), one per
 * signal that is missing or not green. HRV and resting-HR codes are relative
 * to the person's own baseline; none of them is a diagnosis.
 */
export function assessReadiness(
  th: ReadinessThresholds,
  hrvZ: Signal,
  restingHRDelta: Signal,
  asleepMin: number | null,
): Readiness {
  const usable = (s: Signal) => (finite(s.value) && s.nights >= MIN_BASELINE_NIGHTS ? s.value : null);
  const hrv = usable(hrvZ);
  const restingHR = usable(restingHRDelta);
  const signals: { name: string; value: number | null; level: (v: number) => Level; yellow: string; red: string }[] = [
    {
      name: "hrv",
      value: hrv,
      level: (v) => pick(below(v, th.hrvZRed), below(v, th.hrvZYellow)),
      yellow: "hrv_below_baseline",
      red: "hrv_well_below_baseline",
    },
    {
      name: "resting_hr",
      value: restingHR,
      level: (v) => pick(atLeast(v, th.restingHRRed), atLeast(v, th.restingHRYellow)),
      yellow: "resting_hr_above_baseline",
      red: "resting_hr_well_above_baseline",
    },
    {
      name: "sleep",
      value: finite(asleepMin) ? asleepMin : null,
      level: (v) => pick(below(v, th.asleepMinRed), below(v, th.asleepMinYellow)),
      yellow: "sleep_short",
      red: "sleep_very_short",
    },
  ];

  let level: Level = "unknown";
  const reasons: string[] = [];
  let missing = 0;
  for (const signal of signals) {
    if (signal.value === null) {
      missing++;
      reasons.push(`missing:${signal.name}`);
      continue;
    }
    const own = signal.level(signal.value);
    if (own === "red") reasons.push(signal.red);
    else if (own === "yellow") reasons.push(signal.yellow);
    if (SEVERITY[own] > SEVERITY[level]) level = own;
  }

  // Sleep has no baseline, so only the baselined signals set the night count.
  let nights = Infinity;
  if (hrv !== null) nights = Math.min(nights, hrvZ.nights);
  if (restingHR !== null) nights = Math.min(nights, restingHRDelta.nights);

  let result: ConfidenceLevel;
  if (missing >= 2 || nights === Infinity) result = "low";
  else if (missing === 1) result = lower(confidence(nights), "medium");
  else result = confidence(nights);
  return { level, reasons, confidence: result };
}

// below is v < line and atLeast is v ≥ line, both allowing for float rounding
// (a 28-day mean of fractional readings lands a hair off the line).
const tolAt = (line: number) => REL_TOL * Math.max(1, Math.abs(line));
const below = (v: number, line: number) => v < line - tolAt(line);
const atLeast = (v: number, line: number) => v >= line - tolAt(line);

function pick(red: boolean, yellow: boolean): Level {
  if (red) return "red";
  return yellow ? "yellow" : "green";
}

/** Orders levels; unknown is the least severe, so any usable signal replaces it. */
const SEVERITY: Record<Level, number> = { unknown: 0, green: 1, yellow: 2, red: 3 };

const RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

/** The lower of two confidence levels. */
function lower(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return RANK[b] < RANK[a] ? b : a;
}
