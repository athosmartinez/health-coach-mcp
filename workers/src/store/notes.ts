// Coach notes with full-text search.

import { type LocalDate, UTC, type Zone, bounds, parseDate } from "../coach/date";
import { ToolError } from "../coach/errors";
import { byteLength, fields, trimSpace } from "../coach/text";
import { type Db, formatStamp, invalid, nullable, oneOf, readStamp, text } from "./db";

/** Mirrors the schema CHECK on notes.kind. */
export const NOTE_KINDS: readonly string[] = ["insight", "decision", "checkin", "symptom"];

export const DEFAULT_NOTE_LIMIT = 50;
export const MAX_NOTE_LIMIT = 200;
export const MAX_NOTE_TEXT = 8 << 10;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 64;
export const MAX_QUERY_WORDS = 32;
export const MAX_QUERY_BYTES = 512;
export const MAX_QUERY_WORD_LEN = 64;
/** Bounds the table: decades of daily check-ins. */
export const MAX_NOTES = 50_000;

/** A free-text coach note. */
export interface Note {
  id: number;
  kind: string;
  text: string;
  tags: string[];
  related_date?: LocalDate;
  created_at: string;
  /**
   * Marks a note whose stored tags no longer decode: the note is still
   * returned (with no tags) instead of failing the whole search.
   */
  tags_unreadable?: boolean;
}

export interface NoteInput {
  kind: string;
  text: string;
  tags?: readonly string[];
  related_date?: LocalDate;
}

/** Stores a note; the FTS index is updated by the notes_ai trigger. */
export function addNote(db: Db, input: NoteInput): Note {
  const tags = [...(input.tags ?? [])];
  const related = input.related_date ?? "";
  if (!NOTE_KINDS.includes(input.kind)) throw invalid(`kind must be one of ${NOTE_KINDS.join(", ")}`);
  if (trimSpace(input.text) === "" || byteLength(input.text) > MAX_NOTE_TEXT) {
    throw invalid(`note text is required (max ${MAX_NOTE_TEXT} bytes)`);
  }
  if (tags.length > MAX_TAGS) throw invalid(`at most ${MAX_TAGS} tags`);
  for (const tag of tags) {
    if (tag === "" || byteLength(tag) > MAX_TAG_LEN) throw invalid(`tags must be 1 to ${MAX_TAG_LEN} characters`);
  }
  if (related !== "" && parseDate(related) === undefined) throw invalid("related_date must be YYYY-MM-DD");

  const stamp = db.stamp();
  // The count check and the insert share one INSERT ... SELECT, so the cap holds.
  const row = db.first(
    `INSERT INTO notes (kind, text, tags, related_date, created_at)
     SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM notes) < ?
     RETURNING id`,
    input.kind,
    input.text,
    JSON.stringify(tags),
    nullable(related),
    stamp.stored,
    MAX_NOTES,
  );
  if (!row) throw invalid(`note history is full (${MAX_NOTES} notes)`);
  return {
    id: Number(row.id),
    kind: input.kind,
    text: input.text,
    tags,
    ...(related === "" ? {} : { related_date: related }),
    created_at: stamp.at,
  };
}

/** Narrows searchNotes. Absent or empty values mean "no filter". */
export interface NoteFilter {
  kind?: string;
  /** Keeps notes whose related_date, or creation day when unset, is on or after it. */
  since?: LocalDate;
  /** Keeps notes whose related_date, or creation day when unset, is on or before it. */
  until?: LocalDate;
  /** The zone used to turn since and until into instants for created_at (default UTC). */
  zone?: Zone;
  /** Free text; every word must appear (FTS5, words matched as phrases). */
  query?: string;
  limit?: number;
}

/**
 * One page of notes. `more` reports that older matches exist beyond the limit,
 * so the model knows the list is not exhaustive.
 */
export interface NoteResults {
  notes: Note[];
  more: boolean;
}

/** The stored tags of a note. Anything but a JSON array of strings is unreadable. */
function readTags(stored: SqlStorageValue | undefined): { tags: string[]; unreadable: boolean } {
  if (stored === null || stored === undefined) return { tags: [], unreadable: false };
  try {
    const value: unknown = JSON.parse(text(stored));
    if (value === null) return { tags: [], unreadable: false };
    if (Array.isArray(value) && value.every((tag) => typeof tag === "string")) return { tags: value, unreadable: false };
  } catch {
    // Falls through: reported as unreadable.
  }
  return { tags: [], unreadable: true };
}

