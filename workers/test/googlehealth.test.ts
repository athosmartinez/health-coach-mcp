// Ports of internal/googlehealth/client_test.go and review_test.go, and the
// Worker's own rules: the request budget, the byte limits, the record mapper
// and the token source of the CoachStore object.
import { runInDurableObject } from "cloudflare:test";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolError, toWire } from "../src/coach/errors";
import { GOOGLE_HEALTH_SCOPES, OAUTH_CLIENT_HINT, RECONNECT_HINT } from "../src/google";
import {
  FORCED_RENEWALS,
  HEALTH_REQUESTS,
  MAX_SUBREQUESTS,
  RequestBudget,
  SPARE_SUBREQUESTS,
  TOKEN_REQUESTS,
} from "../src/googlehealth/budget";
import {
  type ClientOptions,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_PAGES,
  GoogleHealthClient,
  MAX_ATTEMPTS,
  MAX_CALL_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  NetworkError,
  OWN_REQUEST_HINT,
  type Reduce,
  ResponseTooLargeError,
  SHORTER_RANGE_HINT,
  StatusError,
  type TokenResult,
  type TokenSource,
  equalJitter,
  readTarget,
  retryAfter,
} from "../src/googlehealth/client";
import type { DataType } from "../src/googlehealth/datatypes";
import { MAX_RECORD_CHARS } from "../src/googlehealth/page";
import type { CoachStore, GoogleLink } from "../src/store";
import { GOOGLE_REFRESH_TOKEN, OWNER_EMAIL, OWNER_SUB, mockGoogle } from "./helpers";
import { SAO_PAULO, freshStore } from "./memory-helpers";

const API = "https://health.googleapis.com";

/** The hint of a token request that Google refuses. */
const RENEWAL_HINT = `${OAUTH_CLIENT_HINT} ${RECONNECT_HINT}`;

/** One request as the fake API received it. */
interface Sent {
  method: string;
  /** Without the /v4 prefix of the base URL. */
  path: string;
  auth: string;
  query: Record<string, string>;
  body: any;
  accept: string | null;
  contentType: string | null;
  redirect: string | undefined;
}

type Handle = (n: number, request: Sent) => Response | Promise<Response>;

/**
 * Replaces fetch for the isolate: records every request to the Google Health
 * API and answers with the handler of the test (n counts requests from 1).
 */
function fakeApi(handle: Handle): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) throw new Error(`unexpected fetch in test: ${request.method} ${url.origin}`);
    const text = await request.text();
    const sent: Sent = {
      method: request.method,
      path: url.pathname.replace(/^\/v4/, ""),
      auth: request.headers.get("authorization") ?? "",
      query: Object.fromEntries(url.searchParams),
      body: text === "" ? undefined : JSON.parse(text),
      accept: request.headers.get("accept"),
      contentType: request.headers.get("content-type"),
      redirect: init?.redirect,
    };
    requests.push(sent);
    return handle(requests.length, sent);
  });
  return requests;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function apiError(status: number, grpcStatus: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code: status, status: grpcStatus, message } }, headers);
}

function points(...ids: string[]): { name: string }[] {
  return ids.map((id) => ({ name: `users/me/dataTypes/steps/dataPoints/${id}` }));
}

/** Keeps the last segment of a record's name. */
const id: Reduce<string> = (record) => (record as { name: string }).name.split("/").pop();
/** Keeps the whole record. */
const whole: Reduce<unknown> = (record) => record;

/**
 * Hands out at-0, at-1, ... and renews after `invalidate` of the current
 * token, like the CoachStore object.
 */
class FakeTokens implements TokenSource {
  n = 0;
  stale = false;
  asked = 0;
  invalidated: string[] = [];
  failure: TokenResult | undefined;

  async accessToken(): Promise<TokenResult> {
    this.asked++;
    if (this.failure) return this.failure;
    if (this.stale) {
      this.n++;
      this.stale = false;
    }
    return { ok: true, accessToken: `at-${this.n}` };
  }

  invalidate(rejected: string): boolean {
    this.invalidated.push(rejected);
    if (rejected !== `at-${this.n}`) return false;
    this.stale = true;
    return true;
  }
}

interface TestClient {
  client: GoogleHealthClient;
  tokens: FakeTokens;
  budget: RequestBudget;
  /** Every wait between attempts, in milliseconds. No real time passes. */
  waits: number[];
}

function testClient(options: Partial<ClientOptions> = {}, tokens = new FakeTokens()): TestClient {
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

const listSteps = (client: GoogleHealthClient) => client.list("steps", "2026-10-01", "2026-10-07", id);

/** The error a call fails with. */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call did not fail");
}

function chain(error: unknown): Error[] {
  const links: Error[] = [];
  for (let link = error; link instanceof Error; link = link.cause) links.push(link);
  return links;
}

function statusOf(error: unknown): StatusError | undefined {
  return chain(error).find((link): link is StatusError => link instanceof StatusError);
}

