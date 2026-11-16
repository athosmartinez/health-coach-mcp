// Reads one Google Health record with the rules of the Go server's JSON
// decoding (Go: the record structs of internal/healthdata). A record arrives
// already parsed, so the rules are applied to values instead of to text:
//
// - a missing field and a JSON null both leave the field unset;
// - a value of the wrong JSON type makes the whole record unreadable, also in
//   a field the caller would not have used (Go decodes the whole struct first);
// - an unknown field is ignored.
//
// Every reader throws UNREADABLE for a value it cannot take. A parser catches
// it and reports the record as unreadable: no error text ever quotes a record.

import type { LocalDate } from "../coach/date";
import { trimSpace } from "../coach/text";

/** Thrown, and caught, inside this package only. One shared value: a thrown Error would capture a stack per record. */
export const UNREADABLE: unique symbol = Symbol("unreadable record");

/** Runs a decoder; undefined when the record is unreadable. */
export function decode<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error === UNREADABLE) return undefined;
    throw error;
  }
}

export type Obj = Record<string, unknown>;

/** The record itself. Go refuses anything but an object; null leaves every field unset. */
export function root(record: unknown): Obj | undefined {
  if (record === null) return undefined;
  if (typeof record !== "object" || Array.isArray(record)) throw UNREADABLE;
  return record as Obj;
}

function field(parent: Obj | undefined, key: string): unknown {
  if (parent === undefined || !Object.hasOwn(parent, key)) return undefined;
  const value = parent[key];
  return value === null ? undefined : value;
}

/** An object field (a Go struct or struct pointer): undefined when missing or null. */
export function object(parent: Obj | undefined, key: string): Obj | undefined {
  const value = field(parent, key);
  if (value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw UNREADABLE;
  return value as Obj;
}

/** A list of objects (a Go slice of structs). A null element is an element with every field unset. */
export function objects(parent: Obj | undefined, key: string): (Obj | undefined)[] {
  const value = field(parent, key);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw UNREADABLE;
  return value.map((element) => root(element));
}

/** A string field: "" when missing or null. */
export function text(parent: Obj | undefined, key: string): string {
  const value = field(parent, key);
  if (value === undefined) return "";
  if (typeof value !== "string") throw UNREADABLE;
  return value;
}

/** A boolean field: false when missing or null. */
export function flag(parent: Obj | undefined, key: string): boolean {
  const value = field(parent, key);
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw UNREADABLE;
  return value;
}

/** An optional number (Go *float64): undefined when missing or null. */
export function float(parent: Obj | undefined, key: string): number | undefined {
  const value = field(parent, key);
  if (value === undefined) return undefined;
  // A literal too large for a float64 is an error in Go and Infinity here.
  if (typeof value !== "number" || !Number.isFinite(value)) throw UNREADABLE;
  return value;
}

/** A whole number (Go int): 0 when missing or null. */
export function int(parent: Obj | undefined, key: string): number {
  const value = field(parent, key);
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw UNREADABLE;
  return value;
}

const INT64_TEXT = /^[+-]?\d+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function int64(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw UNREADABLE;
    return value;
  }
  if (typeof value !== "string" || !INT64_TEXT.test(value)) throw UNREADABLE;
  // 15 digits are exact in a double; longer text is checked against int64.
  if (value.length > 15) {
    const big = BigInt(value);
    if (big < INT64_MIN || big > INT64_MAX) throw UNREADABLE;
  }
  return Number(value);
}

/**
 * An int64 the API sends as a JSON string (Go int64s, as a value). Proto3 JSON
 * leaves a zero out, so a missing field is 0. A JSON null is an error here,
 * unlike every other field: Go passes it to the type's own decoder.
 */
export function int64s(parent: Obj | undefined, key: string): number {
  if (parent === undefined || !Object.hasOwn(parent, key)) return 0;
  return int64(parent[key]);
}

/** An optional int64 (Go *int64s): undefined when missing or null. */
export function optionalInt64s(parent: Obj | undefined, key: string): number | undefined {
  const value = field(parent, key);
  return value === undefined ? undefined : int64(value);
}

function utcMs(year: number, month: number, day: number): number {
  const t = new Date(0);
  // Unlike Date.UTC, a year below 100 stays as given.
  t.setUTCFullYear(year, month - 1, day);
  return t.getTime();
}

/** Go's zero time.Time (0001-01-01T00:00:00Z), in epoch milliseconds: a time field that is missing or null. */
export const ZERO_TIME = utcMs(1, 1, 1);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * An instant (Go time.Time), in epoch milliseconds: ZERO_TIME when missing or
 * null. The text must be RFC 3339 as Go reads it: upper case T and Z, two
 * digits per field, a real calendar day, no second 60. A fraction finer than
 * a millisecond is kept as a part of a millisecond, cut to about a
 * microsecond. The result is never after the instant of the text.
 */
