// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Adapted from google-health-cli pkg/client/client.go (Do, isStaleScopeError,
// parseRetryAfter) and cmd/data.go (list and rollup pagination). Changes: read operations and
// four writes only (the create and the delete of a food log entry and of a
// workout session), behind a method and path allowlist; a
// create that is never sent again when its outcome is unknown; waits with
// jitter and a cap on Retry-After; one token renewal shared by 401 and the
// stale-token 403; errors carry the HTTP status and Google's status enum. A
// read never keeps the response body. A write refusal also keeps Google's
// error.message, cut to about 200 characters, and the reason of any ErrorInfo,
// so the model can explain the refusal. Tokens, email addresses, user
// identifiers and the request body are never kept, and neither is a text of
// an exercise write that Google's message repeats; responses are read through
// a size limit; a page cap or a repeated page token is
// an error instead of a truncated result; a request budget shared by the calls
// of one MCP request; each record reduced by the caller as its page is read;
// and a port from Go to TypeScript.

// A client for the Google Health API v4. It reads data points, and it writes
// two data types: the food log (nutrition-log) and the exercise log
// (exercise). For each it creates one data point, and it deletes data points
// of that type by name. No other write can leave it.

import type { LocalDate, Zone } from "../coach/date";
import { ToolError, errorTypes } from "../coach/errors";
import { truncate } from "../coach/text";
import { OAUTH_CLIENT_HINT, RECONNECT_HINT, WRITE_SCOPES, type WriteDataType, scopeName } from "../google";
import type { RequestBudget } from "./budget";
import { type DataType, type TypeInfo, filter, lookup, rollupChunks, windowFilter } from "./datatypes";
import {
  CREATE_PATH as EXERCISE_CREATE_PATH,
  DELETE_PATH as EXERCISE_DELETE_PATH,
  type NewExerciseSession,
  callerTexts as exerciseCallerTexts,
  createBody as exerciseCreateBody,
  deleteBody as exerciseDeleteBody,
  pointId as exercisePointId,
} from "./exerciselog";
import {
  type AnswerFault,
  CREATE_PATH,
  DELETE_PATH,
  MAX_WRITE_RESPONSE_BYTES,
  type NewFoodEntry,
  createBody,
  deleteBody,
  pointId,
  readCreateAnswer,
  readDeleteAnswer,
} from "./nutritionlog";
import { PageSyntaxError, type PageScan, scanPage } from "./page";

/** The Google Health API v4 endpoint. */
export const DEFAULT_BASE_URL = "https://health.googleapis.com/v4";

/**
 * Bounds the requests of one call that keeps failing with 429, 5xx or a
 * network error: the first try plus three retries.
 */
export const MAX_ATTEMPTS = 4;

/** Doubles on each retry: 1 s, 2 s, 4 s. */
export const FIRST_BACKOFF_MS = 1000;

/**
 * The longest server-requested wait honored; a longer one fails the call
 * instead of stalling a tool call for minutes.
 */
export const MAX_RETRY_AFTER_MS = 8000;

/** Bounds pagination against a server that never stops returning a next page token. */
export const DEFAULT_MAX_PAGES = 200;

/** Bounds one HTTP attempt, the read of its body included. A timeout is retried like a network error. */
export const REQUEST_TIMEOUT_MS = 30_000;

// Memory. A Workers isolate has 128 MB for everything, so the Go limits
// (32 MiB per response, 64 MiB per call) are too high here.
//
// One response is held twice for a moment: as bytes, and as text. The text
// takes one byte per character while the JSON holds only Latin-1 characters
// and two when it holds any other, so a response of n bytes needs at most
// n + 2n. The page is then read record by record (page.ts): it is never one
// parsed object tree. One record is parsed at a time, and only when its text
// is at most 1 MiB (MAX_RECORD_CHARS); a top-level field other than the list
// and the page token is never parsed. What a call keeps from the pages already
// read is what the caller's mapper returned. A mapper that keeps a whole
// record keeps about the size of its text, so a call that read b bytes keeps
// at most about b.
//
// Peak of a call, at its last page of n bytes: (MAX_CALL_BYTES − n) kept +
// 3n in flight ≤ MAX_CALL_BYTES + 2 × MAX_RESPONSE_BYTES = 32 + 32 = 64 MiB.
// That leaves 64 MiB for the code, the store, the tool result and the
// garbage the collector has not freed yet (the chunks a body arrived in).
//
// The peak is that of one MCP HTTP request: its calls run one after the
// other (the turn queue of CoachStore). Two MCP HTTP requests at the same
// time are not ordered, and their peaks add up.
//
// 16 MiB still holds a full page of the largest type: 10000 heart-rate
// samples at up to 1.6 kB each.

/** Bounds one response body. */
export const MAX_RESPONSE_BYTES = 16 << 20;

/** Bounds the responses of one call across all its pages and chunks. */
export const MAX_CALL_BYTES = 32 << 20;

/**
 * What CoachStore.googleAccessToken() answers. `sub` is the Google account
 * the token belongs to. A source that does not know it leaves it out, and a
 * write that is bound to an account is then never sent.
 */
export type TokenResult =
  | { ok: true; accessToken: string; sub?: string }
  | { ok: false; code: "auth_expired" | "upstream_unavailable" | "internal_error" | "not_linked" };

/**
 * The Google account (its `sub`) a write is bound to: the one whose entries
 * the tool checked before the write. Undefined when the store held no link
 * then. A request with a bound goes out only with a token of that account.
 */
interface AccountBound {
  account: string | undefined;
}

/**
 * Supplies access tokens. `invalidate` reports a token the API rejected, so
 * the next `accessToken` call renews it, and says whether it did: a token
 * already replaced is left alone (CoachStore.invalidateGoogleAccessToken).
 */
export interface TokenSource {
  accessToken(): Promise<TokenResult>;
  invalidate(rejected: string): boolean | Promise<boolean>;
}

