/// <reference types="vite/client" />
// The subrequest measurement. Workers Free allows 50 external subrequests per
// invocation. This file counts every external `fetch` of one MCP HTTP request
// (the Google Health API and the Google token endpoint) for the worst-case
// input of each coach tool, and checks that no request passes the limit.
//
// Each case is served as in production: one MCP HTTP request to the
// CoachStore object, the real Google Health client and healthdata source, and
// Google behind a mocked `fetch`. The cache is cold at the first request of a
// case. All values are synthetic.
//
// The cases and their counts are the table of the README ("Measured
// subrequests"): a test compares the two. The measured table is also printed
// at the end of the run. A minimal reporter hides the output of a file that
// passes, so to read the table:
//
//   npm test -- test/subrequests.test.ts --reporter=default
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";

import README from "../README.md?raw";
import { DATA_TYPES } from "../src/googlehealth/datatypes";
import { HEALTH_REQUESTS, MAX_SUBREQUESTS } from "../src/googlehealth/budget";
import { OWN_REQUEST_HINT, SHORTER_RANGE_HINT, WRITE_OWN_REQUEST_HINT } from "../src/googlehealth/client";
import { pointId } from "../src/googlehealth/nutritionlog";
import type { CoachStore, GoogleLink } from "../src/store";
import {
  FOOD_NAME,
  type GoogleMock,
  LEVELS,
  type Outcome,
  RENEWED_TOKEN,
  STORED_TOKEN,
  type ToolCall,
  batch,
  day,
  expectBudgetError,
  googleMock,
  link,
  linkedStore,
  newToken,
  skipRetryWaits,
} from "./e2e-helpers";
import {
  FAKE_CLIENT_ID,
  FAKE_USER_ID,
  type FakeGoogle,
  MINUTE,
  at,
  azmRollup,
  bodyFatRec,
  exerciseRec,
  foodRec,
  hrvEvery,
  kcalRollup,
  restingRec,
  samplesEvery2s,
  sleepRec,
  stepRec,
  stepsRollup,
  weightRec,
} from "./healthdata-helpers";
import { GOOGLE_REFRESH_TOKEN } from "./helpers";
import { ALL_TOOL_NAMES, objectTool } from "./memory-helpers";

const g = googleMock();

// The volumes of the synthetic year: today (2026-10-16) and the 365 days
// before it. They are estimates of a band worn day and night; the README
// states them next to the table.

/** Step records of the band on a day it was worn: one per minute with steps. */
const STEP_RECORDS_PER_DAY = 320;
/** HRV samples of a night of 8 hours: one every 5 minutes. */
const HRV_SAMPLES = 97;
/** The dense account: more HRV samples per night, and a phone copy of every sleep record. */
const DENSE_HRV_SAMPLES = 130;
/** A nap on every third day. */
const NAP_EVERY = 3;
/** One training session of an hour on five days of every seven. */
const SESSION_DAYS_OF_7 = 5;
/** Five food items per day. */
const MEALS: [hour: number, meal: string, kcal: number, protein: number][] = [
  [8, "BREAKFAST", 450, 25],
  [12, "LUNCH", 750, 45],
  [16, "SNACK", 200, 10],
  [20, "DINNER", 650, 40],
  [22, "SNACK", 150, 8],
];
/**
 * One day with 33 sessions of 20 minutes: `workout_review` by `date` reads a
 * max heart rate for 31 of them, and by `exercise_id` for one. HEAVY_ID is the
 * newest session of the day, so its max heart rate is read.
 */
const HEAVY_DAY = day(-10);
const HEAVY_SESSIONS = 33;
const HEAVY_ID = "users/me/dataTypes/exercise/dataPoints/syn-heavy-1";

interface YearOptions {
  /** Two sleep records per night (the band and a phone copy) and 130 HRV samples per night. */
  dense?: boolean;
  /** A day without band data in every week: no zone-minutes row and no step record. */
  offWrist?: boolean;
}

type DataType = Parameters<FakeGoogle["add"]>[0];
type Records = Partial<Record<DataType, unknown[]>>;

/** The records of a year, built once per variant: the fake API only reads them. */
const built = new Map<string, { lists: Records; rollups: Records }>();

