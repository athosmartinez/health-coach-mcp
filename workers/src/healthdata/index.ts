// Turns Google Health records into the coach's daily values, through the
// daily_metrics cache (Go: internal/healthdata). It decides what is cached;
// the API client fetches and the metrics package does the math.

import type { LocalDate, Zone } from "../coach/date";
import { type Activity, type ActivityOptions, readActivity } from "./activity";
import { type Body, type BodyOptions, readBody } from "./body";
import { type Cache, Context, type Fetcher, type Logger } from "./cache";
import { type Exercises, readExercises } from "./exercise";
import { type Nutrition, readNutrition } from "./nutrition";
import { type Recovery, type RecoveryOptions, readRecovery } from "./recovery";

export {
  ACTIVITY_KEYS,
  ACTIVITY_VALUES,
  Activity,
  type ActivityDay,
  type ActivityKey,
  type ActivityOptions,
  type ActivityValue,
  KEY_AZM,
  KEY_STEPS,
  KEY_TOTAL_CALORIES,
  ROLLUP_SOURCE,
} from "./activity";
export {
  BODY_KEYS,
  BODY_VALUES,
  Body,
  type BodyKey,
  type BodyOptions,
  type BodyValue,
  KEY_BODY_FAT,
  KEY_WEIGHT,
  type Reading,
  last,
} from "./body";
export { type Cache, type Fetcher, type Logger, dbCache } from "./cache";
export {
  type Exercise,
  type ExerciseHR,
  Exercises,
  MAX_HR_SESSIONS,
  MAX_HR_WINDOW,
  type ZoneMinutes,
} from "./exercise";
export {
  type FoodItem,
  NUTRIENTS,
  NUTRIENT_CARB,
  NUTRIENT_FAT,
  NUTRIENT_FIBER,
  NUTRIENT_KCAL,
  NUTRIENT_PROTEIN,
  NUTRIENT_SODIUM,
  NUTRIENT_SUGAR,
  type Nutrient,
  Nutrition,
  type NutritionDay,
  type Total,
  dayComplete,
} from "./nutrition";
export { PRIMARY_PLATFORM, type Stages } from "./parse";
export { KCAL_WINDOW_DAYS, MAX_RANGE_DAYS, NIGHT_WINDOW_DAYS, ROLLUP_WINDOW_DAYS, SETTLE_DAYS, WORN_WINDOW_DAYS } from "./plan";
export {
  type Excluded,
  type HRVNight,
  KEY_ASLEEP,
  KEY_AWAKE,
  KEY_DEEP,
  KEY_HRV,
  KEY_IN_BED,
  KEY_LIGHT,
  KEY_REM,
  KEY_RESTING_HR,
  KEY_SLEEP_END,
  KEY_SLEEP_START,
  type Night,
  RECOVERY_KEYS,
  RECOVERY_VALUES,
  Recovery,
  type RecoveryKey,
  type RecoveryOptions,
  type RecoveryValue,
  type RestingHR,
  SLEEP_KEYS,
  hrvWithheld,
  restingStandard,
} from "./recovery";

/**
 * What the coach tools read. Every method takes the inclusive local days
 * [from, to], at most MAX_RANGE_DAYS of them, and throws the API client's
 * errors as they are (auth_expired, scope_missing, upstream_unavailable, and
 * the invalid_input of a range that holds more data than the request budget
 * of one MCP request reads).
 */
export interface Source {
  recovery(from: LocalDate, to: LocalDate, options?: RecoveryOptions): Promise<Recovery>;
  activity(from: LocalDate, to: LocalDate, options?: ActivityOptions): Promise<Activity>;
  body(from: LocalDate, to: LocalDate, options?: BodyOptions): Promise<Body>;
  /** `maxHR` is this source's narrow option: false reads no heart-rate samples. */
  exercises(from: LocalDate, to: LocalDate, maxHR: boolean): Promise<Exercises>;
  nutrition(from: LocalDate, to: LocalDate): Promise<Nutrition>;
}

/**
 * Implements Source over the API client and the cache. One instance serves
 * the calls of one MCP request, one after the other: it holds the client,
 * and the client holds the request budget.
 */
export class HealthData implements Source {
  private readonly ctx: Context;

  /** `now` is the clock that decides which days are settled. */
  constructor(api: Fetcher, cache: Cache, zone: Zone, now: () => Date, log?: Logger) {
    this.ctx = new Context(api, cache, zone, now, log);
  }

  recovery(from: LocalDate, to: LocalDate, options?: RecoveryOptions): Promise<Recovery> {
    return readRecovery(this.ctx, from, to, options);
  }

  activity(from: LocalDate, to: LocalDate, options?: ActivityOptions): Promise<Activity> {
    return readActivity(this.ctx, from, to, options);
  }

  body(from: LocalDate, to: LocalDate, options?: BodyOptions): Promise<Body> {
    return readBody(this.ctx, from, to, options);
  }

  exercises(from: LocalDate, to: LocalDate, maxHR: boolean): Promise<Exercises> {
    return readExercises(this.ctx, from, to, maxHR);
  }

  nutrition(from: LocalDate, to: LocalDate): Promise<Nutrition> {
    return readNutrition(this.ctx, from, to);
  }
}
