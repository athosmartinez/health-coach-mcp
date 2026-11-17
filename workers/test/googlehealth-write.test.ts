// The two writes of the Google Health client: the create of one nutrition-log
// data point and the delete of nutrition-log data points by name. The request
// shapes follow Google's documentation (src/googlehealth/nutritionlog.ts names
// the pages); no test calls Google. All values are synthetic.
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolError, toWire } from "../src/coach/errors";
import { RECONNECT_HINT } from "../src/google";
import { RequestBudget } from "../src/googlehealth/budget";
import {
  type ClientOptions,
  GoogleHealthClient,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  MAY_EXIST_HINT,
  type TokenResult,
  type TokenSource,
  WRITE_OWN_REQUEST_HINT,
  readTarget,
  writeTarget,
} from "../src/googlehealth/client";
import {
  CREATE_PATH,
  DELETE_PATH,
  GOOGLE_MAX_QUANTITY,
  MAX_WRITE_RESPONSE_BYTES,
  type NewFoodEntry,
  createBody,
  deleteBody,
  pointId,
  readCreateAnswer,
  readDeleteAnswer,
} from "../src/googlehealth/nutritionlog";
import { parseFood } from "../src/healthdata/nutrition";
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
  accept: string | null;
  contentType: string | null;
  redirect: string | undefined;
}

type Handle = (n: number, request: Sent, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replaces fetch: records every request to the Google Health API and answers with the handler of the test. */
function fakeApi(handle: Handle): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) throw new Error(`unexpected fetch in test: ${request.method} ${url.origin}`);
    const sent: Sent = {
      method: request.method,
      url: request.url,
      path: url.pathname.replace(/^\/v4/, ""),
      auth: request.headers.get("authorization") ?? "",
      text: await request.text(),
      accept: request.headers.get("accept"),
      contentType: request.headers.get("content-type"),
      redirect: init?.redirect,
    };
    requests.push(sent);
    return handle(requests.length, sent, init);
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
    {
      error: {
        code: status,
        status: grpcStatus,
        message: GOOGLE_MESSAGE,
        details: [{ "@type": "type.googleapis.com/google.rpc.DebugInfo", detail: BODY_MARK }],
      },
    },
    headers,
  );
}

const POINT = "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-point-9f3a";

/** The Operation of the documented create example: finished, with the data point. */
function created(name: string = POINT): Response {
  return json(200, {
    done: true,
    response: {
      "@type": "type.googleapis.com/google.devicesandservices.health.v4.DataPoint",
      name,
      dataSource: { recordingMethod: "UNKNOWN", application: { googleWebClientId: "synthetic-client" }, platform: "GOOGLE_WEB_API" },
      nutritionLog: { foodDisplayName: BODY_MARK },
    },
  });
}

/** The Operation of the documented batchDelete example. */
function deleted(): Response {
  return json(200, {
    done: true,
    response: {
      "@type": "type.googleapis.com/google.devicesandservices.health.v4.BatchDeleteDataPointsResponse",
      dataPoints: [{ name: POINT, nutritionLog: { foodDisplayName: BODY_MARK } }],
    },
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

/** 2026-10-16 11:30:45.9 in São Paulo. Every number has a fraction that no status or count has. */
const ENTRY: NewFoodEntry = {
  name: "Arroz com feijão",
  mealType: "LUNCH",
  at: new Date("2026-10-16T14:30:45.900Z"),
  utcOffsetSeconds: -10_800,
  kcal: 431.5,
  proteinGrams: 23.75,
  carbGrams: 51.25,
  fatGrams: 17.5,
};

const ENTRY_JSON =
  '{"nutritionLog":{"interval":{"startTime":"2026-10-16T14:30:45Z","startUtcOffset":"-10800s",' +
  '"endTime":"2026-10-16T14:30:46Z","endUtcOffset":"-10800s"},"foodDisplayName":"Arroz com feijão","mealType":"LUNCH",' +
  '"energy":{"kcal":431.5},"totalCarbohydrate":{"grams":51.25},"totalFat":{"grams":17.5},' +
  '"nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":23.75}}]}}';

/** Nothing of the entry, of a token or of Google's answer. */
const SECRETS = ["Arroz", "feij", "431.5", "23.75", "51.25", "17.5", "at-0", "at-1", BODY_MARK, "7711", "syn-point", "1122334455", "synthetic-client"];

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

const NOT_CREATED_HINT = "the entry was not created; try again in a few minutes";
const DELETE_AGAIN_HINT = "the entry may still exist; call nutrition_log_delete again in a few minutes (a repeated delete is safe)";
const WRITE_SCOPE_HINT = `${RECONNECT_HINT} Allow the permission to add nutrition data (googlehealth.nutrition.writeonly), and check that the Google Health API is enabled in the Cloud project.`;

describe("the allowlist of the client", () => {
  it("has exactly two writes for nutrition-log, and names that data type with each", () => {
    expect(CREATE_PATH).toBe("/users/me/dataTypes/nutrition-log/dataPoints");
    expect(DELETE_PATH).toBe("/users/me/dataTypes/nutrition-log/dataPoints:batchDelete");
    expect(writeTarget("POST", CREATE_PATH)).toEqual({ dataType: "nutrition-log", kind: "create" });
    expect(writeTarget("POST", DELETE_PATH)).toEqual({ dataType: "nutrition-log", kind: "delete" });
    // Neither is a read.
    expect(readTarget("POST", CREATE_PATH)).toBeUndefined();
    expect(readTarget("POST", DELETE_PATH)).toBeUndefined();
  });

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
    ["POST", "/users/me/dataTypes/hydration-log/dataPoints"],
    ["POST", "/users/me/dataTypes/hydration-log/dataPoints:batchDelete"],
    ["POST", "/users/me/dataTypes/steps/dataPoints"],
    ["POST", "/users/me/dataTypes/weight/dataPoints:batchDelete"],
    ["POST", "/users/me/dataTypes/sleep/dataPoints:batchDelete"],
    ["POST", "/users/me/dataTypes/food/dataPoints"],
    // The wildcard of batchDelete, which deletes across data types.
    ["POST", "/users/me/dataTypes/-/dataPoints:batchDelete"],
    ["POST", "/users/-/dataTypes/nutrition-log/dataPoints:batchDelete"],
    // Another user.
    ["POST", "/users/1122334455/dataTypes/nutrition-log/dataPoints"],
    ["POST", "/users/other/dataTypes/nutrition-log/dataPoints:batchDelete"],
    // Another operation on the food log.
    ["PATCH", "/users/me/dataTypes/nutrition-log/dataPoints/syn-point-9f3a"],
    ["DELETE", "/users/me/dataTypes/nutrition-log/dataPoints/syn-point-9f3a"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints/syn-point-9f3a"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints:batchCreate"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints:batchdelete"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints:batchDelete/"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints/"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints:batchDelete:x"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints?x=1"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints:batchDelete?force=true"],
    ["POST", "//users/me/dataTypes/nutrition-log/dataPoints"],
    ["POST", "/users/me/dataTypes/nutrition-log/../steps/dataPoints"],
    ["POST", "/users/me/dataTypes/nutrition-log/dataPoints%3AbatchDelete"],
    ["POST", " /users/me/dataTypes/nutrition-log/dataPoints"],
    ["POST", "/users/me/dataTypes/NUTRITION-LOG/dataPoints"],
    ["POST", "/users/me/profile"],
    ["POST", "/users/me/dataTypes/nutrition-log"],
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
    // A write with a query is neither of the two: the whole input of a write is its body.
    for (const path of [CREATE_PATH, DELETE_PATH]) {
      expect((await failure(probe.probe("POST", path, "x=1", "{}"))).message).toContain("the client refuses");
      expect((await failure(probe.probe("POST", path, "", "{}"))).message).toContain("the client refuses");
    }
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
    expect(budget.used).toBe(0);
  });

  it("sends the two writes, and nothing else, through the request guard", async () => {
    const requests = fakeApi(() => created());
    const probe = new Probe({ tokens: new FakeTokens(), zone: SAO_PAULO, budget: new RequestBudget() });
    await probe.probe("POST", CREATE_PATH, undefined, "{}");
    await probe.probe("POST", DELETE_PATH, undefined, "{}");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints",
      "POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete",
    ]);
  });
});

