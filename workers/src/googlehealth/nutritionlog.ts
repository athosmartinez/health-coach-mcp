// The two writes of the Google Health API v4 that the coach sends for the
// nutrition-log data type: create one data point, and delete data points by
// name. This file holds their shapes only: the paths, the request bodies and
// the reading of the Operation each one answers. The client sends them. The
// writes of the exercise data type (exerciselog.ts) read their answers with
// the readers of this file.
//
// The shapes come from Google's documentation, not from a real call:
//   - https://developers.google.com/health/data-types/nutrition (the examples)
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/batchDelete
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
//     (DataPoint, NutritionLog, SessionTimeInterval)

/** The data type both writes of this file are for. */
export const WRITE_DATA_TYPE = "nutrition-log";

/** `POST` here creates one data point. Relative to the API base URL. */
export const CREATE_PATH = `/users/me/dataTypes/${WRITE_DATA_TYPE}/dataPoints`;

/** `POST` here deletes the data points named in the body. */
export const DELETE_PATH = `${CREATE_PATH}:batchDelete`;

/** A write answer is one Operation with at most one data point: far below this. */
export const MAX_WRITE_RESPONSE_BYTES = 64 << 10;

/** Google documents [0, 100000] for an energy in kcal and for a weight in grams. */
export const GOOGLE_MAX_QUANTITY = 100_000;

/** The pattern of a data point ID, for every data type the coach writes. */
export const POINT_ID = "[A-Za-z0-9_.-]{1,128}";
const POINT_ID_ONLY = new RegExp(`^${POINT_ID}$`);

/**
 * The name of a nutrition-log data point, as a create answers it
 * (`users/<user>/dataTypes/nutrition-log/dataPoints/<id>`). The user part is
 * an ID that Google chose, or `me`.
 */
export const NUTRITION_LOG_NAME = new RegExp(`^users/[A-Za-z0-9_-]+/dataTypes/${WRITE_DATA_TYPE}/dataPoints/(${POINT_ID})$`);

/** The longest name NUTRITION_LOG_NAME is checked against. */
export const MAX_NAME_LENGTH = 256;

/**
 * The data point ID of a nutrition-log data point name (its last path part),
 * or undefined when the text is not such a name. A create answers the user's
 * own ID in the name and a list may answer another form of the user, so two
 * names are the same point when their IDs are equal.
 */
export function pointId(name: string): string | undefined {
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH) return undefined;
  return NUTRITION_LOG_NAME.exec(name)?.[1];
}

/** One food entry to create. */
export interface NewFoodEntry {
  /** Shown as the name of the food. */
  name: string;
  /** BREAKFAST, LUNCH, DINNER or SNACK. */
  mealType: string;
  /** When the food was eaten. Whole seconds are sent. */
  at: Date;
  /** The local offset from UTC at that instant, in seconds. */
  utcOffsetSeconds: number;
  kcal: number;
  /** A macro left undefined is not sent: it is unknown, not zero. */
  proteinGrams?: number;
  carbGrams?: number;
  fatGrams?: number;
}

/** The `nutritionLog` of a create request. The keys are in the order they are sent. */
export interface NutritionLogBody {
  interval: { startTime: string; startUtcOffset: string; endTime: string; endUtcOffset: string };
  foodDisplayName: string;
  mealType: string;
  energy: { kcal: number };
  totalCarbohydrate?: { grams: number };
  totalFat?: { grams: number };
  nutrients?: { nutrient: "PROTEIN"; quantity: { grams: number } }[];
}

/** JSON writes −0 as 0: the body holds the value its text carries. */
const unsigned = (value: number) => (value === 0 ? 0 : value);

function quantity(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > GOOGLE_MAX_QUANTITY) throw new Error(`googlehealth: ${name} is outside the range of the API`);
  return unsigned(value);
}

/**
 * The body of the create request (`{"nutritionLog": …}`).
 *
 * The interval is one second. Google treats a start that equals the end as an
 * empty interval and rejects the write. The guides write a positive window (a
 * meal is 30 minutes, water is 1 second); this sends that shorter window, one
 * second after the start, with the same UTC offset. The entry still belongs
 * to the local day of the start: the food reads take the day from startTime,
 * so an entry at 23:59:59 stays on that day.
 *
 * The reference marks both UTC offsets as required, so both are sent, with
 * the same value. Without them Google reads the local time of the entry as
 * UTC, and an evening meal lands on the next civil day.
 *
 * Throws for a value outside what the API documents: a caller bug, since the
 * tool checks its input against narrower bounds first.
 */