/** Every message and hint along the error's cause chain. */
function texts(error: unknown): string {
  return chain(error)
    .map((link) => `${link.message} ${link instanceof ToolError ? (link.hint ?? "") : ""}`)
    .join(" | ");
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const spies = new Map<(typeof LEVELS)[number], MockInstance>();

/** Every console line of the test so far, as JSON. */
function logged(): string {
  return JSON.stringify(LEVELS.flatMap((level) => spies.get(level)?.mock.calls ?? []));
}

function warnings(): unknown[][] {
  return spies.get("warn")?.mock.calls ?? [];
}

beforeEach(() => {
  for (const level of LEVELS) spies.set(level, vi.spyOn(console, level).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client construction", () => {
  it("uses the Google Health endpoint by default", async () => {
    const requests = fakeApi(() => json(200, {}));
    await listSteps(testClient().client);
    expect(DEFAULT_BASE_URL).toBe("https://health.googleapis.com/v4");
    expect(requests[0]?.path).toBe("/users/me/dataTypes/steps/dataPoints");
  });

  it.each<[string, boolean]>([
    ["https://health.googleapis.com/v4", true],
    ["https://health.googleapis.com/v4/", true],
    ["http://127.0.0.1:8080", true],
    ["http://localhost:8080/v4", true],
    ["http://[::1]:8080", true],
    ["http://health.googleapis.com/v4", false],
    ["http://192.168.0.10:8080", false],
    ["ftp://health.googleapis.com", false],
    ["https://user:pw@health.example", false],
    ["https://health.example/v4?key=x", false],
    ["https://health.example/v4#frag", false],
    ["https:///v4", false],
    ["://bad", false],
    ["", false],
  ])("base URL %s is accepted: %s", (baseUrl, ok) => {
    const build = () => testClient({ baseUrl });
    if (ok) {
      expect(build).not.toThrow();
      return;
    }
    expect(build).toThrow(/^googlehealth: /);
    // The error never echoes the URL.
    expect(build).not.toThrow(/pw|key=x/);
  });

  it("needs a token source, a zone and a budget", () => {
    const options = { tokens: new FakeTokens(), zone: SAO_PAULO, budget: new RequestBudget() };
    for (const missing of ["tokens", "zone", "budget"] as const) {
      const incomplete = { ...options, [missing]: undefined } as unknown as ClientOptions;
      expect(() => new GoogleHealthClient(incomplete), missing).toThrow(/^googlehealth: no /);
    }
    expect(() => new GoogleHealthClient(options)).not.toThrow();
  });

  it("does not double the path separator after a trailing slash", async () => {
    const requests = fakeApi(() => json(200, {}));
    await listSteps(testClient({ baseUrl: `${DEFAULT_BASE_URL}/` }).client);
    expect(requests[0]?.path).toBe("/users/me/dataTypes/steps/dataPoints");
  });

  it("lets a test lower a limit, never raise it", () => {
    expect(() => testClient({ maxPages: DEFAULT_MAX_PAGES + 1 })).toThrow("maxPages");
    expect(() => testClient({ maxResponseBytes: MAX_RESPONSE_BYTES + 1 })).toThrow("maxResponseBytes");
    expect(() => testClient({ maxCallBytes: MAX_CALL_BYTES + 1 })).toThrow("maxCallBytes");
    expect(() => testClient({ maxPages: 0 })).toThrow("maxPages");
    expect(() => testClient({ timeoutMs: 30_001 })).toThrow("timeoutMs");
    expect(() => testClient({ maxPages: 4, maxResponseBytes: 1024, maxCallBytes: 2048 })).not.toThrow();
  });
});

describe("list requests", () => {
  // The filter strings are the ones the Google Health CLI sends for the same
  // --from 2026-10-01 --to 2026-10-07 (its --dry-run output).
  it.each<[DataType, string, string]>([
    ["sleep", `sleep.interval.civil_end_time >= "2026-10-01T00:00:00" AND sleep.interval.civil_end_time < "2026-10-08T00:00:00"`, "25"],
    ["exercise", `exercise.interval.civil_start_time >= "2026-10-01T00:00:00" AND exercise.interval.civil_start_time < "2026-10-08T00:00:00"`, "25"],
    ["steps", `steps.interval.civil_start_time >= "2026-10-01T00:00:00" AND steps.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"],
    ["nutrition-log", `nutrition_log.interval.civil_start_time >= "2026-10-01T00:00:00" AND nutrition_log.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"],
    ["active-zone-minutes", `active_zone_minutes.interval.civil_start_time >= "2026-10-01T00:00:00" AND active_zone_minutes.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"],
    ["weight", `weight.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND weight.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"],
    ["body-fat", `body_fat.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND body_fat.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"],
    ["heart-rate", `heart_rate.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"],
    ["heart-rate-variability", `heart_rate_variability.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND heart_rate_variability.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"],
    ["daily-resting-heart-rate", `daily_resting_heart_rate.date >= "2026-10-01" AND daily_resting_heart_rate.date < "2026-10-08"`, "10000"],
    ["daily-heart-rate-variability", `daily_heart_rate_variability.date >= "2026-10-01" AND daily_heart_rate_variability.date < "2026-10-08"`, "10000"],
  ])("lists %s with its filter and page size", async (dataType, filter, pageSize) => {
    const requests = fakeApi(() => json(200, {}));
    const { client } = testClient();
    expect(await client.list(dataType, "2026-10-01", "2026-10-07", whole)).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: `/users/me/dataTypes/${dataType}/dataPoints`,
      query: { filter, pageSize },
      auth: "Bearer at-0",
      redirect: "manual",
    });
  });

  it("follows the zone offset in a physical-time filter", async () => {
    // Before 2019 São Paulo had daylight saving time (-02:00 in summer).
    const requests = fakeApi(() => json(200, {}));
    await testClient().client.list("weight", "2018-12-01", "2018-12-01", whole);
    expect(requests[0]?.query.filter).toBe(
      `weight.sample_time.physical_time >= "2018-12-01T02:00:00Z" AND weight.sample_time.physical_time < "2018-12-02T02:00:00Z"`,
    );
  });

  it("follows pages", async () => {
    const requests = fakeApi((_n, request) => {
      switch (request.query.pageToken) {
        case undefined:
          return json(200, { dataPoints: points("a", "b"), nextPageToken: "p2" });
        case "p2":
          return json(200, { dataPoints: points("c"), nextPageToken: "p3" });
        case "p3":
          return json(200, { dataPoints: points("d") });
        default:
          throw new Error(`unexpected page token ${request.query.pageToken}`);
      }
    });
    expect(await listSteps(testClient().client)).toEqual(["a", "b", "c", "d"]);
    expect(requests).toHaveLength(3);
    // Every page repeats the filter and the page size.
    for (const request of requests) {
      expect(request.query.filter).toBe(requests[0]?.query.filter);
      expect(request.query.pageSize).toBe("10000");
    }
  });

  it("reconciles through the reconcile method of the API", async () => {
    const requests = fakeApi((_n, request) =>
      request.query.pageToken === undefined
        ? json(200, { dataPoints: points("a"), nextPageToken: "p2" })
        : json(200, { dataPoints: points("b") }),
    );
    const { client } = testClient();
    expect(await client.reconcile("steps", "2026-10-01", "2026-10-07", id)).toEqual(["a", "b"]);
    expect(requests[1]).toMatchObject({
      method: "GET",
      path: "/users/me/dataTypes/steps/dataPoints:reconcile",
      query: { pageToken: "p2" },
    });
    expect(requests[1]?.query.filter).toMatch(/^steps\.interval\.civil_start_time >=/);
  });

  it("lists an instant window", async () => {
    const requests = fakeApi((n) =>
      n === 1 ? json(200, { dataPoints: [{ a: 1 }], nextPageToken: "p2" }) : json(200, { dataPoints: [{ a: 2 }] }),
    );
    const { client } = testClient();
    const start = new Date("2026-10-10T22:00:00Z"); // 19:00 in São Paulo
    const minutes = (n: number) => new Date(start.getTime() + n * 60_000);
    expect(await client.listBetween("heart-rate", start, minutes(97), whole)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/users/me/dataTypes/heart-rate/dataPoints",
      query: {
        filter: `heart_rate.sample_time.physical_time >= "2026-10-10T22:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-10T23:37:00Z"`,
        pageSize: "10000",
      },
    });
    expect(requests[1]?.query.pageToken).toBe("p2");

    const refused: [string, Promise<unknown>][] = [
      ["a civil-time type", client.listBetween("steps", start, minutes(60), whole)],
      ["a daily type", client.listBetween("daily-resting-heart-rate", start, minutes(60), whole)],
      ["an empty window", client.listBetween("heart-rate", start, start, whole)],
      ["over a day", client.listBetween("heart-rate", start, minutes(25 * 60), whole)],
      ["an unknown type", client.listBetween("bogus" as DataType, start, minutes(60), whole)],
    ];
    for (const [name, call] of refused) expect(toWire(await failure(call)).code, name).toBe("internal_error");
    // A refused window never reaches the API.
    expect(requests).toHaveLength(2);
    // Exactly a day is allowed.
    await client.listBetween("heart-rate", start, minutes(24 * 60), whole);
    expect(requests).toHaveLength(3);
  });

  it("sends the headers of a read", async () => {
    const requests = fakeApi(() => json(200, {}));
    const { client } = testClient();
    await listSteps(client);
    await client.dailyRollup("steps", "2026-10-01", "2026-10-01", whole);
    expect(requests.map((request) => request.accept)).toEqual(["application/json", "application/json"]);
    expect(requests.map((request) => request.contentType)).toEqual([null, "application/json"]);
  });
});

describe("daily rollup", () => {
  const civil = (year: number, month: number, day: number) => ({ date: { year, month, day } });

  it("sends the range as civil dates and follows pages", async () => {
    const requests = fakeApi((_n, request) =>
      request.body.pageToken === undefined
        ? json(200, { rollupDataPoints: [{ civilStartTime: "a" }], nextPageToken: "p2" })
        : json(200, { rollupDataPoints: [{ civilStartTime: "b" }] }),
    );
    const { client } = testClient();
    expect(await client.dailyRollup("steps", "2026-10-01", "2026-10-07", whole)).toEqual([
      { civilStartTime: "a" },
      { civilStartTime: "b" },
    ]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ method: "POST", path: "/users/me/dataTypes/steps/dataPoints:dailyRollUp" });
      expect(request.body).toMatchObject({
        range: { start: civil(2026, 10, 1), end: civil(2026, 10, 8) },
        windowSizeDays: 1,
        pageSize: 10000,
      });
    }
    expect(requests[0]?.body).not.toHaveProperty("pageToken");
    expect(requests[1]?.body.pageToken).toBe("p2");
  });

  it("splits a range longer than the API allows", async () => {
    const requests = fakeApi((n) => json(200, { rollupDataPoints: [{ chunk: n }] }));
    const { client } = testClient();
    // total-calories allows 14 days per request: 28 days are two requests.
    expect(await client.dailyRollup("total-calories", "2026-09-10", "2026-10-07", whole)).toEqual([{ chunk: 1 }, { chunk: 2 }]);
    expect(requests.map((request) => request.body.range)).toEqual([
      { start: civil(2026, 9, 10), end: civil(2026, 9, 24) },
      { start: civil(2026, 9, 24), end: civil(2026, 10, 8) },
    ]);
    // Other types allow 90 days.
    await client.dailyRollup("steps", "2026-01-01", "2026-03-31", whole);
    expect(requests).toHaveLength(3);
    await client.dailyRollup("steps", "2026-01-01", "2026-04-01", whole);
    expect(requests).toHaveLength(5);
  });

  it("pages inside each chunk", async () => {
    const requests = fakeApi((_n, request) => {
      const first = request.body.range.start.date.day === 10;
      if (first && request.body.pageToken === undefined) return json(200, { rollupDataPoints: [{ p: "1a" }], nextPageToken: "c1p2" });
      if (first) return json(200, { rollupDataPoints: [{ p: "1b" }] });
      // The second chunk never carries a page token of the first.
      expect(request.body).not.toHaveProperty("pageToken");
      return json(200, { rollupDataPoints: [{ p: "2a" }] });
    });
    const { client } = testClient();
    expect(await client.dailyRollup("total-calories", "2026-09-10", "2026-10-07", whole)).toEqual([{ p: "1a" }, { p: "1b" }, { p: "2a" }]);
    expect(requests).toHaveLength(3);
  });

  it("returns nothing when a later chunk fails", async () => {
    fakeApi((n) => (n === 1 ? json(200, { rollupDataPoints: [{ p: "1a" }] }) : apiError(400, "INVALID_ARGUMENT", "")));
    const { client } = testClient();
    const error = await failure(client.dailyRollup("total-calories", "2026-09-10", "2026-10-07", whole));
    expect(toWire(error).code).toBe("internal_error");
  });
});

describe("local checks", () => {
  it("refuses an operation, a type or a range before any request", async () => {
    const requests = fakeApi(() => {
      throw new Error("a request was sent");
    });
    const { client, tokens } = testClient();
    const calls: [string, Promise<unknown>][] = [
      ["rollup of sleep", client.dailyRollup("sleep", "2026-10-01", "2026-10-01", whole)],
      ["list of calories", client.list("total-calories", "2026-10-01", "2026-10-01", whole)],
      ["unknown type", client.list("blood-glucose" as DataType, "2026-10-01", "2026-10-01", whole)],
      ["path in the type", client.list("steps/../x" as DataType, "2026-10-01", "2026-10-01", whole)],
      ["to before from", client.list("steps", "2026-10-02", "2026-10-01", whole)],
      ["invalid date", client.reconcile("steps", "2026-13-01", "2026-10-01", whole)],
      ["rollup bad dates", client.dailyRollup("steps", "2026-10-02", "2026-10-01", whole)],
      ["reconcile of rollup-only", client.reconcile("total-calories", "2026-10-01", "2026-10-01", whole)],
    ];
    for (const [name, call] of calls) {
      const error = await failure(call);
      // A caller bug, not the user's input.
      expect(error, name).not.toBeInstanceOf(ToolError);
      expect(toWire(error).code, name).toBe("internal_error");
    }
    expect(requests).toHaveLength(0);
    expect(tokens.asked).toBe(0);
  });

  // test/googlehealth-write.test.ts pins the two writes that also pass.
  it("lets only the read requests of its allowlist leave the client", async () => {
    class Probe extends GoogleHealthClient {
      probe(method: string, path: string): Promise<unknown> {
        return this.request(method, path);
      }
    }
    const requests = fakeApi(() => json(200, {}));
    const probe = new Probe({ tokens: new FakeTokens(), zone: SAO_PAULO, budget: new RequestBudget() });
    const refused: [string, string][] = [
      ["POST", "/users/me/dataTypes/steps/dataPoints"],
      ["POST", "/users/me/dataTypes/steps/dataPoints:batchDelete"],
      ["PATCH", "/users/me/dataTypes/steps/dataPoints/x"],
      ["DELETE", "/users/me/dataTypes/steps/dataPoints/x"],
      ["PUT", "/users/me/dataTypes/steps/dataPoints"],
      ["GET", "/users/me/dataTypes/steps/dataPoints:dailyRollUp"],
      ["POST", "/users/me/dataTypes/steps/dataPoints:rollUp"],
      ["GET", "/users/me/profile"],
      ["GET", "/users/other/dataTypes/steps/dataPoints"],
      ["GET", "/users/me/dataTypes/steps/dataPoints?x=1"],
      ["get", "/users/me/dataTypes/steps/dataPoints"],
    ];
    for (const [method, path] of refused) {
      expect(readTarget(method, path), `${method} ${path}`).toBeUndefined();
      expect((await failure(probe.probe(method, path))).message).toContain("the client refuses");
    }
    expect(requests).toHaveLength(0);

    expect(readTarget("GET", "/users/me/dataTypes/steps/dataPoints")).toBe("steps");
    expect(readTarget("GET", "/users/me/dataTypes/heart-rate/dataPoints:reconcile")).toBe("heart-rate");
    expect(readTarget("POST", "/users/me/dataTypes/total-calories/dataPoints:dailyRollUp")).toBe("total-calories");
    await probe.probe("GET", "/users/me/dataTypes/steps/dataPoints");
    expect(requests).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries 429 and 5xx, with Retry-After over the backoff", async () => {
    fakeApi((n) => {
      if (n === 1) return apiError(429, "RESOURCE_EXHAUSTED", "quota", { "retry-after": "2" });
      if (n === 2) return apiError(503, "UNAVAILABLE", "backend");
      return json(200, { dataPoints: points("a") });
    });
    const { client, waits } = testClient();
    expect(await client.list("steps", "2026-10-01", "2026-10-01", id)).toEqual(["a"]);
    // Retry-After (2 s) beats the first backoff (1 s); then the backoff doubles.
    expect(waits).toEqual([2000, 2000]);
  });

  it("gives up after four attempts", async () => {
    const requests = fakeApi(() => apiError(500, "INTERNAL", "secret-body-text 72 bpm"));
    const { client, waits } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "try again in a few minutes",
    });
    expect(MAX_ATTEMPTS).toBe(4);
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(statusOf(error)).toMatchObject({ httpStatus: 500, status: "INTERNAL" });
    expect(statusOf(error)?.message).toBe("Google Health API returned HTTP 500 (INTERNAL)");
    // The response body reaches neither the error nor a log line.
    expect(texts(error)).not.toMatch(/secret-body-text|72/);
    expect(logged()).not.toMatch(/secret-body-text|bpm/);
  });

  it("fails fast on a long Retry-After", async () => {
    const requests = fakeApi(() => apiError(429, "RESOURCE_EXHAUSTED", "quota", { "retry-after": "3600" }));
    const { client, waits } = testClient();
    expect(toWire(await failure(listSteps(client))).code).toBe("upstream_unavailable");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

  it.each<[number, string, number[], number, boolean]>([
    [429, "8", [8000], 2, false],
    [429, "9", [], 1, true],
    [503, "9", [], 1, true],
    [503, "5", [5000, 2000], 3, false], // the next wait is the plain backoff again
    [503, new Date(NOW + 3_600_000).toUTCString(), [], 1, true],
    [503, new Date(NOW + 4000).toUTCString(), [4000, 2000], 3, false],
  ])("honors Retry-After up to 8 s: %i with %s", async (status, header, wantWaits, wantRequests, fails) => {
    const once = wantRequests === 2;
    const requests = fakeApi((n) => {
      if (n === 1) return apiError(status, "UNAVAILABLE", "", { "retry-after": header });
      if (n === 2 && !once) return apiError(503, "UNAVAILABLE", "");
      return json(200, {});
    });
    const { client, waits } = testClient({ now: () => NOW });
    const outcome = await listSteps(client).then(
      () => "ok",
      () => "failed",
    );
    expect(outcome).toBe(fails ? "failed" : "ok");
    expect(waits).toEqual(wantWaits);
    expect(requests).toHaveLength(wantRequests);
  });

  it.each<[string, number]>([
    ["", 0],
    ["3", 3000],
    ["+3", 3000],
    [" 3 ", 3000],
    ["-5", 0],
    ["soon", 0],
    ["1.5", 0],
    ["Fri, 16 Oct 2026 12:00:04 GMT", 4000],
    ["Fri, 16 Oct 2026 11:00:00 GMT", 0], // already past
    ["99999999999999999999", MAX_RETRY_AFTER_MS + 1000], // too large for an int: too long to wait
    ["-99999999999999999999", 0],
    ["9999999999", 86_400_000],
  ])("reads Retry-After %j as %i ms", (header, want) => {
    expect(retryAfter(header, NOW)).toBe(want);
  });

  it("reads a missing Retry-After as no wait", () => {
    expect(retryAfter(null, NOW)).toBe(0);
  });

  it("keeps the jitter within the backoff", () => {
    for (let i = 0; i < 200; i++) {
      const wait = equalJitter(1000);
      expect(wait).toBeGreaterThanOrEqual(500);
      expect(wait).toBeLessThanOrEqual(1000);
    }
  });

  it("retries a quota 403 like a 429", async () => {
    fakeApi((n) => (n === 1 ? apiError(403, "RESOURCE_EXHAUSTED", "Quota exceeded") : json(200, { dataPoints: points("a") })));
    const { client, waits, tokens } = testClient();
    expect(await listSteps(client)).toEqual(["a"]);
    expect(waits).toHaveLength(1);
    expect(tokens.invalidated).toEqual([]);
  });

  it("does not retry another client error", async () => {
    const requests = fakeApi(() =>
      json(400, {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "INVALID_DATA_POINT_FILTER near 2026-10-01 for owner@example.com",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "FILTER_HAS_NEAR", domain: "health.googleapis.com" },
            { note: "synthetic body 7711" },
          ],
        },
      }),
    );
    const { client, waits } = testClient();
    const error = await failure(client.list("steps", "2026-10-01", "2026-10-01", id));
    expect(statusOf(error)).toMatchObject({ httpStatus: 400, status: "INVALID_ARGUMENT" });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
    // An internal error without the body. A read does not repeat the message or the ErrorInfo reason.
    expect(toWire(error).code).toBe("internal_error");
    const shown = `${texts(error)} ${logged()}`;
    for (const secret of ["near", "FILTER_HAS_NEAR", "owner@example.com", "7711"]) expect(shown, secret).not.toContain(secret);
    // It is logged with its HTTP status and Google's enum, never the body.
    expect(warnings()).toEqual([
      ["google health request rejected", { data_type: "steps", http_status: 400, google_status: "INVALID_ARGUMENT" }],
    ]);
  });

  it("retries a request that did not complete", async () => {
    const requests = fakeApi(() => {
      throw new TypeError(`fetch failed: ${API}/v4/users/me/dataTypes/steps/dataPoints?filter=x&pageSize=10000 2026-10-01`);
    });
    const { client, waits } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API could not be reached",
      hint: "try again in a few minutes",
    });
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
    // Only the type of the cause is kept: its text quotes the request.
    const cause = chain(error).find((link) => link instanceof NetworkError);
    expect(cause).toMatchObject({ causeTypes: "TypeError" });
    for (const quoted of ["filter", "pageSize", "2026", "dataPoints", API]) {
      expect(texts(error)).not.toContain(quoted);
      expect(logged()).not.toContain(quoted);
    }
    expect(warnings()[0]).toEqual(["google health request did not complete", { data_type: "steps", cause: "TypeError" }]);
    expect(warnings()[1]).toEqual([
      "google health request failed; retrying",
      { data_type: "steps", http_status: 0, retry: 1, wait_ms: 1000 },
    ]);
  });

  it("cuts a request that hangs and retries it", async () => {
    // The API never answers: each attempt ends only when its signal aborts it.
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const { client, waits } = testClient({ timeoutMs: 10, budget: new RequestBudget(2) });
    const error = await failure(listSteps(client));
    expect(toWire(error)).toMatchObject({ code: "upstream_unavailable", message: "Google Health API could not be reached" });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(waits).toEqual([1000]);
    expect(warnings()[0]).toEqual(["google health request did not complete", { data_type: "steps", cause: "TimeoutError" }]);
  });

  it("recovers from a dropped connection and a 408", async () => {
    fakeApi((n) => {
      if (n === 1) {
        // The connection drops while the body is read.
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        });
        return new Response(body, { status: 200 });
      }
      if (n === 2) return apiError(408, "DEADLINE_EXCEEDED", "");
      return json(200, { dataPoints: points("a") });
    });
    const { client, waits } = testClient();
    expect(await listSteps(client)).toEqual(["a"]);
    expect(waits).toEqual([1000, 2000]);
  });

  it.each([
    ["another host", 307, "https://elsewhere.example/elsewhere"],
    ["the same path", 307, "/v4/users/me/dataTypes/steps/dataPoints?again=1"],
    ["a 302", 302, "https://elsewhere.example/"],
  ])("refuses a redirect to %s", async (_name, status, location) => {
    const requests = fakeApi(() => new Response(null, { status, headers: { location } }));
    const { client, waits } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error).code).toBe("internal_error");
    expect(statusOf(error)?.httpStatus).toBe(status);
    // The redirect is neither followed nor retried.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    expect(waits).toEqual([]);
  });
});

describe("rejected tokens", () => {
  it("renews once on a 401, without a wait", async () => {
    fakeApi((_n, request) =>
      request.auth === "Bearer at-1" ? json(200, { dataPoints: points("a") }) : apiError(401, "UNAUTHENTICATED", "expired"),
    );
    const { client, waits, tokens, budget } = testClient();
    expect(await client.list("steps", "2026-10-01", "2026-10-01", id)).toEqual(["a"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(waits).toEqual([]);
    expect(budget.canRenew).toBe(false);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "steps", http_status: 401 }]]);
  });

  it("answers auth_expired when the renewed token is rejected too", async () => {
    const requests = fakeApi(() => apiError(401, "UNAUTHENTICATED", "revoked"));
    const { client, tokens } = testClient();
    const error = await failure(client.list("steps", "2026-10-01", "2026-10-01", id));
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "Google Health rejected the sign-in", hint: RECONNECT_HINT });
    expect(requests).toHaveLength(2);
    expect(tokens.invalidated).toHaveLength(1);
    expect(statusOf(error)).toMatchObject({ httpStatus: 401, status: "UNAUTHENTICATED" });
  });

  it("answers scope_missing for a scope gap that a renewal does not close", async () => {
    const requests = fakeApi(() => apiError(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes."));
    const { client, tokens } = testClient();
    const error = await failure(client.list("sleep", "2026-10-01", "2026-10-01", whole));
    expect(toWire(error)).toEqual({
      code: "scope_missing",
      message: "Google Health denied access to sleep data",
      hint: `${RECONNECT_HINT} Allow every permission, and check that the Google Health API is enabled in the Cloud project.`,
    });
    // One renewal rules out a stale token; the second 403 is the real answer.
    expect(requests).toHaveLength(2);
    expect(tokens.invalidated).toHaveLength(1);
  });

  it("renews a stale token that Google answers with a 403", async () => {
    fakeApi((n) => (n === 1 ? apiError(403, "PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") : json(200, {})));
    expect(await testClient().client.list("sleep", "2026-10-01", "2026-10-01", whole)).toEqual([]);
  });

  it("does not renew on a policy denial", async () => {
    const requests = fakeApi(() => apiError(403, "PERMISSION_DENIED", "Health API has not been used in project 123"));
    const { client, tokens } = testClient();
    expect(toWire(await failure(client.list("sleep", "2026-10-01", "2026-10-01", whole))).code).toBe("scope_missing");
    expect(requests).toHaveLength(1);
    expect(tokens.invalidated).toEqual([]);
  });

  it("shares one renewal between a 401 and a 403", async () => {
    const requests = fakeApi((n) =>
      n === 1 ? apiError(401, "UNAUTHENTICATED", "expired") : apiError(403, "PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"),
    );
    const { client, tokens } = testClient();
    expect(toWire(await failure(client.list("sleep", "2026-10-01", "2026-10-01", whole))).code).toBe("scope_missing");
    expect(requests).toHaveLength(2);
    expect(tokens.invalidated).toHaveLength(1);
  });

  it.each<[string, number[]]>([
    ["401 first", [401, 503, 503, 503, 200]],
    ["401 in the middle", [503, 401, 503, 503, 200]],
  ])("does not count a renewal as a retry: %s", async (_name, sequence) => {
    const requests = fakeApi((n) => {
      const status = sequence[n - 1] ?? 200;
      return status === 200 ? json(200, { dataPoints: points("a") }) : apiError(status, "X", "");
    });
    const { client, waits } = testClient();
    expect(await listSteps(client)).toEqual(["a"]);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(requests).toHaveLength(5);
  });

  it("renews a token that expires in the middle of a paged fetch", async () => {
    const requests = fakeApi((_n, request) => {
      if (request.query.pageToken === undefined) return json(200, { dataPoints: points("a"), nextPageToken: "p2" });
      if (request.auth === "Bearer at-0") return apiError(401, "UNAUTHENTICATED", "");
      if (request.query.pageToken === "p2") return json(200, { dataPoints: points("b"), nextPageToken: "p3" });
      return json(200, { dataPoints: points("c") });
    });
    const { client, tokens } = testClient();
    expect(await listSteps(client)).toEqual(["a", "b", "c"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(requests.at(-1)?.auth).toBe("Bearer at-1");
  });

  it("forces one renewal per MCP request: a second rejection is final", async () => {
    // The first page renews at-0; the second page rejects at-1 as well.
    const requests = fakeApi((_n, request) => {
      if (request.auth === "Bearer at-0") return apiError(401, "UNAUTHENTICATED", "");
      if (request.query.pageToken === undefined) return json(200, { dataPoints: points("a"), nextPageToken: "p2" });
      return apiError(401, "UNAUTHENTICATED", "");
    });
    const { client, tokens, budget } = testClient();
    expect(FORCED_RENEWALS).toBe(1);
    expect(toWire(await failure(listSteps(client))).code).toBe("auth_expired");
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-1", "Bearer at-1"]);
    expect(tokens.invalidated).toEqual(["at-0"]);
    // The next call of the same MCP request cannot force another renewal either.
    expect(budget.canRenew).toBe(false);
    expect(toWire(await failure(client.list("sleep", "2026-10-01", "2026-10-01", whole))).code).toBe("auth_expired");
    expect(tokens.invalidated).toEqual(["at-0"]);
  });

  it("sends the request again with the token another request already renewed", async () => {
    class Replaced extends FakeTokens {
      override invalidate(rejected: string): boolean {
        this.invalidated.push(rejected);
        // Another request renewed the token in the meantime.
        this.n = 7;
        return false;
      }
    }
    const requests = fakeApi((_n, request) =>
      request.auth === "Bearer at-7" ? json(200, { dataPoints: points("a") }) : apiError(401, "UNAUTHENTICATED", ""),
    );
    const { client, budget } = testClient({}, new Replaced());
    expect(await listSteps(client)).toEqual(["a"]);
    expect(requests.map((request) => request.auth)).toEqual(["Bearer at-0", "Bearer at-7"]);
    // Nothing was renewed for this request, so its forced renewal is still there.
    expect(budget.canRenew).toBe(true);
    expect(warnings()).toEqual([]);
  });
});

describe("token source errors", () => {
  it.each<[TokenResult & { ok: false }, string, string, string | undefined]>([
    [{ ok: false, code: "not_linked" }, "auth_expired", "not signed in to Google Health", RECONNECT_HINT],
    [{ ok: false, code: "auth_expired" }, "auth_expired", "the Google sign-in expired or was revoked", RECONNECT_HINT],
    [
      { ok: false, code: "upstream_unavailable" },
      "upstream_unavailable",
      "Google's token service is unavailable",
      "try again in a few minutes",
    ],
  ])("maps $0.code to a tool error", async (result, code, message, hint) => {
    const requests = fakeApi(() => {
      throw new Error("a request was sent");
    });
    const tokens = new FakeTokens();
    tokens.failure = result;
    const { client, waits } = testClient({}, tokens);
    expect(toWire(await failure(listSteps(client)))).toEqual({ code, message, hint });
    expect(requests).toHaveLength(0);
    expect(waits).toEqual([]);
  });

  it("answers auth_expired for a token request that Google refuses", async () => {
    const requests = fakeApi(() => {
      throw new Error("a request was sent");
    });
    const tokens = new FakeTokens();
    tokens.failure = { ok: false, code: "internal_error" };
    const error = await failure(listSteps(testClient({}, tokens).client));
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "Google rejected the token renewal", hint: RENEWAL_HINT });
    // The hint names both steps: the server's OAuth client, then the reconnect.
    expect(RENEWAL_HINT).toBe(
      "Check the server's Google OAuth client settings. Disconnect and reconnect this connector in the MCP client to sign in with Google again.",
    );
    expect(requests).toHaveLength(0);
  });

  it("asks a failing token source once per MCP request", async () => {
    fakeApi(() => json(200, {}));
    const tokens = new FakeTokens();
    tokens.failure = { ok: false, code: "upstream_unavailable" };
    const budget = new RequestBudget();
    const { client } = testClient({ budget }, tokens);
    const first = await failure(listSteps(client));
    // A second call, and a second client on the same budget, fail the same way without asking.
    expect(await failure(listSteps(client))).toBe(first);
    expect(await failure(listSteps(testClient({ budget }, tokens).client))).toBe(first);
    expect(tokens.asked).toBe(1);
    // The next MCP request has its own budget and asks again.
    tokens.failure = undefined;
    expect(await listSteps(testClient({}, tokens).client)).toEqual([]);
    expect(tokens.asked).toBe(2);
  });
});

describe("page checks", () => {
  it.each<[string, boolean]>([
    [`{}`, false], // the API omits an empty list
    [`{"nextPageToken": ""}`, false],
    [`{"dataPoints": null}`, false],
    [`{"dataPoints": [], "nextPageToken": null}`, false],
    [`null`, true],
    [`[]`, true],
    [``, true],
    [`{"error": {"code": 500}}`, true],
    [`{"data_points": [{"a": 1}]}`, true],
    [`{"dataPoints": {}}`, true],
    [`{"dataPoints": [], "nextPageToken": 7}`, true],
    [`{"dataPoints": [], "nextPageToken": {"token": "p2"}}`, true],
    [`{"dataPoints": [], "newField": 1}`, false], // a field added by Google does not drop the data
    [`{"dataPoints": [], "newField": {"a": [1, {"b": null}], "c": "d"}}`, false],
    [`{"dataPoints": [], "newField": {"a": [1, {"b": nul}]}}`, true], // its value is checked as JSON, though never parsed
    [`{"dataPoints": [], "pageToken": "p2"}`, true], // a renamed continuation would end the range early
    [`{"dataPoints": [], "nextCursor": "p2"}`, true],
    [`{"dataPoints": [], "next_page": "p2"}`, true],
    [`{"dataPoints": [], "hasMore": true}`, true],
    [`{"dataPoints": [], "continuation": "x"}`, true],
    [`{"dataPoints": [], "OFFSET": 25}`, true],
    [`{"dataPoints": [], "truncated": true}`, true],
    [`{"dataPoints": [], "remaining": 3}`, true],
    [`<html>proxy error</html>`, true],
    [`{"dataPoints": [{"a": 1},]}`, true],
  ])("page %s is an error: %s", async (body, wantError) => {
    fakeApi(() => new Response(body, { status: 200 }));
    const { client } = testClient();
    const outcome = await client.list("steps", "2026-10-01", "2026-10-07", whole).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!wantError) {
      expect(outcome).toBeUndefined();
      return;
    }
    expect(toWire(outcome)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health returned an unreadable steps response",
      hint: "try again in a few minutes",
    });
    expect(texts(outcome)).not.toContain("proxy error");
  });

  it("logs an unexpected field by its name, cut at 40 characters", async () => {
    const long = "x".repeat(60);
    fakeApi((n) => (n === 1 ? json(200, { dataPoints: [], [long]: "value 72 bpm" }) : json(200, { [long]: 1 })));
    const { client } = testClient();
    expect(await listSteps(client)).toEqual([]);
    expect(warnings()).toEqual([["google health response has a new field", { data_type: "steps", field: "x".repeat(40) }]]);
    await failure(listSteps(client));
    expect(warnings()[1]).toEqual([
      "google health response has an unexpected field",
      { data_type: "steps", field: "x".repeat(40), has_list: false },
    ]);
    expect(logged()).not.toMatch(/72|bpm/);
  });

  // A response under the byte limit can hold millions of small values, and a
  // parsed tree of them takes many times the size of the text.
  describe("a response that is small in bytes and large in the count of values", () => {
    const point = (name: string) => `{"name":"users/me/dataTypes/steps/dataPoints/${name}"}`;
    /** `count` empty lists in a list: three characters per value. */
    const manyValues = (count: number) => `[${"[],".repeat(count - 1)}[]]`;
    const longestParsed = (parse: MockInstance) => Math.max(0, ...parse.mock.calls.map(([text]) => String(text).length));

    it("reads the list and does not parse the other field", async () => {
      const body = `{"dataPoints":[${point("a")},${point("b")}],"extraValues":${manyValues(700_000)}}`;
      expect(body.length).toBeGreaterThan(2_000_000);
      const requests = fakeApi(() => new Response(body, { status: 200 }));
      const parse = vi.spyOn(JSON, "parse");
      expect(await listSteps(testClient().client)).toEqual(["a", "b"]);
      // The keys and the two records: nothing of the field's value.
      expect(longestParsed(parse)).toBeLessThan(100);
      expect(requests).toHaveLength(1);
      expect(warnings()).toEqual([["google health response has a new field", { data_type: "steps", field: "extraValues" }]]);
    });

    it("answers an unreadable response for such a field in a page without the list", async () => {
      const requests = fakeApi(() => new Response(`{"extraValues":${manyValues(700_000)}}`, { status: 200 }));
      const parse = vi.spyOn(JSON, "parse");
      const error = await failure(listSteps(testClient().client));
      expect(toWire(error)).toMatchObject({ code: "upstream_unavailable", message: "Google Health returned an unreadable steps response" });
      expect(longestParsed(parse)).toBeLessThan(100);
      expect(requests).toHaveLength(1);
    });

    it("answers an unreadable response for a record longer than the cap, without parsing it", async () => {
      const record = `{"name":"users/me/dataTypes/steps/dataPoints/long","samples":${manyValues(350_000)}}`;
      expect(record.length).toBeGreaterThan(MAX_RECORD_CHARS);
      const requests = fakeApi(() => new Response(`{"dataPoints":[${point("a")},${record},${point("c")}]}`, { status: 200 }));
      const parse = vi.spyOn(JSON, "parse");
      const { client, waits } = testClient();
      const error = await failure(listSteps(client));
      expect(toWire(error)).toEqual({
        code: "upstream_unavailable",
        message: "Google Health returned an unreadable steps response",
        hint: "try again in a few minutes",
      });
      expect(longestParsed(parse)).toBeLessThan(100);
      // The same range gives the same record again: no retry.
      expect(requests).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(warnings()).toEqual([]);
    });
  });

  it("refuses a page token that repeats", async () => {
    const requests = fakeApi(() => new Response(`{"dataPoints": [], "nextPageToken": "same"}`, { status: 200 }));
    const error = await failure(listSteps(testClient().client));
    expect(toWire(error).code).toBe("upstream_unavailable");
    expect(requests).toHaveLength(2);
  });

  it("stops at the page cap with an error, never a short result", async () => {
    const requests = fakeApi((n) => json(200, { dataPoints: points("x"), nextPageToken: `p${n}` }));
    const { client } = testClient({ maxPages: 4 });
    const error = await failure(client.list("steps", "2026-10-01", "2026-10-01", id));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "the date range holds more steps data than one call reads",
      hint: "use a shorter date range",
    });
    expect(requests).toHaveLength(4);
    expect(DEFAULT_MAX_PAGES).toBe(200);
  });
});

describe("record mapper", () => {
  it("keeps what the mapper returns and drops undefined", async () => {
    fakeApi((n) =>
      n === 1
        ? json(200, { dataPoints: [{ n: 1 }, { n: 2 }, { n: 3 }], nextPageToken: "p2" })
        : json(200, { dataPoints: [{ n: 4 }, { n: 5 }] }),
    );
    const seen: number[] = [];
    const kept = await testClient().client.list("steps", "2026-10-01", "2026-10-07", (record) => {
      const n = (record as { n: number }).n;
      seen.push(n);
      return n % 2 === 1 ? n * 10 : undefined;
    });
    // Every record is mapped once, in page order; only the mapped values come back.
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(kept).toEqual([10, 30, 50]);
  });

  it("keeps null, 0 and false: only undefined drops a record", async () => {
    fakeApi(() => json(200, { dataPoints: [null, 0, false, "", 7] }));
    expect(await testClient().client.list("steps", "2026-10-01", "2026-10-07", (record) => record)).toEqual([null, 0, false, "", 7]);
  });

  it("maps the records of a rollup and of a reconcile too", async () => {
    fakeApi((_n, request) =>
      request.method === "POST" ? json(200, { rollupDataPoints: [{ v: 1 }, { v: 2 }] }) : json(200, { dataPoints: [{ v: 3 }] }),
    );
    const { client } = testClient();
    const value: Reduce<number> = (record) => (record as { v: number }).v;
    expect(await client.dailyRollup("steps", "2026-10-01", "2026-10-07", value)).toEqual([1, 2]);
    expect(await client.reconcile("steps", "2026-10-01", "2026-10-07", value)).toEqual([3]);
  });

  it("lets an error of the mapper through as it is", async () => {
    fakeApi(() => json(200, { dataPoints: points("a") }));
    const error = await failure(
      testClient().client.list("steps", "2026-10-01", "2026-10-07", () => {
        throw new RangeError("mapper");
      }),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect(toWire(error).code).toBe("internal_error");
  });
});

describe("request budget", () => {
  it("names the numbers of the Workers Free plan", () => {
    expect(MAX_SUBREQUESTS).toBe(50);
    expect(TOKEN_REQUESTS).toBe(2);
    expect(SPARE_SUBREQUESTS).toBe(3);
    expect(HEALTH_REQUESTS).toBe(45);
    expect(HEALTH_REQUESTS + TOKEN_REQUESTS + SPARE_SUBREQUESTS).toBe(MAX_SUBREQUESTS);
    const budget = new RequestBudget();
    expect([budget.limit, budget.remaining, budget.used, budget.canRenew]).toEqual([45, 45, 0, true]);
  });

  it("counts units and never passes the plan's numbers", () => {
    const budget = new RequestBudget(2);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    expect([budget.used, budget.remaining]).toEqual([2, 0]);
    expect([budget.takeRenewal(), budget.takeRenewal()]).toEqual([true, false]);
    expect(new RequestBudget(0).take()).toBe(false);
    expect(new RequestBudget(5, 0).canRenew).toBe(false);
    for (const limit of [-1, 1.5, HEALTH_REQUESTS + 1, NaN]) expect(() => new RequestBudget(limit)).toThrow("request budget");
    expect(() => new RequestBudget(5, FORCED_RENEWALS + 1)).toThrow("forced renewals");
  });

  it("does not send the 46th request: the range holds more than one call reads", async () => {
    const requests = fakeApi((n) => json(200, { dataPoints: points(`r${n}`), nextPageToken: `p${n}` }));
    const { client, budget } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "the date range holds more steps data than one call reads",
      hint: "use a shorter date range",
    });
    // Each page took a unit; the request that would pass the budget was not sent.
    expect(requests).toHaveLength(HEALTH_REQUESTS);
    expect(budget.remaining).toBe(0);
    // No later call of the same MCP request sends anything, whatever its type.
    expect(toWire(await failure(client.dailyRollup("total-calories", "2026-10-01", "2026-10-01", whole)))).toMatchObject({
      code: "invalid_input",
      message: "the date range holds more total-calories data than one call reads",
    });
    expect(requests).toHaveLength(HEALTH_REQUESTS);
  });

  it("takes a unit for every retry: a failing request that uses up the budget is unavailable", async () => {
    const requests = fakeApi(() => apiError(503, "UNAVAILABLE", ""));
    const { client, waits, budget } = testClient({ budget: new RequestBudget(2) });
    const error = await failure(listSteps(client));
    expect(toWire(error)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "try again in a few minutes",
    });
    expect(statusOf(error)).toMatchObject({ httpStatus: 503, status: "UNAVAILABLE" });
    expect(requests).toHaveLength(2);
    expect(budget.used).toBe(2);
    // No wait before a retry that cannot be sent.
    expect(waits).toEqual([1000]);
  });

  it("takes units for pages and retries together", async () => {
    // Page 1, page 2 fails once and is retried, page 3 does not fit.
    const requests = fakeApi((n) => {
      if (n === 2) return apiError(503, "UNAVAILABLE", "");
      return json(200, { dataPoints: points(`r${n}`), nextPageToken: `p${n}` });
    });
    const { client } = testClient({ budget: new RequestBudget(3) });
    expect(toWire(await failure(listSteps(client))).code).toBe("invalid_input");
    expect(requests).toHaveLength(3);
  });

  it("takes a unit for the request sent again after a renewal", async () => {
    const answer = (request: Sent) =>
      request.auth === "Bearer at-0" ? apiError(401, "UNAUTHENTICATED", "") : json(200, { dataPoints: points("a") });
    let requests = fakeApi((_n, request) => answer(request));
    const enough = testClient({ budget: new RequestBudget(2) });
    expect(await listSteps(enough.client)).toEqual(["a"]);
    expect(enough.budget.used).toBe(2);

    vi.mocked(globalThis.fetch).mockRestore();
    requests = fakeApi((_n, request) => answer(request));
    const short = testClient({ budget: new RequestBudget(1) });
    // The request was tried and cannot be sent again: unavailable, not a range that holds too much.
    expect(toWire(await failure(listSteps(short.client))).code).toBe("upstream_unavailable");
    expect(requests).toHaveLength(1);
  });

  // A page that was never tried is invalid_input (a shorter range fits). A
  // request that was tried and cannot be sent again is upstream_unavailable.
  it.each<[string, number, () => Response]>([
    ["a 401", 401, () => apiError(401, "UNAUTHENTICATED", "token 51c2 rejected")],
    ["the stale-token 403", 403, () => apiError(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.")],
  ])("answers upstream_unavailable when %s takes the last unit: the request was tried", async (_name, status, reject) => {
    // 44 pages are read; the request of page 45 takes the last unit and its token is rejected.
    const requests = fakeApi((n) => (n < HEALTH_REQUESTS ? json(200, { dataPoints: points(`r${n}`), nextPageToken: `p${n}` }) : reject()));
    const { client, budget, tokens, waits } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "try again in a few minutes",
    });
    expect(statusOf(error)).toMatchObject({ httpStatus: status });
    expect(requests).toHaveLength(HEALTH_REQUESTS);
    expect(budget.remaining).toBe(0);
    // The token is marked for renewal, so the next MCP request gets a new
    // one. Nothing more is asked or sent in this one, and nothing waits.
    expect(tokens.invalidated).toEqual(["at-0"]);
    expect(tokens.asked).toBe(HEALTH_REQUESTS);
    expect(waits).toEqual([]);
    expect(warnings()).toEqual([["google health token rejected; renewing", { data_type: "steps", http_status: status }]]);
    expect(logged()).not.toMatch(/51c2|insufficient/);
  });

  it("keeps invalid_input for the page after a renewed request that was answered", async () => {
    // A budget of 2: the first request is rejected, the second (after the
    // renewal) is answered with a next page, and that page is never tried.
    const requests = fakeApi((_n, request) =>
      request.auth === "Bearer at-0" ? apiError(401, "UNAUTHENTICATED", "") : json(200, { dataPoints: points("a"), nextPageToken: "p2" }),
    );
    const error = await failure(listSteps(testClient({ budget: new RequestBudget(2) }).client));
    expect(toWire(error)).toMatchObject({ code: "invalid_input", message: "the date range holds more steps data than one call reads" });
    expect(requests).toHaveLength(2);
  });

  it("is shared by every call and every client of one MCP request", async () => {
    const requests = fakeApi(() => json(200, {}));
    const budget = new RequestBudget(3);
    const first = testClient({ budget }).client;
    const second = testClient({ budget }).client;
    await listSteps(first);
    await second.dailyRollup("steps", "2026-10-01", "2026-10-01", whole);
    await first.listBetween("heart-rate", new Date("2026-10-10T22:00:00Z"), new Date("2026-10-10T23:00:00Z"), whole);
    expect(budget.used).toBe(3);
    expect(toWire(await failure(listSteps(second))).code).toBe("invalid_input");
    expect(requests).toHaveLength(3);
  });

  describe("the hint of a call that runs out of budget", () => {
    const RANGE_ERROR = { code: "invalid_input", message: "the date range holds more steps data than one call reads" };
    /** Every page names a next one: the call ends when the budget does. */
    const endless = () => fakeApi((n) => json(200, { dataPoints: points(`r${n}`), nextPageToken: `p${n}` }));

    it("is the Go hint for the first tool call that takes units", async () => {
      endless();
      const budget = new RequestBudget(3);
      // A tool call starts with no unit taken.
      budget.beginCall();
      expect(budget.sharedBefore).toBe(false);
      expect(toWire(await failure(listSteps(testClient({ budget }).client)))).toEqual({ ...RANGE_ERROR, hint: "use a shorter date range" });
      expect(SHORTER_RANGE_HINT).toBe("use a shorter date range");
    });

    it("names a request of its own for a tool call that starts after another one took units", async () => {
      endless();
      const budget = new RequestBudget(3);
      const { client } = testClient({ budget });
      budget.beginCall();
      await failure(listSteps(client));
      expect(budget.remaining).toBe(0);
      // The next tool call of the same MCP request finds the budget taken.
      budget.beginCall();
      expect(budget.sharedBefore).toBe(true);
      expect(toWire(await failure(listSteps(client)))).toEqual({
        ...RANGE_ERROR,
        hint: "use a shorter date range, or send this call in a request of its own",
      });
      expect(OWN_REQUEST_HINT).toBe("use a shorter date range, or send this call in a request of its own");
    });

    it("stays the Go hint for the page cap and the byte limits, which a request of its own does not lift", async () => {
      const requests = endless();
      const budget = new RequestBudget(10);
      budget.beginCall();
      await listSteps(testClient({ budget, maxPages: 1 }).client).catch(() => undefined);
      budget.beginCall();
      expect(budget.sharedBefore).toBe(true);
      // The page cap, with units left.
      const capped = await failure(listSteps(testClient({ budget, maxPages: 2 }).client));
      expect(toWire(capped)).toEqual({ ...RANGE_ERROR, hint: "use a shorter date range" });
      // The byte limit of a response, with units left.
      const large = await failure(listSteps(testClient({ budget, maxResponseBytes: 10 }).client));
      expect(toWire(large)).toEqual({ ...RANGE_ERROR, hint: "use a shorter date range" });
      expect(requests).toHaveLength(4);
      expect(budget.remaining).toBe(6);
    });

    it("does not change a request that was tried: it stays unavailable", async () => {
      const requests = fakeApi(() => apiError(503, "UNAVAILABLE", ""));
      const budget = new RequestBudget(5);
      const { client } = testClient({ budget });
      budget.beginCall();
      // Four attempts of the first tool call.
      await failure(listSteps(client));
      budget.beginCall();
      expect([budget.sharedBefore, budget.remaining]).toEqual([true, 1]);
      // The second tool call tries once, with the last unit.
      expect(toWire(await failure(listSteps(client)))).toMatchObject({ code: "upstream_unavailable", hint: "try again in a few minutes" });
      expect(requests).toHaveLength(5);
    });
  });

  it("asks for no token when the budget is used up", async () => {
    fakeApi(() => json(200, {}));
    const { client, tokens } = testClient({ budget: new RequestBudget(0) });
    expect(toWire(await failure(listSteps(client))).code).toBe("invalid_input");
    expect(tokens.asked).toBe(0);
  });

  it("takes a unit for each rollup chunk", async () => {
    // 91 days of total-calories are 7 chunks of at most 14 days.
    const requests = fakeApi(() => json(200, { rollupDataPoints: [] }));
    const { client, budget } = testClient({ budget: new RequestBudget(6) });
    expect(toWire(await failure(client.dailyRollup("total-calories", "2026-01-01", "2026-04-01", whole))).code).toBe("invalid_input");
    expect(requests).toHaveLength(6);
    expect(budget.remaining).toBe(0);
  });
});

describe("byte limits", () => {
  it("fits a 128 MB isolate", () => {
    expect(MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_CALL_BYTES).toBe(32 * 1024 * 1024);
    // The peak of a call: what it kept, and its last response as bytes and as two-byte text.
    expect(MAX_CALL_BYTES + 2 * MAX_RESPONSE_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("refuses a response over the limit, without a retry", async () => {
    const requests = fakeApi(() => new Response(" ".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }));
    const { client, waits } = testClient();
    const error = await failure(client.list("steps", "2026-10-01", "2026-10-01", id));
    expect(toWire(error)).toEqual({
      code: "invalid_input",
      message: "the date range holds more steps data than one call reads",
      hint: "use a shorter date range",
    });
    expect(chain(error).some((link) => link instanceof ResponseTooLargeError)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("reads a response of exactly the limit", async () => {
    const head = '{"dataPoints":[]';
    fakeApi(() => new Response(`${head}${" ".repeat(MAX_RESPONSE_BYTES - head.length - 1)}}`, { status: 200 }));
    expect(await listSteps(testClient().client)).toEqual([]);
  });

  it("counts bytes, not characters", async () => {
    // 20 characters, 21 bytes.
    const body = '{"dataPoints":["é"]}';
    fakeApi(() => new Response(body, { status: 200 }));
    expect(await testClient({ maxResponseBytes: 21 }).client.list("steps", "2026-10-01", "2026-10-01", whole)).toEqual(["é"]);
    expect(toWire(await failure(listSteps(testClient({ maxResponseBytes: 20 }).client))).code).toBe("invalid_input");
  });

  it("refuses an error response over the limit as well", async () => {
    const requests = fakeApi(() => new Response("x".repeat(2000), { status: 500 }));
    const { client, waits } = testClient({ maxResponseBytes: 1024 });
    expect(toWire(await failure(listSteps(client))).code).toBe("invalid_input");
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("bounds the responses of one call across its pages", async () => {
    const page = (n: number) => JSON.stringify({ dataPoints: points("x"), nextPageToken: `p${n}` });
    const size = page(1).length;
    const requests = fakeApi((n) => new Response(page(n), { status: 200 }));
    // Two pages fit, the third does not.
    const { client } = testClient({ maxCallBytes: 2 * size + 1 });
    const error = await failure(listSteps(client));
    expect(toWire(error)).toMatchObject({ code: "invalid_input", hint: "use a shorter date range" });
    expect(requests).toHaveLength(3);
  });

  it("bounds the responses of one rollup across its chunks", async () => {
    const body = JSON.stringify({ rollupDataPoints: [{ v: 1 }] });
    const requests = fakeApi(() => new Response(body, { status: 200 }));
    const { client } = testClient({ maxCallBytes: body.length + 1 });
    // 28 days of total-calories are two chunks: the second response passes the limit.
    expect(toWire(await failure(client.dailyRollup("total-calories", "2026-09-10", "2026-10-07", whole))).code).toBe("invalid_input");
    expect(requests).toHaveLength(2);
    // Each call has its own count.
    expect(await client.dailyRollup("total-calories", "2026-09-10", "2026-09-23", whole)).toEqual([{ v: 1 }]);
  });
});

describe("errors and logs never quote the response body", () => {
  const statuses = [400, 401, 403, 404, 429, 500];
  const grpcStatuses = ["secret 72 bpm", "lowercase", "A".repeat(65)];
  const cases = statuses.flatMap((status) => grpcStatuses.map((grpc): [number, string] => [status, grpc]));

  it.each(cases)("HTTP %i with the status %j", async (status, grpc) => {
    fakeApi(() => apiError(status, grpc, "secret message 72 bpm"));
    const error = await failure(listSteps(testClient().client));
    // The status of the body is kept only when it is enum-shaped.
    expect(statusOf(error)).toMatchObject({ httpStatus: status, status: "" });
    const wire = toWire(error);
    for (const text of [texts(error), wire.message, wire.hint ?? "", logged()]) {
      expect(text).not.toMatch(/secret|bpm|AAAA|lowercase/);
    }
    expect(texts(error)).not.toContain("72");
  });

  it("never logs or reports an access token", async () => {
    // A renewal, a retry, a rejection and a final 401, each with the token in the answer.
    fakeApi((n, request) => {
      const echo = `token ${request.auth}`;
      if (n === 1) return apiError(401, "UNAUTHENTICATED", echo);
      if (n === 2) return apiError(503, "UNAVAILABLE", echo);
      if (n === 3) return json(200, { dataPoints: points("a"), nextPageToken: "p2", echo });
      return apiError(401, "UNAUTHENTICATED", echo);
    });
    const { client } = testClient();
    const error = await failure(listSteps(client));
    expect(toWire(error).code).toBe("auth_expired");
    expect(warnings().length).toBeGreaterThanOrEqual(3);
    for (const text of [texts(error), JSON.stringify(toWire(error)), logged()]) {
      expect(text).not.toMatch(/at-0|at-1|Bearer/);
    }
  });
});

describe("with the CoachStore token source", () => {
  function link(overrides: Partial<GoogleLink> = {}): GoogleLink {
    return {
      sub: OWNER_SUB,
      email: OWNER_EMAIL,
      refreshToken: GOOGLE_REFRESH_TOKEN,
      accessToken: "at-old",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      scopes: ["openid", "email", ...GOOGLE_HEALTH_SCOPES].join(" "),
      ...overrides,
    };
  }

  /** The client as the object builds it: direct calls, no RPC. */
  function clientOf(instance: CoachStore, budget = new RequestBudget()): GoogleHealthClient {
    return new GoogleHealthClient({
      tokens: {
        accessToken: () => instance.googleAccessToken(),
        invalidate: (rejected) => instance.invalidateGoogleAccessToken(rejected),
      },
      zone: SAO_PAULO,
      budget,
      wait: async () => undefined,
      jitter: (ms) => ms,
    });
  }

  /** Runs one list call inside the object and returns its records or its wire error. */
  function listIn(stub: DurableObjectStub<CoachStore>, budget?: RequestBudget) {
    return runInDurableObject(stub, async (instance) => {
      try {
        return { ok: true as const, records: await listSteps(clientOf(instance, budget)) };
      } catch (error) {
        return { ok: false as const, wire: toWire(error), text: texts(error) };
      }
    });
  }

  /** The Google Health API next to the token endpoint of `mockGoogle`. */
  function health(answer: (auth: string, request: Request, n: number) => Response): { auths: string[]; other: (request: Request) => Response | undefined } {
    const auths: string[] = [];
    return {
      auths,
      other: (request) => {
        if (!request.url.startsWith(`${API}/v4/`)) return undefined;
        const auth = request.headers.get("authorization") ?? "";
        auths.push(auth);
        return answer(auth, request, auths.length);
      },
    };
  }

  const newToken = (accessToken: string) => Response.json({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" });

  it("renews a rejected token once and sends the request again", async () => {
    const api = health((auth) => (auth === "Bearer at-new" ? json(200, { dataPoints: points("a") }) : apiError(401, "UNAUTHENTICATED", "")));
    const calls = mockGoogle(() => newToken("at-new"), api.other);
    const stub = freshStore();
    await stub.linkGoogleAccount(link());
    expect(await listIn(stub)).toEqual({ ok: true, records: ["a"] });
    expect(calls.token).toHaveLength(1);
    expect(api.auths).toEqual(["Bearer at-old", "Bearer at-new"]);
    for (const secret of ["at-old", "at-new", GOOGLE_REFRESH_TOKEN]) expect(logged()).not.toContain(secret);
  });

  it("answers auth_expired when the renewed token is rejected too", async () => {
    const api = health(() => apiError(401, "UNAUTHENTICATED", ""));
    const calls = mockGoogle(() => newToken("at-new"), api.other);
    const stub = freshStore();
    await stub.linkGoogleAccount(link());
    const result = await listIn(stub);
    expect(result).toMatchObject({ ok: false, wire: { code: "auth_expired", hint: RECONNECT_HINT } });
    expect(calls.token).toHaveLength(1);
    expect(api.auths).toHaveLength(2);
    for (const secret of ["at-old", "at-new", GOOGLE_REFRESH_TOKEN]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(logged()).not.toContain(secret);
    }
  });

  it("does not renew a rejected token that was already replaced", async () => {
    const stub = freshStore();
    await stub.linkGoogleAccount(link());
    let replace = (): void => undefined;
    const api = health((auth) => {
      if (auth === "Bearer at-new") return json(200, { dataPoints: points("a") });
      // Another request renews the token while this one is in flight.
      replace();
      return apiError(401, "UNAUTHENTICATED", "");
    });
    const calls = mockGoogle(() => newToken("never-asked"), api.other);
    const budget = new RequestBudget();
    const records = await runInDurableObject(stub, (instance) => {
      replace = () => instance.linkGoogleAccount(link({ accessToken: "at-new" }));
      return listSteps(clientOf(instance, budget));
    });
    expect(records).toEqual(["a"]);
    // The rejection of the old token is ignored: no token endpoint request.
    expect(calls.token).toHaveLength(0);
    expect(api.auths).toEqual(["Bearer at-old", "Bearer at-new"]);
    expect(budget.canRenew).toBe(true);
  });

  it("sends at most two token endpoint requests in one MCP request", async () => {
    // The stored token is expired (request 1); Google rejects the new one
    // (request 2); the rejection of the third token is final.
    let issued = 0;
    const api = health((auth, request) => {
      if (auth === "Bearer t1") return apiError(401, "UNAUTHENTICATED", "");
      if (!new URL(request.url).searchParams.has("pageToken")) return json(200, { dataPoints: points("a"), nextPageToken: "p2" });
      return apiError(401, "UNAUTHENTICATED", "");
    });
    const calls = mockGoogle(() => newToken(`t${++issued}`), api.other);
    const stub = freshStore();
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const budget = new RequestBudget();
    expect(await listIn(stub, budget)).toMatchObject({ ok: false, wire: { code: "auth_expired" } });
    expect(api.auths).toEqual(["Bearer t1", "Bearer t2", "Bearer t2"]);
    expect(calls.token).toHaveLength(TOKEN_REQUESTS);
    // Another call of the same MCP request adds no token request.
    expect(await listIn(stub, budget)).toMatchObject({ ok: false, wire: { code: "auth_expired" } });
    expect(calls.token).toHaveLength(TOKEN_REQUESTS);
    expect(budget.used + calls.token.length).toBeLessThanOrEqual(MAX_SUBREQUESTS);
  });

  it("answers auth_expired without a request when no account is linked", async () => {
    const api = health(() => json(200, {}));
    const calls = mockGoogle(() => newToken("never-asked"), api.other);
    expect(await listIn(freshStore())).toMatchObject({
      ok: false,
      wire: { code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT },
    });
    expect(calls.token).toHaveLength(0);
    expect(api.auths).toHaveLength(0);
  });

  it("answers auth_expired when Google revoked the link", async () => {
    const api = health(() => json(200, {}));
    const calls = mockGoogle(
      () => Response.json({ error: "invalid_grant", error_description: `revoked: ${GOOGLE_REFRESH_TOKEN}` }, { status: 400 }),
      api.other,
    );
    const stub = freshStore();
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const result = await listIn(stub);
    expect(result).toMatchObject({
      ok: false,
      wire: { code: "auth_expired", message: "the Google sign-in expired or was revoked", hint: RECONNECT_HINT },
    });
    expect(JSON.stringify(result)).not.toContain(GOOGLE_REFRESH_TOKEN);
    expect(calls.token).toHaveLength(1);
    expect(api.auths).toHaveLength(0);
  });

  it("asks a token endpoint that is down once per MCP request", async () => {
    const api = health(() => json(200, {}));
    const calls = mockGoogle(() => new Response("<html>down</html>", { status: 503 }), api.other);
    const stub = freshStore();
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const budget = new RequestBudget();
    const unavailable = {
      ok: false,
      wire: { code: "upstream_unavailable", message: "Google's token service is unavailable", hint: "try again in a few minutes" },
    };
    expect(await listIn(stub, budget)).toMatchObject(unavailable);
    expect(await listIn(stub, budget)).toMatchObject(unavailable);
    expect(calls.token).toHaveLength(1);
    // The next MCP request asks again.
    expect(await listIn(stub)).toMatchObject(unavailable);
    expect(calls.token).toHaveLength(2);
    expect(api.auths).toHaveLength(0);
  });

  it("answers upstream_unavailable for a renewal answered with HTTP 200 and no usable token", async () => {
    const api = health(() => json(200, {}));
    const stray = "stray-text-in-the-answer";
    const calls = mockGoogle(() => Response.json({ token_type: "Bearer", note: stray }), api.other);
    const stub = freshStore();
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const budget = new RequestBudget();
    const result = await listIn(stub, budget);
    // Not auth_expired: the link and the OAuth client are fine, and a retry can work.
    expect(result).toMatchObject({
      ok: false,
      wire: { code: "upstream_unavailable", message: "Google's token service is unavailable", hint: "try again in a few minutes" },
    });
    for (const text of [stray, GOOGLE_REFRESH_TOKEN, "at-old"]) {
      expect(JSON.stringify(result)).not.toContain(text);
      expect(logged()).not.toContain(text);
    }
    // The failure is remembered: another call of the same MCP request asks no more.
    expect(await listIn(stub, budget)).toMatchObject({ ok: false, wire: { code: "upstream_unavailable" } });
    expect(calls.token).toHaveLength(1);
    // The link stays, and the status tool reports the same state.
    expect(await stub.googleAccountStatus()).toMatchObject({ linked: true, token: "upstream_unavailable" });
    expect(api.auths).toHaveLength(0);
  });

  it("answers auth_expired when Google refuses the token request", async () => {
    const api = health(() => json(200, {}));
    const secret = "client-secret-in-the-answer";
    const calls = mockGoogle(
      () => Response.json({ error: "invalid_client", error_description: `bad secret ${secret}` }, { status: 401 }),
      api.other,
    );
    const stub = freshStore();
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const budget = new RequestBudget();
    const result = await listIn(stub, budget);
    expect(result).toMatchObject({
      ok: false,
      wire: { code: "auth_expired", message: "Google rejected the token renewal", hint: RENEWAL_HINT },
    });
    // Neither the token nor Google's answer reaches the error or a log line.
    for (const text of [secret, "invalid_client", GOOGLE_REFRESH_TOKEN, "at-old"]) {
      expect(JSON.stringify(result)).not.toContain(text);
      expect(logged()).not.toContain(text);
    }
    // The failure is remembered: another call of the same MCP request asks no more.
    expect(await listIn(stub, budget)).toMatchObject({ ok: false, wire: { code: "auth_expired" } });
    expect(calls.token).toHaveLength(1);
    expect(api.auths).toHaveLength(0);
  });
});