describe("the body of a create", () => {
  it("is the documented nutritionLog, with both offsets and an end one second after the start", () => {
    expect(JSON.stringify(createBody(ENTRY))).toBe(ENTRY_JSON);
  });

  it("leaves out a macro that is unknown, and sends a zero as a zero", () => {
    const { nutritionLog } = createBody({ name: "Water", mealType: "SNACK", at: ENTRY.at, utcOffsetSeconds: -10_800, kcal: 0 });
    expect(Object.keys(nutritionLog)).toEqual(["interval", "foodDisplayName", "mealType", "energy"]);
    expect(JSON.stringify(nutritionLog.energy)).toBe('{"kcal":0}');

    const zeros = createBody({ ...ENTRY, kcal: -0, proteinGrams: 0, carbGrams: -0, fatGrams: 0 });
    expect(JSON.stringify(zeros)).toContain('"energy":{"kcal":0},"totalCarbohydrate":{"grams":0},"totalFat":{"grams":0},"nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":0}}]');
    // A negative zero is sent, and returned, as zero.
    expect(Object.is(zeros.nutritionLog.energy.kcal, 0)).toBe(true);
    expect(Object.is(zeros.nutritionLog.totalCarbohydrate?.grams, 0)).toBe(true);
  });

  it.each([
    ["east of UTC", 19_800, "19800s"],
    ["UTC", 0, "0s"],
    ["a negative zero", -0, "0s"],
    ["west of UTC", -34_200, "-34200s"],
  ])("writes the offset of a zone %s as seconds", (_name, seconds, text) => {
    const { interval } = createBody({ ...ENTRY, utcOffsetSeconds: seconds }).nutritionLog;
    expect(interval).toEqual({ startTime: "2026-10-16T14:30:45Z", startUtcOffset: text, endTime: "2026-10-16T14:30:46Z", endUtcOffset: text });
  });

  it("ends one second after 23:59:59 with the same offset, and the food read keeps the start's day", () => {
    // 23:59:59.900 in São Paulo. The next second is 00:00:00 the next local day.
    const at = new Date("2026-10-17T02:59:59.900Z");
    const body = createBody({ ...ENTRY, at, utcOffsetSeconds: -10_800 });
    expect(body.nutritionLog.interval).toEqual({
      startTime: "2026-10-17T02:59:59Z",
      startUtcOffset: "-10800s",
      endTime: "2026-10-17T03:00:00Z",
      endUtcOffset: "-10800s",
    });
    const read = parseFood(
      { name: "users/me/dataTypes/nutrition-log/dataPoints/syn-late", dataSource: { platform: "GOOGLE_WEB_API" }, ...body },
      new Set(["syn-late"]),
    );
    expect(read.kind).toBe("item");
    if (read.kind !== "item") return;
    expect(SAO_PAULO.dateOf(read.item.at)).toBe("2026-10-16");
    expect(SAO_PAULO.dateOf(Date.parse(body.nutritionLog.interval.endTime))).toBe("2026-10-17");
  });

  it.each([
    ["a kcal above Google's range", { kcal: GOOGLE_MAX_QUANTITY + 1 }],
    ["a negative kcal", { kcal: -1 }],
    ["a kcal that is not a number", { kcal: Number.NaN }],
    ["an infinite protein", { proteinGrams: Number.POSITIVE_INFINITY }],
    ["a negative carbohydrate", { carbGrams: -0.5 }],
    ["a fat above Google's range", { fatGrams: 100_000.5 }],
    ["an empty name", { name: "" }],
    ["an invalid time", { at: new Date(Number.NaN) }],
    ["an offset with a fraction", { utcOffsetSeconds: -10_800.5 }],
    ["an offset beyond any zone", { utcOffsetSeconds: 19 * 3600 }],
    ["an offset that is not a number", { utcOffsetSeconds: Number.NaN }],
  ])("refuses %s before any request", async (_name, change) => {
    const requests = fakeApi(() => created());
    const { client, tokens, budget } = testClient();
    const error = await failure(client.createNutritionLog({ ...ENTRY, ...change }, ACCOUNT));
    // The tool checks its input first: this is a caller bug.
    expect(error).not.toBeInstanceOf(ToolError);
    expect(toWire(error).code).toBe("internal_error");
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
    expect(budget.used).toBe(0);
    expectNoSecret(error);
  });

  it("accepts the limits of Google's range", () => {
    const { nutritionLog } = createBody({ ...ENTRY, kcal: GOOGLE_MAX_QUANTITY, proteinGrams: GOOGLE_MAX_QUANTITY, carbGrams: 0, fatGrams: GOOGLE_MAX_QUANTITY });
    expect(nutritionLog.energy.kcal).toBe(100_000);
  });
});

