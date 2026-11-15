// metric_series (Go: internal/tools/series.go, CAPABILITY §4.1).
//
// The Go server reads the whole source of a metric (every recovery value,
// every daily total). A year of that is more Google requests than one MCP
// request may make, so each metric here reads only what its points need: see
// `daily`.

import type { LocalDate } from "../coach/date";
import { ToolError } from "../coach/errors";
import {
  type ActivityKey,
  KEY_ASLEEP,
  KEY_AZM,
  KEY_HRV,
  KEY_RESTING_HR,
  KEY_STEPS,
  KEY_TOTAL_CALORIES,
  KEY_WEIGHT,
  MAX_RANGE_DAYS,
  type Nutrition,
  type RecoveryKey,
} from "../healthdata";
import { FLAG_PARTIAL_DAY } from "../metrics/quality";
import type { Point } from "../metrics/stats";
import type { Target } from "../store/memory";
import {
  type CoachDeps,
  FLAG_NOT_WORN,
  FLAG_PROVISIONAL_SLEEP,
  FLAG_UNREADABLE_RECORDS,
  FlagSet,
  READ_ONLY,
  SourceSet,
  coachTool,
  dayOf,
  daysBetween,
  envelope,
  envelopeSchema,
  isoWeekStart,
  plusDays,
  round,
  str,
  targetOn,
  todayOf,
} from "./coach";
import {
  FLAG_OTHER_SOURCE_FOOD,
  FLAG_PARTIAL_NUTRIENT_TOTALS,
  REASON_NOT_WORN,
  REASON_OTHER_SOURCE,
  REASON_PARTIAL_DAY,
  REASON_UNREADABLE_FOOD,
  burnOf,
  checkFood,
  firstOf,
  kcalGap,
} from "./nutrition";
import { inputSchema, s } from "./schema";

/** Caps one series response. */
export const MAX_SERIES_POINTS = 180;

/** The metrics, in the order of the input schema's enum, each with its unit. */
export const SERIES_UNITS = {
  weight: "kg",
  resting_hr: "bpm",
  hrv: "ms",
  sleep_asleep_min: "min",
  steps: "steps",
  azm: "min",
  kcal_in: "kcal",
  protein_g: "g",
  total_calories: "kcal",
} as const;

export type SeriesMetric = keyof typeof SERIES_UNITS;

export const SERIES_METRICS = Object.keys(SERIES_UNITS) as SeriesMetric[];

const GRANULARITIES = ["day", "week"] as const;

/** Some items do not report protein, so the total is a lower bound. */
export const REASON_MISSING_PROTEIN = "items_missing_protein";

/** Travels in every series (R3). */
export const SERIES_NOTICE =
  "Values compare the user with their own history; a series is not a diagnosis. A week point is " +
  "the mean of the days with a value (n_days). Weight swings from day to day with water and food: read the trend " +
  "over weeks, not single days. Do not encourage losing weight faster than about 1% of body weight per week or " +
  "eating far below the targets. If weight falls fast without trying, intake stays very low, or resting heart rate " +
  "stays up for days, suggest seeing a doctor (a registered dietitian for eating).";

/** One day, or one week from its Monday. */
interface SeriesPoint {
  date: LocalDate;
  value: number | null;
  /** The days behind the value. */
  n_days: number;
  /** False when the value rests on a protein total that may miss food, so it is a lower bound. */
  complete: boolean;
  /** Why a day's value is null or a lower bound. */
  reason?: string;
  /** The days of a week point withheld for a reason. */
  days_left_out?: number;
}

const SERIES = s.object({
  metric: s.string(),
  unit: s.string(),
  granularity: s.string(),
  from: s.date(),
  to: s.date(),
  points: s.list(
    s.object({
      date: s.date(),
      value: s.nullable(s.number()),
      n_days: s.integer(),
      complete: s.boolean(),
      "reason?": s.string(),
      "days_left_out?": s.integer(),
    }),
  ),
  notice: s.string(),
});

const invalid = (message: string, hint?: string) => new ToolError("invalid_input", message, hint);

async function metricSeries(deps: CoachDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const metric = str(args.metric);
  if (!isMetric(metric)) throw invalid("unknown metric", "pick one of the listed metrics");
  const from = str(args.from);
  if (from === "" || str(args.to) === "") throw invalid("from and to are required");
  const to = dayOf(deps, args.to);
  if (from > to) throw invalid("from is after to");
  const days = daysBetween(from, to);
  if (days > MAX_RANGE_DAYS) throw invalid(`a range spans at most ${MAX_RANGE_DAYS} days`, "split it in two calls");
  const granularity = str(args.granularity) || "day";
  const n = granularity === "week" ? weeksBetween(from, to) : days;
  if (n > MAX_SERIES_POINTS) {
    throw invalid(`the series would have ${n} points, more than ${MAX_SERIES_POINTS}`, "use granularity week or a shorter range");
  }

  const flags = new FlagSet();
  const sources = new SourceSet();
  const series = await daily(deps, metric, from, to, flags, sources);
  const points =
    granularity === "week"
      ? byWeek(series)
      : series.points.map((point): SeriesPoint => {
          const reason = series.reason.get(point.date);
          return {
            date: point.date,
            value: round(point.value),
            n_days: point.value === null ? 0 : 1,
            complete: !series.lower.has(point.date),
            ...(reason === undefined ? {} : { reason }),
          };
        });
  const covered = series.points.filter((point) => point.value !== null).length;
  const data = { metric, unit: SERIES_UNITS[metric], granularity, from, to, points, notice: SERIES_NOTICE };
  return envelope(deps, data, covered, sources, flags);
}

