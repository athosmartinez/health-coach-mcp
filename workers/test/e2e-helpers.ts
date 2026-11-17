// Shared by the tests that serve whole MCP HTTP requests with Google behind a
// mocked `fetch`: the token endpoint and the fake Health API, with every
// external fetch counted. Also the synthetic month and year of data they read.
//
// The clock is fixed at 2026-10-16 10:00 in São Paulo. All values are synthetic.
import { type MockInstance, afterEach, beforeEach, expect, vi } from "vitest";

import { addDays } from "../src/coach/date";
import type { WireError } from "../src/coach/errors";
import { GOOGLE_HEALTH_SCOPES, GOOGLE_TOKEN_URL } from "../src/google";
import { HEALTH_REQUESTS } from "../src/googlehealth/budget";
import type { CoachStore, GoogleLink } from "../src/store";
import {
  FakeGoogle,
  NOW,
  at,
  azmRollup,
  bodyFatRec,
  exerciseRec,
  foodRec,
  hrvNight,
  kcalRollup,
  restingRec,
  samplesEvery2s,
  sleepRec,
  stepRec,
  stepsRollup,
  weightRec,
} from "./healthdata-helpers";
import { GOOGLE_REFRESH_TOKEN, type JsonRpc, OWNER_EMAIL, OWNER_SUB } from "./helpers";
import { type McpTarget, freshStore, mcpRequest, objectTool } from "./memory-helpers";

export const TODAY = "2026-10-16";
/** The day `offset` days from today. */
export const day = (offset: number) => addDays(TODAY, offset) as string;

/** The access token of a link stored by `linkedStore`, and the one the token endpoint hands out. */
export const STORED_TOKEN = "at-stored-51c2";
export const RENEWED_TOKEN = "at-renewed-8e07";

/** Names in the fixtures that must never reach a log line. */
export const SESSION_NAME = "JIU JITSU";
export const FOOD_NAME = "Synthetic food";

export const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type Level = (typeof LEVELS)[number];

export const newToken = (accessToken: string) => Response.json({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" });

/** Google behind `fetch` for one test, and what the code under test sent and logged. */
export interface GoogleMock {
  google: FakeGoogle;
  /**
   * Every external fetch since the last take: "token", or the Health data type
   * ("rollup …" for a daily rollup, "create …" and "delete …" for a write).
   */
  external: string[];
  /** The Authorization header of every Health API request. */
  auths: string[];
  /** Answers the token endpoint. Default: a new token. */
  tokenReply: () => Response | Promise<Response>;
  /**
   * When set and it returns a response, answers a Health API request instead
   * of the fake API. It may wait: for a test that changes the store while a
   * request is in flight.
   */
  healthReply: ((request: Request) => Response | undefined | Promise<Response | undefined>) | undefined;
  /** Puts the mock on `fetch` again, after another helper replaced it (the OAuth sign-in). */
  install(): void;
  /** The external fetches since the last take: a count per kind, and the total. */
  takeExternal(): Record<string, number>;
  /** Every console line of the test so far, as JSON. */
  logged(): string;
  logLines(level: Level): unknown[][];
  clearLogs(): void;
}

/**
 * Registers the per-test setup: the clock fixed at NOW (timers stay real), a
 * spy on every console level, a new fake Health API and the `fetch` mock. Any
 * URL other than the token endpoint and the Health API fails the test.
 */
export function googleMock(): GoogleMock {
  const spies = new Map<string, MockInstance>();
  const mock: GoogleMock = {
    google: new FakeGoogle(),
    external: [],
    auths: [],
    tokenReply: () => newToken(RENEWED_TOKEN),
    healthReply: undefined,
    install() {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === GOOGLE_TOKEN_URL && request.method === "POST") {
          mock.external.push("token");
          return mock.tokenReply();
        }
        if (!mock.google.serves(request)) throw new Error(`unexpected fetch in test: ${request.method} ${request.url}`);
        mock.external.push(mock.google.kindOf(request));
        mock.auths.push(request.headers.get("authorization") ?? "");
        return (await mock.healthReply?.(request)) ?? mock.google.respond(request);
      });
    },
    takeExternal() {
      const counts: Record<string, number> = { total: mock.external.length };
      for (const kind of mock.external) counts[kind] = (counts[kind] ?? 0) + 1;
      mock.external = [];
      return counts;
    },
    logged: () => JSON.stringify(LEVELS.flatMap((level) => spies.get(level)?.mock.calls ?? [])),
    logLines: (level) => spies.get(level)?.mock.calls ?? [],
    clearLogs() {
      for (const level of LEVELS) spies.get(level)?.mockClear();
    },
  };
  beforeEach(() => {
    // Only the clock is fixed: timers stay real.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    for (const level of LEVELS) spies.set(level, vi.spyOn(console, level).mockImplementation(() => undefined));
    mock.google = new FakeGoogle();
    mock.external = [];
    mock.auths = [];
    mock.tokenReply = () => newToken(RENEWED_TOKEN);
    mock.healthReply = undefined;
    mock.install();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  return mock;
}

/**
 * Makes the waits between the retries of the Google Health client pass at
 * once. Only a timer that the client's own retry log line announces is cut.
 * Returns the waits that the client asked for, in milliseconds.
 */
export function skipRetryWaits(mock: GoogleMock): number[] {
  const real = globalThis.setTimeout;
  const waited: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
    const [message, fields] = (mock.logLines("warn").at(-1) ?? []) as [string?, { wait_ms?: number }?];
    if (message === "google health request failed; retrying" && fields?.wait_ms === ms) {
      waited.push(ms ?? 0);
      return real(handler, 0);
    }
    return real(handler, ms);
  }) as typeof setTimeout);
  return waited;
}