export function createBody(entry: NewFoodEntry): { nutritionLog: NutritionLogBody } {
  const ms = entry.at.getTime();
  if (!Number.isFinite(ms)) throw new Error("googlehealth: the entry has no valid time");
  if (!Number.isInteger(entry.utcOffsetSeconds) || Math.abs(entry.utcOffsetSeconds) > 18 * 3600) {
    throw new Error("googlehealth: the entry has no valid UTC offset");
  }
  if (entry.name === "") throw new Error("googlehealth: the entry has no name");
  // Whole seconds. The end is the next second, with the same UTC offset
  // rather than the offset of the end instant.
  const startMs = Math.floor(ms / 1000) * 1000;
  const stamp = (instant: number) => `${new Date(instant).toISOString().slice(0, 19)}Z`;
  const offset = `${unsigned(entry.utcOffsetSeconds)}s`;
  const log: NutritionLogBody = {
    interval: { startTime: stamp(startMs), startUtcOffset: offset, endTime: stamp(startMs + 1000), endUtcOffset: offset },
    foodDisplayName: entry.name,
    mealType: entry.mealType,
    energy: { kcal: quantity("kcal", entry.kcal) },
  };
  if (entry.carbGrams !== undefined) log.totalCarbohydrate = { grams: quantity("carbohydrate", entry.carbGrams) };
  if (entry.fatGrams !== undefined) log.totalFat = { grams: quantity("fat", entry.fatGrams) };
  if (entry.proteinGrams !== undefined) log.nutrients = [{ nutrient: "PROTEIN", quantity: { grams: quantity("protein", entry.proteinGrams) } }];
  return { nutritionLog: log };
}

/**
 * The body of the delete request for one data point ID. The name is written
 * with `users/me`, the form of the documented example and of the request path:
 * the reference says that every name must share the parent of the path.
 * Throws for a text that is not a data point ID (a caller bug).
 */
export function deleteBody(id: string): { names: string[] } {
  if (typeof id !== "string" || !POINT_ID_ONLY.test(id)) throw new Error("googlehealth: not a data point ID");
  return { names: [`users/me/dataTypes/${WRITE_DATA_TYPE}/dataPoints/${id}`] };
}

/**
 * Why the answer of a write cannot be used:
 * - unreadable: not a JSON object;
 * - not_done: the Operation is not finished, and the API has no method to ask again;
 * - operation_error: the Operation carries an error;
 * - no_name: a finished create without the name of a data point of its data type.
 */
export type AnswerFault = "unreadable" | "not_done" | "operation_error" | "no_name";

interface Operation {
  done: boolean;
  failed: boolean;
  /** google.rpc.Code of the error, when it is a whole number in the enum's range. */
  code: number | undefined;
  response: Record<string, unknown> | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the fields of an Operation. Nothing of the text is kept beyond them. */
function operation(text: string): Operation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const failed = Object.hasOwn(parsed, "error") && parsed.error !== null;
  const raw = isObject(parsed.error) ? parsed.error.code : undefined;
  return {
    done: parsed.done === true,
    failed,
    code: typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 16 ? raw : undefined,
    response: isObject(parsed.response) ? parsed.response : undefined,
  };
}

export type CreateAnswer = { ok: true; name: string } | { ok: false; fault: AnswerFault; code?: number };

/**
 * Reads the Operation a create answers. Only a finished Operation without an
 * error, whose response names a data point of the data type of the request,
 * gives a name: an ID is never made up from anything else.
 *
 * `idOf` reads the data point ID of a name of that data type, and answers
 * undefined for any other text: the name of a point of another data type is
 * not an answer to this create. Default: a nutrition-log name.
 */
export function readCreateAnswer(text: string, idOf: (name: string) => string | undefined = pointId): CreateAnswer {
  const op = operation(text);
  if (!op) return { ok: false, fault: "unreadable" };
  if (op.failed) return { ok: false, fault: "operation_error", ...(op.code === undefined ? {} : { code: op.code }) };
  if (!op.done) return { ok: false, fault: "not_done" };
  const name = op.response?.name;
  if (typeof name !== "string" || idOf(name) === undefined) return { ok: false, fault: "no_name" };
  return { ok: true, name };
}

export type DeleteAnswer = { ok: true } | { ok: false; fault: Exclude<AnswerFault, "no_name">; code?: number };

/**
 * Reads the Operation a delete answers. A finished Operation without an error
 * is a delete that happened. The points it lists are not checked: the
 * documentation shows the answer for another data type only.
 */
export function readDeleteAnswer(text: string): DeleteAnswer {
  const op = operation(text);
  if (!op) return { ok: false, fault: "unreadable" };
  if (op.failed) return { ok: false, fault: "operation_error", ...(op.code === undefined ? {} : { code: op.code }) };
  if (!op.done) return { ok: false, fault: "not_done" };
  return { ok: true };
}
