// The food log (Go: internal/healthdata/nutrition.go).

import type { LocalDate } from "../coach/date";
import { compareText } from "../coach/text";
import { pointId } from "../googlehealth/nutritionlog";
import type { Point } from "../metrics/stats";
import type { Context } from "./cache";
import { ZERO_TIME, clean, dataSource, decode, float, label, object, objects, root, text, time } from "./decode";
import { RESOURCE_NAME } from "./exercise";
import { PRIMARY_PLATFORM } from "./parse";
import { dayList, points, shift } from "./plan";

// Nutrient keys, in the coach's units (CAPABILITY I5).
export const NUTRIENT_KCAL = "kcal";
export const NUTRIENT_PROTEIN = "protein_g";
export const NUTRIENT_CARB = "carb_g";
export const NUTRIENT_FAT = "fat_g";
export const NUTRIENT_FIBER = "fiber_g";
export const NUTRIENT_SUGAR = "sugar_g";
export const NUTRIENT_SODIUM = "sodium_mg";

/** The nutrient keys in report order. */
export const NUTRIENTS = [
  NUTRIENT_KCAL,
  NUTRIENT_PROTEIN,
  NUTRIENT_CARB,
  NUTRIENT_FAT,
  NUTRIENT_FIBER,
  NUTRIENT_SUGAR,
  NUTRIENT_SODIUM,
] as const;

export type Nutrient = (typeof NUTRIENTS)[number];

/** One logged food. */
export interface FoodItem {
  id: string;
  name: string;
  /** BREAKFAST, LUNCH, DINNER or SNACK */
  meal: string;
  at: Date;
  /** Labels the device or platform that logged it. */
  source: string;
  /** Only what the item reports: a nutrient left out is unknown, not zero. */
  nutrients: Partial<Record<Nutrient, number>>;
  /**
   * Nutrients the item reported with an implausible value or twice; they
   * count as unknown, and the rest of the item is kept.
   */
  rejected: Nutrient[];
}

/** A day's sum of one nutrient over the items that report it. */
export interface Total {
  value: number;
  /** Items that report it; fewer than the day's items is a partial total. */
  items: number;
}

/** One local day's food log. */
export interface NutritionDay {
  /** In time order. */
  items: FoodItem[];
  totals: Partial<Record<Nutrient, Total>>;
  /** Counts nutrient values dropped from the day's items. */
  rejected: number;
  /** Today, so the log can still grow. Baselines leave it out. */
  partial: boolean;
}

/** Whether every item of the day reports the nutrient. */
export function dayComplete(day: NutritionDay | undefined, nutrient: Nutrient): boolean {
  return day !== undefined && day.items.length > 0 && day.totals[nutrient]?.items === day.items.length;
}

/** The logged days of [from, to]; a day without items is absent. */
export class Nutrition {
  days = new Map<LocalDate, NutritionDay>();
  /** Counts unreadable records; their day is unknown. */
  skipped = 0;
  otherSource = 0;
  /**
   * Counts per day the records left out for coming from another platform, so
   * a day's intake can be known to miss food.
   */
  otherSourceDays = new Map<LocalDate, number>();
  /**
   * Stored names of the entries this server created for the account that was
   * linked when this read started, keyed by data point id. Taken before the
   * list request. Empty when the source has no such table.
   */
  ownNames: ReadonlyMap<string, string> = new Map();

  constructor(
    readonly from: LocalDate,
    readonly to: LocalDate,
  ) {}

  /**
   * One point per day with the day's total of `nutrient`, null on a day
   * without a log or where an item does not report it: a partial total would
   * read as a low day (a missed protein target) in adherence and trends.
   * Tools show a day's partial totals from `days`.
   */
  series(nutrient: Nutrient): Point[] {
    return this.pointsOf(nutrient, false);
  }

  /** `series` without partial days. */
  baselineSeries(nutrient: Nutrient): Point[] {
    return this.pointsOf(nutrient, true);
  }

  private pointsOf(nutrient: Nutrient, baseline: boolean): Point[] {
    if (!NUTRIENTS.includes(nutrient)) throw new Error("healthdata: no such nutrient");
    return points(this.from, this.to, (date) => {
      const day = this.days.get(date);
      if (!day || (baseline && day.partial) || !dayComplete(day, nutrient)) return null;
      return day.totals[nutrient]?.value ?? null;
    });
  }
}

