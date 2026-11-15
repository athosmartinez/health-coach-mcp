// exercise_log_add and exercise_log_delete. First the tool bodies over a fake
// client and a fake store (every input rule, the time rules, the order of the
// steps), then each tool through /mcp of the CoachStore object, with the real
// client and Google behind a mocked `fetch`, and last the reads that show a
// logged session. All values are synthetic.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { UTC, Zone } from "../src/coach/date";
import { ToolError, type WireError } from "../src/coach/errors";
import { GOOGLE_HEALTH_SCOPES, RECONNECT_HINT, WRITE_SCOPES } from "../src/google";
import { MAY_EXIST_HINTS } from "../src/googlehealth/client";
import { type NewExerciseSession, createBody } from "../src/googlehealth/exerciselog";
import { MAX_SESSION_KCAL, clean } from "../src/healthdata";
import { parseExercise } from "../src/healthdata/exercise";
import type { CoachStore } from "../src/store";
import {
  EXERCISE_LOG_NOTICE,
  EXERCISE_LOG_TOOLS,
  EXERCISE_TYPES,
  type ExerciseLogDeps,
  MAX_DURATION_MIN,
  MAX_KCAL,
  MAX_NOTES_CHARS,
  OTHER_TYPE,
  normalizeExerciseType,
  runExerciseLogTool,
} from "../src/tools/exerciselog";
import { MAX_DAYS_BACK, MAX_NAME_CHARS } from "../src/tools/foodlog";
import { invoke } from "../src/tools/register";
import { RENEWED_TOKEN, STORED_TOKEN, TODAY, day, everything, googleMock, link, linkedStore } from "./e2e-helpers";
import { DOCUMENTED_EXERCISE_TYPES, DiskError, FAKE_CLIENT_ID, FAKE_USER_ID, NOW, at, exerciseRec, generatedName } from "./healthdata-helpers";
import { OWNER_SUB } from "./helpers";
import { ALL_TOOL_NAMES, SAO_PAULO, SCHEMA_HINT, freshStore, objectRpc, objectTool } from "./memory-helpers";

// The clock is fixed at NOW (2026-10-16 10:00 in São Paulo), and every console level is spied on.
const g = googleMock();

const NEW_YORK = new Zone("America/New_York");

/** A text from code points: an invisible character is written by its number, never as itself. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** The name of a session the fake client creates. */
const entryName = (n: number) => `users/${FAKE_USER_ID}/dataTypes/exercise/dataPoints/syn-entry-${n}`;

/** An activity that is not in the list, 07:10 to 08:25. The kcal has a fraction that no status, count or duration has. */
const WORKOUT = { exercise_type: "Capoeira angola", start_time: "07:10", duration_min: 75, kcal: 431.5, notes: "Roda de sexta" };

/** Nothing of a call: no activity name, value, notes, entry id, token or part of Google's answer. */
const BODY_MARK = "synthetic body 7711";
const SECRETS = ["Capoeira", "angola", "431.5", "Roda", "sexta", "syn-entry", "syn-created", FAKE_USER_ID, FAKE_CLIENT_ID, STORED_TOKEN, RENEWED_TOKEN, BODY_MARK, "7711"];

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

interface FakeOptions {
  now?: Date;
  zone?: Zone;
  create?: (session: NewExerciseSession) => Promise<string>;
  remove?: (id: string) => Promise<"deleted" | "gone">;
  failRecord?: boolean;
  failForget?: boolean;
  /** The linked Google account at the start; null for none. Default: ACCOUNT. */
  account?: string | null;
}

/** The `sub` of the linked account of the fake store. It must never reach a result, an error or a log line. */
const ACCOUNT = "300000000000000000003";

/** The tool bodies over a fake client and a fake store that note every step. */
function session(options: FakeOptions = {}) {
  const created: NewExerciseSession[] = [];
  const removed: string[] = [];
  /** The account each write named to the client, in order. */
  const accounts: (string | undefined)[] = [];
  /** How many times a tool read the linked account. */
  const reads = { owner: 0 };
  const rows = new Map<string, string>();
  /** The account each row was recorded for. */
  const owners = new Map<string, string>();
  const steps: string[] = [];
  /** The account that is linked now: a test can link another one. */
  const linked: { account: string | undefined } = { account: options.account === null ? undefined : (options.account ?? ACCOUNT) };
  const deps: ExerciseLogDeps = {
    api: {
      createExercise: async (one, account) => {
        steps.push("create");
        created.push(one);
        accounts.push(account);
        return options.create ? options.create(one) : entryName(created.length);
      },
      deleteExercise: async (id, account) => {
        steps.push("delete");
        removed.push(id);
        accounts.push(account);
        return options.remove ? options.remove(id) : "deleted";
      },
    },
    // The rules of the store: a session is recorded for the linked account,
    // and only the sessions of the linked account are known.
    entries: {
      owner: () => {
        reads.owner++;
        return linked.account;
      },
      record: (name, onDay, owner) => {
        steps.push("record");
        if (options.failRecord) throw new DiskError();
        if (owner === undefined || owner !== linked.account) throw new Error("another account is linked");
        rows.set(name, onDay);
        owners.set(name, owner);
      },
      has: (name) => {
        steps.push("has");
        return rows.has(name) && owners.get(name) === linked.account;
      },
      forget: (name) => {
        steps.push("forget");
        if (options.failForget) throw new DiskError();
        if (owners.get(name) !== linked.account) return;
        rows.delete(name);
        owners.delete(name);
      },
    },
    now: () => options.now ?? NOW,
    zone: options.zone ?? SAO_PAULO,
  };
  const call = (name: string, args: unknown): Promise<CallToolResult> => {
    const tool = EXERCISE_LOG_TOOLS.find((one) => one.name === name);
    if (!tool) throw new Error(`no exercise log tool named ${name}`);
    return invoke(tool, (checked) => runExerciseLogTool(deps, name, checked), args);
  };
  const textOf = (result: CallToolResult) => {
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    return block?.type === "text" ? block.text : "";
  };
  return {
    created,
    removed,
    accounts,
    reads,
    rows,
    owners,
    linked,
    steps,
    call,
    async ok(name: string, args: unknown): Promise<Record<string, any>> {
      const result = await call(name, args);
      expect(result.isError, `${name} failed: ${textOf(result)}`).not.toBe(true);
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
      return result.structuredContent as Record<string, any>;
    },
    async fails(name: string, args: unknown): Promise<WireError> {
      const result = await call(name, args);
      expect(result.isError, `${name}(${JSON.stringify(args)}) succeeded, want an error`).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = textOf(result);
      // No error holds the activity name, a value of the session, its notes or an entry id.
      expectNoSecret(text);
      const wire = JSON.parse(text) as WireError;
      expect(Object.keys(wire).sort()).toEqual(wire.hint === undefined ? ["code", "message"] : ["code", "hint", "message"]);
      return wire;
    },
  };
}

const toolCall = (tool: string, code?: string) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: code !== undefined, ...(code === undefined ? {} : { code }) }];

const FIX_HINT = "fix the value named in the message and retry";
const SCHEMA = /^the arguments do not match the tool's input schema: /;
const visibleOnly = (field: string) =>
  `${field} must hold visible characters only: no control or format character (such as a zero-width space, a zero-width joiner or a text direction mark), no line break and no replacement character`;

