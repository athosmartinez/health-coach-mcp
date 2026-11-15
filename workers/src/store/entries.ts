// The food entries this server created in Google Health (the
// nutrition_entries table). The Go server has no such store: it writes
// nothing to Google Health.
//
// The table answers one question: is this entry the server's own? Google's
// documentation does not prove that a delete refuses a data point another app
// wrote, so the server deletes only the entries listed here. A row holds the
// name Google gave the entry, its local day and when it was created: no food
// name and no nutrient value.

import { type LocalDate, parseDate } from "../coach/date";
import { pointId } from "../googlehealth/nutritionlog";
import { type Db, text } from "./db";

/**
 * Records an entry that Google Health just created. `name` is the data point
 * name of the create answer; `day` is the local day of the entry. A name
 * recorded twice keeps one row. Throws for a text that is not a nutrition-log
 * data point name or not a calendar day: both are caller bugs.
 */
export function recordEntry(db: Db, name: string, day: LocalDate): void {
  if (pointId(name) === undefined) throw new Error("store: not a nutrition-log data point name");
  if (parseDate(day) === undefined) throw new Error("store: not a calendar date");
  db.all(
    `INSERT INTO nutrition_entries (name, day, created_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET day = excluded.day`,
    name,
    day,
    db.stamp().stored,
  );
}

/** Whether this server created the entry with exactly this name. */
export function hasEntry(db: Db, name: string): boolean {
  return db.count("SELECT COUNT(*) FROM nutrition_entries WHERE name = ?", name) > 0;
}

/** Removes the row of an entry that is gone from Google Health. No row is not an error. */
export function forgetEntry(db: Db, name: string): void {
  db.all("DELETE FROM nutrition_entries WHERE name = ?", name);
}

/**
 * The data point IDs of the entries this server created on the local days
 * [from, to], read through the index of the day. IDs, not names: a list can
 * name the user in another form than the create did.
 */
export function entryIdsBetween(db: Db, from: LocalDate, to: LocalDate): Set<string> {
  const ids = new Set<string>();
  for (const row of db.all("SELECT name FROM nutrition_entries WHERE day >= ? AND day <= ?", from, to)) {
    const id = pointId(text(row.name));
    if (id !== undefined) ids.add(id);
  }
  return ids;
}