describe("createNutritionLog", () => {
  it("sends one POST with the entry and returns the name of the finished Operation", async () => {
    const requests = fakeApi(() => created());
    const { client, tokens, budget, waits } = testClient();
    expect(await client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints",
        path: CREATE_PATH,
        auth: "Bearer at-0",
        text: ENTRY_JSON,
        accept: "application/json",
        contentType: "application/json",
        redirect: "manual",
      },
    ]);
    expect(budget.used).toBe(1);
    expect(tokens.asked).toBe(1);
    expect(waits).toEqual([]);
    // A successful write logs nothing here: the tool call line is the server's.
    expect(logged()).toBe("[]");
  });

  it("is sent again after a 429, which proves that Google did not take it", async () => {
    const requests = fakeApi((n) => (n < 3 ? apiError(429, "RESOURCE_EXHAUSTED") : created()));
    const { client, budget, waits } = testClient();
    expect(await client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
    expect(requests).toHaveLength(3);
    // Every attempt sends the same entry.
    expect(new Set(requests.map((request) => request.text))).toEqual(new Set([ENTRY_JSON]));
    expect(waits).toEqual([1000, 2000]);
    // Every attempt took a unit.
    expect(budget.used).toBe(3);
    expect(warnings()).toEqual([1, 2].map((retry) => ["google health request failed; retrying", { data_type: "nutrition-log", http_status: 429, retry, wait_ms: retry * 1000 }]));
    expectNoSecret();
  });

  it("is sent again after a quota 403, as after a 429", async () => {
    const requests = fakeApi((n) => (n === 1 ? apiError(403, "RESOURCE_EXHAUSTED") : created()));
    const { client, waits } = testClient();
    expect(await client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("answers that the entry was not created when the 429 answers use every attempt", async () => {
    const requests = fakeApi(() => apiError(429, "RESOURCE_EXHAUSTED"));
    const { client, budget, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: NOT_CREATED_HINT });
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(budget.used).toBe(MAX_ATTEMPTS);
    expect(waits).toEqual([1000, 2000, 4000]);
    expectNoSecret(error);
  });

  it("answers that the entry was not created for a Retry-After over the cap, without a wait", async () => {
    const requests = fakeApi(() => apiError(429, "RESOURCE_EXHAUSTED", { "retry-after": String(MAX_RETRY_AFTER_MS / 1000 + 1) }));
    const { client, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: NOT_CREATED_HINT });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it.each([408, 500, 502, 503, 504, 599])("is never sent again after HTTP %i: the entry may exist", async (status) => {
    const requests = fakeApi(() => apiError(status, "UNAVAILABLE", { "retry-after": "1" }));
    const { client, budget, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: MAY_EXIST_HINT });
    expect(MAY_EXIST_HINT).toContain("the entry may exist: check the day with nutrition_day before a new try");
    expect(requests).toHaveLength(1);
    expect(budget.used).toBe(1);
    expect(waits).toEqual([]);
    expectNoSecret(error);
  });

  it("is never sent again after a network error: the request may have reached Google", async () => {
    const requests = fakeApi(() => {
      throw new TypeError(`connection reset while sending ${BODY_MARK}`);
    });
    const { client, budget, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API could not be reached", hint: MAY_EXIST_HINT });
    expect(requests).toHaveLength(1);
    expect(budget.used).toBe(1);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health request did not complete", { data_type: "nutrition-log", cause: "TypeError" }]]);
    expectNoSecret(error);
  });

  it("is never sent again after a timeout", async () => {
    const requests = fakeApi(
      (_n, _request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const { client, waits } = testClient({ timeoutMs: 20 });
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API could not be reached", hint: MAY_EXIST_HINT });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health request did not complete", { data_type: "nutrition-log", cause: "TimeoutError" }]]);
  });

  it("is never sent again when the answer breaks while it is read", async () => {
    const requests = fakeApi(() => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error(`broken stream ${BODY_MARK}`));
        },
      });
      return new Response(body, { status: 200 });
    });
    const { client, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API could not be reached", hint: MAY_EXIST_HINT });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expectNoSecret(error);
  });

  it("reads the answer through a small cap, and an answer over it is an entry that may exist", async () => {
    expect(MAX_WRITE_RESPONSE_BYTES).toBe(64 * 1024);
    const filler = "x".repeat(MAX_WRITE_RESPONSE_BYTES);
    const requests = fakeApi(() => json(200, { done: true, response: { name: POINT, filler } }));
    const { client, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health returned an unreadable answer for the entry", hint: MAY_EXIST_HINT });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);

    // At the cap, the same answer is read.
    vi.mocked(globalThis.fetch).mockRestore();
    const padded = (size: number) => {
      const base = JSON.stringify({ done: true, response: { name: POINT, filler: "" } });
      return new Response(JSON.stringify({ done: true, response: { name: POINT, filler: "x".repeat(size - base.length) } }), { status: 200 });
    };
    fakeApi(() => padded(MAX_WRITE_RESPONSE_BYTES));
    expect(await testClient().client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
  });

  it("renews a rejected token once and sends the entry again", async () => {
    const requests = fakeApi((n) => (n === 1 ? apiError(401, "UNAUTHENTICATED") : created()));
    const { client, tokens, budget, waits } = testClient();
    expect(await client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-1"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    // Both attempts took a unit; a renewal is not a failure, so there is no wait.
    expect(budget.used).toBe(2);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "nutrition-log", http_status: 401 }]]);
  });

  it("answers auth_expired when the renewed token is rejected too", async () => {
    const requests = fakeApi(() => apiError(401, "UNAUTHENTICATED"));
    const { client } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "Google Health rejected the sign-in", hint: RECONNECT_HINT });
    expect(requests).toHaveLength(2);
    expectNoSecret(error);
  });

  it("answers auth_expired without a request when no account is linked", async () => {
    const requests = fakeApi(() => created());
    const tokens = new FakeTokens();
    tokens.failure = { ok: false, code: "not_linked" };
    const { client, budget } = testClient({}, tokens);
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT });
    expect(requests).toHaveLength(0);
    expect(budget.used).toBe(0);
  });

  it("answers scope_missing for a 403, with the write scope and the reconnect step in the hint", async () => {
    const requests = fakeApi(() => apiError(403, "PERMISSION_DENIED"));
    const { client, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "scope_missing", message: "Google Health denied the write of nutrition-log data", hint: WRITE_SCOPE_HINT });
    expect(WRITE_SCOPE_HINT).toContain("googlehealth.nutrition.writeonly");
    expect(WRITE_SCOPE_HINT).toContain("Disconnect and reconnect this connector");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expectNoSecret(error);
  });

  it("renews once on the stale-token 403, and a second one is scope_missing", async () => {
    const stale = () => json(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    const requests = fakeApi((n) => (n === 1 ? stale() : created()));
    const first = testClient();
    expect(await first.client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-1"]);

    vi.mocked(globalThis.fetch).mockRestore();
    const again = fakeApi(() => stale());
    const error = await failure(testClient().client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toMatchObject({ code: "scope_missing", hint: WRITE_SCOPE_HINT });
    expect(again).toHaveLength(2);
  });

  it.each([
    [400, "INVALID_ARGUMENT"],
    [404, "NOT_FOUND"],
    [409, "ALREADY_EXISTS"],
    [412, "FAILED_PRECONDITION"],
    [422, ""],
  ])("answers that Google refused the entry for HTTP %i, without a retry", async (status, grpc) => {
    const requests = fakeApi(() => apiError(status, grpc));
    const { client, waits } = testClient();
    const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: `Google Health refused the entry: ${GOOGLE_MESSAGE}`,
      hint: "the entry was not created; check the date, the time and the values",
    });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    // The status, Google's enum and the short message. Not the rest of the body.
    expect(warnings()).toEqual([
      ["google health request rejected", { data_type: "nutrition-log", http_status: status, google_status: grpc, google_message: GOOGLE_MESSAGE }],
    ]);
    expectNoSecret(error);
  });

  it("does not follow a redirect, and answers internal_error for it", async () => {
    const requests = fakeApi(() => new Response(null, { status: 307, headers: { location: "https://health.googleapis.com/v4/elsewhere" } }));
    const error = await failure(testClient().client.createNutritionLog(ENTRY, ACCOUNT));
    expect(error).not.toBeInstanceOf(ToolError);
    expect(toWire(error).code).toBe("internal_error");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
  });

  describe("an Operation that gives no name", () => {
    const OTHER_TYPE = "users/1122334455/dataTypes/hydration-log/dataPoints/syn-point-9f3a";
    const NOT_DONE = "Google Health has not finished creating the entry";
    const FAILED = "Google Health reported an error for the entry";
    const NO_NAME = "Google Health returned no usable id for the entry";
    const UNREADABLE = "Google Health returned an unreadable answer for the entry";
    const CASES: [string, unknown, string, string, Record<string, unknown>][] = [
      ["is not finished", { name: "operations/syn-1", metadata: { note: BODY_MARK } }, "not_done", NOT_DONE, {}],
      ["says done: false", { done: false, response: { name: POINT } }, "not_done", NOT_DONE, {}],
      ["has a done that is not a boolean", { done: "true", response: { name: POINT } }, "not_done", NOT_DONE, {}],
      ["has an error", { done: true, error: { code: 3, message: BODY_MARK } }, "operation_error", FAILED, { google_code: 3 }],
      ["has an error and a response", { done: true, error: { code: 13, message: BODY_MARK }, response: { name: POINT } }, "operation_error", FAILED, { google_code: 13 }],
      ["has an error with a code outside the enum", { done: true, error: { code: 431.5, message: BODY_MARK } }, "operation_error", FAILED, {}],
      ["has an error that is not an object", { done: true, error: BODY_MARK }, "operation_error", FAILED, {}],
      ["is finished without a response", { done: true }, "no_name", NO_NAME, {}],
      ["has a response without a name", { done: true, response: { nutritionLog: {} } }, "no_name", NO_NAME, {}],
      ["names a point of another data type", { done: true, response: { name: OTHER_TYPE } }, "no_name", NO_NAME, {}],
      ["names a data type, not a point", { done: true, response: { name: "users/1122334455/dataTypes/nutrition-log" } }, "no_name", NO_NAME, {}],
      ["names a point with more path parts", { done: true, response: { name: `${POINT}/extra` } }, "no_name", NO_NAME, {}],
      ["has a name that is not a text", { done: true, response: { name: 7711 } }, "no_name", NO_NAME, {}],
      ["has a name longer than a name can be", { done: true, response: { name: `users/${"u".repeat(300)}/dataTypes/nutrition-log/dataPoints/a` } }, "no_name", NO_NAME, {}],
      ["has the name outside the response", { done: true, name: POINT }, "no_name", NO_NAME, {}],
      ["is a list", [{ done: true, response: { name: POINT } }], "unreadable", UNREADABLE, {}],
      ["is null", null, "unreadable", UNREADABLE, {}],
      ["is a text", POINT, "unreadable", UNREADABLE, {}],
    ];

    it.each(CASES)("an answer that %s is an entry that may exist: no id is made up", async (_name, body, reason, message, extra) => {
      const requests = fakeApi(() => json(200, body));
      const { client, waits } = testClient();
      const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
      expect(toWire(error)).toEqual({ code: "upstream_unavailable", message, hint: MAY_EXIST_HINT });
      // Google answered 200: the entry is never sent again.
      expect(requests).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(warnings()).toEqual([["google health write answer not usable", { data_type: "nutrition-log", operation: "create", reason, ...extra }]]);
      expectNoSecret(error);
    });

    it.each([
      ["an empty body", ""],
      ["a text that is not JSON", `<html>${BODY_MARK}</html>`],
      ["a cut JSON text", `{"done": true, "response": {"name": "${POINT}"`],
    ])("%s is unreadable", async (_name, body) => {
      fakeApi(() => new Response(body, { status: 200 }));
      const error = await failure(testClient().client.createNutritionLog(ENTRY, ACCOUNT));
      expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: UNREADABLE, hint: MAY_EXIST_HINT });
      expectNoSecret(error);
    });

    it("reads a name in any user form, and only for nutrition-log", () => {
      expect(readCreateAnswer(JSON.stringify({ done: true, response: { name: "users/me/dataTypes/nutrition-log/dataPoints/a.b_c-9" } }))).toEqual({
        ok: true,
        name: "users/me/dataTypes/nutrition-log/dataPoints/a.b_c-9",
      });
      expect(pointId(POINT)).toBe("syn-point-9f3a");
      expect(pointId("users/me/dataTypes/nutrition-log/dataPoints/syn-point-9f3a")).toBe("syn-point-9f3a");
      for (const name of ["", "syn-point-9f3a", OTHER_TYPE, `${POINT}/x`, `x/${POINT}`, `${POINT} `, `${POINT}\n`, "users//dataTypes/nutrition-log/dataPoints/a", "users/me/dataTypes/nutrition-log/dataPoints/"]) {
        expect(pointId(name), JSON.stringify(name)).toBeUndefined();
      }
      expect(pointId(7711 as unknown as string)).toBeUndefined();
    });
  });

  describe("the request budget", () => {
    it("does not send a create the budget has no unit for, and says so", async () => {
      const requests = fakeApi(() => created());
      const budget = new RequestBudget(1);
      const { client, tokens } = testClient({ budget });
      expect(await client.createNutritionLog(ENTRY, ACCOUNT)).toBe(POINT);
      const asked = tokens.asked;

      const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
      expect(toWire(error)).toEqual({
        code: "invalid_input",
        message: "this MCP request already sent all the Google Health requests one request may send: the entry was not sent",
        hint: "send this call in a request of its own",
      });
      expect(WRITE_OWN_REQUEST_HINT).toBe("send this call in a request of its own");
      // Not the text of a read that ran out: a write has no date range.
      expect(toWire(error).message).not.toContain("date range");
      expect(toWire(error).hint).not.toContain("date range");
      expect(requests).toHaveLength(1);
      expect(tokens.asked).toBe(asked);
      expect(logged()).toBe("[]");
    });

    it("answers that the entry was not created when a 429 takes the last unit", async () => {
      const requests = fakeApi(() => apiError(429, "RESOURCE_EXHAUSTED"));
      const { client, waits } = testClient({ budget: new RequestBudget(2) });
      const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
      expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: NOT_CREATED_HINT });
      expect(requests).toHaveLength(2);
      // No wait before a request that cannot be sent.
      expect(waits).toEqual([1000]);
    });

    it("answers that the entry was not created when a rejected token takes the last unit", async () => {
      const requests = fakeApi(() => apiError(401, "UNAUTHENTICATED"));
      const { client, tokens } = testClient({ budget: new RequestBudget(1) });
      const error = await failure(client.createNutritionLog(ENTRY, ACCOUNT));
      expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: NOT_CREATED_HINT });
      expect(requests).toHaveLength(1);
      expect(tokens.invalidated).toEqual(["at-0"]);
    });
  });
});

