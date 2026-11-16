// exercise_log_add and exercise_log_delete: the two tools that write the
// exercise log of Google Health.
//
// They follow the contract of the two food log tools (foodlog.ts): their
// bodies run inside the CoachStore Durable Object and take turns with the
// other tools that reach Google, on the request budget and the token answer
// of the MCP HTTP request.
//
// Nothing of a call is logged beyond the tool call line of register.ts: no
// exercise type, no name, no value, no notes, no entry id.

import type { McpServer } from "@modelcontextprotocol/server";

import { type LocalDate, type Zone, addDays, dateOf, instantOf, today } from "../coach/date";
import { INTERNAL_ERROR, ToolError } from "../coach/errors";
import { trimSpace } from "../coach/text";
import { notLinkedError } from "../googlehealth/client";
import { MAX_NOTES_CHARS as MAX_NOTES_SENT, MAX_SESSION_SECONDS, type NewExerciseSession, pointId } from "../googlehealth/exerciselog";
import { MAX_NAME_LENGTH } from "../googlehealth/nutritionlog";
import { MAX_SESSION_KCAL, allVisible } from "../healthdata";
import { invalid } from "../store/db";
import { ADDS, DELETES, type Entries, MAX_DAYS_BACK, MAX_NAME_CHARS, TIME_PATTERN } from "./foodlog";
import { type Tool, type ToolDefinition, type ToolOutcome, captureAsync, defineTool, register } from "./register";
import { inputSchema, s } from "./schema";

/** The part of the Google Health client the exercise log tools use. */
export interface ExerciseLogApi {
  /**
   * Creates one session and returns the data point name Google gave it. Never
   * sent again when its outcome is unknown. `account` is the Google account
   * the session will be recorded for: the create goes out only with a token
   * of that account.
   */
  createExercise(session: NewExerciseSession, account: string | undefined): Promise<string>;
  /**
   * Deletes the session with this data point ID. "gone": Google has no such
   * session. `account` is the Google account whose session it is: the delete
   * goes out only with a token of that account.
   */
  deleteExercise(id: string, account: string): Promise<"deleted" | "gone">;
}

/** What the exercise log tools need. */
export interface ExerciseLogDeps {
  /** The Google Health client of this MCP request. It holds the request budget: a tool never catches its errors. */
  api: ExerciseLogApi;
  /** The sessions this server created, with the rules of the food entries: one Google account owns each. */
  entries: Entries;
  now: () => Date;
  /** Defines the local day and the local times of a session. */
  zone: Zone;
}

type Args = Record<string, unknown>;
type Body = (deps: ExerciseLogDeps, args: Args) => Promise<Record<string, unknown>>;

interface ExerciseLogTool {
  tool: Tool;
  body: Body;
}

// The arguments of a write are the payload: a schema error must not repeat an
// activity name, a value, the notes or an entry id, also not one that was
// sent as a key.
const writeTool = (definition: ToolDefinition, body: Body): ExerciseLogTool => ({ tool: defineTool(definition, { echo: false }), body });

// --- bounds ---

/**
 * The exercise types the tool logs under their own type. Each one is a value
 * of Google's ExerciseType enum
 * (https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints);
 * a test compares the list with the documented values. Any other activity is
 * logged as OTHER, under the name that was given.
 */
export const EXERCISE_TYPES = [
  "RUNNING",
  "TREADMILL",
  "TRAIL_RUN",
  "WALKING",
  "HIKING",
  "BIKING",
  "OUTDOOR_BIKE",
  "MOUNTAIN_BIKE",
  "STATIONARY_BIKE",
  "SPINNING",
  "SWIMMING",
  "SWIMMING_POOL",
  "SWIMMING_OPEN_WATER",
  "ROWING",
  "ROWING_MACHINE",
  "ELLIPTICAL",
  "STAIRCLIMBER",
  "STRENGTH_TRAINING",
  "WEIGHTLIFTING",
  "FUNCTIONAL_STRENGTH_TRAINING",
  "CALISTHENICS",
  "CROSSFIT",
  "HIIT",
  "CIRCUIT_TRAINING",
  "CORE_TRAINING",
  "STRETCHING",
  "YOGA",
  "PILATES",
  "JIU_JITSU",
  "MARTIAL_ARTS",
  "BOXING",
  "KICKBOXING",
  "MUAY_THAI",
  "KARATE",
  "TAEKWONDO",
  "WRESTLING",
  "SOCCER",
  "BASKETBALL",
  "VOLLEYBALL",
  "TENNIS",
  "PADEL",
  "SURFING",
  "DANCING",
  "CLIMBING",
  "JUMPING_ROPE",
  "WORKOUT",
  "OTHER",
] as const;

