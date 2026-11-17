// The table of the workout sessions this server created (the exercise_entries
// table, through src/store/entries.ts with the data type "exercise").
// test/store-entries.test.ts holds the same rules for the food entries. All
// values are synthetic.
import { describe, expect, it } from "vitest";

import { ENTRY_NAMES_BETWEEN, entryIdsBetween, entryNamesBetween, entryNamesQuery, forgetEntry, hasEntry, linkedAccount, recordEntry } from "../src/store/entries";
import { OWNER_SUB } from "./helpers";
import { fixedClock, linkAccount, withDb } from "./memory-helpers";

const TYPE = "exercise";
const NAME = "users/1122334455/dataTypes/exercise/dataPoints/syn-session-1";
const OTHER = "users/1122334455/dataTypes/exercise/dataPoints/syn-session-2";
const FOOD = "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-session-1";
const OTHER_SUB = "200000000000000000002";

const rows = (sql: SqlStorage, table = "exercise_entries") => sql.exec(`SELECT sub, name, day, created_at FROM ${table} ORDER BY sub, name`).toArray();

describe("the sessions this server created", () => {
  it("records the account, the name, the local day and the creation time of a session, and nothing else", () =>
    withDb((db, sql) => {
      expect(hasEntry(db, NAME, TYPE)).toBe(false);
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      expect(hasEntry(db, NAME, TYPE)).toBe(true);
      expect(hasEntry(db, OTHER, TYPE)).toBe(false);
      expect(rows(sql)).toEqual([{ sub: OWNER_SUB, name: NAME, day: "2026-10-13", created_at: "2026-10-14T12:00:00.000000000Z" }]);
      const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('exercise_entries') ORDER BY cid").toArray();
      expect(columns.map((column) => column.name)).toEqual(["sub", "name", "day", "created_at"]);
    }, fixedClock));

  it("keeps the sessions and the food entries in tables of their own", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      recordEntry(db, FOOD, "2026-10-13");
      // Each table holds the entry of its own data type.
      expect(rows(sql).map((row) => row.name)).toEqual([NAME]);
      expect(rows(sql, "nutrition_entries").map((row) => row.name)).toEqual([FOOD]);
      // A session is not a food entry, and a food entry is not a session: also with the same data point id.
      expect(hasEntry(db, NAME)).toBe(false);
      expect(hasEntry(db, FOOD, TYPE)).toBe(false);
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13", TYPE)]).toEqual(["syn-session-1"]);
      expect([...entryNamesBetween(db, "2026-10-13", "2026-10-13", TYPE).values()]).toEqual([NAME]);
      expect([...entryNamesBetween(db, "2026-10-13", "2026-10-13").values()]).toEqual([FOOD]);
      // Forgetting one leaves the other.
      forgetEntry(db, NAME);
      forgetEntry(db, FOOD, undefined, TYPE);
      expect(hasEntry(db, NAME, TYPE)).toBe(true);
      expect(hasEntry(db, FOOD)).toBe(true);
      forgetEntry(db, NAME, undefined, TYPE);
      expect(rows(sql)).toEqual([]);
      expect(rows(sql, "nutrition_entries")).toHaveLength(1);
    }));

  it.each([
    ["a name of the food log", FOOD, "2026-10-13", "store: not an exercise data point name"],
    ["a name with more path parts", `${NAME}/extra`, "2026-10-13", "store: not an exercise data point name"],
    ["an ID without its path", "syn-session-1", "2026-10-13", "store: not an exercise data point name"],
    ["an empty name", "", "2026-10-13", "store: not an exercise data point name"],
    ["a day that is not a date", NAME, "2026-02-30", "store: not a calendar date"],
  ])("refuses to record %s", (_name, name, day, message) =>
    withDb((db, sql) => {
      expect(() => recordEntry(db, name, day, undefined, TYPE)).toThrow(message);
      expect(rows(sql)).toEqual([]);
    }));

  it("refuses to record the name of a session as a food entry", () =>
    withDb((db, sql) => {
      expect(() => recordEntry(db, NAME, "2026-10-13")).toThrow("store: not a nutrition-log data point name");
      expect(rows(sql, "nutrition_entries")).toEqual([]);
    }));

  it("knows a session only by the exact name it was recorded with, and keeps one row for a name recorded twice", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      recordEntry(db, NAME, "2026-10-14", undefined, TYPE);
      expect(rows(sql)).toMatchObject([{ name: NAME, day: "2026-10-14" }]);
      for (const name of ["users/9988776655/dataTypes/exercise/dataPoints/syn-session-1", "users/me/dataTypes/exercise/dataPoints/syn-session-1", FOOD, `${NAME}/extra`, `${NAME} `, "syn-session-1", "", "%"]) {
        expect(hasEntry(db, name, TYPE), JSON.stringify(name)).toBe(false);
      }
    }));

  it("maps a data point id to the stored name for the days of a range, both ends counted", () =>
    withDb((db) => {
      const underMe = "users/me/dataTypes/exercise/dataPoints/syn-b";
      recordEntry(db, "users/1122334455/dataTypes/exercise/dataPoints/syn-a", "2026-10-12", undefined, TYPE);
      recordEntry(db, underMe, "2026-10-13", undefined, TYPE);
      recordEntry(db, NAME, "2026-10-14", undefined, TYPE);
      recordEntry(db, OTHER, "2026-10-15", undefined, TYPE);
      expect(Object.fromEntries(entryNamesBetween(db, "2026-10-13", "2026-10-14", TYPE))).toEqual({ "syn-b": underMe, "syn-session-1": NAME });
      expect([...entryIdsBetween(db, "2026-10-12", "2026-10-12", TYPE)]).toEqual(["syn-a"]);
      expect(entryNamesBetween(db, "2026-10-16", "2026-10-20", TYPE).size).toBe(0);
      expect(entryNamesBetween(db, "2026-10-14", "2026-10-13", TYPE).size).toBe(0);
      forgetEntry(db, underMe, undefined, TYPE);
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-14", TYPE)]).toEqual(["syn-session-1"]);
    }));

  it("reads the sessions of a range of days through the index of the day", () =>
    withDb((db, sql) => {
      for (let n = 0; n < 300; n++) recordEntry(db, `users/1122334455/dataTypes/exercise/dataPoints/syn-old-${n}`, "2026-09-01", undefined, TYPE);
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      recordEntry(db, OTHER, "2026-10-14", undefined, TYPE);
      const query = entryNamesQuery(TYPE);
      // The statement names the table and the index of its own data type.
      expect(query).toContain("FROM exercise_entries INDEXED BY exercise_entries_by_day");
      expect(entryNamesQuery("nutrition-log")).toBe(ENTRY_NAMES_BETWEEN);
      expect(ENTRY_NAMES_BETWEEN).toContain("FROM nutrition_entries INDEXED BY nutrition_entries_by_day");
      const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, "2026-10-12", "2026-10-14").toArray();
      expect(plan.map((row) => row.detail).join(" ")).toContain("USING INDEX exercise_entries_by_day (day>? AND day<?)");
      const read = sql.exec(query, "2026-10-12", "2026-10-14");
      expect(read.toArray()).toHaveLength(2);
      // The 300 rows of the other days are not read: the read does not walk every session of the account.
      expect(read.rowsRead).toBeLessThanOrEqual(8);
      expect(entryIdsBetween(db, "2026-10-12", "2026-10-14", TYPE).size).toBe(2);
    }));

  it("finds a session through the primary key, and writes three rows for one", () =>
    withDb((db, sql) => {
      for (let n = 0; n < 200; n++) recordEntry(db, `users/1122334455/dataTypes/exercise/dataPoints/syn-fill-${n}`, "2026-10-13", undefined, TYPE);
      const written = sql.exec("INSERT INTO exercise_entries (sub, name, day, created_at) VALUES (?, ?, '2026-10-13', 'x')", OWNER_SUB, NAME).rowsWritten;
      // The row, the entry of the primary key and the entry of the day index.
      expect(written).toBe(3);
      const lookup = sql.exec("SELECT COUNT(*) FROM exercise_entries WHERE sub = ? AND name = ?", OWNER_SUB, NAME);
      lookup.toArray();
      expect(lookup.rowsRead).toBe(1);
      expect(hasEntry(db, NAME, TYPE)).toBe(true);
    }));
});