/**
 * The most one item can plausibly report: a higher value is rejected when it
 * is read. The tool that logs food takes the same bounds, so every value it
 * accepts is a value this reader keeps.
 */
export const MAX_ITEM_KCAL = 10_000;
export const MAX_ITEM_GRAMS = 2_000;
const MAX_ITEM_SODIUM = 20_000; // mg: 50 g of salt in one item

/**
 * Maps the per-item nutrient list to the coach's keys and the factor from
 * grams. Carbohydrates and fat come from the item's own total fields; the
 * list's CARBOHYDRATES entry repeats them and fat subtypes (saturated, mono,
 * poly) are part of the total, so neither is added.
 */
const FROM_LIST: Readonly<Record<string, { key: Nutrient; factor: number }>> = {
  PROTEIN: { key: NUTRIENT_PROTEIN, factor: 1 },
  DIETARY_FIBER: { key: NUTRIENT_FIBER, factor: 1 },
  SUGAR: { key: NUTRIENT_SUGAR, factor: 1 },
  SODIUM: { key: NUTRIENT_SODIUM, factor: 1000 },
};

/** A food item with its time in epoch milliseconds, before its day is known. */
interface ParsedFood extends Omit<FoodItem, "at"> {
  at: number;
}

/** What a food record reduces to. "undated": the time could not be read. "other": from another platform. */
export type FoodRead = { kind: "undated" } | { kind: "other"; at: number } | { kind: "item"; item: ParsedFood };

function readFood(record: unknown) {
  const r = root(record);
  const log = object(r, "nutritionLog");
  const energy = object(log, "energy");
  const carbohydrate = object(log, "totalCarbohydrate");
  const fat = object(log, "totalFat");
  return {
    name: text(r, "name"),
    source: dataSource(r),
    present: log !== undefined,
    foodDisplayName: text(log, "foodDisplayName"),
    mealType: text(log, "mealType"),
    at: time(object(log, "interval"), "startTime"),
    // Proto3 leaves out a zero inside a present field: kcal 0 is "0 kcal".
    kcal: energy === undefined ? undefined : (float(energy, "kcal") ?? 0),
    carb: carbohydrate === undefined ? undefined : (float(carbohydrate, "grams") ?? 0),
    fat: fat === undefined ? undefined : (float(fat, "grams") ?? 0),
    list: objects(log, "nutrients").map((entry) => ({
      nutrient: text(entry, "nutrient"),
      grams: float(object(entry, "quantity"), "grams") ?? 0,
    })),
  };
}

/**
 * Whether the record is a food entry this server created: its data point ID
 * is one of `own`. The comparison is by ID (the last part of the name): a
 * create answers `users/<user id>/…`, and a list can name the user in another
 * form.
 */
function createdHere(name: string, own: ReadonlySet<string> | undefined): boolean {
  if (own === undefined || own.size === 0) return false;
  const id = pointId(name);
  return id !== undefined && own.has(id);
}

/**
 * Reduces one food record. An implausible or repeated nutrient is rejected
 * alone: dropping the whole item would take its calories out of a day that
 * would still look complete.
 *
 * `own` holds the data point IDs of the entries this server created. Such an
 * entry is kept next to the band's own items, although its platform is the
 * API's (GOOGLE_WEB_API): the coach must count the meals it logged itself.
 * The Go server writes nothing to Google Health, so it has no such rule; a
 * record of any other platform is still left out as "other".
 */