/**
 * Maps a raw record to the value the caller keeps; undefined drops the record.
 * The raw page is gone when the next page is read, so keep only what is needed.
 *
 * A mapper sees a record before the rest of its page is checked, and its
 * results are dropped when the page then fails a check. So it must not throw
 * for a record it cannot read: an error of the mapper ends the call as it is.
 */
export type Reduce<T> = (record: unknown) => T | undefined;

export interface ClientOptions {
  tokens: TokenSource;
  /** Local days become UTC instants in this zone for physical-time filters. */
  zone: Zone;
  /** Created once per MCP request by the caller; every call of that request shares it. */
  budget: RequestBudget;
  /** Default DEFAULT_BASE_URL. */
  baseUrl?: string;
  // Replaceable so tests run the retry loop without real time.
  wait?: (ms: number) => Promise<void>;
  jitter?: (ms: number) => number;
  now?: () => number;
  // Lower limits, for tests.
  timeoutMs?: number;
  maxPages?: number;
  maxResponseBytes?: number;
  maxCallBytes?: number;
}

/**
 * A non-2xx answer: the HTTP status and Google's status enum (e.g.
 * PERMISSION_DENIED). The response body is never kept, since it may quote
 * request data.
 */
export class StatusError extends Error {
  constructor(
    readonly httpStatus: number,
    /** "" when the body has no enum-shaped status. */
    readonly status: string,
  ) {
    super(status === "" ? `Google Health API returned HTTP ${httpStatus}` : `Google Health API returned HTTP ${httpStatus} (${status})`);
    this.name = "StatusError";
  }
}

/**
 * A request that did not complete. It keeps only the type names of the cause:
 * the text of a fetch error can quote the request URL (dates, a page token).
 */
export class NetworkError extends Error {
  constructor(readonly causeTypes: string) {
    super("the request did not complete");
    this.name = "NetworkError";
  }
}

