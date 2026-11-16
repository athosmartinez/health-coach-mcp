// The pure math behind the coach tools:
// baselines, z-scores, smoothing, trends and adherence. It does no I/O and
// knows no time zone: callers pass values already assigned to local days.
// A null value is a missing day (never 0), and every function skips it.

import { type LocalDate, addDays, parseDate } from "../coach/date";

/**
 * Stored with every cached daily aggregate. Bump it when a change here alters
 * a stored value, so the cache recomputes instead of mixing versions.
 */
export const ALGO_VERSION = 2;

/** The baseline size below which a z-score is not given. */
export const MIN_BASELINE_NIGHTS = 7;

/** Weighs the newest value in EWMA; 0.25 behaves like a ~7-day window ((2 / alpha) − 1 values). */
export const EWMA_ALPHA = 0.25;

/**
 * Absorbs float rounding when two values that should be equal are compared
 * (70.3 − 70.0 is 0.2999…), scaled to the magnitude of the operands.
 */
export const REL_TOL = 1e-9;

/** One local day of a daily series. A null value means no data that day. */
export interface Point {
  date: LocalDate;
  value: number | null;
}

/**
 * Summarizes a baseline. `sd` is the sample standard deviation (n − 1): the
 * baseline estimates the person's usual spread from a sample of their nights.
 * It is 0 when n < 2.
 */
export interface Stats {
  mean: number;
  sd: number;
  n: number;
}

/** Whether `v` is present and a finite number. */
export function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkDate(d: LocalDate): void {
  if (typeof d !== "string" || parseDate(d) === undefined) {
    throw new Error(`invalid date ${JSON.stringify(d)}, want YYYY-MM-DD`);
  }
}

/**
 * Summarizes the days [before − days, before − 1]: the day being judged is
 * never part of its own baseline. Missing days are skipped. Only the points in
 * the window are checked for duplicates and non-finite values, so a bad row
 * outside it does not fail today's baseline.
 */
export function baseline(series: readonly Point[], before: LocalDate, days: number): Stats {
  if (!(Number.isInteger(days) && days > 0)) {
    throw new Error(`baseline needs at least 1 day, got ${days} days`);
  }
  checkDate(before);
  const first = addDays(before, -days) as LocalDate;
  const window: Point[] = [];
  for (const point of series) {
    checkDate(point.date);
    if (point.date >= first && point.date < before) window.push(point);
  }
  const values: number[] = [];
  for (const point of sorted(window)) {
    if (point.value !== null) values.push(point.value);
  }
  return describe(values, 1);
}

/**
 * Mean and standard deviation with the given degrees-of-freedom correction
 * (1 = sample, 0 = population), in two passes for accuracy.
 */
function describe(values: readonly number[], ddof: number): Stats {
  const stats: Stats = { mean: 0, sd: 0, n: values.length };
  if (stats.n === 0) return stats;
  for (const v of values) stats.mean += v;
  stats.mean /= stats.n;
  if (stats.n <= ddof) return stats;
  let ss = 0;
  for (const v of values) ss += (v - stats.mean) * (v - stats.mean);
  stats.sd = Math.sqrt(ss / (stats.n - ddof));
  return stats;
}

/**
 * (value − mean) / sd, or null when the value is missing, the baseline has
 * fewer than MIN_BASELINE_NIGHTS values or no spread. A flat baseline of a
 * non-round value leaves a rounding residue instead of an exact 0 sd, so a
 * spread below float precision counts as none.
 *
 * The guard is scaled for values of order 1 or larger (ms, bpm, minutes, kg).
 */
export function zScore(value: number | null, b: Stats): number | null {
  if (
    !finite(value) ||
    !finite(b.mean) ||
    !finite(b.sd) ||
    b.n < MIN_BASELINE_NIGHTS ||
    b.sd <= REL_TOL * Math.max(1, Math.abs(b.mean))
  ) {
    return null;
  }
  return (value - b.mean) / b.sd;
}

