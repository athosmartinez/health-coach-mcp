// The food entries this server created in Google Health (the
// nutrition_entries table). The Go server has no such store: it writes
// nothing to Google Health.
//
// The table answers one question: is this entry the server's own? Google's
// documentation does not prove that a delete refuses a data point another app
// wrote, so the server deletes only the entries listed here. A row holds the
// Google account the entry was created for, the name Google gave the entry,
// its local day and when it was created: no food name and no nutrient value.
//
// An entry belongs to the Google account that was linked when it was created
// (the `sub` of the row). It is the server's own only while that account is
// the linked one. After another account is linked, the rows of the account
// before it stay in the table and match nothing: a delete with the token of
// the new account must never be sent for an entry of the old one. They match
// again when their account is linked again.

import { type LocalDate, parseDate } from "../coach/date";
import { pointId } from "../googlehealth/nutritionlog";
import { type Db, text } from "./db";

/** The account that is linked now, as SQL: NULL when none is, and NULL matches no row. */
const LINKED = "(SELECT sub FROM google_account WHERE id = 1)";

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
 * store without a linked account, and for a text that is not a nutrition-log
 * data point name or not a calendar day.
 */
export function recordEntry(db: Db, name: string, day: LocalDate, owner?: string): void {
  if (pointId(name) === undefined) throw new Error("store: not a nutrition-log data point name");
  if (parseDate(day) === undefined) throw new Error("store: not a calendar date");
  const sub = linkedAccount(db);
  if (sub === undefined) throw new Error("store: no Google account is linked");
  if (owner !== undefined && owner !== sub) throw new Error("store: another Google account was linked");
  db.all(
    `INSERT INTO nutrition_entries (sub, name, day, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub, name) DO UPDATE SET day = excluded.day`,
    sub,
    name,
    day,
    db.stamp().stored,
  );
}

/** Whether this server created the entry with exactly this name, for the account that is linked now. */
export function hasEntry(db: Db, name: string): boolean {
  return db.count(`SELECT COUNT(*) FROM nutrition_entries WHERE sub = ${LINKED} AND name = ?`, name) > 0;
}

/**
 * Removes the row of an entry of the linked account that is gone from Google
 * Health. No row is not an error, and a row of another account stays.
 */
export function forgetEntry(db: Db, name: string): void {
  db.all(`DELETE FROM nutrition_entries WHERE sub = ${LINKED} AND name = ?`, name);
}

/**
 * Reads the names of the linked account's entries of a range of days. The
 * index of the day is named, so the read never walks every entry of the
 * account through the primary key. Exported for the test of its plan.
 */
export const ENTRY_NAMES_BETWEEN = `SELECT name FROM nutrition_entries INDEXED BY nutrition_entries_by_day
  WHERE day >= ? AND day <= ? AND sub = ${LINKED}`;

/**
 * The data point IDs of the entries this server created on the local days
 * [from, to] for the account that is linked now, read through the index of
 * the day. An entry of another account is not this account's own: its ID is
 * left out. IDs, not names: a list can name the user in another form than the
 * create did.
 */
export function entryIdsBetween(db: Db, from: LocalDate, to: LocalDate): Set<string> {
  const ids = new Set<string>();
  for (const row of db.all(ENTRY_NAMES_BETWEEN, from, to)) {
    const id = pointId(text(row.name));
    if (id !== undefined) ids.add(id);
  }
  return ids;
}