/** Not retried: the same range returns the same size again. */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`response larger than ${limit} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

interface Reply {
  status: number;
  retryAfter: string | null;
  text: string;
  bytes: number;
}

/** Reads data points and writes the food log and the exercise log. One instance serves the calls of one MCP request, one after the other. */
export class GoogleHealthClient {
  private readonly base: string;
  private readonly tokens: TokenSource;
  private readonly zone: Zone;
  private readonly budget: RequestBudget;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly jitter: (ms: number) => number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxResponseBytes: number;
  private readonly maxCallBytes: number;

  /** Makes no request and reads no stored row. */
  constructor(options: ClientOptions) {
    if (!options.tokens) throw new Error("googlehealth: no token source");
    if (!options.zone) throw new Error("googlehealth: no time zone");
    if (!options.budget) throw new Error("googlehealth: no request budget");
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    checkBaseUrl(base);
    this.base = base.endsWith("/") ? base.slice(0, -1) : base;
    this.tokens = options.tokens;
    this.zone = options.zone;
    this.budget = options.budget;
    this.wait = options.wait ?? sleep;
    this.jitter = options.jitter ?? equalJitter;
    this.now = options.now ?? Date.now;
    this.timeoutMs = lowered("timeoutMs", options.timeoutMs, REQUEST_TIMEOUT_MS);
    this.maxPages = lowered("maxPages", options.maxPages, DEFAULT_MAX_PAGES);
    this.maxResponseBytes = lowered("maxResponseBytes", options.maxResponseBytes, MAX_RESPONSE_BYTES);
    this.maxCallBytes = lowered("maxCallBytes", options.maxCallBytes, MAX_CALL_BYTES);
  }

  /** The data points of the local days [from, to], each one reduced by `reduce`. */
  async list<T>(dataType: DataType, from: LocalDate, to: LocalDate, reduce: Reduce<T>): Promise<T[]> {
    const info = lookup(dataType, "list");
    return this.pages(dataType, info, "/dataPoints", filter(info, from, to, this.zone), reduce);
  }

  /**
   * The data points of [from, to] with overlapping sources merged by the API
   * (steps from the watch and the phone counted once).
   */
  async reconcile<T>(dataType: DataType, from: LocalDate, to: LocalDate, reduce: Reduce<T>): Promise<T[]> {
    const info = lookup(dataType, "reconcile");
    return this.pages(dataType, info, "/dataPoints:reconcile", filter(info, from, to, this.zone), reduce);
  }

  /**
   * The data points of a physical-time type (heart rate, HRV, weight) sampled
   * in [start, end), at most a day: for a workout's window, without listing
   * the whole day.
   */
  async listBetween<T>(dataType: DataType, start: Date, end: Date, reduce: Reduce<T>): Promise<T[]> {
    const info = lookup(dataType, "list");
    return this.pages(dataType, info, "/dataPoints", windowFilter(dataType, info, start, end), reduce);
  }

  /**
   * One aggregate per local day of [from, to]. Ranges longer than the API
   * allows per request are split and merged in order.
   */
  async dailyRollup<T>(dataType: DataType, from: LocalDate, to: LocalDate, reduce: Reduce<T>): Promise<T[]> {
    const info = lookup(dataType, "dailyRollup");
    const chunks = rollupChunks(info, from, to);
    const path = `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
    const out: T[] = [];
    const call = { bytes: 0 };
    for (const chunk of chunks) {
      await this.collect(dataType, "rollupDataPoints", reduce, call, out, (token) =>
        this.request("POST", path, undefined, JSON.stringify(token === "" ? chunk : { ...chunk, pageToken: token })),
      );
    }
    return out;
  }

  /**
   * Creates one nutrition-log data point and returns the name Google gave it.
   *
   * A create is not idempotent. It is sent again only after an answer that
   * proves Google did not accept it (HTTP 429, a quota 403, or the one token
   * renewal). When the outcome is unknown, the error says that the entry may
   * exist. A name is returned only when Google's answer holds one: none is
   * ever made up.
   */
  async createNutritionLog(entry: NewFoodEntry): Promise<string> {
    return this.create("nutrition-log", CREATE_PATH, createBody(entry), pointId);
  }

  /**
   * Deletes the nutrition-log data point with this ID. "gone": Google has no
   * such point, which is the state a delete asks for. Only an HTTP 404 whose
   * body is Google's JSON error with the status NOT_FOUND is "gone"; any other
   * 404 is a refused delete, since it does not prove that the point is not
   * there. The caller
   * decides which points may be deleted: Google's documentation does not prove
   * that it refuses the delete of a point another app wrote.
   */
  async deleteNutritionLog(id: string): Promise<"deleted" | "gone"> {
    return this.remove("nutrition-log", DELETE_PATH, deleteBody(id));
  }

  /**
   * Creates one exercise data point (a workout session) and returns the name
   * Google gave it. The rules are the ones of createNutritionLog: it is sent
   * again only after an answer that proves Google did not accept it, and a
   * name is returned only when Google's answer holds the name of an exercise
   * data point.
   *
   * `account` is the Google account the caller will record the session for
   * (undefined when none was linked). The create is sent only with a token of
   * that account: the tool reads the account from the store and the client
   * takes the token on its own, and one MCP HTTP request keeps one token
   * answer, so the two can belong to different accounts after a sign-in.
   */
  async createExercise(session: NewExerciseSession, account: string | undefined): Promise<string> {
    const body = exerciseCreateBody(session);
    // A session carries free text. What Google repeats of it in a refusal is
    // taken out of the message before the message reaches an error or a log.
    return this.create("exercise", EXERCISE_CREATE_PATH, body, exercisePointId, { account }, exerciseCallerTexts(body));
  }

  /**
   * Deletes the exercise data point with this ID. The rules are the ones of
   * deleteNutritionLog: "gone" only for Google's own NOT_FOUND, and the
   * caller decides which points may be deleted.
   *
   * `account` is the Google account whose session the caller checked. The
   * delete is sent only with a token of that account: a data point ID of one
   * account must never be deleted with the token of another.
   */
  async deleteExercise(id: string, account: string): Promise<"deleted" | "gone"> {
    // The ID is an entry id: a refusal that repeats it must not carry it on.
    return this.remove("exercise", EXERCISE_DELETE_PATH, exerciseDeleteBody(id), { account }, [id]);
  }

  /**
   * Sends one create and reads its Operation. `idOf` reads the ID of a data
   * point name of the data type of the request: an answer that names a point
   * of another data type gives no name.
   */
  private async create(
    dataType: WriteDataType,
    path: string,
    body: unknown,
    idOf: (name: string) => string | undefined,
    bound?: AccountBound,
    echoes?: readonly string[],
  ): Promise<string> {
    const reply = await this.request("POST", path, undefined, JSON.stringify(body), bound, echoes);
    const answer = readCreateAnswer(reply.text, idOf);
    if (answer.ok) return answer.name;
    logFault(dataType, "create", answer.fault, answer.code);
    throw outcomeUnknown(dataType, CREATE_FAULTS[answer.fault]);
  }

  /** Sends one delete and reads its Operation. */
  private async remove(
    dataType: WriteDataType,
    path: string,
    body: unknown,
    bound?: AccountBound,
    echoes?: readonly string[],
  ): Promise<"deleted" | "gone"> {
    const reply = await this.request("POST", path, undefined, JSON.stringify(body), bound, echoes);
    if (reply.status === 404) return "gone";
    const answer = readDeleteAnswer(reply.text);
    if (answer.ok) return "deleted";
    logFault(dataType, "delete", answer.fault, answer.code);
    throw unavailableFor({ dataType, kind: "delete" }, DELETE_FAULTS[answer.fault]);
  }

  private async pages<T>(dataType: DataType, info: TypeInfo, suffix: string, expression: string, reduce: Reduce<T>): Promise<T[]> {
    const path = `/users/me/dataTypes/${dataType}${suffix}`;
    const out: T[] = [];
    await this.collect(dataType, "dataPoints", reduce, { bytes: 0 }, out, (token) => {
      const query = new URLSearchParams({ filter: expression, pageSize: String(info.pageSize) });
      if (token !== "") query.set("pageToken", token);
      return this.request("GET", path, query.toString());
    });
    return out;
  }

  /**
   * Follows next page tokens and adds the reduced items under `key` to `out`.
   * A page is checked whole before its items count, and its text is dropped
   * before the next page is read.
   */
  private async collect<T>(
    dataType: DataType,
    key: string,
    reduce: Reduce<T>,
    call: { bytes: number },
    out: T[],
    fetchPage: (token: string) => Promise<Reply>,
  ): Promise<void> {
    const seen = new Set<string>();
    let token = "";
    for (let page = 0; page < this.maxPages; page++) {
      const reply = await fetchPage(token);
      call.bytes += reply.bytes;
      if (call.bytes > this.maxCallBytes) throw tooMuch(dataType);
      const kept: T[] = [];
      let scan: PageScan;
      try {
        scan = scanPage(reply.text, key, (record) => {
          const value = reduce(record);
          if (value !== undefined) kept.push(value);
        });
      } catch (error) {
        if (error instanceof PageSyntaxError) throw badResponse(dataType);
        throw error;
      }
      // The API omits an empty list, so a page without the list key is a page
      // with no points only when nothing else is in it: an error object or a
      // renamed field read as "no data" would hide the problem. With the list
      // present, a new field is logged and tolerated, unless it looks like
      // paging: a renamed page token read as "last page" would silently cut
      // the range short.
      // The page reader hands over the names of those fields, never their
      // values, and refuses a page token that is neither a string nor null.
      const next = scan.nextPageToken ?? "";
      for (const name of scan.fields) {
        if (!scan.hasList || pagingField(name)) {
          console.warn("google health response has an unexpected field", {
            data_type: dataType,
            field: name.slice(0, 40),
            has_list: scan.hasList,
          });
          throw badResponse(dataType);
        }
        console.warn("google health response has a new field", { data_type: dataType, field: name.slice(0, 40) });
      }
      for (const value of kept) out.push(value);
      if (next === "") return;
      // The same page again would loop until the page cap.
      if (seen.has(next)) throw badResponse(dataType);
      seen.add(next);
      token = next;
    }
    throw tooMuch(dataType);
  }

  /**
   * Sends one logical request: it retries 429, 408, 5xx, a quota 403
   * (RESOURCE_EXHAUSTED) and network errors with backoff, and renews the token
   * once on a 401 or a stale-token 403. Every attempt takes a unit of the
   * request budget before it is sent.
   *
   * The allowlist gives the kind of the request, and the kind gives the retry
   * rules, so a create can never run under the rules of a read. A create is
   * sent again only after an answer that proves Google did not accept it
   * (429, a quota 403, a rejected token). A network error, a timeout, a 408, a
   * 5xx or an answer over the size cap leave its outcome unknown: the call
   * ends there, and its error says that the entry may exist. A delete names
   * the point to remove, so it keeps the rules of a read; a 404 that Google's
   * API answers (NOT_FOUND) comes back to the caller as an answer.
   *
   * With `bound`, every attempt compares the account of the token it is about
   * to send with the account of the bound, also after a renewal: a renewal
   * can answer the token of an account that signed in meanwhile. A request
   * without a bound is not compared.
   *
   * `echoes` are the texts of the request that the caller wrote. A refusal of
   * a write repeats Google's error.message without them.
   */
  protected async request(
    method: string,
    path: string,
    query?: string,
    body?: string,
    bound?: AccountBound,
    echoes: readonly string[] = [],
  ): Promise<Reply> {
    const allowed = requestTarget(method, path, query);
    if (allowed === undefined) throw new Error(`googlehealth: the client refuses ${method} ${path}`);
    // The data type of the request: every log line, message and hint below names this one.
    const { dataType, kind } = allowed;
    const target = query === undefined ? `${this.base}${path}` : `${this.base}${path}?${query}`;
    const limit = kind === "read" ? this.maxResponseBytes : Math.min(this.maxResponseBytes, MAX_WRITE_RESPONSE_BYTES);
    const unavailable = (message: string, cause?: unknown) => unavailableFor(allowed, message, cause);
    let refreshed = false;
    // Whether an attempt of this request was sent.
    let sent = false;
    // Set by every failure that can be retried.
    let last: ToolError | undefined;
    for (let failures = 0; ; ) {
      // Out of budget: a request that kept failing is unavailable, as when the
      // attempts run out; a page or a chunk that was never tried means the
      // range holds more than one call reads; a write that was never tried
      // was not sent, and its error says so.
      if (this.budget.remaining === 0) throw last ?? this.outOfBudget(allowed);
      const held = await this.accessToken();
      const token = held.accessToken;
      // A token of another account, or of an account nobody names, would write
      // to an account the caller did not check. Nothing is sent, and no unit
      // of the budget is taken.
      if (bound !== undefined && (held.sub === undefined || held.sub !== bound.account)) {
        console.warn("google health write not sent: the linked account changed", { data_type: dataType, operation: kind });
        throw accountChanged(kind, sent);
      }
      if (!this.budget.take()) throw last ?? this.outOfBudget(allowed);
      sent = true;

      let reply: Reply;
      let status = 0;
      let serverWait = 0; // server-requested, from Retry-After
      try {
        reply = await this.send(method, target, token, body, limit);
        status = reply.status;
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          if (allowed.kind === "read") throw tooMuch(dataType, error);
          // Google answered, and the answer cannot be read. A create may have
          // happened; a delete can be asked again.
          if (allowed.kind === "create") throw outcomeUnknown(allowed.dataType, CREATE_FAULTS.unreadable, error);
          throw unavailable(DELETE_FAULTS.unreadable, error);
        }
        const cause = error instanceof NetworkError ? error : new NetworkError(errorTypes(error));
        console.warn("google health request did not complete", { data_type: dataType, cause: cause.causeTypes });
        // The request may have reached Google before the connection failed.
        if (allowed.kind === "create") throw outcomeUnknown(allowed.dataType, "Google Health API could not be reached", cause);
        last = unavailable("Google Health API could not be reached", cause);
        reply = { status: 0, retryAfter: null, text: "", bytes: 0 };
      }

      if (status >= 200 && status < 300) return reply;
      if (status !== 0) {
        const rejected = status === 401 || (status === 403 && staleScope(reply.text));
        if (!refreshed && rejected && this.budget.canRenew) {
          refreshed = true;
          if (await this.tokens.invalidate(token)) {
            this.budget.takeRenewal();
            console.warn("google health token rejected; renewing", { data_type: dataType, http_status: status });
          }
          // The request was tried. When the budget has no unit left to send
          // it again, it is unavailable: not a range that holds too much.
          last = unavailable("Google Health API is unavailable", statusError(status, reply.text));
          continue; // a renewal is not a failure: no backoff, no attempt used
        }
        const limited = quota(status, reply.text);
        if (status === 401) {
          throw new ToolError("auth_expired", "Google Health rejected the sign-in", RECONNECT_HINT, {
            cause: statusError(status, reply.text),
          });
        }
        if (status === 403 && !limited) {
          const [message, hint] =
            allowed.kind === "read"
              ? [`Google Health denied access to ${dataType} data`, SCOPE_HINT]
              : [`Google Health denied the write of ${dataType} data`, writeScopeHint(allowed.dataType)];
          throw new ToolError("scope_missing", message, hint, { cause: statusError(status, reply.text) });
        }
        // The point is not there: the state a delete asks for. Only Google's
        // own JSON error with the status NOT_FOUND says so. Any other 404 (the
        // page of a front end for a path or a body that is wrong) says nothing
        // about the point: it is a refused delete, below.
        if (kind === "delete" && status === 404 && statusError(status, reply.text).status === NOT_FOUND) return reply;
        // A rate limit is an answer that Google did not take the request.
        const refusedForNow = status === 429 || limited;
        const noAnswer = status === 408 || status >= 500;
        if (allowed.kind === "create" && noAnswer) {
          // Google may have stored the entry before it failed to answer.
          throw outcomeUnknown(allowed.dataType, "Google Health API is unavailable", statusError(status, reply.text));
        }
        if (refusedForNow || noAnswer) {
          last = unavailable("Google Health API is unavailable", statusError(status, reply.text));
          serverWait = retryAfter(reply.retryAfter, this.now());
          if (serverWait > MAX_RETRY_AFTER_MS) throw last;
        } else {
          const cause = statusError(status, reply.text);
          // A changed filter field, request shape or API version lands here.
          // A read logs the status and Google's enum only. A write also logs
          // the short message and the ErrorInfo reason, so the refusal can be
          // explained; the rest of the body is never logged, and neither is a
          // text of the request that the message repeats.
          const detail = kind === "read" ? undefined : googleWriteFault(reply.text, echoes);
          console.warn("google health request rejected", {
            data_type: dataType,
            http_status: status,
            google_status: cause.status,
            ...(detail?.reason ? { google_reason: detail.reason } : {}),
            ...(detail?.message ? { google_message: detail.message } : {}),
          });
          if (kind !== "read" && status >= 400 && status < 500) throw refused(kind, cause, detail ?? NO_WRITE_FAULT);
          throw new Error(`googlehealth: ${dataType} request rejected`, { cause });
        }
      }

      failures++;
      // Out of attempts, or out of budget for the next one: no wait for a
      // request that cannot be sent.
      if (failures >= MAX_ATTEMPTS || this.budget.remaining === 0) {
        throw last ?? unavailable("Google Health API is unavailable");
      }
      const delay = Math.max(this.jitter(FIRST_BACKOFF_MS << (failures - 1)), serverWait);
      console.warn("google health request failed; retrying", {
        data_type: dataType,
        http_status: status,
        retry: failures,
        wait_ms: delay,
      });
      await this.wait(delay);
    }
  }

  /**
   * The error of a page or a chunk that the budget has no unit for. When
   * earlier tool calls of the same MCP HTTP request took units before this
   * call started, a shorter range is not the only way: the same call can fit
   * a request of its own, and the hint says so.
   */
  private outOfBudget(target: Target): ToolError {
    // A write has no range to shorten: the units went to the calls before it.
    if (target.kind !== "read") return new ToolError("invalid_input", NOT_SENT[target.kind], WRITE_OWN_REQUEST_HINT);
    return tooMuch(target.dataType, undefined, this.budget.sharedBefore ? OWN_REQUEST_HINT : SHORTER_RANGE_HINT);
  }

  /** The access token and the account it belongs to, or the tool error of a token source that cannot give one. */
  private async accessToken(): Promise<Extract<TokenResult, { ok: true }>> {
    if (this.budget.tokenFailure) throw this.budget.tokenFailure;
    const result = await this.tokens.accessToken();
    if (result.ok) return result;
    const failure = tokenError(result.code);
    this.budget.tokenFailure = failure;
    throw failure;
  }

  /** One HTTP attempt. Throws only NetworkError or ResponseTooLargeError. */
  private async send(method: string, target: string, token: string, body: string | undefined, limit: number): Promise<Reply> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await fetch(target, {
        method,
        headers,
        body,
        // The API never redirects; following one could carry the bearer token
        // to another path, a subdomain or plain http on the same host.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const read = await readBody(response, limit);
      return { status: response.status, retryAfter: response.headers.get("retry-after"), ...read };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw error;
      // A timeout and a dropped connection are both a DOMException or a
      // TypeError; the name tells a timeout apart.
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new NetworkError(timedOut ? "TimeoutError" : errorTypes(error));
    }
  }
}