/** The type of an activity that is not in the list. Google keeps the display name of this type only. */
export const OTHER_TYPE = "OTHER";

const LISTED: ReadonlySet<string> = new Set(EXERCISE_TYPES);

/** The longest session, in minutes: a day. The exercise reads drop a longer one. */
export const MAX_DURATION_MIN = MAX_SESSION_SECONDS / 60;

/**
 * The most calories one session can hold: the bound past which workout_review
 * drops a session, so a value this tool accepts is a value the reads keep.
 */
export const MAX_KCAL = MAX_SESSION_KCAL;

/** The longest notes text, in characters (code points), after the spaces around it are cut. */
export const MAX_NOTES_CHARS = MAX_NOTES_SENT;

/** Travels in every result of exercise_log_add (R3). */
export const EXERCISE_LOG_NOTICE =
  "The calories of this session are the client's estimate, not a measurement; null calories were not logged and " +
  "are unknown, not zero. The session has no heart-rate data. An exercise_type that is not in the tool's list was " +
  "logged as OTHER, under the name that was given. Keep entry_id: exercise_log_delete needs it to delete the session.";

const GUARDRAIL =
  "It gives no training or medical advice: never diagnose, and never suggest starting, stopping or dosing a " +
  "medication or a supplement.";

// --- arguments ---

/** An optional text argument: absent, null and "" all mean "not set". */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * A text of 1 to `max` visible characters, with the spaces around it cut. The
 * error names the field and the rule, and never echoes the text.
 *
 * The rule is the one of a food name: only a text that the read filter
 * (`clean` in healthdata/decode.ts) keeps unchanged is accepted. The filter
 * drops control characters, format characters (zero-width characters, text
 * direction overrides), line and paragraph separators, the replacement
 * character and a surrogate without its pair. A text that it would change
 * would be logged as one text and shown by workout_review as another.
 */
function visibleText(field: string, value: string, max: number): string {
  const text = trimSpace(value);
  if (text === "") throw invalid(`${field} must not be empty`);
  // A code point is at most two UTF-16 units: a text this long needs no count.
  if (text.length > 2 * max || [...text].length > max) throw invalid(`${field} must be at most ${max} characters`);
  if (!allVisible(text)) {
    throw invalid(
      `${field} must hold visible characters only: no control or format character (such as a zero-width space, a ` +
        "zero-width joiner or a text direction mark), no line break and no replacement character",
    );
  }
  return text;
}

/**
 * The form exercise types are compared in: upper case, with each run of
 * spaces or hyphens as one underscore ("jiu-jitsu" and "Jiu  Jitsu" are
 * JIU_JITSU). A letter whose upper case is more than one letter keeps its
 * own form.
 */
export function normalizeExerciseType(text: string): string {
  let out = "";
  for (const char of trimSpace(text).replace(/[ -]+/g, "_")) {
    const mapped = char.toUpperCase();
    out += mapped.length === char.length ? mapped : char;
  }
  return out;
}

/** A readable English name of a listed type: "Jiu jitsu" for JIU_JITSU. Google replaces it with a name of its own. */
function englishName(type: string): string {
  const words = type.toLowerCase().replaceAll("_", " ");
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

/**
 * The exercise type and the display name to send. A text that is a listed
 * type, in any letter case and with spaces or hyphens between its words, is
 * that type. Any other text is an activity that is not in the list: it is
 * sent as OTHER, with the text as its name.
 */
function activityOf(value: unknown): { exerciseType: string; displayName: string } {
  const text = visibleText("exercise_type", str(value), MAX_NAME_CHARS);
  const type = normalizeExerciseType(text);
  if (LISTED.has(type)) return { exerciseType: type, displayName: englishName(type) };
  return { exerciseType: OTHER_TYPE, displayName: text };
}

/** The calories of the session; undefined when they were not sent. The error names the bound, never the value. */
function kcalOf(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) throw invalid("kcal must be a number");
  if (value <= 0) throw invalid("kcal must be greater than 0");
  if (value > MAX_KCAL) throw invalid(`kcal must be at most ${MAX_KCAL}`);
  return value;
}