function buildYear(options: YearOptions): { lists: Records; rollups: Records } {
  const lists: Records = {};
  const rollups: Records = {};
  const list = (type: DataType, ...records: unknown[]) => (lists[type] ??= []).push(...records);
  const rollup = (type: DataType, row: unknown) => (rollups[type] ??= []).push(row);
  const night = 480 * MINUTE;
  const hrvStep = options.dense ? Math.floor(night / (DENSE_HRV_SAMPLES - 1)) : night / (HRV_SAMPLES - 1);
  for (let i = 365; i >= 0; i--) {
    const [end, start] = [day(-i), day(-i - 1)];
    const [bed, wake] = [at(start, 23, 0), at(end, 7, 0)];
    list("sleep", sleepRec(bed, wake, { deep: 60 }));
    if (options.dense) list("sleep", sleepRec(bed, wake, { platform: "HEALTH_KIT", deep: 60 }));
    if (i % NAP_EVERY === 0) list("sleep", sleepRec(at(end, 14, 0), at(end, 14, 30), { nap: true }));
    list("heart-rate-variability", ...hrvEvery(bed, wake, hrvStep, 40 + (i % 5)));
    list("daily-resting-heart-rate", restingRec(end, 55 + (i % 3), "WITH_SLEEP", "FITBIT"));
    rollup("steps", stepsRollup(end, 8000 + 10 * (i % 100)));
    rollup("total-calories", kcalRollup(end, 2400 + (i % 100)));
    if (!(options.offWrist && i % 7 === 6)) {
      // Every fifth day has no zone-minutes row: the band was worn, with no minute in a zone.
      if (i % 5 !== 3) rollup("active-zone-minutes", azmRollup(end, 20, 5, 0));
      const record = stepRec(end, "FITBIT");
      for (let n = 0; n < STEP_RECORDS_PER_DAY; n++) list("steps", record);
    }
    list("weight", weightRec(at(end, 7, 30), 80_000 + 100 * (i % 4), "FITBIT"));
    list("body-fat", bodyFatRec(at(end, 7, 30), 20 + (i % 2)));
    if (i % 7 < SESSION_DAYS_OF_7 && end !== HEAVY_DAY) {
      const [from, to] = [at(end, 18, 0), at(end, 19, 0)];
      list("exercise", exerciseRec(from, to, { type: "RUNNING", avgHR: 150, kcal: 600, azm: 60, zones: [5, 15, 30, 10] }));
      // A review lists heart rate only inside the sessions of its day, so the
      // fake holds the samples of the days that a case reviews.
      if (i <= 7) list("heart-rate", ...samplesEvery2s(from, to, 150));
    }
    for (const [hour, meal, kcal, protein] of MEALS) {
      list("nutrition-log", foodRec(at(end, hour, 0), { meal, kcal, carb: 40, fat: 15, list: { PROTEIN: protein } }));
    }
  }
  for (let n = 0; n < HEAVY_SESSIONS; n++) {
    const from = new Date(at(HEAVY_DAY, 6, 0).getTime() + n * 20 * MINUTE);
    const to = new Date(from.getTime() + 20 * MINUTE);
    list("exercise", exerciseRec(from, to, { type: "WALKING", avgHR: 120, kcal: 80, zones: [10, 10, 0, 0], ...(n === HEAVY_SESSIONS - 1 ? { name: HEAVY_ID } : {}) }));
    list("heart-rate", ...samplesEvery2s(from, to, 120));
  }
  return { lists, rollups };
}

/** Fills the fake API with a year of data. */
function yearOfData(google: FakeGoogle, options: YearOptions = {}): void {
  const key = JSON.stringify(options);
  let year = built.get(key);
  if (!year) built.set(key, (year = buildYear(options)));
  // A spread of a whole year of records is too long for one call.
  const chunks = (records: unknown[]) => Array.from({ length: Math.ceil(records.length / 5000) }, (_unused, n) => records.slice(n * 5000, (n + 1) * 5000));
  for (const [type, records] of Object.entries(year.lists)) for (const chunk of chunks(records)) google.add(type as DataType, ...chunk);
  for (const [type, rows] of Object.entries(year.rollups)) for (const chunk of chunks(rows)) google.addRollup(type as DataType, ...chunk);
}

interface Counts {
  health: number;
  token: number;
  /** The same fetches by kind: "token", or the data type ("rollup …" for a daily rollup). */
  kinds: Record<string, number>;
}

function take(): Counts {
  const { total = 0, ...kinds } = g.takeExternal();
  const token = kinds.token ?? 0;
  return { health: total - token, token, kinds };
}

/**
 * "ok", "budget error" (the client's own error for a call that needs more
 * requests), or the error code. `own` says whether the call may carry the
 * hint that names a request of its own: only a call of a batch.
 */
function resultOf(outcome: Outcome, own: boolean, context: string): string {
  if (outcome.ok) return "ok";
  // The budget error of a write: it was not sent, and it has no date range to shorten.
  if (outcome.error.hint === WRITE_OWN_REQUEST_HINT) {
    expect(outcome.error.code, context).toBe("invalid_input");
    expect(outcome.error.message, context).toMatch(/^this MCP request already sent all the Google Health requests one request may send: the (entry|delete) was not sent$/);
    return "budget error";
  }
  if (own && outcome.error.hint === OWN_REQUEST_HINT) {
    // The same code and message as the budget error of a call alone.
    expectBudgetError({ ...outcome.error, hint: SHORTER_RANGE_HINT }, context);
    return "budget error";
  }
  if (outcome.error.hint !== SHORTER_RANGE_HINT) return outcome.error.code;
  expectBudgetError(outcome.error, context);
  return "budget error";
}

interface Measured {
  /** The external fetches of each MCP HTTP request, until every call of it succeeds. */
  requests: Counts[];
  /** The result of each tool call of the first request. */
  first: string[];
  /** The hint of each tool call of the first request; null for a call that succeeded. */
  firstHints: (string | null)[];
  /** One more request on the cache the others filled; absent when the case does not succeed. */
  later?: Counts;
}

/** No case that succeeds needs more than two requests; a case that never succeeds stops here. */
const MAX_REQUESTS = 4;

/**
 * Sends the same MCP HTTP request until every tool call of it succeeds, then
 * once more. A request that ends with an error other than the budget error is
 * the last one. No request may pass the limits. `laterResult` is what every
 * call of the request sent once more answers: "ok", or the error code of a
 * call that can happen only once (the delete of an entry).
 */
