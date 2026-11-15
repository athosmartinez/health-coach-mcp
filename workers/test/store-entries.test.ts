// The table of the food entries this server created (src/store/entries.ts).
// All values are synthetic.
import { describe, expect, it } from "vitest";

import { forgetEntry, hasEntry, recordEntry } from "../src/store/entries";
import { fixedClock, withDb } from "./memory-helpers";

const NAME = "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-entry-1";
const OTHER = "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-entry-2";

const rows = (sql: SqlStorage) => sql.exec("SELECT name, day, created_at FROM nutrition_entries ORDER BY name").toArray();

describe("the entries this server created", () => {
  it("records the name, the local day and the creation time of an entry, and nothing else", () =>
    withDb((db, sql) => {
      expect(hasEntry(db, NAME)).toBe(false);
      recordEntry(db, NAME, "2026-10-13");
      expect(hasEntry(db, NAME)).toBe(true);
      expect(hasEntry(db, OTHER)).toBe(false);
      expect(rows(sql)).toEqual([{ name: NAME, day: "2026-10-13", created_at: "2026-10-14T12:00:00.000000000Z" }]);
    }, fixedClock));

  it("knows an entry only by the exact name it was recorded with", () =>
    withDb((db) => {
      recordEntry(db, NAME, "2026-10-13");
      for (const name of [
        // The same ID under another user, under `me`, and under another data type.
        "users/9988776655/dataTypes/nutrition-log/dataPoints/syn-entry-1",
        "users/me/dataTypes/nutrition-log/dataPoints/syn-entry-1",
        "users/1122334455/dataTypes/hydration-log/dataPoints/syn-entry-1",
        `${NAME}/extra`,
        `${NAME} `,
        NAME.toUpperCase(),
        "syn-entry-1",
        "",
        "%",
      ]) {
        expect(hasEntry(db, name), JSON.stringify(name)).toBe(false);
      }
    }));

  it("keeps one row for a name recorded twice", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      recordEntry(db, NAME, "2026-10-14");
      expect(rows(sql)).toMatchObject([{ name: NAME, day: "2026-10-14" }]);
    }));

  it("forgets one entry and leaves the others", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      recordEntry(db, OTHER, "2026-10-13");
      forgetEntry(db, NAME);
      expect(hasEntry(db, NAME)).toBe(false);
      expect(hasEntry(db, OTHER)).toBe(true);
      // An entry that is not there is not an error.
      forgetEntry(db, NAME);
      expect(rows(sql)).toMatchObject([{ name: OTHER }]);
    }));

  it.each([
    ["a name of another data type", "users/1122334455/dataTypes/exercise/dataPoints/syn-entry-1", "2026-10-13", "not a nutrition-log data point name"],
    ["a name with more path parts", `${NAME}/extra`, "2026-10-13", "not a nutrition-log data point name"],
    ["an ID without its path", "syn-entry-1", "2026-10-13", "not a nutrition-log data point name"],
    ["an empty name", "", "2026-10-13", "not a nutrition-log data point name"],
    ["a day that is not a date", NAME, "2026-02-30", "not a calendar date"],
    ["an empty day", NAME, "", "not a calendar date"],
  ])("refuses to record %s", (_name, name, day, message) =>
    withDb((db, sql) => {
      expect(() => recordEntry(db, name, day)).toThrow(message);
      expect(rows(sql)).toEqual([]);
    }));

  it("finds an entry through the primary key, and writes three rows for one", () =>
    withDb((db, sql) => {
      for (let n = 0; n < 200; n++) recordEntry(db, `users/1122334455/dataTypes/nutrition-log/dataPoints/syn-fill-${n}`, "2026-10-13");
      const written = sql.exec("INSERT INTO nutrition_entries (name, day, created_at) VALUES (?, '2026-10-13', 'x')", NAME).rowsWritten;
      // The row, the entry of the primary key and the entry of the day index.
      expect(written).toBe(3);
      const lookup = sql.exec("SELECT COUNT(*) FROM nutrition_entries WHERE name = ?", NAME);
      lookup.toArray();
      expect(lookup.rowsRead).toBe(1);
      expect(hasEntry(db, NAME)).toBe(true);
    }));
});