export function parseFood(record: unknown, own?: ReadonlySet<string>): FoodRead {
  const r = decode(() => readFood(record));
  if (r === undefined || !r.present || r.at === ZERO_TIME) return { kind: "undated" };
  if (r.source.platform !== PRIMARY_PLATFORM && !createdHere(r.name, own)) return { kind: "other", at: r.at };
  const nutrients: Partial<Record<Nutrient, number>> = {};
  const rejected = new Set<Nutrient>();
  const set = (key: Nutrient, value: number, high: number) => {
    if (rejected.has(key) || key in nutrients || value < 0 || value > high) {
      delete nutrients[key];
      rejected.add(key);
      return;
    }
    nutrients[key] = value;
  };
  if (r.kcal !== undefined) set(NUTRIENT_KCAL, r.kcal, MAX_ITEM_KCAL);
  if (r.carb !== undefined) set(NUTRIENT_CARB, r.carb, MAX_ITEM_GRAMS);
  if (r.fat !== undefined) set(NUTRIENT_FAT, r.fat, MAX_ITEM_GRAMS);
  for (const entry of r.list) {
    const mapped = Object.hasOwn(FROM_LIST, entry.nutrient) ? FROM_LIST[entry.nutrient] : undefined;
    if (!mapped) continue;
    set(mapped.key, entry.grams * mapped.factor, mapped.key === NUTRIENT_SODIUM ? MAX_ITEM_SODIUM : MAX_ITEM_GRAMS);
  }
  return {
    kind: "item",
    item: {
      id: RESOURCE_NAME.test(r.name) ? r.name : "",
      name: clean(r.foodDisplayName),
      meal: clean(r.mealType),
      at: r.at,
      source: label(r.source),
      nutrients,
      rejected: NUTRIENTS.filter((key) => rejected.has(key)),
    },
  };
}

/**
 * The food log of [from, to]. The log is entered by hand and edited for days
 * after the fact, so it is never cached: the range is one list call, and
 * windows would only add requests.
 */
export async function readNutrition(ctx: Context, from: LocalDate, to: LocalDate): Promise<Nutrition> {
  dayList(from, to);
  const { today } = ctx.clock();
  const out = new Nutrition(from, to);
  // The entries this server created, with the same day of margin as the list.
  // Both the ids and the stored names are read here, before the list request:
  // a relink while that request is in flight must not swap in the new
  // account's name for a point id the two accounts share.
  let own: ReadonlySet<string> | undefined;
  try {
    const start = shift(from, -1);
    const end = shift(to, 1);
    if (ctx.cache.createdFoodNames) {
      const names = ctx.cache.createdFoodNames(start, end);
      out.ownNames = names;
      own = new Set(names.keys());
    } else {
      own = ctx.cache.createdFoodIds?.(start, end);
    }
  } catch (cause) {
    throw new Error("healthdata: read created entries", { cause });
  }
  // A day of margin: the API filters on the device's local start time.
  const reads = await ctx.api.list("nutrition-log", shift(from, -1), shift(to, 1), (record) => {
    const read = parseFood(record, own);
    if (read.kind === "undated") return read;
    const day = ctx.zone.dateOf(Math.floor(read.kind === "item" ? read.item.at : read.at));
    return day < from || day > to ? undefined : { ...read, day };
  });
  const items = new Map<LocalDate, ParsedFood[]>();
  for (const read of reads) {
    if (read.kind === "undated") {
      out.skipped++;
      continue;
    }
    if (read.kind === "other") {
      out.otherSource++;
      out.otherSourceDays.set(read.day, (out.otherSourceDays.get(read.day) ?? 0) + 1);
      continue;
    }
    let day = out.days.get(read.day);
    if (!day) {
      day = { items: [], totals: {}, rejected: 0, partial: read.day >= today };
      out.days.set(read.day, day);
      items.set(read.day, []);
    }
    items.get(read.day)?.push(read.item);
    day.rejected += read.item.rejected.length;
    for (const key of NUTRIENTS) {
      const value = read.item.nutrients[key];
      if (value === undefined) continue;
      const total = day.totals[key] ?? { value: 0, items: 0 };
      day.totals[key] = { value: total.value + value, items: total.items + 1 };
    }
  }
  for (const [date, day] of out.days) {
    // The sort is stable: items logged at the same instant keep the API's order.
    const sorted = (items.get(date) ?? []).sort((a, b) => a.at - b.at);
    day.items = sorted.map((item) => ({ ...item, at: new Date(item.at) }));
  }
  const byDay = <V>(map: Map<LocalDate, V>) => new Map([...map].sort(([a], [b]) => compareText(a, b)));
  out.days = byDay(out.days);
  out.otherSourceDays = byDay(out.otherSourceDays);
  if (out.skipped > 0) ctx.log.warn("unreadable nutrition records", { from, to, skipped: out.skipped });
  return out;
}