/** A test may lower a limit, never raise it. */
function lowered(name: string, value: number | undefined, limit: number): number {
  if (value === undefined) return limit;
  if (!Number.isInteger(value) || value < 1 || value > limit) throw new Error(`googlehealth: ${name} must be 1 to ${limit}`);
  return value;
}

const BASE_URL = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)$/i;
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?$/;

/**
 * Accepts https, or http only on a loopback host (a local test server): over
 * http the bearer token would travel in cleartext. The error never echoes the
 * URL, which could hold a password.
 */
function checkBaseUrl(base: string): void {
  const [, scheme = "", authority = ""] = BASE_URL.exec(base) ?? [];
  if (authority === "" || authority.includes("@")) {
    throw new Error("googlehealth: invalid base URL (want scheme://host[/path], no user, query or fragment)");
  }
  switch (scheme.toLowerCase()) {
    case "https":
      return;
    case "http":
      if (LOOPBACK.test(authority)) return;
      throw new Error("googlehealth: base URL must use https outside loopback");
    default:
      throw new Error("googlehealth: base URL must use https");
  }
}

const READ_PATH = /^\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints(:reconcile)?$/;
const ROLLUP_PATH = /^\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints:dailyRollUp$/;

/**
 * The read-only guard: the data type of a request the client may send, or
 * undefined. dailyRollUp is the only POST, and it reads.
 */
