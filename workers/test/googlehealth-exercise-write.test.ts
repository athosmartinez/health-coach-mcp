// The two writes of the Google Health client for the exercise data type: the
// create of one workout session and the delete of sessions by name. Also the
// allowlist of the client as a whole (four writes), and the write scopes.
//
// The request shapes follow Google's documentation
// (src/googlehealth/exerciselog.ts names the pages); no test calls Google.
// test/googlehealth-write.test.ts holds the same rules for nutrition-log, with
// every retry and Operation case: this file holds what differs by data type,
// and one case of each rule the two types share. All values are synthetic.
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolError, toWire } from "../src/coach/errors";
import { GOOGLE_HEALTH_SCOPES, GOOGLE_SIGN_IN_SCOPES, RECONNECT_HINT, WRITE_DATA_TYPES, WRITE_SCOPES, missingHealthScopes, missingWriteScopes, scopeName } from "../src/google";
import { RequestBudget } from "../src/googlehealth/budget";
import { type ClientOptions, GoogleHealthClient, MAX_ATTEMPTS, MAY_EXIST_HINT, MAY_EXIST_HINTS, type TokenResult, type TokenSource, readTarget, writeTarget } from "../src/googlehealth/client";
import {
  CREATE_PATH,
  DELETE_PATH,
  EXERCISE_DATA_TYPE,
  MAX_DISPLAY_NAME_CHARS,
  MAX_KCAL,
  MAX_NOTES_CHARS,
  MAX_SESSION_SECONDS,
  type NewExerciseSession,
  createBody,
  deleteBody,
  pointId,
} from "../src/googlehealth/exerciselog";
import { CREATE_PATH as FOOD_CREATE_PATH, DELETE_PATH as FOOD_DELETE_PATH, type NewFoodEntry, pointId as foodPointId, readCreateAnswer } from "../src/googlehealth/nutritionlog";
import { SAO_PAULO } from "./memory-helpers";

const API = "https://health.googleapis.com";

/** One request as the fake API received it. */
interface Sent {
  method: string;
  url: string;
  /** Without the /v4 prefix of the base URL. */
  path: string;
  auth: string;
  /** The body as it was sent, byte for byte. */
  text: string;
}

type Handle = (n: number, request: Sent) => Response | Promise<Response>;

/** Replaces fetch: records every request to the Google Health API and answers with the handler of the test. */
function fakeApi(handle: Handle): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) throw new Error(`unexpected fetch in test: ${request.method} ${url.origin}`);
    const sent: Sent = { method: request.method, url: request.url, path: url.pathname.replace(/^\/v4/, ""), auth: request.headers.get("authorization") ?? "", text: await request.text() };
    requests.push(sent);
    return handle(requests.length, sent);
  });
  return requests;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A marked text in every error body and answer of the fake: it must never reach an error or a log line. */
const BODY_MARK = "synthetic body 7711";

/** The error.message a write refusal repeats. BODY_MARK sits in another field, which must not be repeated. */
const GOOGLE_MESSAGE = "Request contains an invalid argument.";

function apiError(status: number, grpcStatus: string, headers: Record<string, string> = {}): Response {
  return json(
    status,
    { error: { code: status, status: grpcStatus, message: GOOGLE_MESSAGE, details: [{ "@type": "type.googleapis.com/google.rpc.DebugInfo", detail: BODY_MARK }] } },
    headers,
  );
}

const POINT = "users/1122334455/dataTypes/exercise/dataPoints/syn-point-9f3a";
const FOOD_POINT = "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-point-9f3a";

/** The Operation of the documented create example: finished, with the data point. */
function created(name: string = POINT): Response {
  return json(200, {
    done: true,
    response: {
      "@type": "type.googleapis.com/google.devicesandservices.health.v4.DataPoint",
      name,
      dataSource: { recordingMethod: "MANUAL", application: { googleWebClientId: "synthetic-client" }, platform: "GOOGLE_WEB_API" },
      exercise: { displayName: BODY_MARK, exerciseMetadata: {} },
    },
  });
}

/** The Operation of a batchDelete. */
function deleted(): Response {
  return json(200, {
    done: true,
    response: { "@type": "type.googleapis.com/google.devicesandservices.health.v4.BatchDeleteDataPointsResponse", dataPoints: [{ name: POINT, exercise: { displayName: BODY_MARK } }] },
  });
}

/** The `sub` of the Google account the tokens of FakeTokens belong to, and of another account. Neither may reach an error or a log line. */
const ACCOUNT = "300000000000000000003";
const OTHER_ACCOUNT = "400000000000000000004";

/** Hands out at-0, at-1, ... and renews after `invalidate` of the current token, like the CoachStore object. */
class FakeTokens implements TokenSource {
  n = 0;
  stale = false;
  asked = 0;
  invalidated: string[] = [];
  failure: TokenResult | undefined;
  /** The account each token belongs to, by its number: ACCOUNT when the test names none. Null: an answer without a `sub`. */
  subs: (string | null)[] = [];

  async accessToken(): Promise<TokenResult> {
    this.asked++;
    if (this.failure) return this.failure;
    if (this.stale) {
      this.n++;
      this.stale = false;
    }
    const sub = this.subs[this.n];
    return sub === null ? { ok: true, accessToken: `at-${this.n}` } : { ok: true, accessToken: `at-${this.n}`, sub: sub ?? ACCOUNT };
  }

  invalidate(rejected: string): boolean {
    this.invalidated.push(rejected);
    if (rejected !== `at-${this.n}`) return false;
    this.stale = true;
    return true;
  }
}

function testClient(options: Partial<ClientOptions> = {}, tokens = new FakeTokens()) {
  const waits: number[] = [];
  const budget = options.budget ?? new RequestBudget();
  const client = new GoogleHealthClient({
    tokens,
    zone: SAO_PAULO,
    wait: async (ms) => {
      waits.push(ms);
    },
    jitter: (ms) => ms,
    ...options,
    budget,
  });
  return { client, tokens, budget, waits };
}

/** 2026-10-16 07:10 to 08:25 in São Paulo: 75 minutes. The kcal has a fraction that no status or count has. */
const SESSION: NewExerciseSession = {
  exerciseType: "OTHER",
  displayName: "Capoeira angola",
  start: new Date("2026-10-16T10:10:00.900Z"),
  end: new Date("2026-10-16T11:25:00.100Z"),
  startUtcOffsetSeconds: -10_800,
  endUtcOffsetSeconds: -10_800,
  kcal: 431.5,
  notes: "Roda de sexta",
};

