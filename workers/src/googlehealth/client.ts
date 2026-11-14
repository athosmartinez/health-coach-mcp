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
// parseRetryAfter) and cmd/data.go (list and rollup pagination), through this
// repository's internal/googlehealth/client.go. Changes: read operations only,
// behind a method and path allowlist; waits with jitter and a cap on
// Retry-After; one token renewal shared by 401 and the stale-token 403; errors
// carry the HTTP status and Google's status enum, never the response body;
// responses read through a size limit; a page cap or a repeated page token is
// an error instead of a truncated result; a request budget shared by the calls
// of one MCP request; each record reduced by the caller as its page is read;
// and a port from Go to TypeScript.

// A read-only client for the Google Health API v4.

import type { LocalDate, Zone } from "../coach/date";
import { ToolError, errorTypes } from "../coach/errors";
import { RECONNECT_HINT } from "../google";
import type { RequestBudget } from "./budget";
import { type DataType, type TypeInfo, filter, lookup, rollupChunks, windowFilter } from "./datatypes";
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
// parsed object tree. What a call keeps from the pages already read is what
// the caller's mapper returned. A mapper that keeps a whole record keeps about
// the size of its text, so a call that read b bytes keeps at most about b.
//
// Peak of a call, at its last page of n bytes: (MAX_CALL_BYTES − n) kept +
// 3n in flight ≤ MAX_CALL_BYTES + 2 × MAX_RESPONSE_BYTES = 32 + 32 = 64 MiB.
// That leaves 64 MiB for the code, the store, the tool result and the
// garbage the collector has not freed yet (the chunks a body arrived in).
//
// 16 MiB still holds a full page of the largest type: 10000 heart-rate
// samples at up to 1.6 kB each.

/** Bounds one response body. */
export const MAX_RESPONSE_BYTES = 16 << 20;

/** Bounds the responses of one call across all its pages and chunks. */
export const MAX_CALL_BYTES = 32 << 20;

/** What CoachStore.googleAccessToken() answers. */
export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: "auth_expired" | "upstream_unavailable" | "internal_error" | "not_linked" };

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

/** The token endpoint refused the server's own request (a wrong OAuth client, a malformed answer). */
export class TokenRequestError extends Error {
  constructor() {
    super("the Google token request failed");
    this.name = "TokenRequestError";
  }
}

interface Reply {
  status: number;
  retryAfter: string | null;
  text: string;
  bytes: number;
}

/** Reads data points. One instance serves the calls of one MCP request, one after the other. */
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
      let next = "";
      for (const [name, value] of scan.fields) {
        if (name === "nextPageToken") {
          if (typeof value === "string") next = value;
          else if (value !== null) throw badResponse(dataType);
          continue;
        }
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
   */
  protected async request(method: string, path: string, query?: string, body?: string): Promise<Reply> {
    const dataType = readTarget(method, path);
    if (dataType === undefined) throw new Error(`googlehealth: read-only client refuses ${method} ${path}`);
    const target = query === undefined ? `${this.base}${path}` : `${this.base}${path}?${query}`;
    let refreshed = false;
    // Set by every failure that can be retried.
    let last: ToolError | undefined;
    for (let failures = 0; ; ) {
      // Out of budget: a request that kept failing is unavailable, as when the
      // attempts run out; a page or a chunk that was never tried means the
      // range holds more than one call reads.
      if (this.budget.remaining === 0) throw last ?? tooMuch(dataType);
      const token = await this.accessToken();
      if (!this.budget.take()) throw last ?? tooMuch(dataType);

      let reply: Reply;
      let status = 0;
      let serverWait = 0; // server-requested, from Retry-After
      try {
        reply = await this.send(method, target, token, body);
        status = reply.status;
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw tooMuch(dataType, error);
        const cause = error instanceof NetworkError ? error : new NetworkError(errorTypes(error));
        console.warn("google health request did not complete", { data_type: dataType, cause: cause.causeTypes });
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
          continue; // a renewal is not a failure: no backoff, no attempt used
        }
        const limited = quota(status, reply.text);
        if (status === 401) {
          throw new ToolError("auth_expired", "Google Health rejected the sign-in", RECONNECT_HINT, {
            cause: statusError(status, reply.text),
          });
        }
        if (status === 403 && !limited) {
          throw new ToolError("scope_missing", `Google Health denied access to ${dataType} data`, SCOPE_HINT, {
            cause: statusError(status, reply.text),
          });
        }
        if (status === 429 || status === 408 || status >= 500 || limited) {
          last = unavailable("Google Health API is unavailable", statusError(status, reply.text));
          serverWait = retryAfter(reply.retryAfter, this.now());
          if (serverWait > MAX_RETRY_AFTER_MS) throw last;
        } else {
          const cause = statusError(status, reply.text);
          // A changed filter field or API version lands here; the status and
          // Google's enum are the only signal (the body is never logged).
          console.warn("google health request rejected", {
            data_type: dataType,
            http_status: status,
            google_status: cause.status,
          });
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

  /** The access token, or the tool error of a token source that cannot give one. */
  private async accessToken(): Promise<string> {
    if (this.budget.tokenFailure) throw this.budget.tokenFailure;
    const result = await this.tokens.accessToken();
    if (result.ok) return result.accessToken;
    const failure = tokenError(result.code);
    this.budget.tokenFailure = failure;
    throw failure;
  }

  /** One HTTP attempt. Throws only NetworkError or ResponseTooLargeError. */
  private async send(method: string, target: string, token: string, body: string | undefined): Promise<Reply> {
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
      const read = await readBody(response, this.maxResponseBytes);
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

/** A range whose data exceeds the request, page or byte budget of one call. */
function tooMuch(dataType: DataType, cause?: unknown): ToolError {
  return new ToolError(
    "invalid_input",
    `the date range holds more ${dataType} data than one call reads`,
    "use a shorter date range",
    cause === undefined ? undefined : { cause },
  );
}

function badResponse(dataType: DataType): ToolError {
  return new ToolError("upstream_unavailable", `Google Health returned an unreadable ${dataType} response`, RETRY_HINT);
}

function unavailable(message: string, cause?: unknown): ToolError {
  return new ToolError("upstream_unavailable", message, RETRY_HINT, cause === undefined ? undefined : { cause });
}

/**
 * The tool error of a token source that gave no token. A missing or revoked
 * link is auth_expired; a refused token request is the server's own fault and
 * stays an internal error.
 */
function tokenError(code: string): Error {
  switch (code) {
    case "not_linked":
      return new ToolError("auth_expired", "not signed in to Google Health", RECONNECT_HINT);
    case "auth_expired":
      return new ToolError("auth_expired", "the Google sign-in expired or was revoked", RECONNECT_HINT);
    case "upstream_unavailable":
      return unavailable("Google's token service is unavailable");
    default:
      return new TokenRequestError();
  }
}

const STATUS_ENUM = /^[A-Z][A-Z_]{0,63}$/;

/**
 * Keeps the error.status enum of an error body, and only when it is
 * enum-shaped, so free text from the body never reaches an error.
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
