// nutrition_log_add and nutrition_log_delete: the two tools that write to
// Google Health. The Go server has neither: it only reads Google Health.
//
// Like the coach-moment tools, their bodies run inside the CoachStore Durable
// Object and take turns with them, on the request budget and the token answer
// of the MCP HTTP request.
//
// Nothing of a call is logged beyond the tool call line of register.ts: no
// food name, no value, no entry id.

import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";

import { type LocalDate, type Zone, addDays, dateOf, instantOf, today } from "../coach/date";
import { INTERNAL_ERROR, ToolError } from "../coach/errors";
import { trimSpace } from "../coach/text";
import { MAX_NAME_LENGTH, type NewFoodEntry, pointId } from "../googlehealth/nutritionlog";
import { MAX_ITEM_GRAMS, MAX_ITEM_KCAL, MAX_LABEL_RUNES, clean } from "../healthdata";
import { invalid } from "../store/db";
import { type Tool, type ToolDefinition, type ToolOutcome, captureAsync, defineTool, register } from "./register";
import { inputSchema, s } from "./schema";

/** The part of the Google Health client the write tools use. */
export interface FoodLogApi {
  /** Creates one entry and returns the data point name Google gave it. Never sent again when its outcome is unknown. */
  createNutritionLog(entry: NewFoodEntry): Promise<string>;
  /** Deletes the entry with this data point ID. "gone": Google has no such entry. */
  deleteNutritionLog(id: string): Promise<"deleted" | "gone">;
}

/**
 * The entries this server created, as the store keeps them. An entry belongs
 * to the Google account that was linked when it was created, and the store
 * knows only the entries of the account that is linked now.
 */
export interface Entries {
  /** The Google account that is linked now, or undefined when none is. Never shown and never logged. */
  owner(): string | undefined;
  /**
   * Records the entry that Google just created. `owner` is the account that
   * was linked before the create was sent: when it is not the linked account
   * any more, or was none, the entry is not recorded and this throws.
   */
  record(name: string, day: LocalDate, owner: string | undefined): void;
  /** Whether this server created an entry with exactly this name for the linked account. */
  has(name: string): boolean;
  forget(name: string): void;
}

/** What the write tools need. */
export interface WriteDeps {
  /** The Google Health client of this MCP request. It holds the request budget: a tool never catches its errors. */
  api: FoodLogApi;
  entries: Entries;
  now: () => Date;
  /** Defines the local day and the local time of an entry. */
  zone: Zone;
}

type Args = Record<string, unknown>;
type Body = (deps: WriteDeps, args: Args) => Promise<Record<string, unknown>>;

interface WriteTool {
  tool: Tool;
  body: Body;
}

// The arguments of a write are the payload: a schema error must not repeat a
// food name, a value or an entry id, also not one that was sent as a key.
const writeTool = (definition: ToolDefinition, body: Body): WriteTool => ({ tool: defineTool(definition, { echo: false }), body });

// --- bounds ---

/** The meal types the tool takes: the four that nutrition_day orders its meals by. */
export const MEAL_TYPES = ["BREAKFAST", "LUNCH", "DINNER", "SNACK"] as const;

/**
 * The longest name of an entry, in characters (code points), after the spaces
 * around it are cut. It is the cap of the filter that every food name goes
 * through when it is read (`clean` in healthdata/decode.ts): nutrition_day
 * shows at most this many characters of a name, so a longer one would come
 * back cut.
 */
export const MAX_NAME_CHARS = MAX_LABEL_RUNES;

/**
 * The most one entry can hold. These are the bounds past which nutrition_day
 * rejects a value of an item, and they are far inside Google's own range
 * ([0, 100000] for kcal and for grams): a value this tool accepts is a value
 * Google documents and a value the food reads keep.
 */
export const MAX_KCAL = MAX_ITEM_KCAL;
export const MAX_MACRO_GRAMS = MAX_ITEM_GRAMS;

/** How far back an entry can be dated, in days before today. */
export const MAX_DAYS_BACK = 30;

/** `HH:MM` on a 24-hour clock. */
export const TIME_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";