const SESSION_JSON =
  '{"dataSource":{"recordingMethod":"MANUAL","platform":"GOOGLE_WEB_API"},"exercise":{"interval":{"startTime":"2026-10-16T10:10:00Z",' +
  '"startUtcOffset":"-10800s","endTime":"2026-10-16T11:25:00Z","endUtcOffset":"-10800s"},"exerciseType":"OTHER",' +
  '"displayName":"Capoeira angola","activeDuration":"4500s","metricsSummary":{"caloriesKcal":431.5},"notes":"Roda de sexta"}}';

/** Nothing of the session, of a token or of Google's answer. */
const SECRETS = ["Capoeira", "angola", "431.5", "Roda", "sexta", "at-0", "at-1", BODY_MARK, "7711", "syn-point", "1122334455", "synthetic-client", ACCOUNT, OTHER_ACCOUNT];

/** The error a call fails with. */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call did not fail");
}

/** Every message and hint along the error's cause chain. */
function texts(error: unknown): string {
  const parts: string[] = [];
  for (let link = error; link instanceof Error; link = link.cause) parts.push(`${link.message} ${link instanceof ToolError ? (link.hint ?? "") : ""}`);
  return parts.join(" | ");
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const spies = new Map<(typeof LEVELS)[number], MockInstance>();

/** Every console line of the test so far, as JSON. */
const logged = () => JSON.stringify(LEVELS.flatMap((level) => spies.get(level)?.mock.calls ?? []));
const warnings = () => spies.get("warn")?.mock.calls ?? [];

function expectNoSecret(error?: unknown): void {
  const text = `${logged()} ${error === undefined ? "" : `${texts(error)} ${JSON.stringify(toWire(error))}`}`;
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

beforeEach(() => {
  for (const level of LEVELS) spies.set(level, vi.spyOn(console, level).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const EXERCISE_SCOPE_HINT = `${RECONNECT_HINT} Allow the permission to add exercise data (googlehealth.activity_and_fitness.writeonly), and check that the Google Health API is enabled in the Cloud project.`;
const FOOD_SCOPE_HINT = `${RECONNECT_HINT} Allow the permission to add nutrition data (googlehealth.nutrition.writeonly), and check that the Google Health API is enabled in the Cloud project.`;
const NOT_CREATED_HINT = "the entry was not created; try again in a few minutes";
const DELETE_AGAIN_HINT = "the entry may still exist; call exercise_log_delete again in a few minutes (a repeated delete is safe)";

const FOOD: NewFoodEntry = { name: "Synthetic food", mealType: "LUNCH", at: new Date("2026-10-16T14:30:45Z"), utcOffsetSeconds: -10_800, kcal: 100 };

describe("the write scopes", () => {
  it("asks at sign-in for the write scope of each data type the coach writes", () => {
    expect(WRITE_DATA_TYPES).toEqual(["nutrition-log", "exercise"]);
    expect(WRITE_SCOPES).toEqual({
      "nutrition-log": {
        scope: "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly",
        permits: "add nutrition data",
        addTool: "nutrition_log_add",
        deleteTool: "nutrition_log_delete",
      },
      exercise: {
        scope: "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly",
        permits: "add exercise data",
        addTool: "exercise_log_add",
        deleteTool: "exercise_log_delete",
      },
    });
    expect(GOOGLE_HEALTH_SCOPES).toEqual([
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
      "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
      "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
      "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly",
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly",
    ]);
    expect(GOOGLE_SIGN_IN_SCOPES).toEqual(["openid", "email", ...GOOGLE_HEALTH_SCOPES]);
    for (const type of WRITE_DATA_TYPES) expect(GOOGLE_HEALTH_SCOPES, type).toContain(WRITE_SCOPES[type].scope);
    expect(scopeName(WRITE_SCOPES.exercise.scope)).toBe("googlehealth.activity_and_fitness.writeonly");
  });

  it("names each missing write scope with the tools that need it", () => {
    const all = [...GOOGLE_HEALTH_SCOPES];
    expect(missingWriteScopes(missingHealthScopes(all))).toBe("");
    // An account that signed in before the exercise write scope was requested.
    const before = all.filter((scope) => scope !== WRITE_SCOPES.exercise.scope);
    expect(missingHealthScopes(before)).toEqual([WRITE_SCOPES.exercise.scope]);
    expect(missingWriteScopes(missingHealthScopes(before))).toBe(
      "exercise_log_add and exercise_log_delete need googlehealth.activity_and_fitness.writeonly, which a new sign-in grants.",
    );
    // A missing read scope is not a write scope.
    expect(missingWriteScopes([GOOGLE_HEALTH_SCOPES[0]])).toBe("");
    expect(missingWriteScopes(missingHealthScopes([]))).toBe(
      "nutrition_log_add and nutrition_log_delete need googlehealth.nutrition.writeonly, which a new sign-in grants. " +
        "exercise_log_add and exercise_log_delete need googlehealth.activity_and_fitness.writeonly, which a new sign-in grants.",
    );
  });
});

describe("the allowlist of the client", () => {
  it("has exactly four writes: the create and the delete of nutrition-log and of exercise", () => {
    expect(EXERCISE_DATA_TYPE).toBe("exercise");
    expect(CREATE_PATH).toBe("/users/me/dataTypes/exercise/dataPoints");
    expect(DELETE_PATH).toBe("/users/me/dataTypes/exercise/dataPoints:batchDelete");
    expect(writeTarget("POST", CREATE_PATH)).toEqual({ dataType: "exercise", kind: "create" });
    expect(writeTarget("POST", DELETE_PATH)).toEqual({ dataType: "exercise", kind: "delete" });
    expect(writeTarget("POST", FOOD_CREATE_PATH)).toEqual({ dataType: "nutrition-log", kind: "create" });
    expect(writeTarget("POST", FOOD_DELETE_PATH)).toEqual({ dataType: "nutrition-log", kind: "delete" });
    // A POST to either path is not a read. A GET to the create path is the list of the sessions.
    expect(readTarget("POST", CREATE_PATH)).toBeUndefined();
    expect(readTarget("POST", DELETE_PATH)).toBeUndefined();
    expect(readTarget("GET", CREATE_PATH)).toBe("exercise");
    expect(writeTarget("GET", CREATE_PATH)).toBeUndefined();
  });

  /** Every data type of the read table except the two that are written, and types that do not exist. */
  const OTHER_TYPES = ["steps", "sleep", "weight", "body-fat", "heart-rate", "heart-rate-variability", "daily-resting-heart-rate", "active-zone-minutes", "total-calories", "hydration-log", "exercises", "exercise-log", "workout", "-"];

  const REFUSED: [string, string][] = [
    // Another method on the two paths.
    ["PUT", CREATE_PATH],
    ["PATCH", CREATE_PATH],
    ["DELETE", CREATE_PATH],
    ["post", CREATE_PATH],
    ["GET", DELETE_PATH],
    ["DELETE", DELETE_PATH],
    ["PUT", DELETE_PATH],
    // Another data type.
    ...OTHER_TYPES.flatMap((type): [string, string][] => [
      ["POST", `/users/me/dataTypes/${type}/dataPoints`],
      ["POST", `/users/me/dataTypes/${type}/dataPoints:batchDelete`],
    ]),
    // Another user.
    ["POST", "/users/1122334455/dataTypes/exercise/dataPoints"],
    ["POST", "/users/other/dataTypes/exercise/dataPoints:batchDelete"],
    ["POST", "/users/-/dataTypes/exercise/dataPoints:batchDelete"],
    // Another operation on the exercise log, and other method suffixes.
    ["PATCH", "/users/me/dataTypes/exercise/dataPoints/syn-point-9f3a"],
    ["DELETE", "/users/me/dataTypes/exercise/dataPoints/syn-point-9f3a"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints/syn-point-9f3a"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:batchCreate"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:batchdelete"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:batchDelete/"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints/"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:batchDelete:x"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:reconcile"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:exportExerciseTcx"],
    // A query in the path text.
    ["POST", "/users/me/dataTypes/exercise/dataPoints?x=1"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints:batchDelete?force=true"],
    ["POST", "//users/me/dataTypes/exercise/dataPoints"],
    ["POST", "/users/me/dataTypes/exercise/../steps/dataPoints"],
    ["POST", "/users/me/dataTypes/exercise/dataPoints%3AbatchDelete"],
    ["POST", " /users/me/dataTypes/exercise/dataPoints"],
    ["POST", "/users/me/dataTypes/EXERCISE/dataPoints"],
    ["POST", "/users/me/dataTypes/exercise"],
  ];

  class Probe extends GoogleHealthClient {
    probe(method: string, path: string, query?: string, body?: string): Promise<unknown> {
      return this.request(method, path, query, body);
    }
  }

  it("refuses every other write before a request, a token or a budget unit", async () => {
    const requests = fakeApi(() => {
      throw new Error("a request was sent");
    });
    const tokens = new FakeTokens();
    const budget = new RequestBudget();
    const probe = new Probe({ tokens, zone: SAO_PAULO, budget });
    for (const [method, path] of REFUSED) {
      expect(writeTarget(method, path), `${method} ${path}`).toBeUndefined();
      const error = await failure(probe.probe(method, path, undefined, "{}"));
      // A caller bug, not the user's input.
      expect(error, `${method} ${path}`).not.toBeInstanceOf(ToolError);
      expect(error.message, `${method} ${path}`).toContain("the client refuses");
    }
    // A write with a query is none of the four: the whole input of a write is its body.
    for (const path of [CREATE_PATH, DELETE_PATH, FOOD_CREATE_PATH, FOOD_DELETE_PATH]) {
      expect((await failure(probe.probe("POST", path, "x=1", "{}"))).message).toContain("the client refuses");
      expect((await failure(probe.probe("POST", path, "", "{}"))).message).toContain("the client refuses");
    }
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
    expect(budget.used).toBe(0);
  });

  it("sends the four writes, and nothing else, through the request guard", async () => {
    const requests = fakeApi(() => created());
    const probe = new Probe({ tokens: new FakeTokens(), zone: SAO_PAULO, budget: new RequestBudget() });
    for (const path of [FOOD_CREATE_PATH, FOOD_DELETE_PATH, CREATE_PATH, DELETE_PATH]) await probe.probe("POST", path, undefined, "{}");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints",
      "POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete",
      "POST https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints",
      "POST https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints:batchDelete",
    ]);
  });
});

describe("the body of an exercise create", () => {
  // The request of the guide's only example ("Write a workout session",
  // https://developers.google.com/health/data-types/workouts), as the page
  // shows it. The session has a pause of 5 minutes, so its activeDuration is
  // shorter than its interval.
  const DOCUMENTED_REQUEST = `{
    "dataSource": { "recordingMethod": "ACTIVELY_MEASURED", "platform": "GOOGLE_WEB_API" },
    "exercise": {
      "interval": { "startTime": "2026-04-20T08:00:00Z", "startUtcOffset": "0s", "endTime": "2026-04-20T08:35:00Z", "endUtcOffset": "0s" },
      "exerciseType": "RUNNING",
      "activeDuration": "1800s",
      "metricsSummary": { "caloriesKcal": 380.0, "distanceMillimeters": 5000000.0, "steps": "6200", "averageHeartRateBeatsPerMinute": "148", "averagePaceSecondsPerMeter": 0.36 },
      "exerciseEvents": [
        { "eventTime": "2026-04-20T08:15:00Z", "eventUtcOffset": "0s", "exerciseEventType": "PAUSE" },
        { "eventTime": "2026-04-20T08:20:00Z", "eventUtcOffset": "0s", "exerciseEventType": "RESUME" }
      ]
    }
  }`;

  /** The inputs of the documented example. */
  const EXAMPLE: NewExerciseSession = {
    exerciseType: "RUNNING",
    displayName: "Running",
    start: new Date("2026-04-20T08:00:00Z"),
    end: new Date("2026-04-20T08:35:00Z"),
    startUtcOffsetSeconds: 0,
    endUtcOffsetSeconds: 0,
    kcal: 380,
  };

  it("has the keys, the key order and the value formats of the documented example", () => {
    const documented = JSON.parse(DOCUMENTED_REQUEST) as Record<string, any>;
    const body = JSON.parse(JSON.stringify(createBody(EXAMPLE))) as Record<string, any>;
    /** The keys both objects hold, in the order of `of`. */
    const shared = (of: object, other: object) => Object.keys(of).filter((key) => key in other);

    // The two top-level keys, in the order of the example.
    expect(Object.keys(body)).toEqual(Object.keys(documented));
    // dataSource: the same keys in the same order, and the same platform. The
    // method is MANUAL, another value of the documented RecordingMethod enum.
    expect(Object.keys(body.dataSource)).toEqual(Object.keys(documented.dataSource));
    expect(body.dataSource).toEqual({ recordingMethod: "MANUAL", platform: documented.dataSource.platform });
    // The interval of the same inputs is the interval of the example, key by key and in its order.
    expect(JSON.stringify(body.exercise.interval)).toBe(JSON.stringify(documented.exercise.interval));
    expect(body.exercise.exerciseType).toBe(documented.exercise.exerciseType);
    // Every key that the example also sends comes in the order of the example.
    expect(shared(body.exercise, documented.exercise)).toEqual(shared(documented.exercise, body.exercise));
    expect(shared(body.exercise, documented.exercise)).toEqual(["interval", "exerciseType", "activeDuration", "metricsSummary"]);
    // The only key the example leaves out is displayName, which the reference marks as required.
    expect(Object.keys(body.exercise).filter((key) => !(key in documented.exercise))).toEqual(["displayName"]);
    // activeDuration has the format of the example: whole seconds and "s". No pause is known, so it is the whole interval.
    expect(documented.exercise.activeDuration).toMatch(/^\d+s$/);
    expect(body.exercise.activeDuration).toMatch(/^\d+s$/);
    expect(body.exercise.activeDuration).toBe("2100s");
    // The calories are the number of the example, under the key of the example.
    expect(typeof body.exercise.metricsSummary.caloriesKcal).toBe(typeof documented.exercise.metricsSummary.caloriesKcal);
    expect(body.exercise.metricsSummary).toEqual({ caloriesKcal: documented.exercise.metricsSummary.caloriesKcal });
    expect(Object.keys(body.exercise.metricsSummary).every((key) => key in documented.exercise.metricsSummary)).toBe(true);

    expect(JSON.stringify(createBody(EXAMPLE))).toBe(
      '{"dataSource":{"recordingMethod":"MANUAL","platform":"GOOGLE_WEB_API"},"exercise":{"interval":{"startTime":"2026-04-20T08:00:00Z","startUtcOffset":"0s",' +
        '"endTime":"2026-04-20T08:35:00Z","endUtcOffset":"0s"},"exerciseType":"RUNNING","displayName":"Running","activeDuration":"2100s","metricsSummary":{"caloriesKcal":380}}}',
    );
  });

  it("is the documented exercise with every key in its order, whole seconds, and the notes last", () => {
    expect(JSON.stringify(createBody(SESSION))).toBe(SESSION_JSON);
    expect(Object.keys(createBody(SESSION).exercise)).toEqual(["interval", "exerciseType", "displayName", "activeDuration", "metricsSummary", "notes"]);
  });

  it("always sends metricsSummary, empty without calories, and sends the notes only when given", () => {
    const { exercise } = createBody({ ...SESSION, kcal: undefined, notes: undefined });
    expect(Object.keys(exercise)).toEqual(["interval", "exerciseType", "displayName", "activeDuration", "metricsSummary"]);
    expect(JSON.stringify(exercise.metricsSummary)).toBe("{}");
    // The keys are absent, not undefined: the body is what its JSON text carries.
    const bare: NewExerciseSession = { exerciseType: "YOGA", displayName: "Yoga", start: SESSION.start, end: SESSION.end, startUtcOffsetSeconds: 0, endUtcOffsetSeconds: 0 };
    expect(JSON.stringify(createBody(bare).exercise)).toBe(
      '{"interval":{"startTime":"2026-10-16T10:10:00Z","startUtcOffset":"0s","endTime":"2026-10-16T11:25:00Z","endUtcOffset":"0s"},"exerciseType":"YOGA","displayName":"Yoga","activeDuration":"4500s","metricsSummary":{}}',
    );
  });

  it.each([
    ["east of UTC", 19_800, 19_800, "19800s", "19800s"],
    ["UTC", 0, 0, "0s", "0s"],
    ["a negative zero", -0, -0, "0s", "0s"],
    ["west of UTC", -34_200, -34_200, "-34200s", "-34200s"],
    // New York on 2026-03-08: the clocks go forward during the session.
    ["a start before a DST change and an end after it", -18_000, -14_400, "-18000s", "-14400s"],
    ["a start in summer time and an end in winter time", -14_400, -18_000, "-14400s", "-18000s"],
  ])("writes the offsets of %s as seconds, each for its own instant", (_name, start, end, startText, endText) => {
    const { interval } = createBody({ ...SESSION, startUtcOffsetSeconds: start, endUtcOffsetSeconds: end }).exercise;
    expect(interval).toEqual({ startTime: "2026-10-16T10:10:00Z", startUtcOffset: startText, endTime: "2026-10-16T11:25:00Z", endUtcOffset: endText });
  });

  it("takes a session of one second and one of 24 hours, and sends the length as activeDuration", () => {
    const start = new Date("2026-10-15T03:00:00Z");
    expect(createBody({ ...SESSION, start, end: new Date(start.getTime() + 1000) }).exercise.activeDuration).toBe("1s");
    const day = createBody({ ...SESSION, start, end: new Date(start.getTime() + MAX_SESSION_SECONDS * 1000) }).exercise;
    expect(day.activeDuration).toBe("86400s");
    expect(day.interval).toMatchObject({ startTime: "2026-10-15T03:00:00Z", endTime: "2026-10-16T03:00:00Z" });
    expect(MAX_SESSION_SECONDS).toBe(86_400);
  });

  it("takes each value at its bound", () => {
    expect([MAX_KCAL, MAX_DISPLAY_NAME_CHARS, MAX_NOTES_CHARS]).toEqual([10_000, 64, 500]);
    const atBounds = createBody({ ...SESSION, kcal: MAX_KCAL, displayName: "🤸".repeat(MAX_DISPLAY_NAME_CHARS), notes: "n".repeat(MAX_NOTES_CHARS) });
    expect(atBounds.exercise.metricsSummary.caloriesKcal).toBe(10_000);
    expect([...atBounds.exercise.displayName]).toHaveLength(64);
    expect([...(atBounds.exercise.notes ?? "")]).toHaveLength(500);
  });

  it.each([
    ["an end at the start", { end: SESSION.start }],
    ["an end in the same second as the start", { end: new Date(SESSION.start.getTime() + 50) }],
    ["an end before the start", { end: new Date(SESSION.start.getTime() - 60_000) }],
    ["a session one second longer than 24 hours", { start: new Date("2026-10-15T03:00:00Z"), end: new Date("2026-10-16T03:00:01Z") }],
    ["a start that is not a time", { start: new Date(Number.NaN) }],
    ["an end that is not a time", { end: new Date(Number.NaN) }],
    ["a type in lower case", { exerciseType: "running" }],
    ["a type with a space", { exerciseType: "JIU JITSU" }],
    ["an empty type", { exerciseType: "" }],
    ["the unspecified type", { exerciseType: "EXERCISE_TYPE_UNSPECIFIED" }],
    ["an empty name", { displayName: "" }],
    ["a name of 65 characters", { displayName: "a".repeat(65) }],
    ["a kcal of zero", { kcal: 0 }],
    ["a negative kcal", { kcal: -1 }],
    ["a kcal above the bound", { kcal: 10_000.5 }],
    ["a kcal that is not a number", { kcal: Number.NaN }],
    ["an infinite kcal", { kcal: Number.POSITIVE_INFINITY }],
    ["empty notes", { notes: "" }],
    ["notes of 501 characters", { notes: "n".repeat(501) }],
    ["a start offset with a fraction", { startUtcOffsetSeconds: -10_800.5 }],
    ["an end offset beyond any zone", { endUtcOffsetSeconds: 19 * 3600 }],
    ["an end offset that is not a number", { endUtcOffsetSeconds: Number.NaN }],
  ])("refuses %s before any request", async (_name, change) => {
    const requests = fakeApi(() => created());
    const { client, tokens, budget } = testClient();
    const session = { ...SESSION, ...change };
    expect(() => createBody(session)).toThrow(/^googlehealth: /);
    const error = await failure(client.createExercise(session, ACCOUNT));
    // The tool checks its input first: this is a caller bug.
    expect(error).not.toBeInstanceOf(ToolError);
    expect(toWire(error).code).toBe("internal_error");
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
    expect(budget.used).toBe(0);
    expectNoSecret(error);
  });
});

describe("the name of an exercise data point", () => {
  it("is read in any user form, and only for the exercise data type", () => {
    expect(pointId(POINT)).toBe("syn-point-9f3a");
    expect(pointId("users/me/dataTypes/exercise/dataPoints/a.b_c-9")).toBe("a.b_c-9");
    // The name of the documented answer.
    expect(pointId("users/999298779973222220/dataTypes/exercise/dataPoints/3054085373369111216")).toBe("3054085373369111216");
    for (const name of [
      "",
      "syn-point-9f3a",
      FOOD_POINT,
      "users/me/dataTypes/exercises/dataPoints/a",
      "users/me/dataTypes/-/dataPoints/a",
      `${POINT}/x`,
      `x/${POINT}`,
      `${POINT} `,
      `${POINT}\n`,
      `${POINT}:batchDelete`,
      "users//dataTypes/exercise/dataPoints/a",
      "users/me/dataTypes/exercise/dataPoints/",
      `users/${"u".repeat(300)}/dataTypes/exercise/dataPoints/a`,
    ]) {
      expect(pointId(name), JSON.stringify(name)).toBeUndefined();
    }
    expect(pointId(7711 as unknown as string)).toBeUndefined();
    // Each data type reads only its own names.
    expect(foodPointId(POINT)).toBeUndefined();
    expect(foodPointId(FOOD_POINT)).toBe("syn-point-9f3a");
  });

  it("is written under users/me in a delete, for a data point ID only", () => {
    expect(deleteBody("syn-point-9f3a")).toEqual({ names: ["users/me/dataTypes/exercise/dataPoints/syn-point-9f3a"] });
    for (const id of ["", "a/b", POINT, "a b", 'a"b', "a\nb", "x".repeat(129), "-/-", "é"]) expect(() => deleteBody(id), JSON.stringify(id)).toThrow("not a data point ID");
  });
});

describe("createExercise", () => {
  it("sends one POST with the session and returns the name of the finished Operation", async () => {
    const requests = fakeApi(() => created());
    const { client, tokens, budget, waits } = testClient();
    expect(await client.createExercise(SESSION, ACCOUNT)).toBe(POINT);
    expect(requests).toEqual([{ method: "POST", url: "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints", path: CREATE_PATH, auth: "Bearer at-0", text: SESSION_JSON }]);
    expect(budget.used).toBe(1);
    expect(tokens.asked).toBe(1);
    expect(waits).toEqual([]);
    // A successful write logs nothing here: the tool call line is the server's.
    expect(logged()).toBe("[]");
  });

  // A name of another data type is not an answer to this create: its ID would
  // be recorded as a session, and a delete of it would be sent to the wrong
  // data type.
  it.each([
    ["a nutrition-log data point", FOOD_POINT],
    ["a data point of a type the coach does not write", "users/1122334455/dataTypes/hydration-log/dataPoints/syn-point-9f3a"],
    ["a data type, not a point", "users/1122334455/dataTypes/exercise"],
    ["a point with more path parts", `${POINT}/extra`],
  ])("does not accept an answer that names %s: the entry may exist, and no id is made up", async (_name, name) => {
    const requests = fakeApi(() => created(name));
    const { client, waits } = testClient();
    const error = await failure(client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health returned no usable id for the entry", hint: MAY_EXIST_HINTS.exercise });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health write answer not usable", { data_type: "exercise", operation: "create", reason: "no_name" }]]);
    expectNoSecret(error);
  });

  it("does not accept the name of an exercise data point as the answer of a food log create", async () => {
    const requests = fakeApi(() => created(POINT));
    const error = await failure(testClient().client.createNutritionLog(FOOD));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health returned no usable id for the entry", hint: MAY_EXIST_HINT });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([["google health write answer not usable", { data_type: "nutrition-log", operation: "create", reason: "no_name" }]]);
    // The reader of a create answer takes the name reader of the data type of the request.
    const answer = JSON.stringify({ done: true, response: { name: POINT } });
    expect(readCreateAnswer(answer)).toEqual({ ok: false, fault: "no_name" });
    expect(readCreateAnswer(answer, pointId)).toEqual({ ok: true, name: POINT });
    expect(readCreateAnswer(JSON.stringify({ done: true, response: { name: FOOD_POINT } }), pointId)).toEqual({ ok: false, fault: "no_name" });
  });

  it("points to workout_review, not to nutrition_day, when the outcome is unknown", async () => {
    expect(MAY_EXIST_HINTS.exercise).toBe(
      "the entry may exist: check the day with workout_review before a new try (a session this server has no id for is not listed there, " +
        "and the result has the flag other_source_sessions_excluded; when the week already had a session from another source, check the exercise log in the Fitbit app instead)",
    );
    expect(MAY_EXIST_HINTS.exercise).not.toContain("nutrition");
    expect(MAY_EXIST_HINTS.exercise).not.toContain("food");
    // The hint of a food log create is as it was.
    expect(MAY_EXIST_HINTS["nutrition-log"]).toBe(MAY_EXIST_HINT);
    expect(MAY_EXIST_HINT).toContain("check the day with nutrition_day before a new try");
  });

  it.each([408, 500, 503])("is never sent again after HTTP %i: the entry may exist", async (status) => {
    const requests = fakeApi(() => apiError(status, "UNAVAILABLE", { "retry-after": "1" }));
    const { client, budget, waits } = testClient();
    const error = await failure(client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: MAY_EXIST_HINTS.exercise });
    expect(requests).toHaveLength(1);
    expect(budget.used).toBe(1);
    expect(waits).toEqual([]);
    expectNoSecret(error);
  });

  it("is never sent again after a network error, and the log names the exercise data type", async () => {
    const requests = fakeApi(() => {
      throw new TypeError(`connection reset while sending ${BODY_MARK}`);
    });
    const { client, waits } = testClient();
    const error = await failure(client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API could not be reached", hint: MAY_EXIST_HINTS.exercise });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health request did not complete", { data_type: "exercise", cause: "TypeError" }]]);
    expectNoSecret(error);
  });

  it("is an entry that may exist when the Operation is not finished or carries an error", async () => {
    fakeApi((n) => (n === 1 ? json(200, { name: "operations/syn-1", metadata: { note: BODY_MARK } }) : json(200, { done: true, error: { code: 3, message: BODY_MARK } })));
    const { client } = testClient();
    expect(toWire(await failure(client.createExercise(SESSION, ACCOUNT)))).toEqual({ code: "upstream_unavailable", message: "Google Health has not finished creating the entry", hint: MAY_EXIST_HINTS.exercise });
    expect(toWire(await failure(client.createExercise(SESSION, ACCOUNT)))).toEqual({ code: "upstream_unavailable", message: "Google Health reported an error for the entry", hint: MAY_EXIST_HINTS.exercise });
    expect(warnings()).toEqual([
      ["google health write answer not usable", { data_type: "exercise", operation: "create", reason: "not_done" }],
      ["google health write answer not usable", { data_type: "exercise", operation: "create", reason: "operation_error", google_code: 3 }],
    ]);
    expectNoSecret();
  });

  it("is sent again after a 429, and answers that the entry was not created when every attempt is refused", async () => {
    const requests = fakeApi((n) => (n < 3 ? apiError(429, "RESOURCE_EXHAUSTED") : created()));
    const first = testClient();
    expect(await first.client.createExercise(SESSION, ACCOUNT)).toBe(POINT);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.text))).toEqual(new Set([SESSION_JSON]));
    expect(first.waits).toEqual([1000, 2000]);
    expect(warnings()).toEqual([1, 2].map((retry) => ["google health request failed; retrying", { data_type: "exercise", http_status: 429, retry, wait_ms: retry * 1000 }]));

    vi.mocked(globalThis.fetch).mockRestore();
    const again = fakeApi(() => apiError(429, "RESOURCE_EXHAUSTED"));
    const error = await failure(testClient().client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: NOT_CREATED_HINT });
    expect(again).toHaveLength(MAX_ATTEMPTS);
    expectNoSecret(error);
  });

  it("renews a rejected token once and sends the session again", async () => {
    const requests = fakeApi((n) => (n === 1 ? apiError(401, "UNAUTHENTICATED") : created()));
    const { client, tokens, budget } = testClient();
    expect(await client.createExercise(SESSION, ACCOUNT)).toBe(POINT);
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-1"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(budget.used).toBe(2);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "exercise", http_status: 401 }]]);
  });

  it("answers auth_expired without a request when no account is linked", async () => {
    const requests = fakeApi(() => created());
    const tokens = new FakeTokens();
    tokens.failure = { ok: false, code: "not_linked" };
    const error = await failure(testClient({}, tokens).client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    expect(requests).toHaveLength(0);
  });

  it("answers scope_missing for a 403 with the write scope of its own data type in the hint", async () => {
    const requests = fakeApi(() => apiError(403, "PERMISSION_DENIED"));
    const { client, waits } = testClient();
    const error = await failure(client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "scope_missing", message: "Google Health denied the write of exercise data", hint: EXERCISE_SCOPE_HINT });
    expect(EXERCISE_SCOPE_HINT).toContain("Disconnect and reconnect this connector");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    // The same answer for a food log write names the food log scope.
    const food = await failure(client.createNutritionLog(FOOD));
    expect(toWire(food)).toEqual({ code: "scope_missing", message: "Google Health denied the write of nutrition-log data", hint: FOOD_SCOPE_HINT });
    // And the delete of each data type has the hint of its own type.
    expect(toWire(await failure(client.deleteExercise("syn-point-9f3a", ACCOUNT)))).toEqual({ code: "scope_missing", message: "Google Health denied the write of exercise data", hint: EXERCISE_SCOPE_HINT });
    expect(toWire(await failure(client.deleteNutritionLog("syn-point-9f3a")))).toEqual({ code: "scope_missing", message: "Google Health denied the write of nutrition-log data", hint: FOOD_SCOPE_HINT });
    expectNoSecret(error);
  });

  it("does not send a create the budget has no unit for, and says so", async () => {
    const requests = fakeApi(() => created());
    const error = await failure(testClient({ budget: new RequestBudget(0) }).client.createExercise(SESSION, ACCOUNT));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "this MCP request already sent all the Google Health requests one request may send: the entry was not sent",
      hint: "send this call in a request of its own",
    });
    expect(requests).toHaveLength(0);
    expect(logged()).toBe("[]");
  });

  it.each(["create", "delete"] as const)("a 400 of a %s repeats Google's reason and a short message, with the exercise data type in the log, and nothing else of the body", async (kind) => {
    const head = "interval.end_time must be after interval.start_time. ";
    const tail = "TAIL_NOT_SHOWN";
    const message = `${head}owner@example.com users/1122334455 ya29.a0AfH6SM-secret Bearer at-stored-51c2 ${"x".repeat(220)}${tail}`;
    const requests = fakeApi(() =>
      json(400, {
        error: {
          code: 400,
          message,
          status: "INVALID_ARGUMENT",
          details: [
            { "@type": "type.googleapis.com/google.rpc.BadRequest", reason: "NOT_AN_ERRORINFO", fieldViolations: [{ description: BODY_MARK }] },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INTERVAL_EMPTY", domain: "health.googleapis.com", metadata: { user: "owner@example.com", name: "Capoeira angola" } },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "owner@example.com" },
          ],
        },
      }),
    );
    const error = await failure(kind === "create" ? testClient().client.createExercise(SESSION, ACCOUNT) : testClient().client.deleteExercise("syn-point-9f3a", ACCOUNT));
    const loggedMessage = (warnings()[0]?.[1] as { google_message?: string } | undefined)?.google_message ?? "";
    expect(loggedMessage.startsWith(head)).toBe(true);
    expect(loggedMessage.endsWith("…")).toBe(true);
    expect(loggedMessage).not.toContain(tail);
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: `${kind === "create" ? "Google Health refused the entry" : "Google Health refused the delete"}: INTERVAL_EMPTY: ${loggedMessage}`,
      hint: kind === "create" ? "the entry was not created; check the date, the time and the values" : "the entry was not deleted",
    });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([
      ["google health request rejected", { data_type: "exercise", http_status: 400, google_status: "INVALID_ARGUMENT", google_reason: "INTERVAL_EMPTY", google_message: loggedMessage }],
    ]);
    const shown = `${texts(error)} ${logged()}`;
    for (const secret of ["owner@example.com", "1122334455", "ya29", "at-stored-51c2", "Bearer", BODY_MARK, "NOT_AN_ERRORINFO", tail]) expect(shown, secret).not.toContain(secret);
    expectNoSecret(error);
  });
});