async function measure(target: DurableObjectStub<CoachStore>, calls: readonly ToolCall[], laterResult = "ok"): Promise<Measured> {
  const one = async (n: number): Promise<{ counts: Counts; results: string[]; hints: (string | null)[] }> => {
    const [single] = calls;
    const alone = calls.length === 1 && single !== undefined;
    const outcomes = alone ? [await objectTool(target, single[0], single[1])] : await batch(target, calls);
    const counts = take();
    expect(counts.health, `request ${n}: Google Health requests`).toBeLessThanOrEqual(HEALTH_REQUESTS);
    expect(counts.health + counts.token, `request ${n}: external fetches`).toBeLessThanOrEqual(MAX_SUBREQUESTS);
    return {
      counts,
      // A call that is alone in its request never names a request of its own.
      results: outcomes.map((outcome) => resultOf(outcome, !alone, `request ${n}`)),
      hints: outcomes.map((outcome) => (outcome.ok ? null : (outcome.error.hint ?? ""))),
    };
  };
  const out: Measured = { requests: [], first: [], firstHints: [] };
  for (let n = 1; n <= MAX_REQUESTS; n++) {
    const { counts, results, hints } = await one(n);
    out.requests.push(counts);
    if (n === 1) [out.first, out.firstHints] = [results, hints];
    if (results.every((result) => result === "ok")) {
      const again = await one(n + 1);
      expect(again.results, "the later request").toEqual(again.results.map(() => laterResult));
      out.later = again.counts;
      return out;
    }
    if (results.some((result) => result !== "ok" && result !== "budget error")) return out;
  }
  return out;
}

/** A marked text in every error body of the fake: it must never reach a log line. */
const BODY_MARK = "synthetic body 7711";
const unauthenticated = () => Response.json({ error: { code: 401, message: BODY_MARK, status: "UNAUTHENTICATED" } }, { status: 401 });
const unavailable = () => Response.json({ error: { code: 503, message: BODY_MARK, status: "UNAVAILABLE" } }, { status: 503 });

/** Google rejects the access token of the first Google Health request, once. */
function rejectFirstRequest(mock: GoogleMock): void {
  let rejected = false;
  mock.healthReply = () => {
    if (rejected) return undefined;
    rejected = true;
    return unauthenticated();
  };
}