function isMetric(metric: string): metric is SeriesMetric {
  return Object.hasOwn(SERIES_UNITS, metric);
}

/** Counts the ISO weeks [from, to] touches. */
function weeksBetween(from: LocalDate, to: LocalDate): number {
  const span = daysBetween(isoWeekStart(from), isoWeekStart(to));
  return Math.trunc((span - 1) / 7) + 1;
}

/**
 * One point per day of a range, the days whose value is a lower bound, and
 * why a day's value is null or a lower bound.
 */
interface DailySeries {
  points: Point[];
  lower: Set<LocalDate>;
  reason: Map<LocalDate, string>;
}

const plain = (points: Point[]): DailySeries => ({ points, lower: new Set(), reason: new Map() });

const RECOVERY_KEYS: Record<"resting_hr" | "hrv" | "sleep_asleep_min", RecoveryKey> = {
  resting_hr: KEY_RESTING_HR,
  hrv: KEY_HRV,
  sleep_asleep_min: KEY_ASLEEP,
};

const ACTIVITY_KEYS: Record<"steps" | "azm" | "total_calories", ActivityKey> = {
  steps: KEY_STEPS,
  azm: KEY_AZM,
  total_calories: KEY_TOTAL_CALORIES,
};

/**
 * Reads one point per day of [from, to], with the fewest Google requests the
 * metric allows:
 *   - weight: the weight list (not body fat);
 *   - resting_hr: the resting heart rate list (not sleep or HRV);
 *   - hrv, sleep_asleep_min: the nights (sleep and HRV; a night is cached as a whole);
 *   - steps: the steps rollup;
 *   - azm: the zone-minutes rollup, and the band's steps for the days without a row;
 *   - total_calories: the total-calories rollup, and what tells that the band was worn;
 *   - kcal_in, protein_g: the food log (see `food`).
 */
async function daily(deps: CoachDeps, metric: SeriesMetric, from: LocalDate, to: LocalDate, flags: FlagSet, sources: SourceSet): Promise<DailySeries> {
  switch (metric) {
    case "weight": {
      const body = await deps.health.body(from, to, { values: ["weight"] });
      for (const reading of body.weight.values()) sources.add(reading.source);
      flags.add(FLAG_UNREADABLE_RECORDS, body.skipped > 0);
      return plain(body.series(KEY_WEIGHT));
    }
    case "resting_hr":
    case "hrv":
    case "sleep_asleep_min": {
      const rec = await deps.health.recovery(from, to, { values: [metric === "resting_hr" ? "resting_hr" : "nights"] });
      sources.add(...rec.sources);
      // Resting heart rate does not depend on the night's processing.
      if (metric !== "resting_hr") for (const night of rec.nights.values()) flags.add(FLAG_PROVISIONAL_SLEEP, night.provisional);
      flags.add(FLAG_UNREADABLE_RECORDS, rec.skipped > 0);
      return plain(rec.baselineSeries(RECOVERY_KEYS[metric]));
    }
    case "steps":
    case "azm":
    case "total_calories": {
      const act = await deps.health.activity(from, to, { values: metric === "total_calories" ? ["total_calories", "worn"] : [metric] });
      const today = todayOf(deps);
      flags.add(FLAG_PARTIAL_DAY, to >= today);
      flags.add(FLAG_UNREADABLE_RECORDS, act.skipped > 0);
      const series = plain(act.baselineSeries(ACTIVITY_KEYS[metric]));
      for (const point of series.points) {
        const day = act.days.get(point.date);
        if (point.value === null && point.date >= today) {
          series.reason.set(point.date, REASON_PARTIAL_DAY);
        } else if (metric === "total_calories" && point.value !== null && day && !day.worn) {
          // Without the band the day's total is mostly a resting estimate.
          point.value = null;
          series.reason.set(point.date, REASON_NOT_WORN);
          flags.add(FLAG_NOT_WORN, true);
        }
      }
      return series;
    }
    default: {
      // kcal_in, protein_g
      const logged = await deps.health.nutrition(from, to);
      flags.add(FLAG_PARTIAL_DAY, to >= todayOf(deps));
      flags.add(FLAG_OTHER_SOURCE_FOOD, logged.otherSource > 0);
      flags.add(FLAG_UNREADABLE_RECORDS, logged.skipped > 0);
      return food(deps, metric, logged, from, to, flags, sources);
    }
  }
}