/** Travels in every result of nutrition_log_add (R3). */
export const FOOD_LOG_NOTICE =
  "The calories and macros of this entry are the client's estimate, not a measurement; a macro that is null " +
  "was not logged and is unknown, not zero. Keep entry_id: nutrition_log_delete needs it to delete the entry.";

const GUARDRAIL =
  "It gives no dietary or medical advice: never diagnose, and never suggest starting, stopping or dosing a " +
  "medication or a supplement.";

// It adds a record to an external service on every call.
const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// It erases a record of an external service. A second call for the same entry changes nothing more.
const DELETES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// --- arguments ---

/** An optional text argument: absent, null and "" all mean "not set". */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** JSON writes −0 as 0: a result holds the value its JSON text carries. */
const unsigned = (value: number) => (value === 0 ? 0 : value);

/** The error of a name that holds a character the read filter drops. */
const VISIBLE_ONLY =
  "name must hold visible characters only: no control or format character (such as a zero-width space, a " +
  "zero-width joiner or a text direction mark), no line break and no replacement character";

/**
 * The name of the entry, with the spaces around it cut. The error names the
 * rule and never echoes the name.
 *
 * Only a name that the read filter keeps unchanged is accepted. The filter
 * (`clean`) drops control characters, format characters (zero-width
 * characters, text direction overrides), line and paragraph separators, the
 * replacement character and a surrogate without its pair, and it cuts a name
 * at MAX_NAME_CHARS. A name that it would change would be logged as one text
 * and shown by nutrition_day as another: a name of invisible characters would
 * come back empty, and a direction override would reach Google as it is.
 */
function nameOf(value: unknown): string {
  const name = trimSpace(str(value));
  if (name === "") throw invalid("name must not be empty");
  // A code point is at most two UTF-16 units: a text this long needs no count.
  if (name.length > 2 * MAX_NAME_CHARS || [...name].length > MAX_NAME_CHARS) throw invalid(`name must be at most ${MAX_NAME_CHARS} characters`);
  if (clean(name) !== name) throw invalid(VISIBLE_ONLY);
  return name;
}

/** An amount in [0, max]; undefined when it was not sent. The error names the field and the bound, never the value. */
function amount(field: string, value: unknown, max: number): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) throw invalid(`${field} must be a number`);
  if (value < 0) throw invalid(`${field} must not be negative`);
  if (value > max) throw invalid(`${field} must be at most ${max}`);
  return unsigned(value);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** When the food was eaten, from the optional `date` and `time`. */