describe("the two exercise log tools as they are listed", () => {
  const [add, remove] = EXERCISE_LOG_TOOLS;

  it("are exercise_log_add and exercise_log_delete", () => {
    expect(EXERCISE_LOG_TOOLS.map((tool) => tool.name)).toEqual(["exercise_log_add", "exercise_log_delete"]);
  });

  it("say that they write to an external service: add is not idempotent, delete is destructive", () => {
    expect(add?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(remove?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  });

  it("describe what is written, the list of types, the time rules, the estimate and the guardrail", () => {
    const text = add?.description ?? "";
    expect(text).toContain("It writes one new session to Google Health and returns its entry_id");
    expect(text).toContain(`exercise_type is one of ${EXERCISE_TYPES.join(", ")}; any other text (1 to 64 visible characters) is logged as OTHER under that name.`);
    expect(text).toContain("Give end_time or duration_min, exactly one.");
    expect(text).toContain("an end_time that is before it on the clock is on the next day");
    expect(text).toContain("without start_time, give duration_min alone for a session that ended now");
    expect(text).toContain("today when omitted, at most 30 days before today");
    expect(text).toContain("A session lasts at most 24 hours and never ends after now.");
    expect(text).toContain("kcal is your estimate, above 0 and at most 10000");
    expect(text).toContain("The session has no heart-rate data.");
    expect(text).toContain("never repeat a call for the same workout");
    expect(text).toContain("check the day with workout_review before a new try");
    for (const tool of EXERCISE_LOG_TOOLS) {
      // The medical guardrail of every description.
      expect(tool.description, tool.name).toContain("It gives no training or medical advice: never diagnose, and never suggest starting, stopping or dosing a medication or a supplement.");
    }
    expect(remove?.description).toContain("It deletes only a session that this server created: any other id answers no_data, and nothing is sent to Google Health for it.");
    expect([MAX_NAME_CHARS, MAX_KCAL, MAX_DURATION_MIN, MAX_NOTES_CHARS, MAX_DAYS_BACK]).toEqual([64, 10_000, 1440, 500, 30]);
    // The kcal bound is the one of the exercise reads: a value the tool accepts is a value workout_review keeps.
    expect(MAX_KCAL).toBe(MAX_SESSION_KCAL);
  });

  it("take strict inputs: closed objects, a type without an enum, and optional inputs that may be null or empty", () => {
    const schema = add?.inputSchema ?? {};
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["exercise_type"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["exercise_type", "date", "start_time", "end_time", "duration_min", "kcal", "notes"]);
    const typesOf = (name: string) => schema.properties?.[name]?.type;
    // No enum: a client must not refuse an activity that the server can log as OTHER. The description lists the values.
    expect(schema.properties?.exercise_type).toEqual({ type: "string", description: expect.stringContaining(EXERCISE_TYPES.join(", ")) });
    expect(schema.properties?.exercise_type?.enum).toBeUndefined();
    for (const name of ["date", "start_time", "end_time", "notes"]) expect(typesOf(name), name).toEqual(["null", "string"]);
    expect(typesOf("duration_min")).toEqual(["null", "integer"]);
    expect(typesOf("kcal")).toEqual(["null", "number"]);
    expect(schema.properties?.date?.pattern).toBe("^(?:\\d{4}-\\d{2}-\\d{2})?$");
    for (const name of ["start_time", "end_time"]) expect(schema.properties?.[name]?.pattern, name).toBe("^(?:([01]\\d|2[0-3]):[0-5]\\d)?$");

    expect(remove?.inputSchema).toEqual({
      type: "object",
      properties: { entry_id: { type: "string", description: expect.any(String), maxLength: 256 } },
      required: ["entry_id"],
      additionalProperties: false,
    });
    expect(remove?.outputSchema).toEqual({
      type: "object",
      properties: { entry_id: { type: "string" }, deleted: { type: "boolean" } },
      required: ["entry_id", "deleted"],
      additionalProperties: false,
    });
    expect(add?.outputSchema.required).toEqual(["entry_id", "date", "start_time", "end_time", "duration_min", "exercise_type", "kcal", "notice"]);
    // No field for the activity name or the notes: the result does not echo them.
    for (const field of ["name", "display_name", "notes"]) expect(Object.keys(add?.outputSchema.properties ?? {})).not.toContain(field);
  });

  it("have no boolean schema in their properties", () => {
    const booleans = (schema: unknown): number => {
      if (typeof schema === "boolean") return 1;
      if (typeof schema !== "object" || schema === null) return 0;
      const node = schema as { properties?: Record<string, unknown>; items?: unknown };
      return Object.values(node.properties ?? {}).reduce((sum: number, property) => sum + booleans(property), 0) + (node.items === undefined ? 0 : booleans(node.items));
    };
    for (const tool of EXERCISE_LOG_TOOLS) expect(booleans(tool.inputSchema) + booleans(tool.outputSchema), tool.name).toBe(0);
  });
});

describe("the exercise types of exercise_log_add", () => {
  it("are a closed list of documented ExerciseType values, with JIU_JITSU and OTHER", () => {
    expect(DOCUMENTED_EXERCISE_TYPES).toHaveLength(181);
    expect(DOCUMENTED_EXERCISE_TYPES).not.toContain("EXERCISE_TYPE_UNSPECIFIED");
    // Every type the tool sends is a value the reference documents.
    for (const type of EXERCISE_TYPES) expect(DOCUMENTED_EXERCISE_TYPES, type).toContain(type);
    expect(new Set(EXERCISE_TYPES).size).toBe(EXERCISE_TYPES.length);
    expect(EXERCISE_TYPES).toContain("JIU_JITSU");
    expect(EXERCISE_TYPES).toContain(OTHER_TYPE);
    expect(OTHER_TYPE).toBe("OTHER");
    expect([...EXERCISE_TYPES]).toEqual([
      ...["RUNNING", "TREADMILL", "TRAIL_RUN", "WALKING", "HIKING", "BIKING", "OUTDOOR_BIKE", "MOUNTAIN_BIKE", "STATIONARY_BIKE", "SPINNING"],
      ...["SWIMMING", "SWIMMING_POOL", "SWIMMING_OPEN_WATER", "ROWING", "ROWING_MACHINE", "ELLIPTICAL", "STAIRCLIMBER"],
      ...["STRENGTH_TRAINING", "WEIGHTLIFTING", "FUNCTIONAL_STRENGTH_TRAINING", "CALISTHENICS", "CROSSFIT", "HIIT", "CIRCUIT_TRAINING", "CORE_TRAINING"],
      ...["STRETCHING", "YOGA", "PILATES", "JIU_JITSU", "MARTIAL_ARTS", "BOXING", "KICKBOXING", "MUAY_THAI", "KARATE", "TAEKWONDO", "WRESTLING"],
      ...["SOCCER", "BASKETBALL", "VOLLEYBALL", "TENNIS", "PADEL", "SURFING", "DANCING", "CLIMBING", "JUMPING_ROPE", "WORKOUT", "OTHER"],
    ]);
    // Each listed type is its own normal form.
    for (const type of EXERCISE_TYPES) expect(normalizeExerciseType(type), type).toBe(type);
  });

  it.each([
    ["the type as listed", "RUNNING", "RUNNING", "Running"],
    ["lower case", "running", "RUNNING", "Running"],
    ["mixed case with a hyphen", "Jiu-Jitsu", "JIU_JITSU", "Jiu jitsu"],
    ["a space between the words", "jiu jitsu", "JIU_JITSU", "Jiu jitsu"],
    ["a run of spaces and hyphens between the words", "jiu  -  jitsu", "JIU_JITSU", "Jiu jitsu"],
    ["spaces around the text", "  \t strength training \n", "STRENGTH_TRAINING", "Strength training"],
    ["three words with hyphens", "functional-strength-training", "FUNCTIONAL_STRENGTH_TRAINING", "Functional strength training"],
    ["an underscore as listed", "muay_thai", "MUAY_THAI", "Muay thai"],
    ["a short type", "hiit", "HIIT", "Hiit"],
    ["the type OTHER itself", "other", "OTHER", "Other"],
  ])("sends %s as that type, with a readable English name", async (_name, given, type, displayName) => {
    const s = session();
    const out = await s.ok("exercise_log_add", { exercise_type: given, start_time: "07:10", duration_min: 75 });
    expect(out.exercise_type).toBe(type);
    expect(s.created[0]).toMatchObject({ exerciseType: type, displayName });
    expect(normalizeExerciseType(given)).toBe(type);
  });

  it.each([
    ["an activity that is not in the list", "Capoeira angola", "Capoeira angola"],
    ["an activity with spaces around it", "  Futevôlei de praia  ", "Futevôlei de praia"],
    ["a listed type with one more word", "jiu jitsu no gi", "jiu jitsu no gi"],
    ["a short form of a listed type", "RUN", "RUN"],
    ["a documented type that the tool does not list", "ZUMBA", "ZUMBA"],
    ["a listed type with an accent", "Pádel", "Pádel"],
    // The upper case of this letter is two letters: it keeps its own form, so the text is not a listed type.
    ["a letter whose upper case is two letters", `cro${cp(0xdf)}fit`, `cro${cp(0xdf)}fit`],
    ["an underscore where the list has none", "cross_fit", "cross_fit"],
    ["64 characters", "a".repeat(64), "a".repeat(64)],
    ["letters of another script", "柔術 дзюдо", "柔術 дзюдо"],
  ])("sends %s as OTHER, under the name that was given", async (_name, given, displayName) => {
    const s = session();
    const out = await s.ok("exercise_log_add", { exercise_type: given, start_time: "07:10", duration_min: 75 });
    // The result shows the mapping to OTHER, and does not repeat the name.
    expect(out.exercise_type).toBe("OTHER");
    expect(JSON.stringify(out)).not.toContain(displayName);
    const sent = s.created[0] as NewExerciseSession;
    expect(sent).toMatchObject({ exerciseType: "OTHER", displayName });
    // The read filter changes nothing of the name: workout_review shows the name that was logged.
    expect(clean(displayName)).toBe(displayName);
    // The session as Google holds it, read back as the exercise read reads one this server created.
    const read = parseExercise({ name: entryName(1), ...createBody(sent) }, new Set(["syn-entry-1"]));
    expect(read).toMatchObject({ kind: "session", session: { type: "OTHER", name: displayName } });
  });
});

describe("exercise_log_add", () => {
  it("sends the session, records the returned name with its day, then answers", async () => {
    const s = session();
    const out = await s.ok("exercise_log_add", { ...WORKOUT, date: TODAY });
    expect(out).toEqual({
      entry_id: entryName(1),
      date: "2026-10-16",
      start_time: "07:10",
      end_time: "08:25",
      duration_min: 75,
      exercise_type: "OTHER",
      kcal: 431.5,
      notice: EXERCISE_LOG_NOTICE,
    });
    expect(EXERCISE_LOG_NOTICE).toContain("are the client's estimate, not a measurement");
    expect(EXERCISE_LOG_NOTICE).toContain("The session has no heart-rate data.");
    expect(EXERCISE_LOG_NOTICE).toContain("An exercise_type that is not in the tool's list was logged as OTHER, under the name that was given.");
    expect(EXERCISE_LOG_NOTICE).toContain("Keep entry_id: exercise_log_delete needs it to delete the session.");
    // The result does not echo the activity name or the notes.
    expect(JSON.stringify(out)).not.toContain("Capoeira");
    expect(JSON.stringify(out)).not.toContain("Roda");
    expect(s.created).toEqual([
      {
        exerciseType: "OTHER",
        displayName: "Capoeira angola",
        start: new Date("2026-10-16T10:10:00Z"),
        end: new Date("2026-10-16T11:25:00Z"),
        startUtcOffsetSeconds: -10_800,
        endUtcOffsetSeconds: -10_800,
        kcal: 431.5,
        notes: "Roda de sexta",
      },
    ]);
    // Validate, send the create, store the returned name, answer.
    expect(s.steps).toEqual(["create", "record"]);
    expect([...s.rows]).toEqual([[entryName(1), "2026-10-16"]]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add")]);
    expectNoSecret(g.logged());
  });

  it.each([
    ["left out", {}],
    ["null", { kcal: null, notes: null }],
    ["an empty text for the notes", { notes: "" }],
    ["notes of spaces only", { notes: " \t " }],
  ])("sends no calories and no notes when they are %s: they are unknown, not zero", async (_name, optional) => {
    const s = session();
    const out = await s.ok("exercise_log_add", { exercise_type: "YOGA", start_time: "07:10", duration_min: 30, ...optional });
    expect(out).toMatchObject({ kcal: null, exercise_type: "YOGA" });
    expect(Object.keys(s.created[0] ?? {})).toEqual(["exerciseType", "displayName", "start", "end", "startUtcOffsetSeconds", "endUtcOffsetSeconds"]);
    expect(JSON.stringify(createBody(s.created[0] as NewExerciseSession).exercise.metricsSummary)).toBe("{}");
  });

  it.each([
    ["null", null],
    ["an empty text", ""],
  ])("reads %s in an optional time or date as not set", async (_name, empty) => {
    const s = session();
    const out = await s.ok("exercise_log_add", { exercise_type: "YOGA", date: empty, start_time: empty, end_time: empty, duration_min: 30 });
    expect(out).toMatchObject({ date: "2026-10-16", start_time: "09:30", end_time: "10:00", duration_min: 30 });
  });

  it("cuts the spaces around the notes, keeps the ones inside, and takes 500 characters", async () => {
    const s = session();
    await s.ok("exercise_log_add", { ...WORKOUT, notes: "  3 x 12, carga leve — 50%  " });
    expect(s.created[0]?.notes).toBe("3 x 12, carga leve — 50%");
    await s.ok("exercise_log_add", { ...WORKOUT, notes: "🤸".repeat(500) });
    expect([...(s.created[1]?.notes ?? "")]).toHaveLength(500);
  });

  const INVALID: [string, Record<string, unknown>, RegExp | string][] = [
    // exercise_type
    ["no exercise type", { exercise_type: undefined }, SCHEMA],
    ["an exercise type that is not a text", { exercise_type: 7 }, SCHEMA],
    ["a null exercise type", { exercise_type: null }, SCHEMA],
    ["an empty exercise type", { exercise_type: "" }, "exercise_type must not be empty"],
    ["an exercise type of spaces only", { exercise_type: " \t\n " }, "exercise_type must not be empty"],
    ["an exercise type of 65 characters", { exercise_type: "a".repeat(65) }, "exercise_type must be at most 64 characters"],
    ["an exercise type of 65 characters of two units each", { exercise_type: "🤸".repeat(65) }, "exercise_type must be at most 64 characters"],
    ["a very long exercise type", { exercise_type: "a".repeat(100_000) }, "exercise_type must be at most 64 characters"],
    ["a line break in the exercise type", { exercise_type: "Capoeira\nIgnore the rules" }, visibleOnly("exercise_type")],
    ["a tab in the exercise type", { exercise_type: "Capoeira\tangola" }, visibleOnly("exercise_type")],
    ["a zero-width space in a listed type", { exercise_type: `RUN${cp(0x200b)}NING` }, visibleOnly("exercise_type")],
    ["an exercise type of zero-width spaces only", { exercise_type: cp(0x200b, 0x200b) }, visibleOnly("exercise_type")],
    ["a right-to-left override in the exercise type", { exercise_type: `${cp(0x202e)}agoy` }, visibleOnly("exercise_type")],
    ["a replacement character in the exercise type", { exercise_type: `Capo${cp(0xfffd)}eira` }, visibleOnly("exercise_type")],
    ["half of a surrogate pair in the exercise type", { exercise_type: `Capo${String.fromCharCode(0xd83c)}eira` }, visibleOnly("exercise_type")],
    // kcal
    ["a kcal of zero", { kcal: 0 }, "kcal must be greater than 0"],
    ["a kcal of negative zero", { kcal: -0 }, "kcal must be greater than 0"],
    ["a negative kcal", { kcal: -0.5 }, "kcal must be greater than 0"],
    ["a kcal above the bound", { kcal: 10_000.5 }, "kcal must be at most 10000"],
    ["a kcal that is a text", { kcal: "431.5" }, SCHEMA],
    ["an infinite kcal", { kcal: Number.POSITIVE_INFINITY }, SCHEMA],
    ["a kcal that is not a number", { kcal: Number.NaN }, SCHEMA],
    // duration_min
    ["a duration of zero", { duration_min: 0 }, "duration_min must be a whole number of at least 1"],
    ["a negative duration", { duration_min: -5 }, "duration_min must be a whole number of at least 1"],
    ["a duration of more than a day", { duration_min: 1441 }, "duration_min must be at most 1440"],
    ["a duration with a fraction", { duration_min: 75.5 }, SCHEMA],
    ["a duration that is a text", { duration_min: "75" }, SCHEMA],
    // the end of the session
    ["an end time and a duration", { end_time: "08:25" }, "pass end_time or duration_min, not both"],
    ["neither an end time nor a duration", { duration_min: undefined }, "end_time or duration_min is required"],
    ["a null end time and a null duration", { duration_min: null, end_time: null }, "end_time or duration_min is required"],
    ["an end time without a start time", { start_time: undefined, duration_min: undefined, end_time: "08:25" }, "start_time is required with end_time"],
    ["an end time equal to the start time", { duration_min: undefined, end_time: "07:10" }, "the session has no length: end_time is the same instant as start_time"],
    // date
    ["a date in another format", { date: "16/10/2026" }, SCHEMA],
    ["a date that is not a text", { date: 20261016 }, SCHEMA],
    ["a day that does not exist", { date: "2026-02-30" }, /not a real calendar date/],
    ["a date after today", { date: "2026-10-17" }, "date is after today"],
    ["a date 31 days before today", { date: "2026-09-15" }, "date is more than 30 days before today"],
    ["a date years before today", { date: "2020-01-01" }, "date is more than 30 days before today"],
    ["a date before today without a start time", { date: "2026-10-15", start_time: undefined }, "start_time is required with a date before today"],
    ["a date before today with an empty start time", { date: "2026-10-15", start_time: "" }, "start_time is required with a date before today"],
    // times
    ["a start hour past 23", { start_time: "24:00" }, SCHEMA],
    ["a start hour of one digit", { start_time: "7:10" }, SCHEMA],
    ["a start time with seconds", { start_time: "07:10:00" }, SCHEMA],
    ["a start time that is not a text", { start_time: 710 }, SCHEMA],
    ["an end minute past 59", { duration_min: undefined, end_time: "08:60" }, SCHEMA],
    ["an end time with a zone", { duration_min: undefined, end_time: "08:25Z" }, SCHEMA],
    // a session that has not ended
    ["a session that ends after now", { start_time: "09:30", duration_min: 31 }, "the session ends after now"],
    ["an end time after now", { start_time: "09:30", duration_min: undefined, end_time: "10:01" }, "the session ends after now"],
    ["a start time after now", { start_time: "10:30", duration_min: 15 }, "the session ends after now"],
    ["a session of today that would end tomorrow", { start_time: "09:00", duration_min: undefined, end_time: "01:00" }, "the session ends after now"],
    // notes
    ["notes of 501 characters", { notes: "n".repeat(501) }, "notes must be at most 500 characters"],
    ["notes of two lines", { notes: "first line\nsecond line" }, visibleOnly("notes")],
    ["a zero-width joiner in the notes", { notes: `a${cp(0x200d)}b` }, visibleOnly("notes")],
    ["a text direction override in the notes", { notes: `${cp(0x202e)}seton` }, visibleOnly("notes")],
    ["notes that are not a text", { notes: 7 }, SCHEMA],
    // unknown properties
    ["a property the tool does not have", { distance_km: 5 }, SCHEMA],
    ["the property of the other tool", { entry_id: entryName(1) }, SCHEMA],
  ];

  it.each(INVALID)("answers invalid_input for %s, and sends nothing", async (_name, change, message) => {
    const s = session();
    const args: Record<string, unknown> = { ...WORKOUT, ...change };
    for (const [key, value] of Object.entries(args)) if (value === undefined) delete args[key];
    const error = await s.fails("exercise_log_add", args);
    expect(error.code).toBe("invalid_input");
    expect(error.hint).toEqual(expect.any(String));
    if (message === SCHEMA) expect(error.hint).toBe(SCHEMA_HINT);
    if (typeof message === "string") expect(error.message).toBe(message);
    else expect(error.message).toMatch(message);
    expect(s.steps).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "invalid_input")]);
    expectNoSecret(g.logged());
  });

  it("names the field and the rule in an error, with a hint, and never the value", async () => {
    const s = session();
    expect(await s.fails("exercise_log_add", { ...WORKOUT, kcal: 10_431.5 })).toEqual({ code: "invalid_input", message: "kcal must be at most 10000", hint: FIX_HINT });
    expect(await s.fails("exercise_log_add", { ...WORKOUT, date: day(1) })).toEqual({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
    expect(await s.fails("exercise_log_add", { ...WORKOUT, date: day(-31) })).toEqual({
      code: "invalid_input",
      message: "date is more than 30 days before today",
      hint: "log sessions of the last 30 days only",
    });
    expect(await s.fails("exercise_log_add", { ...WORKOUT, end_time: "08:25" })).toEqual({
      code: "invalid_input",
      message: "pass end_time or duration_min, not both",
      hint: "give the end of the session once",
    });
    expect(await s.fails("exercise_log_add", { exercise_type: "YOGA", start_time: "07:10" })).toEqual({
      code: "invalid_input",
      message: "end_time or duration_min is required",
      hint: "give the local end time as HH:MM, or the length of the session in minutes",
    });
    expect(await s.fails("exercise_log_add", { exercise_type: "YOGA", end_time: "08:25" })).toEqual({
      code: "invalid_input",
      message: "start_time is required with end_time",
      hint: "give the local start time as HH:MM, or give duration_min alone for a session that ended now",
    });
    expect(await s.fails("exercise_log_add", { exercise_type: "YOGA", date: day(-1), duration_min: 30 })).toEqual({
      code: "invalid_input",
      message: "start_time is required with a date before today",
      hint: "give the local start time of the session as HH:MM",
    });
    expect(await s.fails("exercise_log_add", { exercise_type: "YOGA", start_time: "07:10", end_time: "07:10" })).toEqual({
      code: "invalid_input",
      message: "the session has no length: end_time is the same instant as start_time",
      hint: "give an end after the start; an end_time before start_time on the clock is read as the next day",
    });
    expect(await s.fails("exercise_log_add", { exercise_type: "YOGA", start_time: "09:30", duration_min: 31 })).toEqual({
      code: "invalid_input",
      message: "the session ends after now",
      hint: "log a session after it ends; check date, start_time and end_time",
    });
    expect(s.steps).toEqual([]);
  });

  it.each([
    ["kcal just above 0", { kcal: 0.5 }],
    ["kcal at the bound", { kcal: MAX_KCAL }],
    ["an integer kcal", { kcal: 500 }],
  ])("takes %s", async (_name, change) => {
    const s = session();
    expect(await s.ok("exercise_log_add", { ...WORKOUT, ...change })).toMatchObject(change);
  });

  describe("the start and the end of the session", () => {
    it("ends at end_time on the same day when it is after start_time on the clock", async () => {
      const s = session();
      const out = await s.ok("exercise_log_add", { exercise_type: "YOGA", start_time: "07:10", end_time: "08:25" });
      expect(out).toMatchObject({ date: "2026-10-16", start_time: "07:10", end_time: "08:25", duration_min: 75 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-10-16T10:10:00Z"), end: new Date("2026-10-16T11:25:00Z") });
      // A session that ends at the present minute has ended.
      expect(await s.ok("exercise_log_add", { exercise_type: "YOGA", start_time: "09:00", end_time: "10:00" })).toMatchObject({ end_time: "10:00", duration_min: 60 });
      expect(await s.ok("exercise_log_add", { exercise_type: "YOGA", start_time: "09:59", duration_min: 1 })).toMatchObject({ end_time: "10:00" });
    });

    it("ends on the next local day when end_time is before start_time on the clock: a session across midnight", async () => {
      const s = session();
      const out = await s.ok("exercise_log_add", { exercise_type: "DANCING", date: day(-1), start_time: "23:30", end_time: "00:45" });
      // The date is the local day of the start, and the end is the time on the next day.
      expect(out).toMatchObject({ date: "2026-10-15", start_time: "23:30", end_time: "00:45", duration_min: 75 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-10-16T02:30:00Z"), end: new Date("2026-10-16T03:45:00Z") });
      // The session belongs to the day it started on.
      expect([...s.rows.values()]).toEqual(["2026-10-15"]);
      // One minute before the start on the clock is one minute less than a day.
      expect(await s.ok("exercise_log_add", { exercise_type: "HIKING", date: day(-1), start_time: "07:10", end_time: "07:09" })).toMatchObject({ date: "2026-10-15", duration_min: 1439 });
      // The same with a duration.
      const long = await s.ok("exercise_log_add", { exercise_type: "DANCING", date: day(-1), start_time: "23:30", duration_min: 75 });
      expect(long).toMatchObject({ date: "2026-10-15", end_time: "00:45" });
    });

    it("takes a session of 24 hours, and the day 30 days before today", async () => {
      const s = session();
      const out = await s.ok("exercise_log_add", { exercise_type: "HIKING", date: day(-2), start_time: "07:00", duration_min: MAX_DURATION_MIN });
      expect(out).toMatchObject({ date: "2026-10-14", start_time: "07:00", end_time: "07:00", duration_min: 1440 });
      expect(createBody(s.created[0] as NewExerciseSession).exercise.activeDuration).toBe("86400s");
      expect(await s.ok("exercise_log_add", { exercise_type: "HIKING", date: day(-30), start_time: "00:00", duration_min: 30 })).toMatchObject({ date: "2026-09-16" });
      expect([...s.rows.values()]).toEqual(["2026-10-14", "2026-09-16"]);
    });

    it("ended now, at the whole minute, when start_time is left out", async () => {
      const s = session({ now: new Date("2026-10-16T13:07:45.678Z") });
      const out = await s.ok("exercise_log_add", { exercise_type: "YOGA", duration_min: 45 });
      expect(out).toMatchObject({ date: "2026-10-16", start_time: "09:22", end_time: "10:07", duration_min: 45 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-10-16T12:22:00Z"), end: new Date("2026-10-16T13:07:00Z") });
      // With today's date too.
      expect(await s.ok("exercise_log_add", { exercise_type: "YOGA", date: "2026-10-16", duration_min: 45 })).toMatchObject({ start_time: "09:22", end_time: "10:07" });
    });

    it("places a session that ended now on the local day it started, also the day before", async () => {
      // 00:10:20 on 2026-10-16 in São Paulo: an hour ago was 23:10 on the 15th.
      const s = session({ now: new Date("2026-10-16T03:10:20Z") });
      const out = await s.ok("exercise_log_add", { exercise_type: "YOGA", duration_min: 60 });
      expect(out).toMatchObject({ date: "2026-10-15", start_time: "23:10", end_time: "00:10", duration_min: 60 });
      expect([...s.rows.values()]).toEqual(["2026-10-15"]);
      // Today and the 30 days are counted in the coach's zone: one minute before local midnight, today is still the 15th.
      const before = session({ now: new Date("2026-10-16T02:59:00Z") });
      expect(await before.fails("exercise_log_add", { exercise_type: "YOGA", date: "2026-10-16", start_time: "00:00", duration_min: 1 })).toMatchObject({ message: "date is after today" });
      expect(await before.fails("exercise_log_add", { exercise_type: "YOGA", date: "2026-09-14", start_time: "12:00", duration_min: 30 })).toMatchObject({ message: "date is more than 30 days before today" });
      expect(await before.ok("exercise_log_add", { exercise_type: "YOGA", date: "2026-09-15", start_time: "12:00", duration_min: 30 })).toMatchObject({ date: "2026-09-15" });
    });

    it.each([
      ["UTC", UTC, "11:00", "12:00", 0],
      ["a zone east of UTC on the half hour", new Zone("Asia/Kolkata"), "16:30", "17:30", 19_800],
      ["New York in summer time", NEW_YORK, "07:00", "08:00", -14_400],
    ])("reads the times in %s, and sends its offset", async (_name, zone, start, end, offset) => {
      const s = session({ zone });
      expect(await s.ok("exercise_log_add", { exercise_type: "YOGA", start_time: start, end_time: end })).toMatchObject({ start_time: start, end_time: end, duration_min: 60 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-10-16T11:00:00Z"), end: new Date("2026-10-16T12:00:00Z"), startUtcOffsetSeconds: offset, endUtcOffsetSeconds: offset });
    });

    // New York, 2026-03-08: the clocks go from 02:00 to 03:00.
    it("sends the offset of each instant when the clocks go forward during the session", async () => {
      const s = session({ zone: NEW_YORK, now: new Date("2026-03-08T20:00:00Z") });
      const out = await s.ok("exercise_log_add", { exercise_type: "RUNNING", start_time: "01:30", duration_min: 120 });
      // Two hours after 01:30 winter time is 04:30 summer time.
      expect(out).toMatchObject({ date: "2026-03-08", start_time: "01:30", end_time: "04:30", duration_min: 120 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-03-08T06:30:00Z"), end: new Date("2026-03-08T08:30:00Z"), startUtcOffsetSeconds: -18_000, endUtcOffsetSeconds: -14_400 });
      expect(createBody(s.created[0] as NewExerciseSession).exercise.interval).toEqual({
        startTime: "2026-03-08T06:30:00Z",
        startUtcOffset: "-18000s",
        endTime: "2026-03-08T08:30:00Z",
        endUtcOffset: "-14400s",
      });
      // With an end time: 01:30 to 03:30 on the clock is one hour of real time.
      expect(await s.ok("exercise_log_add", { exercise_type: "RUNNING", start_time: "01:30", end_time: "03:30" })).toMatchObject({ end_time: "03:30", duration_min: 60 });
      expect(s.created[1]).toMatchObject({ end: new Date("2026-03-08T07:30:00Z"), startUtcOffsetSeconds: -18_000, endUtcOffsetSeconds: -14_400 });
    });

    it("reads a time that the clocks skip as the first instant after the gap", async () => {
      const s = session({ zone: NEW_YORK, now: new Date("2026-03-08T20:00:00Z") });
      // 02:30 does not exist: the session starts at 03:00 summer time. The result shows the time that was logged.
      const out = await s.ok("exercise_log_add", { exercise_type: "RUNNING", start_time: "02:30", duration_min: 30 });
      expect(out).toMatchObject({ start_time: "03:00", end_time: "03:30", duration_min: 30 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-03-08T07:00:00Z"), startUtcOffsetSeconds: -14_400, endUtcOffsetSeconds: -14_400 });
      // Two skipped times are the same instant: a session without a length.
      expect(await s.fails("exercise_log_add", { exercise_type: "RUNNING", start_time: "02:10", end_time: "02:40" })).toMatchObject({
        code: "invalid_input",
        message: "the session has no length: end_time is the same instant as start_time",
      });
      expect(s.steps).toEqual(["create", "record"]);
    });

    // New York, 2026-11-01: the clocks go back from 02:00 to 01:00.
    it("sends the offset of each instant when the clocks go back during the session", async () => {
      const s = session({ zone: NEW_YORK, now: new Date("2026-11-01T20:00:00Z") });
      const out = await s.ok("exercise_log_add", { exercise_type: "WALKING", start_time: "00:30", end_time: "02:30" });
      // Two hours on the clock, three hours of real time.
      expect(out).toMatchObject({ date: "2026-11-01", start_time: "00:30", end_time: "02:30", duration_min: 180 });
      expect(s.created[0]).toMatchObject({ start: new Date("2026-11-01T04:30:00Z"), end: new Date("2026-11-01T07:30:00Z"), startUtcOffsetSeconds: -14_400, endUtcOffsetSeconds: -18_000 });
      expect(createBody(s.created[0] as NewExerciseSession).exercise).toMatchObject({
        interval: { startUtcOffset: "-14400s", endUtcOffset: "-18000s" },
        activeDuration: "10800s",
      });
    });

    it("refuses a session longer than 24 hours, which only a day of 25 hours can hold", async () => {
      // 2026-11-01 has 25 hours in New York: 01:30 (the first one) to 01:00 the next day is 24 hours and a half.
      const s = session({ zone: NEW_YORK, now: new Date("2026-11-02T20:00:00Z") });
      expect(await s.fails("exercise_log_add", { exercise_type: "HIKING", date: "2026-11-01", start_time: "01:30", end_time: "01:00" })).toEqual({
        code: "invalid_input",
        message: "the session is longer than 24 hours",
        hint: "log a session of at most 24 hours",
      });
      expect(s.steps).toEqual([]);
      // 24 hours of real time on that day end at 00:30 the next day on the clock.
      expect(await s.ok("exercise_log_add", { exercise_type: "HIKING", date: "2026-11-01", start_time: "01:30", duration_min: 1440 })).toMatchObject({ end_time: "00:30", duration_min: 1440 });
    });
  });

  describe("when the client or the store fails", () => {
    it("passes the error of the client on as it is, and records nothing", async () => {
      const s = session({
        create: async () => {
          throw new ToolError("upstream_unavailable", "Google Health API is unavailable", MAY_EXIST_HINTS.exercise);
        },
      });
      expect(await s.fails("exercise_log_add", WORKOUT)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: MAY_EXIST_HINTS.exercise });
      expect(s.steps).toEqual(["create"]);
      expect(s.rows.size).toBe(0);
      expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "upstream_unavailable")]);
      expect(g.logLines("error")).toEqual([]);
    });

    it("answers internal_error, with the types only in the log, for an unexpected error of the client", async () => {
      const s = session({
        create: async () => {
          throw new TypeError("bug near Capoeira angola 431.5");
        },
      });
      expect(await s.fails("exercise_log_add", WORKOUT)).toEqual({ code: "internal_error", message: "unexpected internal error" });
      expect(s.rows.size).toBe(0);
      expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: "exercise_log_add", error_types: "TypeError" }]]);
      expectNoSecret(g.logged());
    });

    it("says that the entry was created and cannot be deleted when the store write fails after Google took it", async () => {
      const s = session({ failRecord: true });
      expect(await s.fails("exercise_log_add", WORKOUT)).toEqual({
        code: "internal_error",
        message: "the entry was created in Google Health, but this server could not record it, so it cannot delete the entry",
        hint: "do not log the same workout again",
      });
      // Google holds the session: it was sent once, and the store has no row for it.
      expect(s.steps).toEqual(["create", "record"]);
      expect(s.created).toHaveLength(1);
      expect(s.rows.size).toBe(0);
      expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: "exercise_log_add", error_types: "ToolError > DiskError" }]]);
      expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "internal_error")]);
      // "disk full: synthetic secret 4242" is the text of the store's error.
      expect(g.logged()).not.toContain("4242");
      expectNoSecret(g.logged());
    });

    it("answers with the name the client returned, and no other", async () => {
      const name = "users/me/dataTypes/exercise/dataPoints/a.b_c-9";
      const s = session({ create: async () => name });
      expect((await s.ok("exercise_log_add", WORKOUT)).entry_id).toBe(name);
      expect([...s.rows.keys()]).toEqual([name]);
    });

    it("records the session for the account that was linked before the create, and for no other", async () => {
      const s = session();
      const out = await s.ok("exercise_log_add", WORKOUT);
      expect([...s.owners]).toEqual([[out.entry_id, ACCOUNT]]);
      // The create names that account to the client, which sends it only with a token of that account.
      expect(s.accounts).toEqual([ACCOUNT]);
      expect(s.reads.owner).toBe(1);
      // The account is the server's own business: it is in no result and no log line.
      expect(JSON.stringify(out)).not.toContain(ACCOUNT);
      expect(g.logged()).not.toContain(ACCOUNT);

      // A sign-in of another account, while the create is in flight: the store binds no row to the new one.
      const other = "400000000000000000004";
      const raced = session({
        create: async () => {
          raced.linked.account = other;
          return entryName(1);
        },
      });
      expect(await raced.fails("exercise_log_add", WORKOUT)).toMatchObject({ code: "internal_error", hint: "do not log the same workout again" });
      expect(raced.steps).toEqual(["create", "record"]);
      expect(raced.rows.size).toBe(0);
      for (const secret of [ACCOUNT, other]) expect(g.logged()).not.toContain(secret);
    });

    it("names no account to the client when none is linked, and passes on the error of a create that was not sent", async () => {
      // The client refuses the write when its token is not of the named account, and sends nothing.
      const notSent = new ToolError("invalid_input", "the linked Google account changed during this MCP request: the entry was not sent", "send this call in a request of its own");
      const s = session({
        account: null,
        create: async () => {
          throw notSent;
        },
      });
      expect(await s.fails("exercise_log_add", WORKOUT)).toEqual({ code: "invalid_input", message: notSent.message, hint: notSent.hint });
      expect(s.accounts).toEqual([undefined]);
      // Nothing was created, so nothing is recorded.
      expect(s.steps).toEqual(["create"]);
      expect(s.rows.size).toBe(0);
    });
  });
});