export function readTarget(method: string, path: string): DataType | undefined {
  const pattern = method === "GET" ? READ_PATH : method === "POST" ? ROLLUP_PATH : undefined;
  return pattern?.exec(path)?.[1] as DataType | undefined;
}

/** The writes the client may send for a data type: one create and one delete. */
export type WriteKind = "create" | "delete";

/** A write the client may send: its data type and its kind. */
export interface WriteTarget {
  dataType: WriteDataType;
  kind: WriteKind;
}

/**
 * The write guard: the data type and the kind of a write the client may send,
 * or undefined. Exactly four requests pass, each compared as a whole text:
 * for the nutrition-log data type and for the exercise data type, the create
 * of one data point and the delete of data points by name. No pattern is
 * used, so no other data type, user or method suffix can pass.
 */
export function writeTarget(method: string, path: string): WriteTarget | undefined {
  if (method !== "POST") return undefined;
  if (path === CREATE_PATH) return { dataType: "nutrition-log", kind: "create" };
  if (path === DELETE_PATH) return { dataType: "nutrition-log", kind: "delete" };
  if (path === EXERCISE_CREATE_PATH) return { dataType: "exercise", kind: "create" };
  if (path === EXERCISE_DELETE_PATH) return { dataType: "exercise", kind: "delete" };
  return undefined;
}