/**
 * value − mean, or null when the value is missing or not finite or the
 * baseline is empty. A short baseline still gives a delta: callers that judge
 * it (assessReadiness) pass the baseline size along.
 */
export function delta(value: number | null, b: Stats): number | null {
  if (!finite(value) || !finite(b.mean) || b.n === 0) return null;
  return value - b.mean;
}

/**
 * The change from the mean in percent of |mean| (so a rise is positive
 * whatever the sign), or null when delta is null or the mean is 0.
 */
export function deltaPct(value: number | null, b: Stats): number | null {
  const d = delta(value, b);
  if (d === null || b.mean === 0) return null;
  return (d / Math.abs(b.mean)) * 100;
}

/**
 * Smooths the series in date order, returning one point per input point. The
 * first value seeds it; days before it come back null. A missing day (a null
 * value or a date with no point) comes back null and leaves the state as it
 * was, so the next value blends with the last one seen however long the gap:
 * the average runs over logged values, it does not decay with time.
 */
export function ewma(series: readonly Point[], alpha: number): Point[] {
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`EWMA alpha must be in (0, 1], got ${alpha}`);
  let state: number | null = null;
  return sorted(series).map((point) => {
    if (point.value === null) return { date: point.date, value: null };
    state = state === null ? point.value : alpha * point.value + (1 - alpha) * state;
    return { date: point.date, value: state };
  });
}

/**
 * The least-squares slope of the series per 7 days, with x the number of days
 * since the first value (so gaps keep their real width). It is null with fewer
 * than 2 values.
 */
export function slopePerWeek(series: readonly Point[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of sorted(series)) {
    if (point.value === null) continue;
    xs.push(dayNumber(point.date));
    ys.push(point.value);
  }
  if (xs.length < 2) return null;
  const mx = describe(xs, 0).mean;
  const my = describe(ys, 0).mean;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] as number) - mx;
    sxy += dx * ((ys[i] as number) - my);
    sxx += dx * dx;
  }
  return (sxy / sxx) * 7; // dates are distinct, so sxx > 0
}

/** Compares two periods. */
export type TrendDirection = "up" | "down" | "flat" | "unknown";

/**
 * Up or down when this − prev reaches minChange (inclusive, within float
 * rounding) and is not zero, flat otherwise, and unknown when either value is
 * missing or not finite. minChange must be a finite number ≥ 0.
 */
export function trend(current: number | null, prev: number | null, minChange: number): TrendDirection {
  if (!(minChange >= 0) || !Number.isFinite(minChange)) {
    throw new Error(`trend threshold must be a finite number ≥ 0, got ${minChange}`);
  }
  if (!finite(current) || !finite(prev)) return "unknown";
  const d = current - prev;
  const tol = REL_TOL * Math.max(1, Math.abs(current), Math.abs(prev));
  if (d > tol && d >= minChange - tol) return "up";
  if (d < -tol && d <= -minChange + tol) return "down";
  return "flat";
}

const DAY_MINUTES = 24 * 60;

/**
 * The population standard deviation, in minutes, of sleep start times given
 * as minutes after local midnight (0–1439). Times are read on a 24-hour circle
 * around their circular mean, so 23:50 and 00:10 are 20 minutes apart (sd 10),
 * not 23h40. It describes these nights, hence population sd. It is null with
 * fewer than 2 nights.
 */
export function sleepOnsetConsistency(startMinutes: readonly number[]): number | null {
  let sin = 0;
  let cos = 0;
  startMinutes.forEach((m, i) => {
    if (!(Number.isInteger(m) && m >= 0 && m < DAY_MINUTES)) {
      // The index, not the value: errors never carry health data.
      throw new Error(`sleep start #${i} is not a minute of the day (0–${DAY_MINUTES - 1})`);
    }
    const angle = (2 * Math.PI * m) / DAY_MINUTES;
    sin += Math.sin(angle);
    cos += Math.cos(angle);
  });
  if (startMinutes.length < 2) return null;
  // Times spread evenly around the clock have no mean direction; measure from
  // the first night then, which gives the same spread.
  let ref = startMinutes[0] as number;
  if (Math.hypot(sin, cos) > REL_TOL * startMinutes.length) {
    ref = ((Math.atan2(sin, cos) * DAY_MINUTES) / (2 * Math.PI) + DAY_MINUTES) % DAY_MINUTES;
  }
  const deviations = startMinutes.map((m) => {
    const d = (m - ref) % DAY_MINUTES;
    if (d >= DAY_MINUTES / 2) return d - DAY_MINUTES;
    if (d < -DAY_MINUTES / 2) return d + DAY_MINUTES;
    return d;
  });
  return describe(deviations, 0).sd;
}