describe("exercise_log_delete", () => {
  /** A session with one entry that the server created. */
  async function withEntry(options: FakeOptions = {}) {
    const s = session(options);
    const { entry_id: entryId } = await s.ok("exercise_log_add", WORKOUT);
    s.steps.length = 0;
    g.clearLogs();
    return { s, entryId: entryId as string };
  }

  const NO_ENTRY = { code: "no_data", message: "this server created no entry with that id", hint: "it deletes only an entry that exercise_log_add created and that was not deleted yet" };

  it("checks the entry, deletes it by its data point id, then removes its row", async () => {
    const { s, entryId } = await withEntry();
    expect(await s.ok("exercise_log_delete", { entry_id: entryId })).toEqual({ entry_id: entryId, deleted: true });
    expect(s.removed).toEqual(["syn-entry-1"]);
    expect(s.steps).toEqual(["has", "delete", "forget"]);
    expect(s.rows.size).toBe(0);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_delete")]);
    expectNoSecret(g.logged());
  });

  it("answers as a delete, and removes the row, when Google no longer has the session", async () => {
    const { s, entryId } = await withEntry({ remove: async () => "gone" });
    expect(await s.ok("exercise_log_delete", { entry_id: entryId })).toEqual({ entry_id: entryId, deleted: true });
    expect(s.rows.size).toBe(0);
  });

  it("answers no_data for a second delete of the same entry, without a request", async () => {
    const { s, entryId } = await withEntry();
    await s.ok("exercise_log_delete", { entry_id: entryId });
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);
    expect(s.removed).toHaveLength(1);
  });

  const OWN = entryName(1);
  it.each([
    // The shape of an exercise data point name, and not in the table.
    ["an entry this server did not create", entryName(2), "no_data"],
    ["the same id under another user", "users/9988776655/dataTypes/exercise/dataPoints/syn-entry-1", "no_data"],
    ["the same id under users/me", "users/me/dataTypes/exercise/dataPoints/syn-entry-1", "no_data"],
    ["a session of the band", "users/me/dataTypes/exercise/dataPoints/syn-1760612400", "no_data"],
    // Not the shape of an exercise data point name.
    ["the same id under the food log", `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-entry-1`, "invalid_input"],
    ["the same id under another data type", `users/${FAKE_USER_ID}/dataTypes/sleep/dataPoints/syn-entry-1`, "invalid_input"],
    ["the name with one more path part", `${OWN}/extra`, "invalid_input"],
    ["the name with a path part before it", `v4/${OWN}`, "invalid_input"],
    ["the name with the batchDelete suffix", `${OWN}:batchDelete`, "invalid_input"],
    ["the wildcard data type", `users/${FAKE_USER_ID}/dataTypes/-/dataPoints/syn-entry-1`, "invalid_input"],
    ["the data type alone", `users/${FAKE_USER_ID}/dataTypes/exercise`, "invalid_input"],
    ["the id without its path", "syn-entry-1", "invalid_input"],
    ["the name with a space after it", `${OWN} `, "invalid_input"],
    ["the name with a line break", `${OWN}\n`, "invalid_input"],
    ["the name in upper case", OWN.toUpperCase(), "invalid_input"],
    ["a URL", `https://health.googleapis.com/v4/${OWN}`, "invalid_input"],
    ["an empty text", "", "invalid_input"],
    ["a text of 257 characters", `users/${"u".repeat(215)}/dataTypes/exercise/dataPoints/syn-entry-1`, "invalid_input"],
  ])("refuses %s before any request", async (_name, entryId, code) => {
    const { s } = await withEntry();
    const error = await s.fails("exercise_log_delete", { entry_id: entryId });
    expect(error.code).toBe(code);
    expect(error.hint).toEqual(expect.any(String));
    // Nothing was asked of Google, and the server's own entry is still there.
    expect(s.removed).toEqual([]);
    expect(s.steps.filter((step) => step !== "has")).toEqual([]);
    expect([...s.rows.keys()]).toEqual([OWN]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_delete", code)]);
  });

  it("names the rule and the tools that give an id for a text that is not an exercise data point name", async () => {
    const { s } = await withEntry();
    expect(await s.fails("exercise_log_delete", { entry_id: `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-entry-1` })).toEqual({
      code: "invalid_input",
      message: "entry_id is not the id of an exercise log entry",
      hint: "use the entry_id that exercise_log_add returned or that workout_review lists",
    });
  });

  it.each([
    ["no entry_id", {}],
    ["a null entry_id", { entry_id: null }],
    ["an entry_id that is not a text", { entry_id: 7 }],
    ["a list of ids", { entry_id: [OWN] }],
    ["a property the tool does not have", { entry_id: OWN, force: true }],
    ["a date in place of an id", { date: TODAY }],
  ])("answers invalid_input for %s", async (_name, args) => {
    const { s } = await withEntry();
    const error = await s.fails("exercise_log_delete", args);
    expect(error).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
    expect(s.steps).toEqual([]);
  });

  it("takes a text of 256 characters as an id, and no longer one", async () => {
    const { s } = await withEntry();
    const name = (userLength: number) => `users/${"u".repeat(userLength)}/dataTypes/exercise/dataPoints/syn-entry-1`;
    const fits = name(256 - name(0).length);
    expect(fits).toHaveLength(256);
    // It reaches the ownership check.
    expect(await s.fails("exercise_log_delete", { entry_id: fits })).toMatchObject({ code: "no_data" });
    expect(await s.fails("exercise_log_delete", { entry_id: `${fits}u` })).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
  });

  it("keeps the row when the client fails, so the delete can be asked again", async () => {
    const { s, entryId } = await withEntry({
      remove: async () => {
        throw new ToolError("upstream_unavailable", "Google Health API is unavailable", "try again");
      },
    });
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toMatchObject({ code: "upstream_unavailable" });
    expect(s.steps).toEqual(["has", "delete"]);
    expect([...s.rows.keys()]).toEqual([entryId]);
  });

  it("says that the entry was deleted when the store cannot remove the row after it", async () => {
    const { s, entryId } = await withEntry({ failForget: true });
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toEqual({
      code: "internal_error",
      message: "the entry was deleted in Google Health, but this server could not update its record",
      hint: "no other step is needed",
    });
    expect(s.removed).toHaveLength(1);
    expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: "exercise_log_delete", error_types: "ToolError > DiskError" }]]);
    expectNoSecret(g.logged());
  });

  it("answers no_data, without a request, for an entry of a Google account that is not the linked one", async () => {
    const { s, entryId } = await withEntry();
    // Another account is linked: its token must never delete a session of the first account.
    s.linked.account = "400000000000000000004";
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);
    expect(s.removed).toEqual([]);
    expect(s.steps).toEqual(["has"]);
    // The row stays.
    expect([...s.rows.keys()]).toEqual([entryId]);

    // The first account is linked again: the session is its own again, and the delete happens.
    s.linked.account = ACCOUNT;
    s.accounts.length = 0;
    s.reads.owner = 0;
    expect(await s.ok("exercise_log_delete", { entry_id: entryId })).toEqual({ entry_id: entryId, deleted: true });
    expect(s.removed).toEqual(["syn-entry-1"]);
    expect(s.rows.size).toBe(0);
    // The account is read once, and the delete names it to the client: the one the "not linked" check and the ownership check saw.
    expect(s.reads.owner).toBe(1);
    expect(s.accounts).toEqual([ACCOUNT]);
  });

  it("keeps the row when the client does not send the delete because its token is of another account", async () => {
    const notSent = new ToolError("invalid_input", "the linked Google account changed during this MCP request: the delete was not sent", "send this call in a request of its own");
    const { s, entryId } = await withEntry({
      remove: async () => {
        throw notSent;
      },
    });
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toEqual({ code: "invalid_input", message: notSent.message, hint: notSent.hint });
    expect(s.steps).toEqual(["has", "delete"]);
    expect([...s.rows.keys()]).toEqual([entryId]);
  });

  it.each([
    ["its own entry", entryName(1)],
    ["an entry this server did not create", entryName(2)],
  ])("answers auth_expired for %s when no Google account is linked, before the ownership check", async (_name, entryId) => {
    const { s } = await withEntry();
    // The link is gone: the row of the entry stays, and matches no account.
    s.linked.account = undefined;
    expect(await s.fails("exercise_log_delete", { entry_id: entryId })).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    // The store is not asked for the entry, and nothing is asked of Google.
    expect(s.steps).toEqual([]);
    expect(s.removed).toEqual([]);
    expect([...s.rows.keys()]).toEqual([entryName(1)]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_delete", "auth_expired")]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    // The shape of the id is checked first.
    expect(await s.fails("exercise_log_delete", { entry_id: `${entryId}/extra` })).toMatchObject({ code: "invalid_input", message: "entry_id is not the id of an exercise log entry" });
    expect(s.steps).toEqual([]);
  });
});