// A session belongs to the Google account that was linked when it was
// created. With another account linked, a delete would go out with the wrong
// token.
describe("the sessions of the linked Google account", () => {
  it("knows only the sessions of the linked account, and keeps the rows of another account", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      expect(hasEntry(db, NAME, TYPE)).toBe(true);

      // Another account is linked: the session of the first one is not this server's own now.
      linkAccount(sql, OTHER_SUB);
      expect(linkedAccount(db)).toBe(OTHER_SUB);
      expect(hasEntry(db, NAME, TYPE)).toBe(false);
      expect(entryNamesBetween(db, "2026-10-13", "2026-10-13", TYPE).size).toBe(0);
      // Forgetting it does nothing: the row is not the linked account's.
      forgetEntry(db, NAME, undefined, TYPE);
      expect(rows(sql)).toMatchObject([{ sub: OWNER_SUB, name: NAME }]);
      // The new account has sessions of its own, also one with the same name.
      recordEntry(db, OTHER, "2026-10-14", undefined, TYPE);
      recordEntry(db, NAME, "2026-10-15", undefined, TYPE);
      expect(rows(sql)).toMatchObject([
        { sub: OWNER_SUB, name: NAME, day: "2026-10-13" },
        { sub: OTHER_SUB, name: NAME, day: "2026-10-15" },
        { sub: OTHER_SUB, name: OTHER, day: "2026-10-14" },
      ]);

      // The first account is linked again: its session is its own again, and the others are not.
      linkAccount(sql, OWNER_SUB);
      expect(hasEntry(db, NAME, TYPE)).toBe(true);
      expect(hasEntry(db, OTHER, TYPE)).toBe(false);
      expect([...entryNamesBetween(db, "2026-10-01", "2026-10-31", TYPE).values()]).toEqual([NAME]);
      forgetEntry(db, NAME, undefined, TYPE);
      expect(rows(sql)).toMatchObject([
        { sub: OTHER_SUB, name: NAME },
        { sub: OTHER_SUB, name: OTHER },
      ]);
    }));

  it("knows no session and records none when no account is linked", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13", undefined, TYPE);
      sql.exec("DELETE FROM google_account");
      expect(hasEntry(db, NAME, TYPE)).toBe(false);
      expect(entryIdsBetween(db, "2026-10-13", "2026-10-13", TYPE).size).toBe(0);
      forgetEntry(db, NAME, undefined, TYPE);
      expect(() => recordEntry(db, OTHER, "2026-10-13", OWNER_SUB, TYPE)).toThrow("store: no Google account is linked");
      // The row of the account that was linked stays, for when it is linked again.
      expect(rows(sql)).toMatchObject([{ sub: OWNER_SUB, name: NAME }]);
    }));

  it("does not record a session when the linked account is not the one the session was created for", () =>
    withDb((db, sql) => {
      // The account that was linked before the create was sent.
      const owner = linkedAccount(db);
      linkAccount(sql, OTHER_SUB);
      expect(() => recordEntry(db, NAME, "2026-10-13", owner, TYPE)).toThrow("store: another Google account was linked");
      expect(rows(sql)).toEqual([]);
      // The same account still: recorded.
      recordEntry(db, NAME, "2026-10-13", OTHER_SUB, TYPE);
      expect(rows(sql)).toMatchObject([{ sub: OTHER_SUB, name: NAME }]);
    }));
});