export function time(parent: Obj | undefined, key: string): number {
  const value = field(parent, key);
  if (value === undefined) return ZERO_TIME;
  if (typeof value !== "string") throw UNREADABLE;
  const match = RFC3339.exec(value);
  if (!match) throw UNREADABLE;
  const part = (i: number) => Number(match[i]);
  const [year, month, day, hour, minute, second] = [part(1), part(2), part(3), part(4), part(5), part(6)];
  if (!validCivil(year, month, day) || hour > 23 || minute > 59 || second > 59) throw UNREADABLE;
  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    if (part(9) > 23 || part(10) > 59) throw UNREADABLE;
    offsetMinutes = (match[8] === "-" ? -1 : 1) * (part(9) * 60 + part(10));
  }
  // The fraction is cut, never rounded: a sum that rounds up can pass the end
  // of its second (23:59:59.999999999 would become the next day). The whole
  // milliseconds come from the first three digits, as an integer.
  const digits = match[7] ?? "";
  const ms =
    utcMs(year, month, day) + (hour * 3600 + minute * 60 + second) * 1000 - offsetMinutes * 60_000 + Number(digits.slice(0, 3).padEnd(3, "0"));
  // The rest, down to the nanosecond (the Go server reads nine digits), is cut
  // to a step that a double holds exactly next to the milliseconds. So the
  // sum is exact and stays below the next millisecond.
  const rest = digits.length > 3 ? Math.floor(Number(`0.${digits.slice(3, 9)}`) * SUB_MS_STEPS) / SUB_MS_STEPS : 0;
  return Math.abs(ms) < EXACT_SUB_MS ? ms + rest : ms;
}

/**
 * The steps of a millisecond that an instant keeps, so two samples inside one
 * millisecond stay in order: about a microsecond each.
 */
const SUB_MS_STEPS = 1024;

/** Below this many milliseconds from 1970 (the year 2248), a double holds every step of SUB_MS_STEPS exactly. */
const EXACT_SUB_MS = 2 ** 43;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function validCivil(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

const MAX_YEAR = 999_999;

/**
 * The day of the API's Date ({year, month, day}), or undefined when it is not
 * a real calendar day. Year 0 is proto3's "not set".
 */
export function civilDay(date: Obj | undefined): LocalDate | undefined {
  const [year, month, day] = [int(date, "year"), int(date, "month"), int(date, "day")];
  if (year === 0 || Math.abs(year) > MAX_YEAR || !validCivil(year, month, day)) return undefined;
  // The Go server writes the date with at least four year digits.
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${year < 0 ? "-" : ""}${pad(Math.abs(year), 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Where a record comes from. */
export interface DataSource {
  platform: string;
  recordingMethod: string;
  deviceName: string;
}

export function dataSource(record: Obj | undefined): DataSource {
  const source = object(record, "dataSource");
  return {
    platform: text(source, "platform"),
    recordingMethod: text(source, "recordingMethod"),
    deviceName: text(object(source, "device"), "displayName"),
  };
}

export const MAX_LABEL_RUNES = 64;

// Go: unicode.IsControl (Cc) and the categories Cf, Zl and Zp.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Makes a Google-supplied string safe to show: it reaches the cache and tool
 * output, which an LLM reads, so control, format (bidi overrides, zero-width)
 * and line or paragraph separator characters are dropped and the length is
 * capped. U+FFFD (what invalid UTF-8 decodes to) and lone surrogates go too.
 */
export function clean(s: string): string {
  let out = "";
  let kept = 0;
  for (const char of s) {
    if (kept === MAX_LABEL_RUNES) break;
    if (dropped(char)) continue;
    out += char;
    kept++;
  }
  return trimSpace(out);
}

/** Whether `clean` drops the character (one code point). */
function dropped(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code === 0xfffd || (code >= 0xd800 && code <= 0xdfff) || HIDDEN.test(char);
}

/**
 * Whether `clean` keeps every character of `s`: the rule of `clean` for a
 * text longer than a label, which `clean` would cut.
 */
export function allVisible(s: string): boolean {
  for (const char of s) if (dropped(char)) return false;
  return true;
}

/** Names the source in envelopes: the device when known, else the platform. */
export function label(source: DataSource): string {
  return clean(source.deviceName) || clean(source.platform);
}

const DURATION_PART = /^(\d*)(?:\.(\d*))?(ns|us|µs|μs|ms|s|m|h)(?![a-zµμ])/;
const UNIT_NS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

/**
 * Go's time.ParseDuration, in nanoseconds: a sign, then one or more numbers
 * with a unit ("3600s", "1h30m", "1.5s"), or "0". Undefined for any other
 * text and for a duration past int64 nanoseconds. A protobuf Duration arrives
 * as seconds ("3600s").
 */
export function parseDuration(s: string): number | undefined {
  let rest = s;
  let negative = false;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    negative = rest.startsWith("-");
    rest = rest.slice(1);
  }
  if (rest === "0") return 0;
  if (rest === "") return undefined;
  let total = 0n;
  while (rest !== "") {
    const match = DURATION_PART.exec(rest);
    if (!match) return undefined;
    const [whole = "", fraction = ""] = [match[1], match[2]];
    if (whole === "" && fraction === "") return undefined;
    const unit = UNIT_NS[match[3] as string] as bigint;
    total += BigInt(whole || "0") * unit;
    // The part below a nanosecond is cut, as in Go.
    if (fraction !== "") total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length);
    if (total > INT64_MAX) return undefined;
    rest = rest.slice(match[0].length);
  }
  return Number(negative ? -total : total);
}
