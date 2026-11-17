// The entries this server created in Google Health: the food entries (the
// nutrition_entries table) and the workout sessions (the exercise_entries
// table). The Go server has no such store: it writes nothing to Google
// Health.
//
// Each table answers one question: is this entry the server's own? Google's
// documentation does not prove that a delete refuses a data point another app
// wrote, so the server deletes only the entries listed here. A row holds the
// Google account the entry was created for, the name Google gave the entry,
// its local day and when it was created: no food or session name, and no
// value of the entry.
//
// An entry belongs to the Google account that was linked when it was created
// (the `sub` of the row). It is the server's own only while that account is
// the linked one. After another account is linked, the rows of the account
// before it stay in the table and match nothing: a delete with the token of
// the new account must never be sent for an entry of the old one. They match
// again when their account is linked again.
//
// Every function takes the data type of the entry last, and reads the food
// entries when it is left out.

import { type LocalDate, parseDate } from "../coach/date";
import type { WriteDataType } from "../google";
import { pointId as exercisePointId } from "../googlehealth/exerciselog";
import { pointId } from "../googlehealth/nutritionlog";
import { type Db, text } from "./db";

/** The account that is linked now, as SQL: NULL when none is, and NULL matches no row. */
const LINKED = "(SELECT sub FROM google_account WHERE id = 1)";

interface EntryTable {
  /** The table of the entries of the data type, and the index of its `day` column. */
  table: string;
  index: string;
  /** The data point ID of a name of the data type; undefined for any other text. */
  pointId(name: string): string | undefined;
  /** The data type in the words of an error: "a nutrition-log", "an exercise". */
  a: string;
}

/**
 * The table of each data type the server writes. A closed table: the name of
 * a table or of an index in a statement comes from here, never from input.
 */
const TABLES: Readonly<Record<WriteDataType, EntryTable>> = {
  "nutrition-log": { table: "nutrition_entries", index: "nutrition_entries_by_day", pointId, a: "a nutrition-log" },
  exercise: { table: "exercise_entries", index: "exercise_entries_by_day", pointId: exercisePointId, a: "an exercise" },
};

/** The Google account that is linked now (its `sub`), or undefined when none is. */
export function linkedAccount(db: Db): string | undefined {
  const sub = db.first("SELECT sub FROM google_account WHERE id = 1")?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

/**
 * Records an entry that Google Health just created, for the account that is
 * linked now. `name` is the data point name of the create answer; `day` is
 * the local day of the entry. A name recorded twice for one account keeps one
 * row.
 *
 * `owner` is the account that was linked before the create was sent. When
 * another account is the linked one by now, the entry is not recorded: its
 * row would bind an entry of one account to another. Throws for that, for a
 * store without a linked account, and for a text that is not a data point
 * name of the data type or not a calendar day.
 */
export function recordEntry(db: Db, name: string, day: LocalDate, owner?: string, type: WriteDataType = "nutrition-log"): void {
  const { table, pointId: idOf, a } = TABLES[type];
  if (idOf(name) === undefined) throw new Error(`store: not ${a} data point name`);
  if (parseDate(day) === undefined) throw new Error("store: not a calendar date");
  const sub = linkedAccount(db);
  if (sub === undefined) throw new Error("store: no Google account is linked");
  if (owner !== undefined && owner !== sub) throw new Error("store: another Google account was linked");
  db.all(
    `INSERT INTO ${table} (sub, name, day, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub, name) DO UPDATE SET day = excluded.day`,
    sub,
    name,
    day,
    db.stamp().stored,
  );
}

/** Whether this server created the entry with exactly this name, for the account that is linked now. */
export function hasEntry(db: Db, name: string, type: WriteDataType = "nutrition-log"): boolean {
  return db.count(`SELECT COUNT(*) FROM ${TABLES[type].table} WHERE sub = ${LINKED} AND name = ?`, name) > 0;
}

/**
 * Removes the row of an entry that is gone from Google Health. No row is not
 * an error, and a row of another account stays.
 *
 * `owner` is the account the delete was sent for: the one that was linked
 * before the request. Another account can be the linked one when the answer
 * comes, and the row to remove is still the one of `owner`. Without `owner`,
 * the row is the one of the account that is linked now.
 */
export function forgetEntry(db: Db, name: string, owner?: string, type: WriteDataType = "nutrition-log"): void {
  const { table } = TABLES[type];
  if (owner === undefined) db.all(`DELETE FROM ${table} WHERE sub = ${LINKED} AND name = ?`, name);
  else db.all(`DELETE FROM ${table} WHERE sub = ? AND name = ?`, owner, name);
}

/**
 * The statement that reads the names of the linked account's entries of a
 * range of days. The index of the day is named, so the read never walks every
 * entry of the account through the primary key. Exported for the test of its
 * plan.
 */
export function entryNamesQuery(type: WriteDataType): string {
  const { table, index } = TABLES[type];
  return `SELECT name FROM ${table} INDEXED BY ${index}
  WHERE day >= ? AND day <= ? AND sub = ${LINKED}`;
}

/** The statement of the food entries. */
export const ENTRY_NAMES_BETWEEN = entryNamesQuery("nutrition-log");

/**
 * The data point IDs of the entries this server created on the local days
 * [from, to] for the account that is linked now, read through the index of
 * the day. An entry of another account is not this account's own: its ID is
 * left out. IDs, not names: a list can name the user in another form than the
 * create did.
 */
export function entryIdsBetween(db: Db, from: LocalDate, to: LocalDate, type: WriteDataType = "nutrition-log"): Set<string> {
  return new Set(entryNamesBetween(db, from, to, type).keys());
}

/**
 * The stored name of each entry this server created on the local days
 * [from, to] for the account that is linked now, keyed by data point ID.
 * The name is the one the create answered: `hasEntry` matches it exactly.
 * A list can name the same point with the user written as `me` or by an ID,
 * so the key is the ID, not the whole name. Two stored names with one ID
 * keep the lesser name. An entry of another account is left out.
 */
export function entryNamesBetween(db: Db, from: LocalDate, to: LocalDate, type: WriteDataType = "nutrition-log"): Map<string, string> {
  const idOf = TABLES[type].pointId;
  const names = new Map<string, string>();
  for (const row of db.all(entryNamesQuery(type), from, to)) {
    const name = text(row.name);
    const id = idOf(name);
    if (id === undefined) continue;
    const kept = names.get(id);
    if (kept === undefined || name < kept) names.set(id, name);
  }
  return names;
}