describe("deleteNutritionLog", () => {
  it("sends one POST to batchDelete with the name of the point under users/me", async () => {
    const requests = fakeApi(() => deleted());
    const { client, budget } = testClient();
    expect(await client.deleteNutritionLog("syn-point-9f3a", ACCOUNT)).toBe("deleted");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete",
        path: DELETE_PATH,
        auth: "Bearer at-0",
        text: '{"names":["users/me/dataTypes/nutrition-log/dataPoints/syn-point-9f3a"]}',
        accept: "application/json",
        contentType: "application/json",
        redirect: "manual",
      },
    ]);
    expect(budget.used).toBe(1);
    expect(logged()).toBe("[]");
  });

  it.each(["", "a/b", "users/me/dataTypes/nutrition-log/dataPoints/a", "a b", 'a"b', "a\nb", "x".repeat(129), "-/-", "é"])("refuses the ID %j before any request", async (id) => {
    const requests = fakeApi(() => deleted());
    const { client, tokens } = testClient();
    const error = await failure(client.deleteNutritionLog(id, ACCOUNT));
    expect(error).not.toBeInstanceOf(ToolError);
    expect(() => deleteBody(id)).toThrow("not a data point ID");
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
  });

  it("takes Google's own 404, with the status NOT_FOUND, as a point that is already gone, without a retry", async () => {
    const requests = fakeApi(() => apiError(404, "NOT_FOUND"));
    const { client, waits } = testClient();
    expect(await client.deleteNutritionLog("syn-point-9f3a", ACCOUNT)).toBe("gone");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(logged()).toBe("[]");
  });

  // A 404 that is not Google's JSON error says nothing about the point: a
  // front end answers it for a path or a body that is wrong. Taken as "gone",
  // the server would forget an entry that Google still holds.
  it.each([
    ["the HTML page of a front end", () => new Response(`<html><title>Error 404 (Not Found)</title>${BODY_MARK} NOT_FOUND</html>`, { status: 404, headers: { "content-type": "text/html" } }), "", ""],
    ["an empty body", () => new Response(null, { status: 404 }), "", ""],
    ["a JSON error without a status", () => json(404, { error: { code: 404, message: "no such point", detail: BODY_MARK } }), "", "no such point"],
    ["a JSON error whose status is not an enum text", () => json(404, { error: { code: 404, status: "not found", message: "no such point", detail: BODY_MARK } }), "", "no such point"],
    ["a JSON error with another status", () => apiError(404, "UNIMPLEMENTED"), "UNIMPLEMENTED", GOOGLE_MESSAGE],
    ["a JSON body that only names NOT_FOUND in a text", () => json(404, { message: "NOT_FOUND", status: "NOT_FOUND" }), "", ""],
    ["a JSON text NOT_FOUND", () => json(404, "NOT_FOUND"), "", ""],
  ] as [string, () => Response, string, string][])("takes a 404 with %s as a refused delete, not as a point that is gone", async (_name, reply, grpc, googleMessage) => {
    const requests = fakeApi(reply);
    const { client, waits } = testClient();
    const error = await failure(client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    const message = googleMessage === "" ? "Google Health refused the delete" : `Google Health refused the delete: ${googleMessage}`;
    expect(toWire(error)).toEqual({ code: "invalid_input", message, hint: "the entry was not deleted" });
    // An answer, so no retry.
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([
      [
        "google health request rejected",
        { data_type: "nutrition-log", http_status: 404, google_status: grpc, ...(googleMessage === "" ? {} : { google_message: googleMessage }) },
      ],
    ]);
    expectNoSecret(error);
  });

  it("is sent again after a 429, a 5xx and a network error: a delete of a name is idempotent", async () => {
    const requests = fakeApi((n) => {
      if (n === 1) return apiError(429, "RESOURCE_EXHAUSTED");
      if (n === 2) return apiError(503, "UNAVAILABLE");
      if (n === 3) throw new TypeError("connection reset");
      return deleted();
    });
    const { client, budget, waits } = testClient();
    expect(await client.deleteNutritionLog("syn-point-9f3a", ACCOUNT)).toBe("deleted");
    expect(requests).toHaveLength(4);
    expect(budget.used).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expectNoSecret();
  });

  it("answers unavailable, with a hint to delete again, when every attempt fails", async () => {
    const requests = fakeApi(() => apiError(503, "UNAVAILABLE"));
    const { client, waits } = testClient();
    const error = await failure(client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: DELETE_AGAIN_HINT });
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(waits).toEqual([1000, 2000, 4000]);
    expectNoSecret(error);
  });

  it.each([
    ["is not finished", { name: "operations/syn-2" }, "not_done", "Google Health has not finished the delete", {}],
    ["has an error", { done: true, error: { code: 5, message: BODY_MARK } }, "operation_error", "Google Health reported an error for the delete", { google_code: 5 }],
    ["is not an object", [BODY_MARK], "unreadable", "Google Health returned an unreadable answer for the delete", {}],
  ])("answers unavailable for an Operation that %s", async (_name, body, reason, message, extra) => {
    const requests = fakeApi(() => json(200, body));
    const error = await failure(testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message, hint: DELETE_AGAIN_HINT });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([["google health write answer not usable", { data_type: "nutrition-log", operation: "delete", reason, ...extra }]]);
    expectNoSecret(error);
  });

  it("takes a finished Operation as a delete that happened, whatever it lists", () => {
    expect(readDeleteAnswer('{"done":true}')).toEqual({ ok: true });
    expect(readDeleteAnswer('{"done":true,"response":{}}')).toEqual({ ok: true });
    expect(readDeleteAnswer('{"done":true,"error":null}')).toEqual({ ok: true });
    expect(readDeleteAnswer("{}")).toEqual({ ok: false, fault: "not_done" });
    expect(readDeleteAnswer("")).toEqual({ ok: false, fault: "unreadable" });
  });

  it("answers unavailable for an answer over the cap", async () => {
    const requests = fakeApi(() => json(200, { done: true, filler: "x".repeat(MAX_WRITE_RESPONSE_BYTES) }));
    const error = await failure(testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "upstream_unavailable", message: "Google Health returned an unreadable answer for the delete", hint: DELETE_AGAIN_HINT });
    expect(requests).toHaveLength(1);
  });

  it("answers that Google refused the delete for another 4xx", async () => {
    const requests = fakeApi(() => apiError(400, "INVALID_ARGUMENT"));
    const error = await failure(testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `Google Health refused the delete: ${GOOGLE_MESSAGE}`, hint: "the entry was not deleted" });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([
      ["google health request rejected", { data_type: "nutrition-log", http_status: 400, google_status: "INVALID_ARGUMENT", google_message: GOOGLE_MESSAGE }],
    ]);
    expectNoSecret(error);
  });

  it.each(["create", "delete"] as const)("a 400 %s repeats Google's reason and a short message, and nothing else of the body", async (kind) => {
    const head = "endTime must be after startTime. ";
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
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "BAD_INTERVAL",
              domain: "health.googleapis.com",
              metadata: { user: "owner@example.com", token: "ya29.a0AfH6SM-secret" },
            },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "END_TIME_EMPTY", domain: "health.googleapis.com" },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "owner@example.com" },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "BAD_INTERVAL" },
          ],
        },
      }),
    );
    const error = await failure(kind === "create" ? testClient().client.createNutritionLog(ENTRY, ACCOUNT) : testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    const wire = toWire(error);
    const base = kind === "create" ? "Google Health refused the entry" : "Google Health refused the delete";
    const loggedMessage = (warnings()[0]?.[1] as { google_message?: string } | undefined)?.google_message ?? "";
    expect(loggedMessage.startsWith(head)).toBe(true);
    expect(loggedMessage.endsWith("…")).toBe(true);
    expect(loggedMessage.length).toBe(201);
    expect(loggedMessage).not.toContain(tail);
    expect(wire).toEqual({
      code: "invalid_input",
      message: `${base}: BAD_INTERVAL, END_TIME_EMPTY: ${loggedMessage}`,
      hint: kind === "create" ? "the entry was not created; check the date, the time and the values" : "the entry was not deleted",
    });
    expect(requests).toHaveLength(1);
    expect(warnings()).toEqual([
      [
        "google health request rejected",
        {
          data_type: "nutrition-log",
          http_status: 400,
          google_status: "INVALID_ARGUMENT",
          google_reason: "BAD_INTERVAL, END_TIME_EMPTY",
          google_message: loggedMessage,
        },
      ],
    ]);
    const shown = `${texts(error)} ${logged()}`;
    for (const secret of ["owner@example.com", "1122334455", "ya29", "at-stored-51c2", "Bearer", BODY_MARK, "NOT_AN_ERRORINFO", tail]) {
      expect(shown, secret).not.toContain(secret);
    }
    expectNoSecret(error);
  });

  it("drops a write message that is only a token, an email or a user id", async () => {
    fakeApi(() =>
      json(400, {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "owner@example.com users/1122334455 ya29.a0AfH6SM-secret",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "BAD_INTERVAL", domain: "health.googleapis.com" }],
        },
      }),
    );
    const error = await failure(testClient().client.createNutritionLog(ENTRY, ACCOUNT));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "Google Health refused the entry: BAD_INTERVAL",
      hint: "the entry was not created; check the date, the time and the values",
    });
    expect(warnings()).toEqual([
      ["google health request rejected", { data_type: "nutrition-log", http_status: 400, google_status: "INVALID_ARGUMENT", google_reason: "BAD_INTERVAL" }],
    ]);
    const shown = `${texts(error)} ${logged()}`;
    for (const secret of ["owner@example.com", "1122334455", "ya29"]) expect(shown, secret).not.toContain(secret);
    expectNoSecret(error);
  });

  it("answers scope_missing for a 403 and auth_expired for a 401 that repeats", async () => {
    fakeApi(() => apiError(403, "PERMISSION_DENIED"));
    expect(toWire(await failure(testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT)))).toEqual({
      code: "scope_missing",
      message: "Google Health denied the write of nutrition-log data",
      hint: WRITE_SCOPE_HINT,
    });
    vi.mocked(globalThis.fetch).mockRestore();
    const requests = fakeApi(() => apiError(401, "UNAUTHENTICATED"));
    expect(toWire(await failure(testClient().client.deleteNutritionLog("syn-point-9f3a", ACCOUNT)))).toMatchObject({ code: "auth_expired", hint: RECONNECT_HINT });
    expect(requests).toHaveLength(2);
  });

  it("does not send a delete the budget has no unit for, and says so", async () => {
    const requests = fakeApi(() => deleted());
    const error = await failure(testClient({ budget: new RequestBudget(0) }).client.deleteNutritionLog("syn-point-9f3a", ACCOUNT));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "this MCP request already sent all the Google Health requests one request may send: the delete was not sent",
      hint: WRITE_OWN_REQUEST_HINT,
    });
    expect(requests).toHaveLength(0);
  });
});