/** The notes of the session; undefined when none were sent. */
function notesOf(value: unknown): string | undefined {
  const text = str(value);
  return trimSpace(text) === "" ? undefined : visibleText("notes", text, MAX_NOTES_CHARS);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The wall clock of an instant in the zone, as HH:MM. */
function clockOf(instant: Date, zone: Zone): string {
  const wall = new Date(instant.getTime() + zone.offsetMs(instant.getTime()));
  return `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

/**
 * The instant of a local time on a local day. On the day of a DST change, a
 * time the clocks skip is the first instant after the gap, and a time that
 * happens twice is its first instant (coach/date.ts).
 */
function instantAt(field: string, day: LocalDate, time: string, zone: Zone): Date {
  const [hour = Number.NaN, minute = Number.NaN] = time.split(":").map(Number);
  const instant = instantOf(day, hour, minute, zone);
  if (instant === undefined) throw invalid(`${field} must be HH:MM on a 24-hour clock`);
  return instant;
}

const MINUTE_MS = 60_000;

/**
 * When the session started and ended, from `date`, `start_time`, and one of
 * `end_time` and `duration_min`.
 *
 * - With `start_time`: the session starts at that time of `date` (today when
 *   left out). It ends `duration_min` later, or at `end_time`: on the same
 *   local day when `end_time` is after `start_time` on the clock, on the next
 *   local day when it is before (a session across midnight).
 * - Without `start_time`: the session ended now, at the whole minute, and
 *   started `duration_min` before. A date before today needs a start time.
 *
 * Refused, before anything is sent: a session without a length, one longer
 * than 24 hours, and one that ends after now.
 */
function spanOf(deps: ExerciseLogDeps, args: Args): { start: Date; end: Date } {
  const now = deps.now();
  const todayIs = today(now, deps.zone);
  const date = str(args.date);
  const startTime = str(args.start_time);
  const endTime = str(args.end_time);
  const duration = typeof args.duration_min === "number" ? args.duration_min : undefined;

  if (endTime !== "" && duration !== undefined) {
    throw new ToolError("invalid_input", "pass end_time or duration_min, not both", "give the end of the session once");
  }
  if (endTime === "" && duration === undefined) {
    throw new ToolError("invalid_input", "end_time or duration_min is required", "give the local end time as HH:MM, or the length of the session in minutes");
  }
  if (duration !== undefined) {
    if (!Number.isInteger(duration) || duration < 1) throw invalid("duration_min must be a whole number of at least 1");
    if (duration > MAX_DURATION_MIN) throw invalid(`duration_min must be at most ${MAX_DURATION_MIN}`);
  }
  const asked = date === "" ? todayIs : date;
  if (asked > todayIs) throw new ToolError("invalid_input", "date is after today", "omit date for today");
  const earliest = addDays(todayIs, -MAX_DAYS_BACK);
  if (earliest === undefined || asked < earliest) {
    throw new ToolError("invalid_input", `date is more than ${MAX_DAYS_BACK} days before today`, `log sessions of the last ${MAX_DAYS_BACK} days only`);
  }

  let start: Date;
  let end: Date;
  if (startTime === "") {
    if (duration === undefined) {
      throw new ToolError("invalid_input", "start_time is required with end_time", "give the local start time as HH:MM, or give duration_min alone for a session that ended now");
    }
    if (asked !== todayIs) {
      throw new ToolError("invalid_input", "start_time is required with a date before today", "give the local start time of the session as HH:MM");
    }
    end = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
    start = new Date(end.getTime() - duration * MINUTE_MS);
  } else {
    start = instantAt("start_time", asked, startTime, deps.zone);
    if (duration !== undefined) {
      end = new Date(start.getTime() + duration * MINUTE_MS);
    } else {
      // "HH:MM" texts compare as their times do. An end that is before the
      // start on the clock is on the next local day; an equal one has no length.
      const endDay = endTime >= startTime ? asked : addDays(asked, 1);
      if (endDay === undefined) throw invalid("date must be a calendar date");
      end = instantAt("end_time", endDay, endTime, deps.zone);
    }
  }
  const length = end.getTime() - start.getTime();
  // Also two times that the clocks skip: both read as the first instant after the gap.
  if (length <= 0) {
    throw new ToolError(
      "invalid_input",
      "the session has no length: end_time is the same instant as start_time",
      "give an end after the start; an end_time before start_time on the clock is read as the next day",
    );
  }
  if (length > MAX_SESSION_SECONDS * 1000) {
    throw new ToolError("invalid_input", "the session is longer than 24 hours", "log a session of at most 24 hours");
  }
  if (end.getTime() > now.getTime()) {
    throw new ToolError("invalid_input", "the session ends after now", "log a session after it ends; check date, start_time and end_time");
  }
  return { start, end };
}

/** The offset of the zone from UTC at an instant, in whole seconds. */
const offsetSeconds = (zone: Zone, instant: Date) => Math.trunc(zone.offsetMs(instant.getTime()) / 1000);

// --- exercise_log_add ---

/** The error of a session that Google holds and the store could not record. */
const NOT_RECORDED =
  "the entry was created in Google Health, but this server could not record it, so it cannot delete the entry";

const EXERCISE_LOG_ADD = writeTool(
  {
    name: "exercise_log_add",
    description:
      "Logs one completed workout session in the user's Google Health exercise log, for a workout that the band " +
      "did not record. It writes one new session to Google Health and returns its entry_id; keep the id, or read " +
      "it later from workout_review, because exercise_log_delete needs it. exercise_type is one of " +
      `${EXERCISE_TYPES.join(", ")}; any other text (1 to ${MAX_NAME_CHARS} visible characters) is logged as ` +
      `${OTHER_TYPE} under that name. Give end_time or duration_min, exactly one. With start_time, an end_time ` +
      "that is before it on the clock is on the next day; without start_time, give duration_min alone for a " +
      "session that ended now. date is the local day the session started: today when omitted, at most " +
      `${MAX_DAYS_BACK} days before today. Times are HH:MM in the coach's time zone. A session lasts at most 24 ` +
      `hours and never ends after now. kcal is your estimate, above 0 and at most ${MAX_KCAL}: leave it out when ` +
      "unknown, and say to the user that it is an estimate. The session has no heart-rate data. Log only after " +
      "the user confirms the session. Every call adds a new session, so never repeat a call for the same " +
      "workout, and do not log a workout that the band recorded: workout_review marks a logged session that " +
      "overlaps a band session with overlaps_band_session. After an upstream_unavailable error whose hint says " +
      `that the entry may exist, check the day with workout_review before a new try. ${GUARDRAIL}`,
    annotations: ADDS,
    inputSchema: inputSchema(
      s.object({
        exercise_type: s.string(
          `The activity: one of ${EXERCISE_TYPES.join(", ")}. Any other text, 1 to ${MAX_NAME_CHARS} visible ` +
            `characters, is logged as ${OTHER_TYPE} under that name`,
        ),
        "date?": s.date(`Local day the session started, YYYY-MM-DD; omit for today; at most ${MAX_DAYS_BACK} days before today`),
        "start_time?": {
          type: "string",
          description: "Local start time, HH:MM on a 24-hour clock; omit, with duration_min, for a session that ended now",
          pattern: TIME_PATTERN,
        },
        "end_time?": {
          type: "string",
          description: "Local end time, HH:MM on a 24-hour clock; before start_time on the clock means the next day; give this or duration_min",
          pattern: TIME_PATTERN,
        },
        "duration_min?": s.integer(`Length of the session in whole minutes, 1 to ${MAX_DURATION_MIN}; give this or end_time`),
        "kcal?": s.number(`Estimated calories burned in kcal, above 0 and at most ${MAX_KCAL}; omit when unknown`),
        "notes?": s.string(`Notes of the session, one line of at most ${MAX_NOTES_CHARS} visible characters; omit for none`),
      }),
    ),
    outputSchema: s.object({
      entry_id: s.string("The id of the new session; pass it to exercise_log_delete to delete the session"),
      date: s.date("Local day the session started, YYYY-MM-DD"),
      start_time: s.string("Local start time of the session, HH:MM"),
      end_time: s.string("Local end time of the session, HH:MM"),
      duration_min: s.number("Length of the session in minutes"),
      exercise_type: s.string(`The exercise type that was logged: ${OTHER_TYPE} for an activity that is not in the list`),
      kcal: s.nullable(s.number()),
      notice: s.string(),
    }),
  },
  async (deps, args) => {
    // Everything is checked before anything is sent.
    const { exerciseType, displayName } = activityOf(args.exercise_type);
    const kcal = kcalOf(args.kcal);
    const notes = notesOf(args.notes);
    const { start, end } = spanOf(deps, args);

    const session: NewExerciseSession = {
      exerciseType,
      displayName,
      start,
      end,
      startUtcOffsetSeconds: offsetSeconds(deps.zone, start),
      endUtcOffsetSeconds: offsetSeconds(deps.zone, end),
    };
    if (kcal !== undefined) session.kcal = kcal;
    if (notes !== undefined) session.notes = notes;
    // A session belongs to the local day it starts on, as the exercise reads place it.
    const day = dateOf(start, deps.zone);
    // The session will belong to the account that is linked now. Without a
    // link the create answers auth_expired, and nothing is sent. The client
    // sends the create only with a token of this account: the token answer of
    // the MCP HTTP request can be older than the link.
    const owner = deps.entries.owner();
    const entryId = await deps.api.createExercise(session, owner);

    // Google holds the session from here on. Without its row the server does
    // not own it: say so, instead of an error that reads as "nothing happened".
    try {
      deps.entries.record(entryId, day, owner);
    } catch (cause) {
      throw new ToolError("internal_error", NOT_RECORDED, "do not log the same workout again", { cause });
    }
    return {
      entry_id: entryId,
      date: day,
      start_time: clockOf(start, deps.zone),
      end_time: clockOf(end, deps.zone),
      duration_min: (end.getTime() - start.getTime()) / MINUTE_MS,
      exercise_type: exerciseType,
      kcal: kcal ?? null,
      notice: EXERCISE_LOG_NOTICE,
    };
  },
);