// The arguments of a write are its payload: a schema error names a declared
// property and the rule that failed, never a key or a value that the client
// sent.
describe("a schema error of an exercise log tool", () => {
  const SCHEMA_PREFIX = "the arguments do not match the tool's input schema: ";
  const UNKNOWN = `${SCHEMA_PREFIX}the arguments hold a property that the tool does not have`;

  /** The whole error, as the client reads it, and the log of the call. */
  async function schemaError(tool: string, args: unknown): Promise<string> {
    const s = session();
    g.clearLogs();
    const wire = await s.fails(tool, args);
    expect(wire.code).toBe("invalid_input");
    expect(wire.hint).toBe(SCHEMA_HINT);
    expect(wire.message.startsWith(SCHEMA_PREFIX)).toBe(true);
    // Nothing was sent, and nothing of the arguments is in a log line.
    expect(s.steps).toEqual([]);
    expectNoSecret(g.logged());
    expect(g.logLines("log")).toEqual([toolCall(tool, "invalid_input")]);
    return wire.message;
  }

  it("does not repeat an activity name, the notes or an entry id that was sent as the key of a property", async () => {
    expect(await schemaError("exercise_log_add", { ...WORKOUT, "Capoeira angola": true })).toBe(UNKNOWN);
    expect(await schemaError("exercise_log_add", { ...WORKOUT, "Roda de sexta 431.5": 75 })).toBe(UNKNOWN);
    expect(await schemaError("exercise_log_delete", { entry_id: entryName(1), [entryName(1)]: true })).toBe(UNKNOWN);
  });

  it.each([
    ["an exercise type that is a number", "exercise_log_add", { exercise_type: 431.5 }, "exercise_type must be a text"],
    ["an exercise type that is a list with the activity", "exercise_log_add", { exercise_type: ["Capoeira angola"] }, "exercise_type must be a text"],
    ["a kcal that is a text of a number", "exercise_log_add", { kcal: "431.5" }, "kcal must be a number or null"],
    ["a kcal that is an object with the activity", "exercise_log_add", { kcal: { "Capoeira angola": 431.5 } }, "kcal must be a number or null"],
    ["a duration that is a text", "exercise_log_add", { duration_min: "Roda de sexta" }, "duration_min must be a whole number or null"],
    ["a duration with a fraction", "exercise_log_add", { duration_min: 431.5 }, "duration_min must be a whole number or null"],
    ["a date that is the activity", "exercise_log_add", { date: "Capoeira angola" }, "date must be a date, YYYY-MM-DD"],
    ["a start time that is the activity", "exercise_log_add", { start_time: "Capoeira angola" }, "start_time does not have the format that its description gives"],
    ["an end time that is a number", "exercise_log_add", { end_time: 431.5 }, "end_time must be a text or null"],
    ["notes that are a number", "exercise_log_add", { notes: 431.5 }, "notes must be a text or null"],
    ["an entry id that is a number", "exercise_log_delete", { entry_id: 431.5 }, "entry_id must be a text"],
    ["an entry id longer than the cap", "exercise_log_delete", { entry_id: `${entryName(1)}${"-syn-entry".repeat(30)}` }, "entry_id must be at most 256 characters"],
  ] as [string, string, Record<string, unknown>, string][])("names the property and its rule for %s, and never the value", async (_name, tool, change, message) => {
    const base = tool === "exercise_log_add" ? WORKOUT : {};
    expect(await schemaError(tool, { ...base, ...change })).toBe(`${SCHEMA_PREFIX}${message}`);
  });

  it("names a property that is missing, and has one text for arguments that are not an object", async () => {
    expect(await schemaError("exercise_log_add", { start_time: "07:10", duration_min: 75 })).toBe(`${SCHEMA_PREFIX}exercise_type is required`);
    expect(await schemaError("exercise_log_delete", {})).toBe(`${SCHEMA_PREFIX}entry_id is required`);
    for (const args of ["Capoeira angola", 431.5, null]) expect(await schemaError("exercise_log_add", args)).toBe(`${SCHEMA_PREFIX}the arguments must be an object`);
  });
});