/**
 * One day of a value against the target in force that day (targets are
 * versioned, so they can differ between days). Partial days, missing values
 * and days without a positive target (none in force) are skipped.
 */
export interface TargetDay {
  date: LocalDate;
  value: number | null;
  target: number | null;
  partial: boolean;
}

/**
 * Counts the eligible days (value and target present, day not partial) and
 * those that hit. `pct` is null when no day is eligible, never 0%. Every
 * eligible day is a hit, below or above: days_hit + days_below + days_above =
 * days_counted. The field names are the ones the tool outputs carry.
 */
export interface Adherence {
  pct: number | null;
  days_hit: number;
  days_counted: number;
  days_below: number;
  days_above: number;
}

/** Counts days within ±tolerance of the target (0.10 = ±10%), boundaries included. */
export function adherenceWithin(days: readonly TargetDay[], tolerance: number): Adherence {
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error(`tolerance must be in [0, 1), got ${tolerance}`);
  return adherence(days, (v, t) => {
    if (v < t - tolerance * t - REL_TOL * t) return -1;
    if (v > t + tolerance * t + REL_TOL * t) return 1;
    return 0;
  });
}

/** Counts days at or above the target. */
export function adherenceAtLeast(days: readonly TargetDay[]): Adherence {
  return adherence(days, (v, t) => (v < t - REL_TOL * t ? -1 : 0));
}

/**
 * Rejects data that would skew the percentage instead of being skipped: an
 * invalid or repeated date, a value or target that is not a finite number, or
 * a negative value. `side` places a value against its target: -1 below, 0 a
 * hit, 1 above.
 */
function adherence(days: readonly TargetDay[], side: (value: number, target: number) => number): Adherence {
  const seen = new Set<LocalDate>();
  const a: Adherence = { pct: null, days_hit: 0, days_counted: 0, days_below: 0, days_above: 0 };
  for (const day of days) {
    checkDate(day.date);
    if (seen.has(day.date)) throw new Error(`date ${day.date} appears twice`);
    seen.add(day.date);
    for (const v of [day.value, day.target]) {
      if (v !== null && !finite(v)) throw new Error(`value on ${day.date} is not a finite number`);
    }
    if (day.value !== null && day.value < 0) throw new Error(`value on ${day.date} is negative`);
    if (day.partial || day.value === null || day.target === null || day.target <= 0) continue;
    a.days_counted++;
    const placed = side(day.value, day.target);
    if (placed < 0) a.days_below++;
    else if (placed > 0) a.days_above++;
    else a.days_hit++;
  }
  if (a.days_counted > 0) a.pct = (a.days_hit / a.days_counted) * 100;
  return a;
}

/**
 * A date-ordered copy of `series`. Rejects invalid dates, a date listed twice
 * and non-finite values (NaN would poison every average silently).
 */
function sorted(series: readonly Point[]): Point[] {
  for (const point of series) {
    checkDate(point.date);
    if (point.value !== null && !finite(point.value)) {
      throw new Error(`value on ${point.date} is not a finite number`);
    }
  }
  // YYYY-MM-DD sorts as text in date order.
  const points = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 1; i < points.length; i++) {
    const date = (points[i] as Point).date;
    if (date === (points[i - 1] as Point).date) throw new Error(`date ${date} appears twice in the series`);
  }
  return points;
}

/** The number of days from the Unix epoch to `d`, which `sorted` has already validated. */
function dayNumber(d: LocalDate): number {
  return Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
}