/** What a request is. A write carries one of the data types the client writes. */
type Target = { dataType: DataType; kind: "read" } | WriteTarget;

/** The allowlist of the client: what a request is, or undefined for one that must not leave. */
function requestTarget(method: string, path: string, query: string | undefined): Target | undefined {
  const read = readTarget(method, path);
  if (read !== undefined) return { dataType: read, kind: "read" };
  const write = writeTarget(method, path);
  // The whole input of a write is its body: a write with a query is not one of the four.
  if (write === undefined || query !== undefined) return undefined;
  return write;
}

const PAGING_WORDS = ["token", "page", "next", "cursor", "more", "contin", "offset", "after", "trunc", "partial", "remain"];

/**
 * Whether an unknown response field name looks like a continuation marker
 * (nextPageToken renamed or joined by another).
 */
function pagingField(name: string): boolean {
  const lower = name.toLowerCase();
  return PAGING_WORDS.some((word) => lower.includes(word));
}

const RETRY_HINT = "try again in a few minutes";

const SCOPE_HINT = `${RECONNECT_HINT} Allow every permission, and check that the Google Health API is enabled in the Cloud project.`;

/** The Go client's hint for a range that holds more than one call reads. */
export const SHORTER_RANGE_HINT = "use a shorter date range";

/**
 * The hint of a call that ran out of the request budget after earlier tool
 * calls of the same MCP HTTP request took units of it.
 */
export const OWN_REQUEST_HINT = `${SHORTER_RANGE_HINT}, or send this call in a request of its own`;

/** A range whose data exceeds the request, page or byte budget of one call. */
function tooMuch(dataType: DataType, cause?: unknown, hint: string = SHORTER_RANGE_HINT): ToolError {
  return new ToolError(
    "invalid_input",
    `the date range holds more ${dataType} data than one call reads`,
    hint,
    cause === undefined ? undefined : { cause },
  );
}

function badResponse(dataType: DataType): ToolError {
  return new ToolError("upstream_unavailable", `Google Health returned an unreadable ${dataType} response`, RETRY_HINT);
}

function unavailable(message: string, cause?: unknown): ToolError {
  return new ToolError("upstream_unavailable", message, RETRY_HINT, cause === undefined ? undefined : { cause });
}

// --- the errors of a write ---

/**
 * The hint of a write that Google denied: the write scope of the data type of
 * that write, and what it permits (the table WRITE_SCOPES).
 */
function writeScopeHint(dataType: WriteDataType): string {
  const { permits, scope } = WRITE_SCOPES[dataType];
  return `${RECONNECT_HINT} Allow the permission to ${permits} (${scopeName(scope)}), and check that the Google Health API is enabled in the Cloud project.`;
}

/**
 * The hint of a create whose outcome is unknown, by data type: the read that
 * shows the day, and what it shows of an entry that this server has no ID
 * for. Such an entry is not one of the server's own.
 *
 * - A food entry: nutrition_day reports it as food from another source. That
 *   report is one flag, not a count. So on a day that already had food from
 *   another source, nutrition_day cannot show whether the entry was added:
 *   only the food log itself, in the Fitbit app, can.
 * - A workout session: workout_review leaves it out and raises
 *   other_source_sessions_excluded. That flag covers the week of the day,
 *   and it is one flag too: in a week that already had a session from
 *   another source, only the exercise log in the Fitbit app can show it.
 */
export const MAY_EXIST_HINTS: Readonly<Record<WriteDataType, string>> = {
  "nutrition-log":
    "the entry may exist: check the day with nutrition_day before a new try " +
    "(an entry this server has no id for shows there as food from another source; " +
    "when the day already had food from another source, check the food log in the Fitbit app instead)",
  exercise:
    "the entry may exist: check the day with workout_review before a new try " +
    "(a session this server has no id for is not listed there, and the result has the flag other_source_sessions_excluded; " +
    "when the week already had a session from another source, check the exercise log in the Fitbit app instead)",
};

/** The hint of a food log create whose outcome is unknown. */
export const MAY_EXIST_HINT = MAY_EXIST_HINTS["nutrition-log"];

/**
 * The hint of an unavailable answer, by kind of request. A create that ends
 * with this hint was answered by Google with a refusal (a rate limit, a
 * rejected token), so the entry does not exist. The hint of a delete names
 * the delete tool of the data type of that delete.
 */
function retryHint(target: Target): string {
  switch (target.kind) {
    case "read":
      return RETRY_HINT;
    case "create":
      return `the entry was not created; ${RETRY_HINT}`;
    case "delete":
      return `the entry may still exist; call ${WRITE_SCOPES[target.dataType].deleteTool} again in a few minutes (a repeated delete is safe)`;
  }
}

function unavailableFor(target: Target, message: string, cause?: unknown): ToolError {
  return new ToolError("upstream_unavailable", message, retryHint(target), cause === undefined ? undefined : { cause });
}

/** A create that may have happened: it must not be sent again before the day is checked. */
function outcomeUnknown(dataType: WriteDataType, message: string, cause?: unknown): ToolError {
  return new ToolError("upstream_unavailable", message, MAY_EXIST_HINTS[dataType], cause === undefined ? undefined : { cause });
}