// Google's error.message can repeat a value of the request. A session carries
// free text (the name of an activity that is not in the list, the notes), and
// no name, note, value or entry id may reach an error or a log line.
describe("a refusal of Google that repeats what the request sent", () => {
  const REASON = "SYNTHETIC_FIELD_REJECTED";
  const refusal = (message: string) => () =>
    json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: REASON, domain: "health.googleapis.com" }] } });

  /** The message of the one reject log line. */
  function rejectLine(): string {
    expect(warnings()).toHaveLength(1);
    const [text, fields] = warnings()[0] as [string, { google_reason?: string; google_message?: string }];
    expect(text).toBe("google health request rejected");
    expect(fields.google_reason).toBe(REASON);
    return fields.google_message ?? "";
  }

  it("a create: the activity name, the notes and the kcal value are taken out, in any letter case, and the rest stays", async () => {
    const requests = fakeApi(
      refusal('Invalid value at exercise.display_name: "CAPOEIRA ANGOLA". Notes "roda de SEXTA" and calories_kcal 431.5 were not accepted for OTHER at 2026-10-16T10:10:00Z.'),
    );
    const error = await failure(testClient().client.createExercise(SESSION, ACCOUNT));
    // The reason, the field names, the type and the time of the session stay.
    const kept = 'Invalid value at exercise.display_name: " ". Notes " " and calories_kcal were not accepted for OTHER at 2026-10-16T10:10:00Z.';
    expect(rejectLine()).toBe(kept);
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: `Google Health refused the entry: ${REASON}: ${kept}`,
      hint: "the entry was not created; check the date, the time and the values",
    });
    expect(requests).toHaveLength(1);
    const shown = `${texts(error)} ${logged()}`.toLowerCase();
    for (const sent of ["capoeira", "angola", "roda", "sexta", "431.5"]) expect(shown, sent).not.toContain(sent);
    expectNoSecret(error);
  });

  it("a create: a name that is part of the notes, and a text that Google repeats twice, leave no rest", async () => {
    fakeApi(refusal("notes [Roda de sexta, na roda] name [Roda] again [RODA DE SEXTA, NA RODA] rejected"));
    const error = await failure(testClient().client.createExercise({ ...SESSION, displayName: "Roda", notes: "Roda de sexta, na roda" }, ACCOUNT));
    expect(rejectLine()).toBe("notes [ ] name [ ] again [ ] rejected");
    expect(texts(error).toLowerCase()).not.toContain("roda");
    expectNoSecret(error);
  });

  it("a create: a text of the request is taken out before the redaction can cut it into parts", async () => {
    // The notes hold what the redaction removes on its own: without the order, the words around it would stay.
    const notes = "Aula com owner@example.com na sexta";
    fakeApi(refusal(`notes "${notes}" rejected`));
    const error = await failure(testClient().client.createExercise({ ...SESSION, notes }, ACCOUNT));
    expect(rejectLine()).toBe('notes " " rejected');
    for (const part of ["Aula", "example.com", "sexta"]) expect(`${texts(error)} ${logged()}`, part).not.toContain(part);
  });

  it("a create: the name the server made for a listed type is not taken out, so the type stays in the message", async () => {
    const message = "exercise_type RUNNING is not accepted here";
    fakeApi(refusal(message));
    const error = await failure(testClient().client.createExercise({ ...SESSION, exerciseType: "RUNNING", displayName: "Running", kcal: undefined, notes: undefined }, ACCOUNT));
    expect(rejectLine()).toBe(message);
    expect(toWire(error).message).toBe(`Google Health refused the entry: ${REASON}: ${message}`);
  });

  it("a create: a text shorter than 3 characters is not taken out", async () => {
    // A kcal of 50 and a name of two letters: both are in the time of the session and in common words.
    const message = "calories_kcal 50 at 2026-10-16T10:50:00Z is too low";
    fakeApi(refusal(message));
    await failure(testClient().client.createExercise({ ...SESSION, displayName: "is", kcal: 50, notes: undefined }, ACCOUNT));
    expect(rejectLine()).toBe(message);
  });

  // Ids that the redaction of tokens and of account ids does not catch on its own: no digit, and fewer than 10 digits.
  it.each(["syn_point_k", "4410772"])("a delete: the data point id %s is taken out, in any letter case", async (id) => {
    const requests = fakeApi(refusal(`Data point users/me/dataTypes/exercise/dataPoints/${id} (${id.toUpperCase()}) cannot be deleted.`));
    const error = await failure(testClient().client.deleteExercise(id, ACCOUNT));
    const kept = "Data point /dataTypes/exercise/dataPoints/ ( ) cannot be deleted.";
    expect(rejectLine()).toBe(kept);
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `Google Health refused the delete: ${REASON}: ${kept}`, hint: "the entry was not deleted" });
    expect(requests).toHaveLength(1);
    expect(`${texts(error)} ${logged()}`.toLowerCase()).not.toContain(id.toLowerCase());
  });

  it("the food log writes keep their message as it was", async () => {
    const message = "Synthetic food with energy 100 was not accepted";
    fakeApi(refusal(message));
    const error = await failure(testClient().client.createNutritionLog(FOOD));
    expect(rejectLine()).toBe(message);
    expect(toWire(error).message).toBe(`Google Health refused the entry: ${REASON}: ${message}`);
  });
});