export function link(overrides: Partial<GoogleLink> = {}): GoogleLink {
  return {
    sub: OWNER_SUB,
    email: OWNER_EMAIL,
    refreshToken: GOOGLE_REFRESH_TOKEN,
    accessToken: STORED_TOKEN,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: ["openid", "email", ...GOOGLE_HEALTH_SCOPES].join(" "),
    ...overrides,
  };
}

/** A new store with a linked Google account. */
export async function linkedStore(overrides: Partial<GoogleLink> = {}): Promise<DurableObjectStub<CoachStore>> {
  const stub = freshStore();
  await stub.linkGoogleAccount(link(overrides));
  return stub;
}

export type Outcome = { ok: true; output: Record<string, any> } | { ok: false; error: WireError };

export type ToolCall = [name: string, args: Record<string, unknown>];

/** One HTTP request with several JSON-RPC messages; the answers by request id. */
export async function batch(target: McpTarget, calls: readonly ToolCall[]): Promise<Outcome[]> {
  const body = calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  const response = await target.fetch(mcpRequest(body));
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const replies = new Map<number, JsonRpc>();
  const lines = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter((line) => line !== "")
    : [text];
  for (const line of lines) {
    const parsed = JSON.parse(line) as JsonRpc | JsonRpc[];
    for (const reply of Array.isArray(parsed) ? parsed : [parsed]) replies.set(Number(reply.id), reply);
  }
  return calls.map((_call, i) => {
    const reply = replies.get(i + 1);
    expect(reply?.error, JSON.stringify(reply)).toBeUndefined();
    const result = reply?.result as { isError?: boolean; content?: { text: string }[]; structuredContent?: Record<string, any> };
    if (result.isError) return { ok: false, error: JSON.parse(result.content?.[0]?.text ?? "") as WireError };
    return { ok: true, output: result.structuredContent ?? {} };
  });
}

/**
 * Synthetic data for today and the `back` days before it: each day a night of
 * 480 minutes in bed with 97 HRV samples, a resting heart rate, and the daily
 * totals. Every fifth day has no zone-minutes row but step records of the
 * band (`bandStepRecords` of them). A weigh-in with body fat every third day.
 * A day that `offWrist` picks has no band data: no zone-minutes row and no
 * step record.
 */
export function daysOfData(google: FakeGoogle, back: number, offWrist: (i: number) => boolean = () => false, bandStepRecords = 1): void {
  for (let i = back; i >= 0; i--) {
    const [end, start] = [day(-i), day(-i - 1)];
    google.add("sleep", sleepRec(at(start, 23, 0), at(end, 7, 0), { deep: 60 }));
    google.add("heart-rate-variability", ...hrvNight(at(start, 23, 0), at(end, 7, 0), 40 + (i % 5)));
    google.add("daily-resting-heart-rate", restingRec(end, 55 + (i % 3), "WITH_SLEEP", "FITBIT"));
    google.addRollup("steps", stepsRollup(end, 8000 + 10 * (i % 100)));
    google.addRollup("total-calories", kcalRollup(end, 2400 + (i % 100)));
    // A day off the wrist has neither a zone-minutes row nor step records of the band.
    if (!offWrist(i)) {
      if (i % 5 === 3) for (let n = 0; n < bandStepRecords; n++) google.add("steps", stepRec(end, "FITBIT"));
      else google.addRollup("active-zone-minutes", azmRollup(end, 20, 5, 0));
    }
    if (i % 3 === 0) {
      google.add("weight", weightRec(at(end, 7, 30), 80_000 + 100 * (i % 4), "FITBIT"));
      google.add("body-fat", bodyFatRec(at(end, 7, 30), 20 + (i % 2)));
    }
  }
}