/**
 * The hint of a write that was not sent for a reason of its MCP HTTP request:
 * the request budget had no unit for it, or the linked Google account changed
 * during the request.
 */
export const WRITE_OWN_REQUEST_HINT = "send this call in a request of its own";

const NO_UNIT_LEFT = "this MCP request already sent all the Google Health requests one request may send";

const NOT_SENT: Readonly<Record<WriteKind, string>> = {
  create: `${NO_UNIT_LEFT}: the entry was not sent`,
  delete: `${NO_UNIT_LEFT}: the delete was not sent`,
};

const ACCOUNT_CHANGED = "the linked Google account changed during this MCP request";

/**
 * A write that is bound to one Google account, and whose token belongs to
 * another: it is not sent. Like a write the budget has no unit for, it is
 * invalid_input: nothing is wrong at Google or with the sign-in, and the same
 * call works in a request of its own, which reads the account and the token
 * together. The text names no account and no token.
 *
 * `sentBefore`: an attempt went out before the token changed, with the token
 * of the account the write is bound to. Google rejected that token, or
 * answered a failure that can be retried.
 */
function accountChanged(kind: Target["kind"], sentBefore: boolean): ToolError {
  const what = kind === "create" ? "the entry" : kind === "delete" ? "the delete" : "the request";
  return new ToolError("invalid_input", `${ACCOUNT_CHANGED}: ${what} was not sent${sentBefore ? " again" : ""}`, WRITE_OWN_REQUEST_HINT);
}

/**
 * A write that Google answered with a 4xx other than a rejected token, a
 * denial or a rate limit: it took nothing. The message repeats Google's
 * ErrorInfo reason and short error.message when the body has them, so the
 * model can say why. It does not repeat the request body, a token, an email
 * address or a user identifier. The same two fields are on the reject log.
 */
function refused(kind: WriteKind, cause: StatusError, detail: WriteRefusal): ToolError {
  const base = kind === "create" ? "Google Health refused the entry" : "Google Health refused the delete";
  const hint = kind === "create" ? "the entry was not created; check the date, the time and the values" : "the entry was not deleted";
  return new ToolError("invalid_input", refusalText(base, detail), hint, { cause });
}

const CREATE_FAULTS: Readonly<Record<AnswerFault, string>> = {
  unreadable: "Google Health returned an unreadable answer for the entry",
  not_done: "Google Health has not finished creating the entry",
  operation_error: "Google Health reported an error for the entry",
  no_name: "Google Health returned no usable id for the entry",
};

const DELETE_FAULTS: Readonly<Record<Exclude<AnswerFault, "no_name">, string>> = {
  unreadable: "Google Health returned an unreadable answer for the delete",
  not_done: "Google Health has not finished the delete",
  operation_error: "Google Health reported an error for the delete",
};

/** The log line of a write answer that cannot be used: the reason, never a part of the answer. */
function logFault(dataType: WriteDataType, operation: WriteKind, fault: AnswerFault, code: number | undefined): void {
  console.warn("google health write answer not usable", {
    data_type: dataType,
    operation,
    reason: fault,
    ...(code === undefined ? {} : { google_code: code }),
  });
}

const RENEWAL_HINT = `${OAUTH_CLIENT_HINT} ${RECONNECT_HINT}`;

/**
 * The tool error of a call that finds no linked Google account. The token
 * source answers it, and so does a tool that must stop before it asks for a
 * token: one text for both, so the person reads the same step to take.
 */
export function notLinkedError(): ToolError {
  return new ToolError("auth_expired", "not signed in to Google Health", RECONNECT_HINT);
}

/**
 * The tool error of a token source that gave no token. A missing or revoked
 * link is auth_expired, and so is a token request that Google refuses (a wrong
 * OAuth client): the person can fix both, and no renewal works until then. The
 * message carries no detail of Google's answer.
 */
function tokenError(code: string): ToolError {
  switch (code) {
    case "not_linked":
      return notLinkedError();
    case "auth_expired":
      return new ToolError("auth_expired", "the Google sign-in expired or was revoked", RECONNECT_HINT);
    case "upstream_unavailable":
      return unavailable("Google's token service is unavailable");
    default:
      return new ToolError("auth_expired", "Google rejected the token renewal", RENEWAL_HINT);
  }
}

const STATUS_ENUM = /^[A-Z][A-Z_]{0,63}$/;

/** Google's status enum of an HTTP 404 that the API itself answers. */
const NOT_FOUND = "NOT_FOUND";

/**
 * Keeps the error.status enum of an error body, and only when it is
 * enum-shaped, so free text from the body never reaches an error. A write
 * refusal's message and ErrorInfo reason are read separately, by
 * googleWriteFault, and only for that refusal.
 */
function statusError(httpStatus: number, body: string): StatusError {
  let status = "";
  try {
    const parsed = JSON.parse(body) as { error?: { status?: unknown } } | null;
    const candidate = parsed?.error?.status;
    if (typeof candidate === "string" && STATUS_ENUM.test(candidate)) status = candidate;
  } catch {
    // Not JSON: the HTTP status is all there is.
  }
  return new StatusError(httpStatus, status);
}

/**
 * What a write refusal may repeat from Google's error. Both are empty when
 * the body has nothing safe to repeat. A read never builds one.
 */
interface WriteRefusal {
  /** ErrorInfo reasons, in order, without duplicates. */
  reason: string;
  /** error.message, with secrets removed and cut to about 200 characters. */
  message: string;
}

const NO_WRITE_FAULT: WriteRefusal = { reason: "", message: "" };

/** About 200 characters: the cut for a write's error.message, in UTF-8 bytes. */
const WRITE_ERROR_TEXT = 200;