// From here on: the object, the real client and store, and the fake API.

const storedSessions = (stub: DurableObjectStub<CoachStore>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT * FROM exercise_entries ORDER BY name").toArray());

const createdName = (n: number) => `users/${FAKE_USER_ID}/dataTypes/exercise/dataPoints/syn-created-${n}`;
/** The name a list gives the same point: under users/me. */
const listedName = (n: number) => `users/me/dataTypes/exercise/dataPoints/syn-created-${n}`;

const EXERCISE_URL = "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints";
const EXERCISE_SCOPE_HINT = `${RECONNECT_HINT} Allow the permission to add exercise data (googlehealth.activity_and_fitness.writeonly), and check that the Google Health API is enabled in the Cloud project.`;

/** The error.message a write refusal repeats. The marked text sits in another field, which must not be repeated. */
const GOOGLE_MESSAGE = "Request contains an invalid argument.";
const googleError = (status: number, grpc: string) => () =>
  Response.json(
    { error: { code: status, message: GOOGLE_MESSAGE, status: grpc, details: [{ "@type": "type.googleapis.com/google.rpc.DebugInfo", detail: `${BODY_MARK} for ${STORED_TOKEN}` }] } },
    { status },
  );

async function ok(stub: DurableObjectStub<CoachStore>, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const outcome = await objectTool(stub, name, args);
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.output;
}

describe("the fake Google Health API of the tests", () => {
  /** A create of the body, as the fake API answers it. */
  async function create(body: unknown): Promise<{ status: number; error?: { status?: string; message?: string; details?: { "@type"?: string; reason?: string }[] } }> {
    const response = await g.google.respond(new Request(EXERCISE_URL, { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json()) as object) };
  }

  const valid = () =>
    createBody({
      exerciseType: "RUNNING",
      displayName: "Running",
      start: new Date("2026-10-16T10:10:00Z"),
      end: new Date("2026-10-16T11:25:00Z"),
      startUtcOffsetSeconds: -10_800,
      endUtcOffsetSeconds: -10_800,
    }) as Record<string, any>;

  it("takes the body the client builds, and the documented example", async () => {
    expect((await create(valid())).status).toBe(200);
    // The request of the guide's example has no displayName, which the reference marks as required: with one, it is taken.
    const example = {
      dataSource: { recordingMethod: "ACTIVELY_MEASURED", platform: "GOOGLE_WEB_API" },
      exercise: {
        interval: { startTime: "2026-04-20T08:00:00Z", startUtcOffset: "0s", endTime: "2026-04-20T08:35:00Z", endUtcOffset: "0s" },
        exerciseType: "RUNNING",
        displayName: "Run",
        activeDuration: "1800s",
        metricsSummary: { caloriesKcal: 380.0 },
      },
    };
    expect((await create(example)).status).toBe(200);
    expect(g.google.createdPoints("exercise")).toHaveLength(2);
  });

  // The rules the reference documents for an Exercise. A fake that accepts a
  // body the real API refuses hides the defect: a food entry whose interval
  // had no length passed such a fake, and Google refused it.
  it.each([
    ["no exercise", (body: Record<string, any>) => delete body.exercise, "SYNTHETIC_EXERCISE_MISSING"],
    ["no start time", (body: Record<string, any>) => delete body.exercise.interval.startTime, "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["no start offset", (body: Record<string, any>) => delete body.exercise.interval.startUtcOffset, "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["no end time", (body: Record<string, any>) => delete body.exercise.interval.endTime, "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["no end offset", (body: Record<string, any>) => delete body.exercise.interval.endUtcOffset, "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["no interval", (body: Record<string, any>) => delete body.exercise.interval, "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["an offset that is a number", (body: Record<string, any>) => (body.exercise.interval.endUtcOffset = -10_800), "SYNTHETIC_INTERVAL_INCOMPLETE"],
    ["an end at the start", (body: Record<string, any>) => (body.exercise.interval.endTime = body.exercise.interval.startTime), "SYNTHETIC_INTERVAL_EMPTY"],
    ["an end before the start", (body: Record<string, any>) => (body.exercise.interval.endTime = "2026-10-16T10:09:59Z"), "SYNTHETIC_INTERVAL_EMPTY"],
    ["a type that is not in the enum", (body: Record<string, any>) => (body.exercise.exerciseType = "CAPOEIRA"), "SYNTHETIC_EXERCISE_TYPE_UNKNOWN"],
    ["a type in lower case", (body: Record<string, any>) => (body.exercise.exerciseType = "running"), "SYNTHETIC_EXERCISE_TYPE_UNKNOWN"],
    ["the unspecified type", (body: Record<string, any>) => (body.exercise.exerciseType = "EXERCISE_TYPE_UNSPECIFIED"), "SYNTHETIC_EXERCISE_TYPE_UNKNOWN"],
    ["no type", (body: Record<string, any>) => delete body.exercise.exerciseType, "SYNTHETIC_EXERCISE_TYPE_UNKNOWN"],
    ["no display name", (body: Record<string, any>) => delete body.exercise.displayName, "SYNTHETIC_DISPLAY_NAME_MISSING"],
    ["an empty display name", (body: Record<string, any>) => (body.exercise.displayName = ""), "SYNTHETIC_DISPLAY_NAME_MISSING"],
    ["no metrics summary", (body: Record<string, any>) => delete body.exercise.metricsSummary, "SYNTHETIC_METRICS_SUMMARY_MISSING"],
    ["a null metrics summary", (body: Record<string, any>) => (body.exercise.metricsSummary = null), "SYNTHETIC_METRICS_SUMMARY_MISSING"],
  ] as [string, (body: Record<string, any>) => unknown, string][])("refuses an exercise create with %s: HTTP 400, INVALID_ARGUMENT and an ErrorInfo", async (_name, damage, reason) => {
    const body = valid();
    damage(body);
    const answer = await create(body);
    expect(answer.status).toBe(400);
    expect(answer.error).toMatchObject({ status: "INVALID_ARGUMENT", message: expect.any(String), details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] });
    // Nothing was created.
    expect(g.google.createdPoints("exercise")).toEqual([]);
  });

  it("keeps the display name of the body for OTHER only, as the reference says", async () => {
    await create(valid());
    const other = valid();
    other.exercise.exerciseType = "OTHER";
    other.exercise.displayName = "Capoeira angola";
    await create(other);
    expect(g.google.createdPoints("exercise").map((point) => point.exercise.displayName)).toEqual([generatedName("RUNNING"), "Capoeira angola"]);
    expect(generatedName("RUNNING")).not.toBe("Running");
  });
});

describe("the exercise log tools through /mcp of the object", () => {
  it("are listed after the food log tools: 22 tools in all", async () => {
    const reply = await objectRpc(freshStore(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (reply.result as { tools: { name: string; annotations?: Record<string, unknown> }[] }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);
    expect(tools).toHaveLength(22);
    const names = tools.map((tool) => tool.name);
    expect(names.slice(names.indexOf("nutrition_log_add"))).toEqual(["nutrition_log_add", "nutrition_log_delete", "exercise_log_add", "exercise_log_delete"]);
    expect(tools.find((tool) => tool.name === "exercise_log_add")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(tools.find((tool) => tool.name === "exercise_log_delete")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  });

  it("add sends one create with the documented body and records the session", async () => {
    const stub = await linkedStore();
    const outcome = await objectTool(stub, "exercise_log_add", WORKOUT);
    expect(outcome).toEqual({
      ok: true,
      output: { entry_id: createdName(1), date: TODAY, start_time: "07:10", end_time: "08:25", duration_min: 75, exercise_type: "OTHER", kcal: 431.5, notice: EXERCISE_LOG_NOTICE },
    });
    // One request to Google Health, with the stored token; no token request.
    expect(g.takeExternal()).toEqual({ total: 1, "create exercise": 1 });
    expect(g.auths).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(JSON.stringify(g.google.writes)).toBe(
      '[{"kind":"create","body":{"dataSource":{"recordingMethod":"MANUAL","platform":"GOOGLE_WEB_API"},"exercise":{"interval":{"startTime":"2026-10-16T10:10:00Z",' +
        '"startUtcOffset":"-10800s","endTime":"2026-10-16T11:25:00Z","endUtcOffset":"-10800s"},"exerciseType":"OTHER","displayName":"Capoeira angola",' +
        '"activeDuration":"4500s","metricsSummary":{"caloriesKcal":431.5},"notes":"Roda de sexta"}}}]',
    );
    // The row holds the linked Google account, the name, the local day and the creation time: no activity name, no notes, no value.
    expect(await storedSessions(stub)).toEqual([{ sub: OWNER_SUB, name: createdName(1), day: TODAY, created_at: "2026-10-16T13:00:00.000000000Z" }]);
    // The food entries have a table of their own, and it is empty.
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM nutrition_entries").one())).toEqual({ n: 0 });
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add")]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("sends every listed type as a type the documented enum holds, and the fake API takes each one", async () => {
    const stub = await linkedStore();
    for (const type of EXERCISE_TYPES) {
      const out = await ok(stub, "exercise_log_add", { exercise_type: type.toLowerCase().replaceAll("_", " "), start_time: "06:00", duration_min: 30 });
      expect(out.exercise_type, type).toBe(type);
      expect(g.google.writes.at(-1)?.body.exercise.exerciseType, type).toBe(type);
    }
    expect(g.google.createdPoints("exercise")).toHaveLength(EXERCISE_TYPES.length);
    expect(g.takeExternal()).toEqual({ total: EXERCISE_TYPES.length, "create exercise": EXERCISE_TYPES.length });
  });

  it("delete sends one batchDelete for the session and removes its row, and a second delete is no_data", async () => {
    const stub = await linkedStore();
    const added = await ok(stub, "exercise_log_add", WORKOUT);
    await ok(stub, "exercise_log_add", { exercise_type: "YOGA", start_time: "06:00", duration_min: 30 });
    g.takeExternal();
    g.clearLogs();

    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({ ok: true, output: { entry_id: createdName(1), deleted: true } });
    expect(g.takeExternal()).toEqual({ total: 1, "delete exercise": 1 });
    // The name is sent under users/me, the form of the request path.
    expect(g.google.writes.at(-1)).toEqual({ kind: "delete", body: { names: [listedName(1)] } });
    // Only that session is gone, in Google and in the store.
    expect(g.google.createdPoints("exercise").map((point) => point.name)).toEqual([listedName(2)]);
    expect(await storedSessions(stub)).toMatchObject([{ name: createdName(2) }]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_delete")]);

    // A second delete of the same id: no_data, and no request.
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({
      ok: false,
      error: { code: "no_data", message: "this server created no entry with that id", hint: "it deletes only an entry that exercise_log_add created and that was not deleted yet" },
    });
    expect(g.takeExternal()).toEqual({ total: 0 });
    expectNoSecret(g.logged());
  });

  it("delete takes Google's own 404 (NOT_FOUND) as a session that is already gone, and no other 404", async () => {
    const stub = await linkedStore();
    const added = await ok(stub, "exercise_log_add", WORKOUT);
    g.takeExternal();
    g.clearLogs();
    // The HTML page of a front end does not prove that the session is gone: the row stays.
    g.healthReply = () => new Response(`<html>Error 404 ${BODY_MARK}</html>`, { status: 404, headers: { "content-type": "text/html" } });
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "Google Health refused the delete", hint: "the entry was not deleted" },
    });
    expect(await storedSessions(stub)).toMatchObject([{ name: createdName(1) }]);
    expect(g.logLines("warn")).toEqual([["google health request rejected", { data_type: "exercise", http_status: 404, google_status: "" }]]);

    g.healthReply = googleError(404, "NOT_FOUND");
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({ ok: true, output: { entry_id: createdName(1), deleted: true } });
    expect(await storedSessions(stub)).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("never asks Google for a session the store does not hold, whatever exists there", async () => {
    const stub = await linkedStore();
    // A session that another store of this server created, and a session of the band.
    const other = await linkedStore();
    const theirs = await ok(other, "exercise_log_add", WORKOUT);
    g.google.add("exercise", exerciseRec(at(TODAY, 6, 0), at(TODAY, 7, 0), { type: "RUNNING", name: "users/me/dataTypes/exercise/dataPoints/syn-band" }));
    g.takeExternal();
    for (const entryId of [theirs.entry_id as string, listedName(1), "users/me/dataTypes/exercise/dataPoints/syn-band", `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-created-1`, `${createdName(1)}/x`]) {
      const outcome = await objectTool(stub, "exercise_log_delete", { entry_id: entryId });
      expect(outcome.ok, entryId).toBe(false);
    }
    expect(g.takeExternal()).toEqual({ total: 0 });
    expect(g.google.createdPoints("exercise")).toHaveLength(1);
  });

  it("keeps the two logs apart: neither delete tool takes an id of the other data type", async () => {
    const stub = await linkedStore();
    const workout = await ok(stub, "exercise_log_add", WORKOUT);
    const food = await ok(stub, "nutrition_log_add", { name: "Synthetic food", meal_type: "LUNCH", kcal: 100 });
    g.takeExternal();
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: workout.entry_id })).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "entry_id is not the id of a food log entry", hint: "use the entry_id that nutrition_log_add returned or that nutrition_day lists" },
    });
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: food.entry_id })).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "entry_id is not the id of an exercise log entry", hint: "use the entry_id that exercise_log_add returned or that workout_review lists" },
    });
    // The same data point id under the other data type is not an entry of that type.
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: (food.entry_id as string).replace("nutrition-log", "exercise") })).toMatchObject({ ok: false, error: { code: "no_data" } });
    expect(g.takeExternal()).toEqual({ total: 0 });
    // Both entries are still there, and each delete tool deletes its own.
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: workout.entry_id })).toMatchObject({ ok: true });
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: food.entry_id })).toMatchObject({ ok: true });
    expect(g.takeExternal()).toEqual({ total: 2, "delete exercise": 1, "delete nutrition-log": 1 });
  });

  it("surfaces a refusal of Google: the ErrorInfo reason and the short message, with the exercise data type in the log", async () => {
    const stub = await linkedStore();
    // The request of the tool reaches the fake API with one rule broken: an end at the start.
    g.healthReply = async (request) => {
      const body = (await request.clone().json()) as { exercise: { interval: { startTime: string; endTime: string } } };
      body.exercise.interval.endTime = body.exercise.interval.startTime;
      return g.google.respond(new Request(request.url, { method: "POST", body: JSON.stringify(body) }));
    };
    expect(await objectTool(stub, "exercise_log_add", WORKOUT)).toEqual({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Google Health refused the entry: SYNTHETIC_INTERVAL_EMPTY: interval.end_time must be after interval.start_time",
        hint: "the entry was not created; check the date, the time and the values",
      },
    });
    // One request, no retry, nothing created and nothing recorded.
    expect(g.takeExternal()).toEqual({ total: 1, "create exercise": 1 });
    expect(g.google.createdPoints("exercise")).toEqual([]);
    expect(await storedSessions(stub)).toEqual([]);
    expect(g.logLines("warn")).toEqual([
      [
        "google health request rejected",
        { data_type: "exercise", http_status: 400, google_status: "INVALID_ARGUMENT", google_reason: "SYNTHETIC_INTERVAL_EMPTY", google_message: "interval.end_time must be after interval.start_time" },
      ],
    ]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "invalid_input")]);
    expectNoSecret(g.logged());
  });

  it("does not repeat the activity name, the notes, the kcal value or the entry id that a refusal of Google repeats", async () => {
    const stub = await linkedStore();
    const refusal = (message: string) => () =>
      Response.json(
        { error: { code: 400, status: "INVALID_ARGUMENT", message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SYNTHETIC_FIELD_REJECTED", domain: "health.googleapis.com" }] } },
        { status: 400 },
      );
    const rejected = (message: string) => [
      "google health request rejected",
      { data_type: "exercise", http_status: 400, google_status: "INVALID_ARGUMENT", google_reason: "SYNTHETIC_FIELD_REJECTED", google_message: message },
    ];
    // Google repeats the three values of the call, one of them in another letter case.
    g.healthReply = refusal('display_name "CAPOEIRA ANGOLA", notes "Roda de sexta" and calories_kcal 431.5 are not accepted for OTHER');
    const kept = 'display_name " ", notes " " and calories_kcal are not accepted for OTHER';
    expect(await objectTool(stub, "exercise_log_add", WORKOUT)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: `Google Health refused the entry: SYNTHETIC_FIELD_REJECTED: ${kept}`, hint: "the entry was not created; check the date, the time and the values" },
    });
    expect(g.logLines("warn")).toEqual([rejected(kept)]);
    expect(g.logged().toLowerCase()).not.toContain("capoeira");
    expectNoSecret(g.logged());

    // A delete whose refusal repeats the id of the data point.
    g.healthReply = undefined;
    const added = await ok(stub, "exercise_log_add", WORKOUT);
    g.clearLogs();
    g.healthReply = refusal("data point syn-created-1 cannot be deleted");
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "Google Health refused the delete: SYNTHETIC_FIELD_REJECTED: data point cannot be deleted", hint: "the entry was not deleted" },
    });
    expect(g.logLines("warn")).toEqual([rejected("data point cannot be deleted")]);
    // The row stays: the delete did not happen.
    expect(await storedSessions(stub)).toMatchObject([{ name: createdName(1) }]);
    expectNoSecret(g.logged());
  });

  it.each([
    ["Google answers 503", () => googleError(503, "UNAVAILABLE")(), "upstream_unavailable", ["tool_call"]],
    ["Google refuses the entry", () => googleError(400, "INVALID_ARGUMENT")(), "invalid_input", ["tool_call", "google health request rejected"]],
    [
      "the request does not complete",
      () => {
        throw new TypeError(`${BODY_MARK}: Capoeira angola 431.5`);
      },
      "upstream_unavailable",
      ["tool_call", "google health request did not complete"],
    ],
    [
      "Google answers an Operation that is not finished",
      () => Response.json({ name: `operations/${BODY_MARK}`, metadata: { activity: "Capoeira angola", kcal: 431.5 } }),
      "upstream_unavailable",
      ["tool_call", "google health write answer not usable"],
    ],
    [
      "Google names a food log entry in its answer",
      () => Response.json({ done: true, response: { name: `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-created-9` } }),
      "upstream_unavailable",
      ["tool_call", "google health write answer not usable"],
    ],
  ] as [string, () => Response, string, string[]][])("an add that fails because %s logs no part of the session, and names the exercise data type", async (_name, reply, code, messages) => {
    const stub = await linkedStore();
    g.healthReply = reply;
    const outcome = await objectTool(stub, "exercise_log_add", WORKOUT);
    expect(outcome).toMatchObject({ ok: false, error: { code } });
    if (!outcome.ok) {
      expectNoSecret(JSON.stringify(outcome.error));
      // A create whose outcome is unknown points to the read of the sessions, never to the food log.
      if (code === "upstream_unavailable") expect(outcome.error.hint).toBe(MAY_EXIST_HINTS.exercise);
    }
    // One request: a create is never sent again when its outcome is unknown.
    expect(g.takeExternal()).toEqual({ total: 1, "create exercise": 1 });
    expect(await storedSessions(stub)).toEqual([]);
    const lines = (["log", "info", "warn", "error", "debug"] as const).flatMap((level) => g.logLines(level)) as [string, Record<string, unknown>][];
    expect(lines.map(([message]) => message)).toEqual(messages);
    // Every line of the client names the data type of the write.
    for (const [message, fields] of lines) if (message !== "tool_call") expect(fields.data_type, message).toBe("exercise");
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", code)]);
    expectNoSecret(g.logged());
  });

  it("answers scope_missing with the exercise write scope for an HTTP 403, for the add and for the delete", async () => {
    const stub = await linkedStore();
    const added = await ok(stub, "exercise_log_add", WORKOUT);
    g.takeExternal();
    g.healthReply = googleError(403, "PERMISSION_DENIED");
    const expected = { ok: false, error: { code: "scope_missing", message: "Google Health denied the write of exercise data", hint: EXERCISE_SCOPE_HINT } };
    expect(await objectTool(stub, "exercise_log_add", WORKOUT)).toEqual(expected);
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual(expected);
    expect(g.takeExternal()).toEqual({ total: 2, "create exercise": 1, "delete exercise": 1 });
    // The session was not deleted: its row stays, so the delete can be asked again.
    expect(await storedSessions(stub)).toMatchObject([{ name: createdName(1) }]);
    expectNoSecret(g.logged());
  });

  it("google_account_status names the missing exercise write scope and the two tools that need it", async () => {
    // An account that signed in before the exercise write scope was requested.
    const granted = GOOGLE_HEALTH_SCOPES.filter((scope) => scope !== WRITE_SCOPES.exercise.scope);
    const stub = await linkedStore({ scopes: ["openid", "email", ...granted].join(" ") });
    const status = await ok(stub, "google_account_status");
    expect(status).toMatchObject({ linked: true, token: "ok", scopes_missing: ["https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly"] });
    expect(status.hint).toBe(
      "Some Google Health permissions were not granted. exercise_log_add and exercise_log_delete need googlehealth.activity_and_fitness.writeonly, " +
        "which a new sign-in grants. Disconnect and reconnect this connector in the MCP client to sign in with Google again.",
    );
    // Every scope granted: no hint. A missing read scope alone: the hint as it was.
    expect((await ok(await linkedStore(), "google_account_status")).hint).toBeNull();
    const withoutSleep = GOOGLE_HEALTH_SCOPES.filter((scope) => !scope.endsWith("sleep.readonly"));
    expect((await ok(await linkedStore({ scopes: withoutSleep.join(" ") }), "google_account_status")).hint).toBe(
      "Some Google Health permissions were not granted. Disconnect and reconnect this connector in the MCP client to sign in with Google again.",
    );
    expect(g.external).toEqual([]);
  });

  it("answers auth_expired without a request when no Google account is linked, and invalid_input first for a malformed id", async () => {
    const stub = freshStore();
    for (const [name, args] of [
      ["exercise_log_add", WORKOUT],
      ["exercise_log_delete", { entry_id: createdName(1) }],
    ] as const) {
      expect(await objectTool(stub, name, args), name).toEqual({ ok: false, error: { code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT } });
    }
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: `${createdName(1)}/x` })).toMatchObject({ ok: false, error: { code: "invalid_input", message: "entry_id is not the id of an exercise log entry" } });
    expect(g.external).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "auth_expired"), toolCall("exercise_log_delete", "auth_expired"), toolCall("exercise_log_delete", "invalid_input")]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("knows a session only while the account it was created for is the linked one", async () => {
    const stub = await linkedStore();
    const added = await ok(stub, "exercise_log_add", WORKOUT);
    g.takeExternal();
    // Another Google account signs in: the session of the first one is not this server's own now.
    await stub.linkGoogleAccount(link({ sub: "200000000000000000002", email: "other@example.com" }));
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toMatchObject({ ok: false, error: { code: "no_data" } });
    // The link is removed: the answer names the sign-in, for every well-formed id.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toMatchObject({ ok: false, error: { code: "auth_expired" } });
    expect(g.takeExternal()).toEqual({ total: 0 });
    expect(await storedSessions(stub)).toMatchObject([{ sub: OWNER_SUB, name: createdName(1) }]);
    // The first account signs in again: the same delete now happens.
    await stub.linkGoogleAccount(link());
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: added.entry_id })).toEqual({ ok: true, output: { entry_id: createdName(1), deleted: true } });
    expect(g.takeExternal()).toEqual({ total: 1, "delete exercise": 1 });
    expect(await storedSessions(stub)).toEqual([]);
  });

  it("says that the session exists when the store cannot record it, and logs only the tool and the error types", async () => {
    const stub = await linkedStore();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE exercise_entries");
    });
    expect(await objectTool(stub, "exercise_log_add", WORKOUT)).toEqual({
      ok: false,
      error: {
        code: "internal_error",
        message: "the entry was created in Google Health, but this server could not record it, so it cannot delete the entry",
        hint: "do not log the same workout again",
      },
    });
    // Google took the session, once.
    expect(g.takeExternal()).toEqual({ total: 1, "create exercise": 1 });
    expect(g.google.createdPoints("exercise")).toHaveLength(1);
    expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: "exercise_log_add", error_types: expect.stringMatching(/^ToolError > \w*Error$/) }]]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "internal_error")]);
    expectNoSecret(g.logged());
  });
});