// Google's error.message can repeat a value of the request. An entry carries
// the food name the caller wrote, and no name, amount or entry id may reach
// an error or a log line. The meal type and the times are the server's own.
describe("a refusal of Google that repeats what the food request sent", () => {
  const REASON = "SYNTHETIC_FIELD_REJECTED";
  const refusal = (message: string) => () =>
    json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: REASON, domain: "health.googleapis.com" }] } });

  function rejectLine(): string {
    expect(warnings()).toHaveLength(1);
    const [text, fields] = warnings()[0] as [string, { google_reason?: string; google_message?: string }];
    expect(text).toBe("google health request rejected");
    expect(fields.google_reason).toBe(REASON);
    return fields.google_message ?? "";
  }

  it("a create: the food name, the kcal and each macro are taken out, in any letter case, and the meal type and the time stay", async () => {
    const requests = fakeApi(
      refusal('Invalid value at nutrition_log.food_display_name: "ARROZ COM FEIJÃO". Energy 431.5, carbohydrate 51.25, fat 17.5 and protein 23.75 were not accepted for LUNCH at 2026-10-16T14:30:45Z.'),
    );
    const error = await failure(testClient().client.createNutritionLog(ENTRY, ACCOUNT));
    const kept = 'Invalid value at nutrition_log.food_display_name: " ". Energy , carbohydrate , fat and protein were not accepted for LUNCH at 2026-10-16T14:30:45Z.';
    expect(rejectLine()).toBe(kept);
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: `Google Health refused the entry: ${REASON}: ${kept}`,
      hint: "the entry was not created; check the date, the time and the values",
    });
    expect(requests).toHaveLength(1);
    const shown = `${texts(error)} ${logged()}`.toLowerCase();
    for (const sent of ["arroz", "feij", "431.5", "51.25", "17.5", "23.75"]) expect(shown, sent).not.toContain(sent);
    expect(shown).toContain("lunch");
    expectNoSecret(error);
  });

  it("a create: a text that Google repeats twice, and a number that is also in the name, leave no rest", async () => {
    const name = "porção 431.5";
    fakeApi(refusal(`name [${name}] again [${name.toUpperCase()}] energy 431.5 rejected`));
    const error = await failure(testClient().client.createNutritionLog({ ...ENTRY, name }, ACCOUNT));
    expect(rejectLine()).toBe("name [ ] again [ ] energy rejected");
    expect(texts(error).toLowerCase()).not.toContain("431.5");
    expect(texts(error).toLowerCase()).not.toContain("por");
  });

  it("a create: a text of the request is taken out before the redaction can cut it into parts", async () => {
    const name = "Aula com owner@example.com na sexta";
    fakeApi(refusal(`name "${name}" rejected`));
    const error = await failure(testClient().client.createNutritionLog({ ...ENTRY, name, proteinGrams: undefined, carbGrams: undefined, fatGrams: undefined }, ACCOUNT));
    expect(rejectLine()).toBe('name " " rejected');
    for (const part of ["Aula", "example.com", "sexta"]) expect(`${texts(error)} ${logged()}`, part).not.toContain(part);
  });

  it("a create: the meal type is not taken out, so it stays in the message", async () => {
    const message = "meal_type LUNCH is not accepted here";
    fakeApi(refusal(message));
    const error = await failure(testClient().client.createNutritionLog({ ...ENTRY, name: "ok", kcal: 50, proteinGrams: undefined, carbGrams: undefined, fatGrams: undefined }, ACCOUNT));
    expect(rejectLine()).toBe(message);
    expect(toWire(error).message).toBe(`Google Health refused the entry: ${REASON}: ${message}`);
  });

  it("a create: a text shorter than 3 characters is not taken out", async () => {
    const message = "energy 50 at 2026-10-16T14:50:00Z is too low";
    fakeApi(refusal(message));
    await failure(testClient().client.createNutritionLog({ ...ENTRY, name: "ok", kcal: 50, proteinGrams: undefined, carbGrams: undefined, fatGrams: undefined }, ACCOUNT));
    expect(rejectLine()).toBe(message);
  });

  it.each(["syn_point_k", "4410772"])("a delete: the data point id %s is taken out, in any letter case", async (id) => {
    const requests = fakeApi(refusal(`Data point users/me/dataTypes/nutrition-log/dataPoints/${id} (${id.toUpperCase()}) cannot be deleted.`));
    const error = await failure(testClient().client.deleteNutritionLog(id, ACCOUNT));
    const kept = "Data point /dataTypes/nutrition-log/dataPoints/ ( ) cannot be deleted.";
    expect(rejectLine()).toBe(kept);
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `Google Health refused the delete: ${REASON}: ${kept}`, hint: "the entry was not deleted" });
    expect(requests).toHaveLength(1);
    expect(`${texts(error)} ${logged()}`.toLowerCase()).not.toContain(id.toLowerCase());
  });
});