// --- exercise_log_delete ---

const EXERCISE_LOG_DELETE = writeTool(
  {
    name: "exercise_log_delete",
    description:
      "Deletes one session of the user's Google Health exercise log, by the entry_id that exercise_log_add " +
      "returned or that workout_review lists on the session. It deletes only a session that this server created: " +
      "any other id answers no_data, and nothing is sent to Google Health for it. A delete cannot be undone, so " +
      "confirm it with the user first. " +
      GUARDRAIL,
    annotations: DELETES,
    inputSchema: inputSchema(
      s.object({
        entry_id: {
          type: "string",
          description:
            "The entry_id that exercise_log_add returned, or that workout_review lists on the session " +
            "(users/…/dataTypes/exercise/dataPoints/…)",
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
      throw new ToolError(
        "invalid_input",
        "entry_id is not the id of an exercise log entry",
        "use the entry_id that exercise_log_add returned or that workout_review lists",
      );
    }
    // Without a linked account the store matches no entry, also not one that
    // this server created: "no entry with that id" would be false for it, and
    // would hide the step that makes the delete work. So the answer is the
    // one of a token request without a link, for every id, and no request is
    // sent. It says nothing about which entries exist.
    const owner = deps.entries.owner();
    if (owner === undefined) throw notLinkedError();
    // Only a session of this server is deleted, and the check comes before
    // any request: Google's documentation does not prove that it would refuse
    // the delete of a session the band or another app wrote. A session that
    // was created for another Google account than the linked one is not this
    // server's own now: the delete would go out with the wrong account's token.
    if (!deps.entries.has(entryId)) {
      throw new ToolError(
        "no_data",
        "this server created no entry with that id",
        "it deletes only an entry that exercise_log_add created and that was not deleted yet",
      );
    }
    // "gone" is the state the delete asks for: the row goes in both cases.
    // The entry is this account's own, so the delete goes out only with a
    // token of this account.
    await deps.api.deleteExercise(id, owner);
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

const TOOLS: readonly ExerciseLogTool[] = [EXERCISE_LOG_ADD, EXERCISE_LOG_DELETE];

/** The tools that write the exercise log, in the order they are listed. */
export const EXERCISE_LOG_TOOLS: readonly Tool[] = TOOLS.map((one) => one.tool);

const byName = new Map(TOOLS.map((one) => [one.tool.name, one]));

/** Whether `name` is one of the exercise log tools. */
export function isExerciseLogTool(name: string): boolean {
  return byName.has(name);
}

/**
 * Runs the body of an exercise log tool. Errors come back in the outcome and
 * are never thrown: a ToolError of the body or of the Google Health client as
 * it is, anything else as internal_error.
 */
export async function runExerciseLogTool(deps: ExerciseLogDeps, name: string, args: Args): Promise<ToolOutcome> {
  const one = byName.get(name);
  if (!one) return { ok: false, error: INTERNAL_ERROR };
  return captureAsync(one.tool, () => one.body(deps, args));
}

/** Adds the exercise log tools. `run` executes a tool body and returns its outcome. */
export function registerExerciseLog(server: McpServer, run: (name: string, args: Args) => Promise<ToolOutcome>): void {
  for (const tool of EXERCISE_LOG_TOOLS) register(server, tool, (args) => run(tool.name, args));
}