function when(deps: WriteDeps, dateArg: unknown, timeArg: unknown): { at: Date; day: LocalDate; time: string; utcOffsetSeconds: number } {
  const now = deps.now();
  const todayIs = today(now, deps.zone);
  const date = str(dateArg);
  const time = str(timeArg);
  const asked = date === "" ? todayIs : date;
  if (asked > todayIs) throw new ToolError("invalid_input", "date is after today", "omit date for today");
  const earliest = addDays(todayIs, -MAX_DAYS_BACK);
  if (earliest === undefined || asked < earliest) {
    throw new ToolError("invalid_input", `date is more than ${MAX_DAYS_BACK} days before today`, `log food of the last ${MAX_DAYS_BACK} days only`);
  }
  let at: Date;
  if (time === "") {
    if (asked !== todayIs) {
      throw new ToolError("invalid_input", "time is required with a date before today", "give the local time of the meal as HH:MM");
    }
    // Whole seconds are sent.
    at = new Date(Math.floor(now.getTime() / 1000) * 1000);
  } else {
    const [hour = Number.NaN, minute = Number.NaN] = time.split(":").map(Number);
    // On the day of a DST change, a time the clocks skip is the first instant
    // after the gap, and a time that happens twice is its first instant.
    const instant = instantOf(asked, hour, minute, deps.zone);
    if (instant === undefined) throw invalid("time must be HH:MM on a 24-hour clock");
    if (instant.getTime() > now.getTime()) {
      throw new ToolError("invalid_input", "time is after now", "omit time to log the entry at the present time");
    }
    at = instant;
  }
  const offsetMs = deps.zone.offsetMs(at.getTime());
  const wall = new Date(at.getTime() + offsetMs);
  return {
    at,
    day: dateOf(at, deps.zone),
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`,
    utcOffsetSeconds: Math.trunc(offsetMs / 1000),
  };
}

// --- nutrition_log_add ---

/** The error of an entry that Google holds and the store could not record. */
const NOT_RECORDED =
  "the entry was created in Google Health, but this server could not record it, so it cannot delete the entry";

const NUTRITION_LOG_ADD = writeTool(
  {
    name: "nutrition_log_add",
    description:
      "Logs one meal or food item in the user's Google Health food log, with the calories and macros that you " +
      "estimated, for example from a photo or a description. It writes one new entry to Google Health and returns " +
      "its entry_id; keep the id, because nutrition_log_delete needs it. The values are your estimates, not " +
      "measurements: say so to the user, and log only after the user confirms the food and the values. Bounds: " +
      `name 1 to ${MAX_NAME_CHARS} visible characters (no control or format character, no line break), the name ` +
      `nutrition_day then shows unchanged; kcal 0 to ${MAX_KCAL}; protein_g, carbs_g ` +
      `and fat_g 0 to ${MAX_MACRO_GRAMS} each, and a macro you leave out is logged as unknown, not as 0. date is ` +
      `today when omitted and at most ${MAX_DAYS_BACK} days before today; time is HH:MM in the coach's time zone, is ` +
      "now when omitted, is required with a date before today and is never after now. Every call adds a new entry, " +
      "so never repeat a call for the same food. After an upstream_unavailable error whose hint says that the " +
      `entry may exist, check the day with nutrition_day before a new try. ${GUARDRAIL}`,
    annotations: ADDS,
    inputSchema: inputSchema(
      s.object({
        name: s.string(
          `Name of the food or the meal, 1 to ${MAX_NAME_CHARS} visible characters: no control or format character ` +
            "(zero-width characters, text direction marks) and no line break",
        ),
        meal_type: s.string("The meal the food belongs to"),
        kcal: s.number(`Estimated energy in kcal, 0 to ${MAX_KCAL}`),
        "protein_g?": s.number(`Estimated protein in grams, 0 to ${MAX_MACRO_GRAMS}; omit when unknown`),
        "carbs_g?": s.number(`Estimated carbohydrate in grams, 0 to ${MAX_MACRO_GRAMS}; omit when unknown`),
        "fat_g?": s.number(`Estimated fat in grams, 0 to ${MAX_MACRO_GRAMS}; omit when unknown`),
        "date?": s.date(`Local day of the meal, YYYY-MM-DD; omit for today; at most ${MAX_DAYS_BACK} days before today`),
        "time?": {
          type: "string",
          description: "Local time of the meal, HH:MM on a 24-hour clock; omit for now; required with a date before today",
          pattern: TIME_PATTERN,
        },
      }),
      { meal_type: MEAL_TYPES },
    ),
    outputSchema: s.object({
      entry_id: s.string("The id of the new entry; pass it to nutrition_log_delete to delete the entry"),
      date: s.date(),
      time: s.string("Local time of the entry, HH:MM"),
      meal_type: s.string(),
      kcal: s.number(),
      protein_g: s.nullable(s.number()),
      carbs_g: s.nullable(s.number()),
      fat_g: s.nullable(s.number()),
      notice: s.string(),
    }),
  },
  async (deps, args) => {
    // Everything is checked before anything is sent.
    const name = nameOf(args.name);
    const mealType = str(args.meal_type);
    const kcal = amount("kcal", args.kcal, MAX_KCAL);
    if (kcal === undefined) throw invalid("kcal must be a number");
    const protein = amount("protein_g", args.protein_g, MAX_MACRO_GRAMS);
    const carbs = amount("carbs_g", args.carbs_g, MAX_MACRO_GRAMS);
    const fat = amount("fat_g", args.fat_g, MAX_MACRO_GRAMS);
    const { at, day, time, utcOffsetSeconds } = when(deps, args.date, args.time);

    const entry: NewFoodEntry = { name, mealType, at, utcOffsetSeconds, kcal };
    if (protein !== undefined) entry.proteinGrams = protein;
    if (carbs !== undefined) entry.carbGrams = carbs;
    if (fat !== undefined) entry.fatGrams = fat;
    // The entry will belong to the account that is linked now. Without a link
    // the create answers auth_expired, and nothing is sent.
    const owner = deps.entries.owner();
    const entryId = await deps.api.createNutritionLog(entry);

    // Google holds the entry from here on. Without its row the server does
    // not own it: say so, instead of an error that reads as "nothing happened".
    try {
      deps.entries.record(entryId, day, owner);
    } catch (cause) {
      throw new ToolError("internal_error", NOT_RECORDED, "do not log the same food again", { cause });
    }
    return {
      entry_id: entryId,
      date: day,
      time,
      meal_type: mealType,
      kcal,
      protein_g: protein ?? null,
      carbs_g: carbs ?? null,
      fat_g: fat ?? null,
      notice: FOOD_LOG_NOTICE,
    };
  },
);