describe("the reads of a session this server logged", () => {
  const JIU_JITSU_DAY = day(-2);

  /** A month of the band's data, a session of another platform on the 14th, and two sessions logged through the tool on that day. */
  async function logged() {
    const stub = await linkedStore();
    everything(g.google);
    g.google.add("exercise", exerciseRec(at(JIU_JITSU_DAY, 15, 0), at(JIU_JITSU_DAY, 15, 30), { type: "WALKING", platform: "HEALTH_KIT", kcal: 90 }));
    // 12:00 to 12:45: no session of the band covers that time.
    const own = await ok(stub, "exercise_log_add", { exercise_type: "Capoeira angola", date: JIU_JITSU_DAY, start_time: "12:00", duration_min: 45, kcal: 300.5, notes: "Roda de sexta" });
    // 07:30 to 08:30: the band recorded a class from 07:00 to 08:00.
    const twice = await ok(stub, "exercise_log_add", { exercise_type: "jiu-jitsu", date: JIU_JITSU_DAY, start_time: "07:30", end_time: "08:30" });
    g.takeExternal();
    g.clearLogs();
    return { stub, own, twice };
  }

  it("workout_review shows a logged session next to the band's, with entry_id, manual_entry and no heart rate", async () => {
    const { stub, own, twice } = await logged();
    const review = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    const sessions = review.data.sessions as Record<string, any>[];
    // In time order: the band's class, the logged class, the logged roda, the band's run. The walk of another platform is left out.
    expect(sessions.map((one) => [one.type, one.start.slice(11, 16), one.source])).toEqual([
      ["JIU_JITSU", "07:00", "Synthetic Band"],
      ["JIU_JITSU", "07:30", "GOOGLE_WEB_API"],
      ["OTHER", "12:00", "GOOGLE_WEB_API"],
      ["RUNNING", "18:00", "Synthetic Band"],
    ]);
    // A session of the band has no entry_id; a logged one has the name the create answered, which a list writes under users/me.
    expect(sessions.map((one) => one.entry_id)).toEqual([null, twice.entry_id, own.entry_id, null]);
    expect([own.entry_id, twice.entry_id]).toEqual([createdName(1), createdName(2)]);
    expect(sessions.map((one) => one.exercise_id).slice(1, 3)).toEqual([listedName(2), listedName(1)]);
    expect(sessions[1]).toEqual({
      exercise_id: listedName(2),
      type: "JIU_JITSU",
      // Google's own name for a type other than OTHER.
      name: generatedName("JIU_JITSU"),
      start: "2026-10-14T07:30:00-03:00",
      end: "2026-10-14T08:30:00-03:00",
      active_min: 60,
      avg_hr_bpm: null,
      max_hr_bpm: null,
      heart_rate_zone_minutes: null,
      kcal: null,
      azm_min: 0,
      // It covers time of the band's class: the same workout may be there twice.
      quality_flags: ["manual_entry", "no_hr_data", "overlaps_band_session"],
      source: "GOOGLE_WEB_API",
      entry_id: createdName(2),
    });
    expect(sessions[2]).toMatchObject({ type: "OTHER", name: "Capoeira angola", active_min: 45, kcal: 300.5, avg_hr_bpm: null, quality_flags: ["manual_entry", "no_hr_data"] });
    // Nothing of the two records is merged: the band's class keeps its own values and flags.
    expect(sessions[0]).toMatchObject({ active_min: 60, avg_hr_bpm: 81, kcal: 400, quality_flags: ["low_hr_for_activity"], entry_id: null });
    expect(sessions[3]).toMatchObject({ quality_flags: [], entry_id: null });
    // The week counts each record: the band's four sessions and the two logged ones.
    expect(review.data.week_context).toMatchObject({ sessions: 6, active_min_by_type: { RUNNING: 70, JIU_JITSU: 120, OTHER: 45, WALKING: 30 } });
    // The overlap is on the result too, once: the class is in the week's count and minutes twice.
    expect((review.quality_flags as string[]).filter((flag) => flag === "overlaps_band_session")).toHaveLength(1);
    for (const flag of ["other_source_sessions_excluded", "low_hr_for_activity", "manual_entry", "no_hr_data", "overlaps_band_session"]) expect(review.quality_flags, flag).toContain(flag);
    expect(review.sources).toEqual(expect.arrayContaining(["GOOGLE_WEB_API", "Synthetic Band"]));
    // The heart rate is listed for the band's two sessions only, and the read writes nothing.
    const external = g.takeExternal();
    expect(external["heart-rate"]).toBe(2);
    expect(external["create exercise"] ?? 0).toBe(0);

    // By exercise_id, the id of the list: the same session, with the same entry_id.
    const one = await ok(stub, "workout_review", { exercise_id: listedName(2) });
    expect(one.data.sessions).toEqual([sessions[1]]);
  });

  it("weekly_report and morning_briefing count a logged session, by type and never by name", async () => {
    const { stub } = await logged();
    const week = await ok(stub, "weekly_report");
    // The band's four sessions of the week (a run, the class and a run, a walk) and the two logged ones.
    expect(week.data.adherence.sessions).toBe(6);
    // Two of the six may be the same class: the logged one overlaps the band's.
    expect(week.quality_flags).toContain("overlaps_band_session");
    expect(week.quality_flags).toContain("other_source_sessions_excluded");
    expect(week.sources).toContain("GOOGLE_WEB_API");
    // The briefing of the 15th reports the load of the 14th.
    const briefing = await ok(stub, "morning_briefing", { date: day(-1) });
    expect(briefing.data.yesterday_load.exercises).toEqual([
      { type: "JIU_JITSU", minutes: 60, avg_hr_bpm: 81, quality_flags: ["low_hr_for_activity"] },
      { type: "JIU_JITSU", minutes: 60, avg_hr_bpm: null, quality_flags: ["manual_entry", "no_hr_data", "overlaps_band_session"] },
      { type: "OTHER", minutes: 45, avg_hr_bpm: null, quality_flags: ["manual_entry", "no_hr_data"] },
      { type: "RUNNING", minutes: 30, avg_hr_bpm: 150, quality_flags: [] },
    ]);
    expect(briefing.quality_flags).toContain("other_source_sessions_excluded");
    // Every flag of a listed session is a flag of the briefing.
    for (const flag of ["low_hr_for_activity", "manual_entry", "no_hr_data", "overlaps_band_session"]) expect(briefing.quality_flags, flag).toContain(flag);
    expect(JSON.stringify(briefing)).not.toContain("Capoeira");
    expect(JSON.stringify(week)).not.toContain("Capoeira");
    // No read logs a name, a value or the notes of the session.
    expectNoSecret(g.logged());
  });

  it("workout_review and weekly_report show an overlap of the week on the result, also when the reviewed day has none", async () => {
    const { stub, twice } = await logged();
    // The 15th has the band's walk only. The overlap is on the 14th, in the same ISO week.
    const other = await ok(stub, "workout_review", { date: day(-1) });
    const sessions = other.data.sessions as Record<string, any>[];
    expect(sessions.map((one) => [one.type, one.quality_flags])).toEqual([["WALKING", []]]);
    // The week holds the class twice, as two records: the count and the minutes are per record.
    expect(other.data.week_context).toMatchObject({ sessions: 6, active_min_by_type: { RUNNING: 70, JIU_JITSU: 120, OTHER: 45, WALKING: 30 } });
    expect(other.quality_flags).toContain("overlaps_band_session");
    // The flags of a session of another day are not on the result: only the overlap changes what the week counts.
    for (const flag of ["manual_entry", "no_hr_data", "low_hr_for_activity"]) expect(other.quality_flags, flag).not.toContain(flag);
    // By exercise_id of the band's walk: the same week, the same flag.
    const byId = await ok(stub, "workout_review", { exercise_id: sessions[0]?.exercise_id });
    expect(byId.data.sessions).toHaveLength(1);
    expect(byId.quality_flags).toContain("overlaps_band_session");
    expect((await ok(stub, "weekly_report")).quality_flags).toContain("overlaps_band_session");

    // Without the overlapping session, the week still has a logged session (the roda), and it overlaps nothing.
    await ok(stub, "exercise_log_delete", { entry_id: twice.entry_id });
    const after = await ok(stub, "workout_review", { date: day(-1) });
    expect(after.data.week_context).toMatchObject({ sessions: 5, active_min_by_type: { RUNNING: 70, JIU_JITSU: 60, OTHER: 45, WALKING: 30 } });
    expect(after.quality_flags).not.toContain("overlaps_band_session");
    const week = await ok(stub, "weekly_report");
    expect(week.data.adherence.sessions).toBe(5);
    expect(week.quality_flags).not.toContain("overlaps_band_session");
    expect(week.sources).toContain("GOOGLE_WEB_API");
    // The day of the roda: a logged session, listed, without the flag.
    const rodaDay = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    expect((rodaDay.data.sessions as { type: string }[]).map((one) => one.type)).toEqual(["JIU_JITSU", "OTHER", "RUNNING"]);
    expect(rodaDay.quality_flags).not.toContain("overlaps_band_session");
  });

  it("deletes a session by the id workout_review lists, in a later call", async () => {
    const { stub } = await logged();
    // The results of the adds are not kept: a later chat has only what workout_review returns.
    const review = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    const ids = (review.data.sessions as { entry_id: string | null }[]).map((one) => one.entry_id).filter((id) => id !== null);
    expect(ids).toEqual([createdName(2), createdName(1)]);
    g.takeExternal();

    expect(await objectTool(stub, "exercise_log_delete", { entry_id: ids[0] })).toEqual({ ok: true, output: { entry_id: createdName(2), deleted: true } });
    expect(g.takeExternal()).toEqual({ total: 1, "delete exercise": 1 });
    expect(g.google.writes.at(-1)).toEqual({ kind: "delete", body: { names: [listedName(2)] } });
    expect(await storedSessions(stub)).toMatchObject([{ name: createdName(1), day: JIU_JITSU_DAY }]);

    // The day without that session: the band's class, the roda and the run. The overlap is gone with the session.
    const after = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    expect((after.data.sessions as { type: string; entry_id: string | null }[]).map((one) => [one.type, one.entry_id])).toEqual([
      ["JIU_JITSU", null],
      ["OTHER", createdName(1)],
      ["RUNNING", null],
    ]);
    expect(after.quality_flags).not.toContain("overlaps_band_session");
    expect(after.data.week_context.sessions).toBe(5);
    // The band's sessions are not deletable: they have no entry_id, and their exercise_id is not this server's own.
    const band = (after.data.sessions as { exercise_id: string }[])[0]?.exercise_id as string;
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: band })).toMatchObject({ ok: false, error: { code: "no_data" } });
  });

  it("reads a session of another linked Google account as a session of another source, with no entry_id", async () => {
    const { stub, own } = await logged();
    await stub.linkGoogleAccount(link({ sub: "200000000000000000002", email: "other@example.com" }));
    const review = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    // Only the band's sessions: the two logged ones are not this account's own.
    expect((review.data.sessions as { type: string; entry_id: string | null }[]).map((one) => [one.type, one.entry_id])).toEqual([
      ["JIU_JITSU", null],
      ["RUNNING", null],
    ]);
    expect(review.quality_flags).toContain("other_source_sessions_excluded");
    expect(review.data.week_context.sessions).toBe(4);
    expect(await objectTool(stub, "exercise_log_delete", { entry_id: own.entry_id })).toMatchObject({ ok: false, error: { code: "no_data" } });
  });

  it("leaves the food reads as they were: a logged session is not food, and a logged food is not a session", async () => {
    const { stub } = await logged();
    const food = await ok(stub, "nutrition_log_add", { name: "Synthetic meal", meal_type: "LUNCH", kcal: 100, date: JIU_JITSU_DAY, time: "13:00" });
    const dayOfFood = await ok(stub, "nutrition_day", { date: JIU_JITSU_DAY });
    const entryIds = dayOfFood.data.per_meal.flatMap((meal: { items: { entry_id: string | null }[] }) => meal.items.map((item) => item.entry_id));
    // The band's four meals and the logged one: the only entry_id is the food entry's.
    expect(entryIds.filter((id: string | null) => id !== null)).toEqual([food.entry_id]);
    expect(dayOfFood.data.items_logged).toBe(5);
    expect(dayOfFood.quality_flags).not.toContain("other_source_food_excluded");
    const review = await ok(stub, "workout_review", { date: JIU_JITSU_DAY });
    expect(review.data.sessions).toHaveLength(4);
    expect(JSON.stringify(review)).not.toContain("nutrition-log");
  });
});