describe("deleteExercise", () => {
  it("sends one POST to batchDelete of the exercise data type with the name of the point under users/me", async () => {
    const requests = fakeApi(() => deleted());
    const { client, budget } = testClient();
    expect(await client.deleteExercise("syn-point-9f3a", ACCOUNT)).toBe("deleted");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints:batchDelete",
        path: DELETE_PATH,
        auth: "Bearer at-0",
        text: '{"names":["users/me/dataTypes/exercise/dataPoints/syn-point-9f3a"]}',
      },
    ]);
    expect(budget.used).toBe(1);
    expect(logged()).toBe("[]");
  });

  it.each(["", "a/b", POINT, "a b", "a\nb", "x".repeat(129)])("refuses the ID %j before any request", async (id) => {
    const requests = fakeApi(() => deleted());
    const { client, tokens } = testClient();
    const error = await failure(client.deleteExercise(id, ACCOUNT));
    expect(error).not.toBeInstanceOf(ToolError);
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
  });

  it("takes Google's own 404, with the status NOT_FOUND, as a point that is already gone", async () => {
    const requests = fakeApi(() => apiError(404, "NOT_FOUND"));
    const { client, waits } = testClient();
    expect(await client.deleteExercise("syn-point-9f3a", ACCOUNT)).toBe("gone");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(logged()).toBe("[]");
  });

  it("takes a 404 that is not Google's NOT_FOUND as a refused delete, not as a point that is gone", async () => {
    const requests = fakeApi(() => new Response(`<html><title>Error 404 (Not Found)</title>${BODY_MARK} NOT_FOUND</html>`, { status: 404, headers: { "content-type": "text/html" } }));
    const error = await failure(testClient().client.deleteExercise("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: "Google Health refused the delete", hint: "the entry was not deleted" });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([["google health request rejected", { data_type: "exercise", http_status: 404, google_status: "" }]]);
    expectNoSecret(error);
  });

  it("is sent again after a 429, a 5xx and a network error, and names exercise_log_delete when every attempt fails", async () => {
    const requests = fakeApi((n) => {
      if (n === 1) return apiError(429, "RESOURCE_EXHAUSTED");
      if (n === 2) return apiError(503, "UNAVAILABLE");
      if (n === 3) throw new TypeError("connection reset");
      return deleted();
    });
    const first = testClient();
    expect(await first.client.deleteExercise("syn-point-9f3a", ACCOUNT)).toBe("deleted");
    expect(requests).toHaveLength(4);
    expect(first.waits).toEqual([1000, 2000, 4000]);

    vi.mocked(globalThis.fetch).mockRestore();
    const again = fakeApi(() => apiError(503, "UNAVAILABLE"));
    const error = await failure(testClient().client.deleteExercise("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: DELETE_AGAIN_HINT });
    expect(again).toHaveLength(MAX_ATTEMPTS);
    // The hint of a food log delete still names its own tool.
    const food = await failure(testClient().client.deleteNutritionLog("syn-point-9f3a"));
    expect(toWire(food).hint).toBe("the entry may still exist; call nutrition_log_delete again in a few minutes (a repeated delete is safe)");
    expectNoSecret(error);
  });

  it("answers unavailable, with the exercise data type in the log, for an Operation that cannot be used", async () => {
    fakeApi(() => json(200, { done: true, error: { code: 5, message: BODY_MARK } }));
    const error = await failure(testClient().client.deleteExercise("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health reported an error for the delete", hint: DELETE_AGAIN_HINT });
    expect(warnings()).toEqual([["google health write answer not usable", { data_type: "exercise", operation: "delete", reason: "operation_error", google_code: 5 }]]);
    expectNoSecret(error);
  });

  it("does not send a delete the budget has no unit for, and says so", async () => {
    const requests = fakeApi(() => deleted());
    const error = await failure(testClient({ budget: new RequestBudget(0) }).client.deleteExercise("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "this MCP request already sent all the Google Health requests one request may send: the delete was not sent",
      hint: "send this call in a request of its own",
    });
    expect(requests).toHaveLength(0);
  });
});

// The tool reads the account from the store, and the client takes the token on
// its own. An exercise write names the account the tool checked, and goes out
// only with a token of that account.
describe("the Google account of an exercise write", () => {
  const CHANGED = "the linked Google account changed during this MCP request";
  const OWN_REQUEST = "send this call in a request of its own";
  const NOT_SENT_LINE = (operation: string) => ["google health write not sent: the linked account changed", { data_type: "exercise", operation }];

  const WRITES = [
    ["create", (client: GoogleHealthClient, account: string | undefined) => client.createExercise(SESSION, account), "the entry"],
    ["delete", (client: GoogleHealthClient, account: string | undefined) => client.deleteExercise("syn-point-9f3a", account as string), "the delete"],
  ] as const;

  it.each(WRITES)("a %s is not sent with the token of another account", async (kind, write, what) => {
    const requests = fakeApi(() => (kind === "create" ? created() : deleted()));
    const { client, tokens, budget, waits } = testClient();
    const error = await failure(write(client, OTHER_ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent`, hint: OWN_REQUEST });
    // No fetch, no unit of the budget, no retry.
    expect(requests).toHaveLength(0);
    expect(budget.used).toBe(0);
    expect(waits).toEqual([]);
    expect(tokens.asked).toBe(1);
    expect(tokens.invalidated).toEqual([]);
    expect(warnings()).toEqual([NOT_SENT_LINE(kind)]);
    expectNoSecret(error);
  });

  it.each(WRITES)("a %s is not sent with a token that names no account", async (kind, write, what) => {
    const requests = fakeApi(() => (kind === "create" ? created() : deleted()));
    const tokens = new FakeTokens();
    tokens.subs = [null];
    const error = await failure(write(testClient({}, tokens).client, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent`, hint: OWN_REQUEST });
    expect(requests).toHaveLength(0);
    expectNoSecret(error);
  });

  it("a create for a store without a link is not sent with the token of an account that signed in meanwhile", async () => {
    const requests = fakeApi(() => created());
    const error = await failure(testClient().client.createExercise(SESSION, undefined));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: the entry was not sent`, hint: OWN_REQUEST });
    expect(requests).toHaveLength(0);
  });

  it.each(WRITES)("a %s is not sent again when the renewed token belongs to another account", async (kind, write, what) => {
    // Google rejects the first token. The renewal answers the token of the account that signed in meanwhile.
    const requests = fakeApi((n) => (n === 1 ? apiError(401, "UNAUTHENTICATED") : kind === "create" ? created() : deleted()));
    const tokens = new FakeTokens();
    tokens.subs = [ACCOUNT, OTHER_ACCOUNT];
    const { client, budget } = testClient({}, tokens);
    const error = await failure(write(client, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent again`, hint: OWN_REQUEST });
    // The one attempt went out with the token of the account of the write.
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(budget.used).toBe(1);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "exercise", http_status: 401 }], NOT_SENT_LINE(kind)]);
    expectNoSecret(error);
  });

  it("the food log writes and the reads name no account, and are not compared", async () => {
    const requests = fakeApi((_n, request) => {
      if (request.method === "GET") return json(200, {});
      return request.path === FOOD_DELETE_PATH ? deleted() : created(FOOD_POINT);
    });
    const tokens = new FakeTokens();
    // A token source that says no account, as before the answer carried one.
    tokens.subs = [null];
    const { client } = testClient({}, tokens);
    expect(await client.createNutritionLog(FOOD)).toBe(FOOD_POINT);
    expect(await client.deleteNutritionLog("syn-point-9f3a")).toBe("deleted");
    expect(await client.list("exercise", "2026-10-16", "2026-10-16", (record) => record)).toEqual([]);
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-0", "Bearer at-0"]);
    expect(logged()).toBe("[]");
  });
});
