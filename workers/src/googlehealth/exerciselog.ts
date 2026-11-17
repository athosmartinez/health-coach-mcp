// The two writes of the Google Health API v4 that the coach sends for the
// exercise data type: create one workout session, and delete sessions by
// name. This file holds their shapes only: the paths, the request bodies and
// the names of the data points. The client sends them, and reads the
// Operation each one answers with the readers of nutritionlog.ts.
//
// The shapes come from Google's documentation, not from a real call:
//   - https://developers.google.com/health/data-types (exercise: a Session
//     record with the operations create and batchDelete, and the write scope
//     googlehealth.activity_and_fitness.writeonly)
//   - https://developers.google.com/health/data-types/workouts ("Write a
//     workout session": the only request example)
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/batchDelete
//   - https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
//     (DataPoint, DataSource, Exercise, SessionTimeInterval, MetricsSummary)

import { MAX_BATCH_DELETE, MAX_NAME_LENGTH, POINT_ID } from "./nutritionlog";

/** The data type both writes of this file are for. */
export const EXERCISE_DATA_TYPE = "exercise";

/** `POST` here creates one data point. Relative to the API base URL. */
export const CREATE_PATH = `/users/me/dataTypes/${EXERCISE_DATA_TYPE}/dataPoints`;

/** `POST` here deletes the data points named in the body. */
export const DELETE_PATH = `${CREATE_PATH}:batchDelete`;

const POINT_ID_ONLY = new RegExp(`^${POINT_ID}$`);

/**
 * The name of an exercise data point, as a create answers it
 * (`users/<user>/dataTypes/exercise/dataPoints/<id>`). The user part is an ID
 * that Google chose, or `me`.
 */
export const EXERCISE_NAME = new RegExp(`^users/[A-Za-z0-9_-]+/dataTypes/${EXERCISE_DATA_TYPE}/dataPoints/(${POINT_ID})$`);

/**
 * The data point ID of an exercise data point name (its last path part), or
 * undefined when the text is not such a name. A create answers the user's own
 * ID in the name and a list may answer another form of the user, so two names
 * are the same point when their IDs are equal.
 */
export function pointId(name: string): string | undefined {
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH) return undefined;
  return EXERCISE_NAME.exec(name)?.[1];
}

/** The longest session, in seconds: the exercise reads drop a longer one. */
export const MAX_SESSION_SECONDS = 24 * 3600;

/**
 * The most calories one session holds. It is the bound of the exercise reads
 * (MAX_SESSION_KCAL in healthdata/exercise.ts), written again here because
 * that module reads the names of this one; a test compares the two.
 */
export const MAX_KCAL = 10_000;

/** The longest display name, in characters (code points): what the reads show of a name. */
export const MAX_DISPLAY_NAME_CHARS = 64;

/** The longest notes text, in characters (code points). */
export const MAX_NOTES_CHARS = 500;

/** A value of Google's ExerciseType enum is upper case words joined by underscores. */
const EXERCISE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNSPECIFIED = "EXERCISE_TYPE_UNSPECIFIED";

/** One workout session to create. */
export interface NewExerciseSession {
  /** A value of Google's ExerciseType enum, such as RUNNING or OTHER. */
  exerciseType: string;
  /**
   * The name of the session. Google keeps it only for the type OTHER; for
   * every other type it writes a name of its own.
   */
  displayName: string;
  /** When the session started and ended. Whole seconds are sent. */
  start: Date;
  end: Date;
  /** The local offset from UTC at the start instant and at the end instant, in seconds. */
  startUtcOffsetSeconds: number;
  endUtcOffsetSeconds: number;
  /** Left undefined, no calories are sent: they are unknown, not zero. */
  kcal?: number;
  /** Left undefined, no notes are sent. */
  notes?: string;
}

/** The body of a create request. The keys are in the order they are sent. */
export interface ExerciseBody {
  dataSource: { recordingMethod: "MANUAL"; platform: "GOOGLE_WEB_API" };
  exercise: {
    interval: { startTime: string; startUtcOffset: string; endTime: string; endUtcOffset: string };
    exerciseType: string;
    displayName: string;
    activeDuration: string;
    metricsSummary: { caloriesKcal?: number };
    notes?: string;
  };
}

/** JSON writes −0 as 0: the body holds the value its text carries. */
const unsigned = (value: number) => (value === 0 ? 0 : value);

function offset(name: string, seconds: number): string {
  if (!Number.isInteger(seconds) || Math.abs(seconds) > 18 * 3600) throw new Error(`googlehealth: the session has no valid UTC offset at its ${name}`);
  return `${unsigned(seconds)}s`;
}

const count = (text: string) => [...text].length;

