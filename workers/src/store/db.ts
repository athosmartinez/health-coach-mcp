// Shared pieces of the coach memory store: the
// SQL handle with its clock, stored timestamps, and the validation helpers.

import { type LocalDate, parseDate } from "../coach/date";
import { ToolError } from "../coach/errors";

/** Where the store reads the time. Injected, so tests control it. */
export type Clock = () => Date;

export type Row = Record<string, SqlStorageValue>;

/** An instant, as stored and as tool outputs show it. */
export interface Stamp {
  /** Fixed width (9 fractional digits, UTC), so stamps sort and compare as text. */
  stored: string;
  /** RFC 3339, the fraction trimmed of trailing zeros. */
  at: string;
  time: Date;
}

/** The Durable Object's SQLite database, with the clock the store stamps rows with. */
export class Db {
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly now: Clock = () => new Date(),
  ) {}

  /** Runs one statement to the end and returns its rows. */
  all<T extends Row = Row>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  first<T extends Row = Row>(query: string, ...bindings: SqlStorageValue[]): T | undefined {
    return this.all<T>(query, ...bindings)[0];
  }

  /** The single number a COUNT(*) style query returns. */
  count(query: string, ...bindings: SqlStorageValue[]): number {
    const value = Object.values(this.first(query, ...bindings) ?? {})[0];
    return typeof value === "number" ? value : 0;
  }

  /** Runs `body` in a transaction. A throw rolls it back and is rethrown. */
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(body);
  }

  /** The current instant, formatted once for storage and for the output. */
  stamp(): Stamp {
    const time = this.now();
    const stored = formatStamp(time);
    return { stored, at: trimFraction(stored), time };
  }
}

/** Formats an instant for storage: always 9 fractional digits, UTC. */
export function formatStamp(t: Date): string {
  return t.toISOString().replace("Z", "000000Z");
}

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{9}Z$/;

const trimFraction = (stored: string) => stored.replace(/\.?0+Z$/, "Z");

/** A stored row that no longer reads. The message names the column kind, never its value. */
export class CorruptRowError extends Error {
  constructor(what: string) {
    super(`corrupt ${what}`);
    this.name = "CorruptRowError";
  }
}

/**
 * Reads a stored timestamp as RFC 3339. A corrupt value fails the whole read
 * instead of becoming an empty or zero time. The calendar date and the clock
 * are checked here, field by field: Date.parse accepts 30 February (as
 * 2 March) and hour 24.
 */
export function readStamp(value: SqlStorageValue | undefined): string {
  const [, date = "", hour, minute, second] = (typeof value === "string" && STAMP.exec(value)) || [];
  if (parseDate(date) === undefined || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new CorruptRowError("timestamp");
  }
  return trimFraction(value as string);
}

/** Text of a column; NULL reads as "". */
export function text(value: SqlStorageValue | undefined): string {
  if (typeof value === "string") return value;
  return value === null || value === undefined || value instanceof ArrayBuffer ? "" : String(value);
}

/** Number of a column; NULL reads as undefined. */
export function numberOrUndefined(value: SqlStorageValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Maps "" to NULL, so optional text columns stay NULL and never empty. */
export function nullable(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** What a tool reports when nothing is stored yet: "nothing recorded" to the model, not a fault. */
export function notFound(): ToolError {
  return new ToolError("no_data", "nothing recorded yet");
}

/**
 * Builds the error a tool shows the model for a rejected value. The message
 * names fields and allowed values, never stored health values.
 */
export function invalid(message: string): ToolError {
  return new ToolError("invalid_input", message, "fix the value named in the message and retry");
}

/** Throws invalid_input unless `d` is a real calendar date ("" passes when optional). */
export function validDate(name: string, d: LocalDate, optional: boolean): void {
  if (d === "" && optional) return;
  if (parseDate(d) === undefined) throw invalid(`${name} must be YYYY-MM-DD`);
}

/** Throws invalid_input unless `value` is one of `allowed` ("" passes when optional). */
export function oneOf(name: string, value: string, allowed: readonly string[], optional: boolean): void {
  if ((value === "" && optional) || allowed.includes(value)) return;
  throw invalid(`${name} must be one of ${allowed.join(", ")}`);
}