/** Google's ErrorInfo.reason: a short constant, not free text. */
const REASON_ENUM = /^[A-Z][A-Z0-9_]{0,62}$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const USER_IN_PATH = /users\/[A-Za-z0-9_.~-]+/gi;
const BEARER = /Bearer\s+\S+/gi;
const YA29 = /ya29\.[A-Za-z0-9._~+/-]+=*/g;
/** A Google account id. Shorter numbers (a status, a count, a year) stay. */
const ACCOUNT_ID = /\d{10,}/g;
/**
 * A hyphenated or dotted token: it starts with a letter and contains a digit.
 * A timestamp starts with a digit, so the time of the refusal stays.
 */
const TOKENISH = /\b(?=[A-Za-z])(?=[A-Za-z0-9._-]*\d)[A-Za-z][A-Za-z0-9._-]{9,}\b/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops tokens, email addresses and user identifiers from text a write may repeat. */
function redactWriteText(text: string): string {
  return text
    .replace(EMAIL, " ")
    .replace(BEARER, " ")
    .replace(YA29, " ")
    .replace(USER_IN_PATH, " ")
    .replace(ACCOUNT_ID, " ")
    .replace(TOKENISH, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A shorter text identifies nothing, and its removal would empty the message. */
const MIN_ECHO_CHARS = 3;

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g;

/**
 * `text` without every occurrence of a text of `echoes`, compared without
 * regard to letter case. Each removed stretch becomes one space.
 *
 * Every occurrence is marked on the text as Google sent it, and the marked
 * stretches are cut together: so a text that is part of another one (a name
 * inside the notes), or that overlaps it, leaves no rest behind. The removal
 * runs before the redaction of tokens and identifiers, which would cut a
 * repeated text into parts that match nothing.
 */
function withoutEchoes(text: string, echoes: readonly string[]): string {
  const cut = new Array<boolean>(text.length).fill(false);
  let found = false;
  for (const echo of echoes) {
    if ([...echo].length < MIN_ECHO_CHARS) continue;
    // A lookahead matches at every start, also where two occurrences overlap.
    const occurrence = new RegExp(`(?=(${echo.replace(REGEXP_SYNTAX, "\\$&")}))`, "giu");
    for (const match of text.matchAll(occurrence)) {
      cut.fill(true, match.index, match.index + (match[1]?.length ?? 0));
      found = true;
    }
  }
  if (!found) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!cut[i]) out += text[i];
    else if (!cut[i - 1]) out += " ";
  }
  return out;
}

/**
 * The reason and short message of a write that Google refused. Only
 * error.message and the reason of an ErrorInfo in error.details are read.
 * The message is cut to about 200 characters. Anything that is a token, an
 * email address or a user identifier is left out, and so is the rest of the
 * body: a request is never logged or returned. `echoes` are the texts of the
 * request that the caller wrote (a name, notes, a value, an entry id): the
 * message is repeated without them. The reason is a constant, and stays.
 */
function googleWriteFault(body: string, echoes: readonly string[] = []): WriteRefusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NO_WRITE_FAULT;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return NO_WRITE_FAULT;
  const error = parsed.error;
  const message = typeof error.message === "string" ? truncate(redactWriteText(withoutEchoes(error.message, echoes)), WRITE_ERROR_TEXT) : "";
  const details = Array.isArray(error.details) ? error.details : [];
  const reasons: string[] = [];
  let used = 0;
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    const type = detail["@type"];
    if (typeof type !== "string" || !type.endsWith("google.rpc.ErrorInfo")) continue;
    const reason = detail.reason;
    if (typeof reason !== "string" || !REASON_ENUM.test(reason) || reasons.includes(reason)) continue;
    const next = used + (reasons.length === 0 ? 0 : 2) + reason.length;
    if (next > WRITE_ERROR_TEXT) break;
    reasons.push(reason);
    used = next;
  }
  return { reason: reasons.join(", "), message };
}

/** The tool-error text of a refusal: the fixed sentence, then Google's reason and message. */
function refusalText(base: string, detail: WriteRefusal): string {
  const extra = [detail.reason, detail.message].filter((part) => part !== "");
  return extra.length === 0 ? base : `${base}: ${extra.join(": ")}`;
}

/** A 403 that is a rate limit (RESOURCE_EXHAUSTED), not a denial. */
function quota(status: number, body: string): boolean {
  return status === 403 && statusError(status, body).status === "RESOURCE_EXHAUSTED";
}

/**
 * A 403 of the "insufficient authentication scopes" kind. An access token can
 * pass the local validity check yet be expired at Google, and the API then
 * answers this 403 instead of a 401. A real scope gap repeats after a renewal,
 * so one renewal tells the two apart.
 */
function staleScope(body: string): boolean {
  return body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || body.toLowerCase().includes("insufficient authentication scopes");
}

const INTEGER = /^[+-]?\d+$/;
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const MAX_INT64 = 2 ** 63;

/**
 * Parses a Retry-After header in seconds or HTTP-date form into milliseconds;
 * 0 when absent or unparseable.
 */
export function retryAfter(header: string | null, now: number): number {
  const value = (header ?? "").trim();
  if (value === "") return 0;
  if (INTEGER.test(value)) {
    const seconds = Number(value);
    // Too large for Go's int is too long to wait.
    if (seconds >= MAX_INT64) return MAX_RETRY_AFTER_MS + 1000;
    return Math.min(Math.max(seconds, 0), 86_400) * 1000;
  }
  if (HTTP_DATE.test(value)) {
    const at = Date.parse(value);
    if (at > now) return at - now;
  }
  return 0;
}

/** Spreads d over [d/2, d], so clients that failed together do not retry together. */
export function equalJitter(ms: number): number {
  const half = Math.floor(ms / 2);
  return half + Math.floor(Math.random() * (ms - half + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a body through the size limit and decodes it. A BOM stays in the
 * text, so the page reader rejects it as the Go JSON decoder does.
 */
async function readBody(response: Response, limit: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(limit);
    }
    chunks.push(value);
  }
  let bytes: Uint8Array;
  if (chunks.length === 1) {
    bytes = chunks[0] as Uint8Array;
  } else {
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return { text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes), bytes: total };
}