/**
 * The body of the create request (`{"dataSource": …, "exercise": …}`).
 *
 * - `dataSource`. `recordingMethod` is MANUAL, "the data was manually entered
 *   by the user". `platform` is GOOGLE_WEB_API: the reference marks the field
 *   as output only, and the request of the guide's example sends it, so it is
 *   sent as the example has it.
 * - `interval`. The reference marks the four fields as required. Each offset
 *   is the one of its own instant: they differ when the clocks change during
 *   the session.
 * - `displayName`. The reference marks it as required, and says that Google
 *   overrides it with a name of its own for every type but OTHER. The example
 *   of the guide leaves it out; it is always sent.
 * - `activeDuration`. Optional in the reference. It is always sent, as the
 *   whole length of the session (no pause is known): the exercise reads drop
 *   a session without it.
 * - `metricsSummary`. Required in the reference, with every field optional:
 *   `{}` without calories.
 * - `notes`. Sent only when given.
 *
 * Throws for a session that is empty or longer than MAX_SESSION_SECONDS, and
 * for a value outside the bounds of the tool: a caller bug, since the tool
 * checks its input first.
 */
export function createBody(session: NewExerciseSession): ExerciseBody {
  const [startMs, endMs] = [session.start.getTime(), session.end.getTime()];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error("googlehealth: the session has no valid time");
  // Whole seconds.
  const start = Math.floor(startMs / 1000);
  const end = Math.floor(endMs / 1000);
  const seconds = end - start;
  if (seconds <= 0) throw new Error("googlehealth: the session is empty");
  if (seconds > MAX_SESSION_SECONDS) throw new Error("googlehealth: the session is longer than a day");
  if (!EXERCISE_TYPE.test(session.exerciseType) || session.exerciseType === UNSPECIFIED) throw new Error("googlehealth: the session has no valid exercise type");
  if (session.displayName === "" || count(session.displayName) > MAX_DISPLAY_NAME_CHARS) throw new Error("googlehealth: the session has no valid name");
  const stamp = (instant: number) => `${new Date(instant * 1000).toISOString().slice(0, 19)}Z`;
  const exercise: ExerciseBody["exercise"] = {
    interval: {
      startTime: stamp(start),
      startUtcOffset: offset("start", session.startUtcOffsetSeconds),
      endTime: stamp(end),
      endUtcOffset: offset("end", session.endUtcOffsetSeconds),
    },
    exerciseType: session.exerciseType,
    displayName: session.displayName,
    activeDuration: `${seconds}s`,
    metricsSummary: {},
  };
  if (session.kcal !== undefined) {
    if (!Number.isFinite(session.kcal) || session.kcal <= 0 || session.kcal > MAX_KCAL) throw new Error("googlehealth: kcal is outside the range of a session");
    exercise.metricsSummary.caloriesKcal = session.kcal;
  }
  if (session.notes !== undefined) {
    if (session.notes === "" || count(session.notes) > MAX_NOTES_CHARS) throw new Error("googlehealth: the notes are outside the range of a session");
    exercise.notes = session.notes;
  }
  return { dataSource: { recordingMethod: "MANUAL", platform: "GOOGLE_WEB_API" }, exercise };
}

/** The exercise type whose display name Google keeps: the name is then the caller's own text. */
const OTHER = "OTHER";

/**
 * The texts of a create body that the caller wrote, as the body carries them:
 * the display name of an activity that is not in Google's enum, the notes,
 * and the calories as their JSON number text. Google's answer to a refused
 * create can repeat them, and none may reach an error or a log line.
 *
 * The display name of any other type is not one of them: the server makes it
 * from the type (`Running` for RUNNING), so it says nothing that the type
 * does not say, and removing it would remove the type from Google's message.
 * The times and the type are not caller text either.
 */
export function callerTexts(body: ExerciseBody): string[] {
  const { exerciseType, displayName, metricsSummary, notes } = body.exercise;
  const texts: string[] = [];
  if (exerciseType === OTHER) texts.push(displayName);
  if (notes !== undefined) texts.push(notes);
  if (metricsSummary.caloriesKcal !== undefined) texts.push(JSON.stringify(metricsSummary.caloriesKcal));
  return texts;
}

/**
 * The body of the delete request for one data point ID, or for several. The
 * names are written with `users/me`, the form of the request path: the
 * reference says that every name must share the parent of the path, and that
 * `names` can hold up to {@link MAX_BATCH_DELETE} of them. Throws for a text
 * that is not a data point ID, for no id, or for more than that (a caller bug).
 */
export function deleteBody(idOrIds: string | readonly string[]): { names: string[] } {
  const ids = typeof idOrIds === "string" ? [idOrIds] : idOrIds;
  if (ids.length === 0 || ids.length > MAX_BATCH_DELETE) throw new Error("googlehealth: not a data point ID");
  return {
    names: ids.map((id) => {
      if (typeof id !== "string" || !POINT_ID_ONLY.test(id)) throw new Error("googlehealth: not a data point ID");
      return `users/me/dataTypes/${EXERCISE_DATA_TYPE}/dataPoints/${id}`;
    }),
  };
}