/**
 * Judges each logged day with nutrition_day's rule (checkFood). The calories
 * burned are read only for the logged days without a kcal target, since only
 * their log check needs them (burnOf).
 */
async function food(
  deps: CoachDeps,
  metric: "kcal_in" | "protein_g",
  logged: Nutrition,
  from: LocalDate,
  to: LocalDate,
  flags: FlagSet,
  sources: SourceSet,
): Promise<DailySeries> {
  const targets = new Map<LocalDate, Target | undefined>();
  const unreferenced: LocalDate[] = [];
  for (const [day, entry] of logged.days) {
    if (day < from || day > to || entry.items.length === 0) continue;
    const target = targetOn(deps, day);
    targets.set(day, target);
    if (target?.kcal === undefined) unreferenced.push(day);
    for (const item of entry.items) sources.add(item.source);
  }
  const burn = await burnOf(deps, unreferenced);
  const today = todayOf(deps);
  const series = plain([]);
  for (let day = from; day <= to; day = plusDays(day, 1)) {
    const point: Point = { date: day, value: null };
    series.points.push(point);
    const entry = logged.days.get(day);
    if (!entry || entry.items.length === 0) continue;
    const other = logged.otherSourceDays.get(day) ?? 0;
    const fc = checkFood(entry.items, other, logged.skipped, targets.get(day), burn.kcal.get(day) ?? null, entry.partial || day >= today);
    if (metric === "kcal_in") {
      const gap = kcalGap(fc);
      if (gap === "") point.value = fc.kcal;
      else series.reason.set(day, gap);
    } else if (fc.dayGap === REASON_PARTIAL_DAY) {
      series.reason.set(day, REASON_PARTIAL_DAY);
    } else if (fc.protein !== null) {
      point.value = fc.protein;
      const reason = firstOf(
        fc.proteinComplete ? "" : REASON_MISSING_PROTEIN,
        other > 0 ? REASON_OTHER_SOURCE : "",
        logged.skipped > 0 ? REASON_UNREADABLE_FOOD : "",
        fc.dayGap,
      );
      if (reason !== "") {
        series.lower.add(day);
        series.reason.set(day, reason);
      }
      flags.add(FLAG_PARTIAL_NUTRIENT_TOTALS, !fc.proteinComplete);
    }
  }
  return series;
}

/** Averages the days of each ISO week. */
function byWeek(series: DailySeries): SeriesPoint[] {
  const weeks: { point: SeriesPoint; sum: number; leftOut: number }[] = [];
  for (const point of series.points) {
    const start = isoWeekStart(point.date);
    let week = weeks.at(-1);
    if (!week || week.point.date !== start) {
      week = { point: { date: start, value: null, n_days: 0, complete: true }, sum: 0, leftOut: 0 };
      weeks.push(week);
    }
    if (point.value !== null) {
      week.sum += point.value;
      week.point.n_days++;
      week.point.complete &&= !series.lower.has(point.date);
    } else if (series.reason.has(point.date)) {
      week.leftOut++;
    }
  }
  return weeks.map(({ point, sum, leftOut }) => ({
    ...point,
    value: point.n_days > 0 ? round(sum / point.n_days) : null,
    ...(leftOut > 0 ? { days_left_out: leftOut } : {}),
  }));
}

export const METRIC_SERIES = coachTool(
  {
    name: "metric_series",
    description:
      "Daily or weekly values of one metric over [from, to] (at most 366 days, at most 180 points), " +
      "for questions the coach-moment tools do not answer. A day without a value is null, never 0. Today is left " +
      "out of steps, AZM, total calories and food while its totals still grow, nights Google is still processing " +
      "are left out of HRV and sleep, and resting heart rate keeps the band's standard method only. Days follow " +
      "nutrition_day's rule: kcal_in is null on a day whose log cannot show the intake (an item lacks kcal, food " +
      "from another platform or unreadable, the log looks incomplete) and total_calories is null on a day without " +
      "the band; the point's reason says why. protein_g keeps a total that may miss food with complete=false (a " +
      "lower bound) and the reason. Weeks are ISO weeks (Monday first); a week point is the mean of its days " +
      "with a value, and days_left_out counts the days withheld for a reason. Never raw heart-rate samples.",
    annotations: READ_ONLY,
    inputSchema: inputSchema(
      s.object({
        metric: s.string("the metric"),
        from: s.date("first local day (YYYY-MM-DD)"),
        to: s.date("last local day (YYYY-MM-DD), today at the latest"),
        "granularity?": s.string("day (default) or week"),
      }),
      { metric: SERIES_METRICS, granularity: GRANULARITIES },
    ),
    outputSchema: envelopeSchema(SERIES),
  },
  metricSeries,
);