// --- nutrition_log_delete ---

const NUTRITION_LOG_DELETE = writeTool(
  {
    name: "nutrition_log_delete",
    description:
      "Deletes one entry of the user's Google Health food log, by the entry_id that nutrition_log_add returned. It " +
      "deletes only an entry that this server created: any other id answers no_data, and nothing is sent to Google " +
      "Health for it. A delete cannot be undone, so confirm it with the user first. " +
      GUARDRAIL,
    annotations: DELETES,
    inputSchema: inputSchema(
      s.object({
        entry_id: {
          type: "string",
          description: "The entry_id that nutrition_log_add returned (users/…/dataTypes/nutrition-log/dataPoints/…)",
          maxLength: MAX_NAME_LENGTH,
        },
      }),
    ),
    outputSchema: s.object({ entry_id: s.string(), deleted: s.boolean() }),
  },
  async (deps, args) => {
    const entryId = str(args.entry_id);
    const id = pointId(entryId);
    if (id === undefined) {
      throw new ToolError("invalid_input", "entry_id is not the id of a food log entry", "use the entry_id that nutrition_log_add returned");
    }
    // Only an entry of this server is deleted, and the check comes before any
    // request: Google's documentation does not prove that it would refuse the
    // delete of an entry another app wrote. An entry that was created for
    // another Google account than the linked one is not this server's own
    // now: the delete would go out with the wrong account's token.
    if (!deps.entries.has(entryId)) {
      throw new ToolError(
        "no_data",
        "this server created no entry with that id",
        "it deletes only an entry that nutrition_log_add created and that was not deleted yet",
      );
    }
    // "gone" is the state the delete asks for: the row goes in both cases.
    await deps.api.deleteNutritionLog(id);
    try {
      deps.entries.forget(entryId);
    } catch (cause) {
      throw new ToolError("internal_error", "the entry was deleted in Google Health, but this server could not update its record", "no other step is needed", {
        cause,
      });
    }
    return { entry_id: entryId, deleted: true };
  },
);

// --- registration ---

const WRITES: readonly WriteTool[] = [NUTRITION_LOG_ADD, NUTRITION_LOG_DELETE];

/** The tools that write to Google Health, in the order they are listed. */
export const WRITE_TOOLS: readonly Tool[] = WRITES.map((one) => one.tool);

const byName = new Map(WRITES.map((one) => [one.tool.name, one]));

/**
 * Runs the body of a write tool. Errors come back in the outcome and are
 * never thrown: a ToolError of the body or of the Google Health client as it
 * is, anything else as internal_error.
 */
export async function runWriteTool(deps: WriteDeps, name: string, args: Args): Promise<ToolOutcome> {
  const one = byName.get(name);
  if (!one) return { ok: false, error: INTERNAL_ERROR };
  return captureAsync(one.tool, () => one.body(deps, args));
}

/** Adds the write tools. `run` executes a tool body and returns its outcome. */
export function registerWrites(server: McpServer, run: (name: string, args: Args) => Promise<ToolOutcome>): void {
  for (const tool of WRITE_TOOLS) register(server, tool, (args) => run(tool.name, args));
}