/** Google rejects the access token of the first Google Health request, then answers 429 to every request. */
function rejectThenLimit(mock: GoogleMock): void {
  let rejected = false;
  mock.healthReply = () => {
    if (rejected) return Response.json({ error: { code: 429, message: BODY_MARK, status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
    rejected = true;
    return unauthenticated();
  };
}

/** The log lines a tool that reaches Google may write, and their fields. */
const LOG_FIELDS: Record<string, readonly string[]> = {
  tool_call: ["tool", "duration_ms", "is_error", "code"],
  "google health request failed; retrying": ["data_type", "http_status", "retry", "wait_ms"],
  "google health token rejected; renewing": ["data_type", "http_status"],
};
/** The text a log field may hold: a tool name, a data type or an error code. */
const LOG_TEXT = new Set<string>([...ALL_TOOL_NAMES, ...DATA_TYPES, "invalid_input", "upstream_unavailable", "no_data"]);

/** The entry of the write cases. Every number has a fraction that no status or count has. */
const FOOD = { name: "Feijoada completa", meal_type: "LUNCH", kcal: 431.5, protein_g: 23.75, carbs_g: 51.25, fat_g: 17.5 };
const ADD: ToolCall = ["nutrition_log_add", FOOD];
/** The name of the n-th entry the fake API creates. */
const createdName = (n: number) => `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-created-${n}`;
const DELETE: ToolCall = ["nutrition_log_delete", { entry_id: createdName(1) }];
/** The session of the exercise log cases: an activity that is not in the tool's list. */
const LOG_SESSION: ToolCall = ["exercise_log_add", { exercise_type: "Capoeira angola", start_time: "07:10", duration_min: 75, kcal: 431.5, notes: "Roda de sexta" }];
const DELETE_SESSION: ToolCall = ["exercise_log_delete", { entry_id: `users/${FAKE_USER_ID}/dataTypes/exercise/dataPoints/syn-created-1` }];
/** Nothing of a write: no part of the entry, no entry id, no part of Google's answer. */
const WRITE_SECRETS = ["Feijoada", "431.5", "23.75", "51.25", "17.5", "syn-created", FAKE_USER_ID, FAKE_CLIENT_ID, "Item ", "Capoeira", "Roda de sexta"];

/** No health value, name, token or response body in a log line: only names, counts and statuses. */
function expectCleanLogs(): void {
  for (const level of LEVELS) {
    for (const [message, fields, ...rest] of g.logLines(level) as [string, Record<string, unknown>, ...unknown[]][]) {
      expect(Object.keys(LOG_FIELDS), `${level}: ${message}`).toContain(message);
      expect(rest).toEqual([]);
      for (const [key, value] of Object.entries(fields)) {
        expect(LOG_FIELDS[message], `${message}.${key}`).toContain(key);
        if (typeof value === "string") expect([...LOG_TEXT], `${message}.${key}`).toContain(value);
        else expect(["number", "boolean"], `${message}.${key}`).toContain(typeof value);
      }
    }
  }
  const text = g.logged();
  for (const secret of [STORED_TOKEN, RENEWED_TOKEN, GOOGLE_REFRESH_TOKEN, "at-renewed", "at-signin", "fake-refresh", BODY_MARK, FOOD_NAME, "Synthetic Band", "Synthetic Scale", ...WRITE_SECRETS]) {
    expect(text).not.toContain(secret);
  }
}

const YEAR = { from: day(-365), to: day(0), granularity: "week" };
const series = (metric: string): ToolCall => ["metric_series", { metric, ...YEAR }];

interface Case {
  tool: string;
  input: string;
  year?: YearOptions;
  /** Every list of the band's steps comes back in two pages. */
  twoPageSteps?: boolean;
  link?: Partial<GoogleLink>;
  /** A kcal target in force on every day. */
  kcalTarget?: boolean;
  arrange?: (mock: GoogleMock, stub: DurableObjectStub<CoachStore>) => void | Promise<void>;
  /** A write case reads nothing: the fake API starts without the year of data. */
  empty?: boolean;
  /** Tool calls sent before the measurement, each in a request of its own. They are not counted. */
  before?: ToolCall[];
  /** What each call answers when the request is sent once more. Default: "ok". */
  laterResult?: string;
  calls: ToolCall[];
  /** Google Health requests of each MCP HTTP request, until every call of it succeeds. */
  health: number[];
  /** Token endpoint requests of each of them. Default: none. */
  token?: number[];
  /** The result of the first request: "ok", "budget error" or an error code. Default: "ok". */
  first?: string;
  /** Google Health requests of one more request on the filled cache; null when the case never succeeds. */
  later: number | null;
  /** The waits between retries that the client asks for. Default: none. */
  waits?: number;
  /**
   * The hint of each tool call of the first request, null for a call that
   * succeeded. Default: every budget error has the Go hint, as a call alone
   * in its request has.
   */
  hints?: (string | null)[];
}

const EXPIRED: Partial<GoogleLink> = { accessTokenExpiresAt: 0 };
const BRIEFING: ToolCall = ["morning_briefing", { date: day(-2) }];
// By `date` the review lists heart rate once per session: its worst case.
const WORKOUT: ToolCall = ["workout_review", { date: HEAVY_DAY }];
const WORKOUT_BY_ID: ToolCall = ["workout_review", { exercise_id: HEAVY_ID }];
const WEEK_BEFORE: ToolCall = ["weekly_report", { week_end: day(-7) }];
const DENSE: YearOptions = { dense: true };
const HARD: Pick<Case, "year" | "twoPageSteps"> = { year: { offWrist: true }, twoPageSteps: true };
const BUDGET = "budget error";

const CASES: Case[] = [
  // Each tool alone, with its worst-case input, on the year of data.
  { tool: "`morning_briefing`", input: "the day after a day without a zone-minutes row", calls: [BRIEFING], health: [9], later: 5 },
  { tool: "`workout_review`", input: "`date` of a day with 33 sessions", calls: [WORKOUT], health: [39], later: 35 },
  { tool: "`workout_review`", input: "`exercise_id` of the newest session of that day", calls: [WORKOUT_BY_ID], health: [12], later: 8 },
  { tool: "`nutrition_day`", input: "a settled day without a zone-minutes row", calls: [["nutrition_day", { date: day(-3) }]], health: [5], later: 1 },
  { tool: "`weekly_report`", input: "the current week, no kcal target", calls: [["weekly_report", {}]], health: [13], later: 11 },
  { tool: "`weekly_report`", input: "the week before, no kcal target", calls: [WEEK_BEFORE], health: [14], later: 4 },
  { tool: "`metric_series`", input: "`weight`, 366 days by week", calls: [series("weight")], health: [1], later: 1 },
  { tool: "`metric_series`", input: "`vo2_max`, 366 days by week", calls: [series("vo2_max")], health: [1], later: 1 },
  { tool: "`metric_series`", input: "`resting_hr`, 366 days by week", calls: [series("resting_hr")], health: [1], later: 1 },
  { tool: "`metric_series`", input: "`hrv`, 366 days by week", calls: [series("hrv")], health: [29], later: 2 },
  { tool: "`metric_series`", input: "`sleep_asleep_min`, 366 days by week", calls: [series("sleep_asleep_min")], health: [29], later: 2 },
  { tool: "`metric_series`", input: "`steps`, 366 days by week", calls: [series("steps")], health: [5], later: 5 },
  { tool: "`metric_series`", input: "`azm`, 366 days by week", calls: [series("azm")], health: [18], later: 1 },
  { tool: "`metric_series`", input: "`total_calories`, 366 days by week", calls: [series("total_calories")], health: [45], later: 2 },
  { tool: "`metric_series`", input: "`kcal_in`, 366 days by week, no kcal target", calls: [series("kcal_in")], health: [45, 3], first: BUDGET, later: 3 },
  { tool: "`metric_series`", input: "`protein_g`, 366 days by week, no kcal target", calls: [series("protein_g")], health: [45, 3], first: BUDGET, later: 3 },
  { tool: "`metric_series`", input: "`kcal_in`, 366 days by week, a kcal target on every day", kcalTarget: true, calls: [series("kcal_in")], health: [1], later: 1 },
  // The dense account, for the tools that read nights.
  { tool: "`morning_briefing`", input: "dense account, the same day", year: DENSE, calls: [BRIEFING], health: [10], later: 5 },
  { tool: "`workout_review`", input: "dense account, the same `date`", year: DENSE, calls: [WORKOUT], health: [40], later: 35 },
  { tool: "`weekly_report`", input: "dense account, the week before", year: DENSE, calls: [WEEK_BEFORE], health: [16], later: 4 },
  { tool: "`metric_series`", input: "dense account, `hrv`, 366 days by week", year: DENSE, calls: [series("hrv")], health: [45], later: 2 },
  { tool: "`metric_series`", input: "dense account, `sleep_asleep_min`, 366 days by week", year: DENSE, calls: [series("sleep_asleep_min")], health: [45], later: 2 },
  // A day off the wrist in every week, and two pages in every list of the band's steps.
  { tool: "`metric_series`", input: "off-wrist days and two-page steps lists, `azm`, 366 days", ...HARD, calls: [series("azm")], health: [31], later: 29 },
  { tool: "`metric_series`", input: "off-wrist days and two-page steps lists, `total_calories`, 366 days", ...HARD, calls: [series("total_calories")], health: [45, 42], first: BUDGET, later: 30 },
  { tool: "`metric_series`", input: "off-wrist days and two-page steps lists, `kcal_in`, 366 days, no kcal target", ...HARD, calls: [series("kcal_in")], health: [45, 44], first: BUDGET, later: 31 },
  // The access token. `total_calories` over 366 days needs the whole budget.
  { tool: "`metric_series`", input: "`total_calories`, 366 days; the access token is renewed first", link: EXPIRED, calls: [series("total_calories")], health: [45], token: [1], later: 2 },
  {
    tool: "`metric_series`",
    input: "`total_calories`, 366 days; Google rejects the token once",
    arrange: rejectFirstRequest,
    calls: [series("total_calories")],
    health: [45, 2],
    token: [1, 0],
    first: BUDGET,
    later: 2,
  },
  {
    tool: "`metric_series`",
    input: "`total_calories`, 366 days; the token is renewed first, and Google rejects the new one once",
    link: EXPIRED,
    arrange: rejectFirstRequest,
    calls: [series("total_calories")],
    health: [45, 2],
    token: [2, 0],
    first: BUDGET,
    later: 2,
  },
  {
    tool: "`metric_series`",
    input: "the case above, and a new sign-in replaces the link during each renewal",
    link: EXPIRED,
    arrange: (mock, stub) => {
      rejectFirstRequest(mock);
      const id = stub.id.toString();
      let asked = 0;
      mock.tokenReply = async () => {
        asked++;
        // The first renewal of each ask loses to a sign-in whose own access
        // token is already expired. The mock runs inside the object, so it
        // reaches the store through a stub of its own.
        if (asked === 1 || asked === 3) {
          const self = env.COACH_STORE.get(env.COACH_STORE.idFromString(id));
          await self.linkGoogleAccount(link({ refreshToken: `fake-refresh-${asked}`, accessToken: `at-signin-${asked}`, accessTokenExpiresAt: 0 }));
        }
        return newToken(`at-renewed-${asked}`);
      };
    },
    calls: [series("total_calories")],
    health: [45, 2],
    token: [4, 0],
    first: BUDGET,
    later: 2,
  },
  // Google Health answers 503.
  {
    tool: "`morning_briefing`",
    input: "Google Health answers 503 to every request",
    arrange: (mock) => {
      mock.healthReply = unavailable;
    },
    calls: [BRIEFING],
    health: [4],
    first: "upstream_unavailable",
    later: null,
    // 4 attempts of the first request.
    waits: 3,
  },
  {
    tool: "`metric_series`",
    input: "`total_calories`, 366 days; Google Health answers 503 three times before each answer",
    arrange: (mock) => {
      const failures = new Map<string, number>();
      mock.healthReply = (request) => {
        const key = `${request.method} ${request.url}`;
        const seen = failures.get(key) ?? 0;
        if (seen === 3) {
          failures.delete(key);
          return undefined;
        }
        failures.set(key, seen + 1);
        return unavailable();
      };
    },
    calls: [series("total_calories")],
    health: [45],
    first: "upstream_unavailable",
    later: null,
    // 11 requests answered at their 4th attempt; the 45th request is the first attempt of the 12th.
    waits: 33,
  },
  // One POST with a JSON array: the five coach tools and google_account_status.
  {
    tool: "the five coach tools and `google_account_status`",
    input: "one POST; today's briefing, a day with one session, a day of food, the current week, 7 days of steps; the access token is renewed first",
    link: EXPIRED,
    calls: [
      ["morning_briefing", {}],
      ["workout_review", { date: day(-2) }],
      ["nutrition_day", { date: day(-2) }],
      ["weekly_report", {}],
      ["metric_series", { metric: "steps", from: day(-6), to: day(0) }],
      ["google_account_status", {}],
    ],
    health: [33],
    token: [1],
    later: 29,
  },
  {
    tool: "the five coach tools and `google_account_status`",
    input: "one POST; the worst-case input of each tool; the access token is renewed first",
    link: EXPIRED,
    calls: [BRIEFING, WORKOUT, ["nutrition_day", { date: day(-3) }], ["weekly_report", {}], series("total_calories"), ["google_account_status", {}]],
    health: [45, 45, 45, 45],
    token: [1, 0, 0, 0],
    // The briefing and the status are answered. The other four calls need more than the budget has left.
    first: `ok, ${BUDGET} ×4, ok`,
    // The briefing took units before each of them started: each one can fit a request of its own.
    hints: [null, OWN_REQUEST_HINT, OWN_REQUEST_HINT, OWN_REQUEST_HINT, OWN_REQUEST_HINT, null],
    later: null,
  },
  // The two tools that write the food log. A later request of an add is one
  // more entry; a later request of a delete finds no entry of its own
  // (no_data) and sends nothing.
  { tool: "`nutrition_log_add`", input: "one entry", empty: true, calls: [ADD], health: [1], later: 1 },
  {
    tool: "`nutrition_log_add`",
    input: "one entry; the access token is renewed first, and Google rejects the new one once",
    empty: true,
    link: EXPIRED,
    arrange: rejectFirstRequest,
    calls: [ADD],
    health: [2],
    token: [2],
    later: 1,
  },
  {
    tool: "`nutrition_log_add`",
    input: "one entry; the token is renewed first, Google rejects the new one once, then answers 429 to every request",
    empty: true,
    link: EXPIRED,
    arrange: rejectThenLimit,
    calls: [ADD],
    // The rejected request, then 4 attempts that Google answers with 429.
    health: [5],
    token: [2],
    first: "upstream_unavailable",
    later: null,
    waits: 3,
  },
  { tool: "`nutrition_log_delete`", input: "an entry this server created", empty: true, before: [ADD], calls: [DELETE], health: [1], later: 0, laterResult: "no_data" },
  {
    tool: "`nutrition_log_delete`",
    input: "an entry this server created that Google no longer has (HTTP 404, `NOT_FOUND`)",
    empty: true,
    before: [ADD],
    // Google's own answer for a point that is gone: an answer, so one request and no retry.
    arrange: (mock) => {
      mock.healthReply = () => Response.json({ error: { code: 404, message: BODY_MARK, status: "NOT_FOUND" } }, { status: 404 });
    },
    calls: [DELETE],
    health: [1],
    later: 0,
    laterResult: "no_data",
  },
  {
    tool: "`nutrition_log_delete`",
    input: "an entry this server created; the access token is renewed first, and Google rejects the new one once",
    empty: true,
    before: [ADD],
    // The access token expires after the add, so the delete renews it first.
    arrange: async (mock, stub) => {
      await stub.linkGoogleAccount(link(EXPIRED));
      rejectFirstRequest(mock);
    },
    calls: [DELETE],
    health: [2],
    token: [2],
    later: 0,
    laterResult: "no_data",
  },
  {
    tool: "`nutrition_log_delete`",
    input: "an entry this server created; the token is renewed first, Google rejects the new one once, then answers 429 to every request",
    empty: true,
    before: [ADD],
    arrange: async (mock, stub) => {
      await stub.linkGoogleAccount(link(EXPIRED));
      rejectThenLimit(mock);
    },
    calls: [DELETE],
    // The rejected request, then 4 attempts that Google answers with 429.
    health: [5],
    token: [2],
    first: "upstream_unavailable",
    later: null,
    waits: 3,
  },
  // A day is one batchDelete of the entries this server created, whatever the count. A later request finds none.
  {
    tool: "`nutrition_log_delete`",
    input: "the entries this server created on one day",
    empty: true,
    before: [ADD, ADD, ADD],
    calls: [["nutrition_log_delete", { date: day(0) }]],
    health: [1],
    later: 0,
    laterResult: "no_data",
  },
  {
    tool: "`nutrition_log_add`, 100 calls",
    input: "one POST with 100 entries; the access token is renewed first",
    empty: true,
    link: EXPIRED,
    calls: Array.from({ length: 100 }, (_unused, n): ToolCall => ["nutrition_log_add", { name: `Item ${n + 1}`, meal_type: "SNACK", kcal: 100.5 + n }]),
    // Each POST creates 45 entries and reports each one; the other 55 calls are not sent.
    health: [45, 45, 45, 45],
    token: [1, 0, 0, 0],
    first: `ok ×45, ${BUDGET} ×55`,
    hints: [...Array.from({ length: 45 }, () => null), ...Array.from({ length: 55 }, () => WRITE_OWN_REQUEST_HINT)],
    later: null,
  },
  // The two tools that write the exercise log: the counts of the food log
  // tools. A later request of an add is one more session; a later request of
  // a delete finds no session of its own (no_data) and sends nothing.
  { tool: "`exercise_log_add`", input: "one session", empty: true, calls: [LOG_SESSION], health: [1], later: 1 },
  {
    tool: "`exercise_log_add`",
    input: "one session; the access token is renewed first, and Google rejects the new one once",
    empty: true,
    link: EXPIRED,
    arrange: rejectFirstRequest,
    calls: [LOG_SESSION],
    health: [2],
    token: [2],
    later: 1,
  },
  {
    tool: "`exercise_log_add`",
    input: "one session; the token is renewed first, Google rejects the new one once, then answers 429 to every request",
    empty: true,
    link: EXPIRED,
    arrange: rejectThenLimit,
    calls: [LOG_SESSION],
    // The rejected request, then 4 attempts that Google answers with 429.
    health: [5],
    token: [2],
    first: "upstream_unavailable",
    later: null,
    waits: 3,
  },
  { tool: "`exercise_log_delete`", input: "a session this server created", empty: true, before: [LOG_SESSION], calls: [DELETE_SESSION], health: [1], later: 0, laterResult: "no_data" },
  {
    tool: "`exercise_log_delete`",
    input: "a session this server created; the token is renewed first, Google rejects the new one once, then answers 429 to every request",
    empty: true,
    before: [LOG_SESSION],
    arrange: async (mock, stub) => {
      await stub.linkGoogleAccount(link(EXPIRED));
      rejectThenLimit(mock);
    },
    calls: [DELETE_SESSION],
    // The rejected request, then 4 attempts that Google answers with 429.
    health: [5],
    token: [2],
    first: "upstream_unavailable",
    later: null,
    waits: 3,
  },
  // A day is one batchDelete of the sessions this server created. A later request finds none.
  {
    tool: "`exercise_log_delete`",
    input: "the sessions this server created on one day",
    empty: true,
    before: [LOG_SESSION, LOG_SESSION],
    calls: [["exercise_log_delete", { date: day(0) }]],
    health: [1],
    later: 0,
    laterResult: "no_data",
  },
];

type Row = Required<Pick<Case, "tool" | "input" | "health" | "token" | "first" | "later">>;

const rowOf = (one: Case): Row => ({
  tool: one.tool,
  input: one.input,
  health: one.health,
  token: one.token ?? one.health.map(() => 0),
  first: one.first ?? "ok",
  later: one.later,
});

/** "ok, budget error ×4, ok" for the results of a batch; one word for a single call. */
function resultsText(results: readonly string[]): string {
  const runs: [string, number][] = [];
  for (const result of results) {
    const last = runs.at(-1);
    if (last && last[0] === result) last[1]++;
    else runs.push([result, 1]);
  }
  // Every call with the same result: one word.
  if (runs.length === 1) return results[0] ?? "";
  return runs.map(([result, count]) => (count === 1 ? result : `${result} ×${count}`)).join(", ");
}

const measuredRow = (one: Case, m: Measured): Row => ({
  tool: one.tool,
  input: one.input,
  health: m.requests.map((counts) => counts.health),
  token: m.requests.map((counts) => counts.token),
  first: resultsText(m.first),
  later: m.later?.health ?? null,
});

/** The table of the README and of the PR body. */
function render(rows: readonly Row[]): string {
  const lines = [
    "| Tool | Input | Google Health requests | Token requests | Total | Outcome of request 1 | Requests until success | A later request |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const totals = row.health.map((health, n) => health + (row.token[n] ?? 0));
    const cells = [
      row.tool,
      row.input,
      row.health.join(", "),
      row.token.join(", "),
      totals.join(", "),
      row.first,
      row.later === null ? "none" : String(row.health.length),
      row.later === null ? "—" : String(row.later),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** The most external fetches of one MCP HTTP request in the table. */
const highest = (rows: readonly Row[]) => Math.max(...rows.flatMap((row) => row.health.map((health, n) => health + (row.token[n] ?? 0))));

const measured = new Map<Case, Measured>();

afterAll(() => {
  // The mocks are restored here, so this line reaches the test output.
  const rows = CASES.flatMap((one) => {
    const m = measured.get(one);
    return m ? [measuredRow(one, m)] : [];
  });
  if (rows.length === 0) return;
  // Request 1 of each case by kind of fetch, for the reader of the run.
  const kinds = CASES.flatMap((one) => {
    const first = measured.get(one)?.requests[0];
    if (!first) return [];
    const parts = Object.entries(first.kinds).map(([kind, count]) => `${kind} ${count}`);
    return [`- ${one.tool}, ${one.input}: ${parts.join(", ")}`];
  });
  console.log(
    `\nMeasured external fetches of one MCP HTTP request (Workers Free limit: ${MAX_SUBREQUESTS}). Highest: ${highest(rows)}.\n\n${render(rows)}\n\nRequest 1 of each case, by kind:\n${kinds.join("\n")}\n`,
  );
});

describe("the external fetches of one MCP HTTP request", () => {
  it.each(CASES)("$tool, $input", async (one) => {
    if (!one.empty) yearOfData(g.google, one.year);
    if (one.twoPageSteps) g.google.twoPages.add("steps");
    const stub = await linkedStore(one.link);
    if (one.kcalTarget) expect((await objectTool(stub, "targets_set", { effective_from: day(-400), kcal: 2200 })).ok).toBe(true);
    for (const [name, args] of one.before ?? []) expect((await objectTool(stub, name, args)).ok, `before: ${name}`).toBe(true);
    take();
    const waited = skipRetryWaits(g);
    await one.arrange?.(g, stub);
    g.clearLogs();

    const m = await measure(stub, one.calls, one.laterResult);
    measured.set(one, m);
    expect(measuredRow(one, m)).toEqual(rowOf(one));
    expect(m.firstHints).toEqual(one.hints ?? m.first.map((result) => (result === "ok" ? null : result === BUDGET ? SHORTER_RANGE_HINT : expect.any(String))));

    // The client waits 1, 2 and 4 seconds (with jitter, each at least half) between the attempts of a request.
    expect(waited).toHaveLength(one.waits ?? 0);
    for (const ms of waited) expect(ms >= 500 && ms <= 4000, `a wait of ${ms} ms`).toBe(true);
    expectCleanLogs();
  });

  // The budget error says "use a shorter date range". In a batch that hint
  // misleads a call that found the budget already taken by the calls before
  // it: the same call can fit a request of its own.
  it("names a request of its own in the hint of the budget error only after another call took units", async () => {
    yearOfData(g.google);
    const budgetError = (type: string, hint: string) => ({
      ok: false,
      error: { code: "invalid_input", message: `the date range holds more ${type} data than one call reads`, hint },
    });

    // A call alone in its request: the Go hint.
    const alone = await objectTool(await linkedStore(), ...series("kcal_in"));
    expect(alone).toEqual(budgetError("total-calories", SHORTER_RANGE_HINT));
    expect(take().health).toBe(HEALTH_REQUESTS);

    // In a batch: two calls that take no unit, then the first call that takes
    // units keeps the Go hint. The call after it finds no unit left.
    const [status, profile, first, starved, later] = await batch(await linkedStore(), [
      ["google_account_status", {}],
      ["profile_get", {}],
      series("kcal_in"),
      series("weight"),
      ["google_account_status", {}],
    ]);
    expect([status?.ok, profile?.ok, later?.ok]).toEqual([true, true, true]);
    expect(first).toEqual(budgetError("total-calories", SHORTER_RANGE_HINT));
    expect(starved).toEqual(budgetError("weight", OWN_REQUEST_HINT));
    expect(OWN_REQUEST_HINT).toBe("use a shorter date range, or send this call in a request of its own");
    expect(take().health).toBe(HEALTH_REQUESTS);

    // The starved call, in a request of its own, needs one request.
    const own = await objectTool(await linkedStore(), ...series("weight"));
    expect(own.ok).toBe(true);
    expect(take().health).toBe(1);
    expectCleanLogs();
  });

  // A create is not idempotent, so the budget must never leave an entry in
  // Google that the request did not report with its id.
  it("stops a POST of 100 adds at the budget: 45 entries are created and reported, and no other entry is sent", async () => {
    const calls = Array.from({ length: 100 }, (_unused, n): ToolCall => ["nutrition_log_add", { name: `Item ${n + 1}`, meal_type: "SNACK", kcal: 100.5 + n }]);
    const stub = await linkedStore(EXPIRED);
    const idsOf = (points: { name: string }[]) => points.map((point) => pointId(point.name));
    const names = () => g.google.writes.map((write) => write.body.nutritionLog.foodDisplayName as string);

    const outcomes = await batch(stub, calls);
    expect(take()).toMatchObject({ health: HEALTH_REQUESTS, token: 1, kinds: { "create nutrition-log": HEALTH_REQUESTS, token: 1 } });
    // The first 45 calls, in the order of the POST, each with the id of its own entry.
    const reported = outcomes.slice(0, HEALTH_REQUESTS).map((outcome) => (outcome.ok ? (outcome.output.entry_id as string) : ""));
    expect(reported).toEqual(Array.from({ length: HEALTH_REQUESTS }, (_unused, n) => createdName(n + 1)));
    expect(names()).toEqual(Array.from({ length: HEALTH_REQUESTS }, (_unused, n) => `Item ${n + 1}`));
    // Google holds those 45 entries and no other: every entry that was sent was reported.
    expect(idsOf(g.google.createdPoints() as { name: string }[])).toEqual(reported.map((name) => pointId(name)));
    // Each of the other 55 calls answers that it was not sent, with the same error.
    for (const [n, outcome] of outcomes.slice(HEALTH_REQUESTS).entries()) {
      expect(outcome, `call ${HEALTH_REQUESTS + n + 1}`).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "this MCP request already sent all the Google Health requests one request may send: the entry was not sent",
          hint: "send this call in a request of its own",
        },
      });
    }

    // The client sends the calls that were not sent again, and only those: 45 more, then the last 10.
    const second = await batch(stub, calls.slice(45));
    expect(second.map((outcome) => outcome.ok)).toEqual([...Array.from({ length: 45 }, () => true), ...Array.from({ length: 10 }, () => false)]);
    const third = await batch(stub, calls.slice(90));
    expect(third.every((outcome) => outcome.ok)).toBe(true);
    expect(take()).toMatchObject({ health: 55, token: 0 });
    // Each of the 100 entries exists once.
    expect(names()).toEqual(Array.from({ length: 100 }, (_unused, n) => `Item ${n + 1}`));
    expect(g.google.createdPoints()).toHaveLength(100);
    expectCleanLogs();
  });

  it("never pass the limit of the plan, and the README holds the same table", () => {
    const rows = CASES.map(rowOf);
    // 45 Google Health requests and 4 token requests: the bound of the design.
    expect(highest(rows)).toBe(49);
    expect(highest(rows)).toBeLessThanOrEqual(MAX_SUBREQUESTS);
    expect(Math.max(...rows.flatMap((row) => row.health))).toBe(HEALTH_REQUESTS);
    // Every case that succeeds does so in at most two requests.
    for (const row of rows) if (row.later !== null) expect(row.health.length, `${row.tool}, ${row.input}`).toBeLessThanOrEqual(2);
    expect(README).toContain(render(rows));
    expect(README).toContain(`The highest count is **${highest(rows)} external fetches** in one MCP HTTP request`);
  });
});