export const RUN_ID = "users/me/dataTypes/exercise/dataPoints/syn-run";

/** A jiu-jitsu class and a run on 2026-10-14, a walk on the 15th and a run on the 12th. */
export function sessions(google: FakeGoogle): void {
  const add = (date: string, hour: number, minutes: number, options: Parameters<typeof exerciseRec>[2], bpm: number) => {
    const [start, end] = [at(date, hour, 0), new Date(at(date, hour, 0).getTime() + minutes * 60_000)];
    google.add("exercise", exerciseRec(start, end, options));
    google.add("heart-rate", ...samplesEvery2s(start, end, bpm));
  };
  add(day(-2), 7, 60, { type: "JIU_JITSU", avgHR: 81, kcal: 400, azm: 10, zones: [40, 10, 0, 0] }, 95);
  add(day(-2), 18, 30, { type: "RUNNING", avgHR: 150, kcal: 350, azm: 50, zones: [2, 8, 15, 5], name: RUN_ID }, 164);
  add(day(-1), 12, 30, { type: "WALKING", avgHR: 100, kcal: 120, azm: 5, zones: [25, 5, 0, 0] }, 104);
  add(day(-4), 7, 40, { type: "RUNNING", avgHR: 148, kcal: 420, azm: 60, zones: [2, 8, 20, 10] }, 160);
}

/** Four meals on 2026-10-14 (kcal 2200, protein 130) and a snack today. */
export function meals(google: FakeGoogle): void {
  const closed = day(-2);
  google.add(
    "nutrition-log",
    foodRec(at(closed, 8, 0), { meal: "BREAKFAST", kcal: 500, carb: 60, fat: 15, list: { PROTEIN: 30 } }),
    foodRec(at(closed, 12, 0), { meal: "LUNCH", kcal: 800, carb: 90, fat: 25, list: { PROTEIN: 50, DIETARY_FIBER: 10 } }),
    foodRec(at(closed, 16, 0), { meal: "SNACK", kcal: 200, carb: 20, fat: 8, list: { PROTEIN: 10 } }),
    foodRec(at(closed, 20, 0), { meal: "DINNER", kcal: 700, carb: 70, fat: 20, list: { PROTEIN: 40 } }),
    foodRec(at(TODAY, 7, 0), { meal: "SNACK", kcal: 200, list: { PROTEIN: 10 } }),
  );
}

/** One month of days (2026-09-16 to 2026-10-16), the sessions and the meals. */
export function everything(google: FakeGoogle): void {
  daysOfData(google, 30);
  sessions(google);
  meals(google);
}

/** Two meals on each of the `back` days before today. */
export function foodDays(google: FakeGoogle, back: number): void {
  for (let i = back; i >= 1; i--) {
    google.add(
      "nutrition-log",
      foodRec(at(day(-i), 12, 0), { meal: "LUNCH", kcal: 1200, list: { PROTEIN: 70 } }),
      foodRec(at(day(-i), 20, 0), { meal: "DINNER", kcal: 900, list: { PROTEIN: 60 } }),
    );
  }
}

/** The budget error of the Google Health client: the call needs more requests than one MCP request may send. */
export function expectBudgetError(error: WireError, context: string): void {
  expect(error.message, context).toMatch(/^the date range holds more [a-z0-9-]+ data than one call reads$/);
  expect(error, context).toMatchObject({ code: "invalid_input", hint: "use a shorter date range" });
}

/**
 * Calls a tool on one store, one MCP HTTP request per call, until it
 * succeeds. Returns the Google requests of each call. A call may fail only
 * with the budget error of the client, and never sends more than the budget.
 */
export async function untilOk(
  mock: GoogleMock,
  target: McpTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: Record<string, any>; calls: Record<string, number>[] }> {
  const calls: Record<string, number>[] = [];
  for (let n = 0; n < 6; n++) {
    const outcome = await objectTool(target, name, args);
    const counts = mock.takeExternal();
    calls.push(counts);
    expect(counts.total, `call ${n + 1}`).toBeLessThanOrEqual(HEALTH_REQUESTS);
    expect(counts.token ?? 0).toBe(0);
    if (outcome.ok) return { output: outcome.output, calls };
    expectBudgetError(outcome.error, `call ${n + 1}`);
  }
  throw new Error(`${name} did not succeed in ${calls.length} calls: ${JSON.stringify(calls)}`);
}