// The tool reads the account from the store, and the client takes the token on
// its own. A food write names the account the tool checked, and goes out only
// with a token of that account.
describe("the Google account of a food write", () => {
  const CHANGED = "the linked Google account changed during this MCP request";
  const NOT_SENT_LINE = (operation: string) => ["google health write not sent: the linked account changed", { data_type: "nutrition-log", operation }];

  const WRITES = [
    ["create", (client: GoogleHealthClient, account: string | undefined) => client.createNutritionLog(ENTRY, account), "the entry"],
    ["delete", (client: GoogleHealthClient, account: string | undefined) => client.deleteNutritionLog("syn-point-9f3a", account as string), "the delete"],
  ] as const;

  it.each(WRITES)("a %s is not sent with the token of another account", async (kind, write, what) => {
    const requests = fakeApi(() => (kind === "create" ? created() : deleted()));
    const { client, tokens, budget, waits } = testClient();
    const error = await failure(write(client, OTHER_ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent`, hint: WRITE_OWN_REQUEST_HINT });
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
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent`, hint: WRITE_OWN_REQUEST_HINT });
    expect(requests).toHaveLength(0);
    expectNoSecret(error);
  });

  it("a create for a store without a link is not sent with the token of an account that signed in meanwhile", async () => {
    const requests = fakeApi(() => created());
    const error = await failure(testClient().client.createNutritionLog(ENTRY, undefined));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: the entry was not sent`, hint: WRITE_OWN_REQUEST_HINT });
    expect(requests).toHaveLength(0);
  });

  it.each(WRITES)("a %s is not sent again when the renewed token belongs to another account", async (kind, write, what) => {
    const requests = fakeApi((n) => (n === 1 ? apiError(401, "UNAUTHENTICATED") : kind === "create" ? created() : deleted()));
    const tokens = new FakeTokens();
    tokens.subs = [ACCOUNT, OTHER_ACCOUNT];
    const { client, budget } = testClient({}, tokens);
    const error = await failure(write(client, ACCOUNT));
    expect(toWire(error)).toEqual({ code: "invalid_input", message: `${CHANGED}: ${what} was not sent again`, hint: WRITE_OWN_REQUEST_HINT });
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(budget.used).toBe(1);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "nutrition-log", http_status: 401 }], NOT_SENT_LINE(kind)]);
    expectNoSecret(error);
  });
});