/** Returns matching notes, newest first. */
export function searchNotes(db: Db, filter: NoteFilter = {}): NoteResults {
  const kind = filter.kind ?? "";
  const since = filter.since ?? "";
  const until = filter.until ?? "";
  const zone = filter.zone ?? UTC;
  oneOf("kind", kind, NOTE_KINDS, true);

  const where = ["1 = 1"];
  const args: SqlStorageValue[] = [];
  if (kind !== "") {
    where.push("n.kind = ?");
    args.push(kind);
  }
  if (since !== "" && until !== "" && until < since) throw invalid("until must not be before since");
  if (until !== "") {
    const day = bounds(until, zone);
    if (!day) throw invalid("until must be YYYY-MM-DD");
    where.push("(n.related_date <= ? OR (n.related_date IS NULL AND n.created_at < ?))");
    args.push(until, formatStamp(day.end));
  }
  if (since !== "") {
    const day = bounds(since, zone);
    if (!day) throw invalid("since must be YYYY-MM-DD");
    where.push("(n.related_date >= ? OR (n.related_date IS NULL AND n.created_at >= ?))");
    args.push(since, formatStamp(day.start));
  }
  let from = "notes n";
  if (filter.query) {
    from = "notes n JOIN notes_fts ON notes_fts.rowid = n.id";
    where.push("notes_fts MATCH ?");
    args.push(ftsQuery(filter.query));
  }
  let limit = Math.floor(filter.limit ?? 0);
  if (!(limit > 0)) limit = DEFAULT_NOTE_LIMIT;
  limit = Math.min(limit, MAX_NOTE_LIMIT);
  args.push(limit + 1); // one extra row tells whether more exist

  // Only fixed fragments are interpolated; every value is a placeholder.
  // ids are AUTOINCREMENT, so they order by insertion even within one clock tick.
  let rows;
  try {
    rows = db.all(
      `SELECT n.id, n.kind, n.text, n.tags, n.related_date, n.created_at FROM ${from}
       WHERE ${where.join(" AND ")} ORDER BY n.id DESC LIMIT ?`,
      ...args,
    );
  } catch (error) {
    throw ftsSyntaxError(error);
  }
  const notes = rows.map((row): Note => {
    const { tags, unreadable } = readTags(row.tags);
    const related = text(row.related_date);
    return {
      id: Number(row.id),
      kind: text(row.kind),
      text: text(row.text),
      tags,
      ...(related === "" ? {} : { related_date: related }),
      created_at: readStamp(row.created_at),
      ...(unreadable ? { tags_unreadable: true } : {}),
    };
  });
  if (notes.length > limit) return { notes: notes.slice(0, limit), more: true };
  return { notes, more: false };
}

/**
 * Quotes every word as an FTS5 phrase, so user text can never be read as query
 * syntax (AND, NEAR, column filters, unbalanced quotes). NUL characters are
 * dropped: SQLite ends the string there and reports a syntax error. A query
 * with no words left is rejected rather than silently matching everything.
 */
export function ftsQuery(query: string): string {
  if (byteLength(query) > MAX_QUERY_BYTES) throw invalid(`query is too long (max ${MAX_QUERY_BYTES} bytes)`);
  const words = fields(query.replaceAll("\u0000", ""));
  if (words.length === 0) throw invalid("query has no words; omit it to list notes");
  if (words.length > MAX_QUERY_WORDS) throw invalid(`search at most ${MAX_QUERY_WORDS} words`);
  return words
    .map((word) => {
      if (byteLength(word) > MAX_QUERY_WORD_LEN) throw invalid(`query words are at most ${MAX_QUERY_WORD_LEN} bytes`);
      return `"${word.replaceAll('"', '""')}"`;
    })
    .join(" ");
}

/**
 * Maps only an FTS5 syntax error to invalid_input. Quoting makes it unreachable
 * from user text, so anything else from FTS5 (a corrupt index, a missing
 * content row) is a real fault and passes through unchanged.
 */
export function ftsSyntaxError(error: unknown): unknown {
  if (error instanceof Error && error.message.includes("fts5: syntax error")) {
    return new ToolError("invalid_input", "the search text could not be parsed", "use plain words");
  }
  return error;
}
