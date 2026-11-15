// The table of the food entries this server created (src/store/entries.ts).
// All values are synthetic.
import { describe, expect, it } from "vitest";

import { ENTRY_NAMES_BETWEEN, entryIdsBetween, forgetEntry, hasEntry, recordEntry } from "../src/store/entries";
import { fixedClock, withDb } from "./memory-helpers";
import { linkAccount } from "./memory-helpers";
import { linkedAccount } from "../src/store/entries";
import { OWNER_SUB } from "./helpers";

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

  it("lists the data point ids of the entries of a range of days, both ends counted", () =>
    withDb((db) => {
      recordEntry(db, "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-a", "2026-10-12");
      recordEntry(db, "users/me/dataTypes/nutrition-log/dataPoints/syn-b", "2026-10-13");
      recordEntry(db, "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-c", "2026-10-13");
      recordEntry(db, "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-d", "2026-10-14");
      recordEntry(db, "users/1122334455/dataTypes/nutrition-log/dataPoints/syn-e", "2026-10-15");
      // The ids, without the user part of the names.
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-14")].sort()).toEqual(["syn-b", "syn-c", "syn-d"]);
      expect([...entryIdsBetween(db, "2026-10-12", "2026-10-12")]).toEqual(["syn-a"]);
      expect(entryIdsBetween(db, "2026-10-16", "2026-10-20").size).toBe(0);
      expect(entryIdsBetween(db, "2026-10-14", "2026-10-13").size).toBe(0);
      // A deleted entry is no longer listed.
      forgetEntry(db, "users/me/dataTypes/nutrition-log/dataPoints/syn-b");
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13")]).toEqual(["syn-c"]);
    }));

  it("leaves out a row whose name no longer reads as a data point name", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      recordEntry(db, OTHER, "2026-10-13");
      sql.exec("UPDATE nutrition_entries SET name = 'not a name' WHERE name = ?", OTHER);
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13")]).toEqual(["syn-entry-1"]);
    }));

  it("reads the entries of a range of days through the index of the day", () =>
    withDb((db, sql) => {
      for (let n = 0; n < 300; n++) recordEntry(db, `users/1122334455/dataTypes/nutrition-log/dataPoints/syn-old-${n}`, "2026-09-01");
      recordEntry(db, NAME, "2026-10-13");
      recordEntry(db, OTHER, "2026-10-14");
      // The query of entryIdsBetween itself: the days through their index, then the account of each row.
      const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${ENTRY_NAMES_BETWEEN}`, "2026-10-12", "2026-10-14").toArray();
      expect(plan.map((row) => row.detail).join(" ")).toContain("USING INDEX nutrition_entries_by_day (day>? AND day<?)");
      const read = sql.exec(ENTRY_NAMES_BETWEEN, "2026-10-12", "2026-10-14");
      expect(read.toArray()).toHaveLength(2);
      // The 300 rows of the other days are not read: the read does not walk every entry of the account.
      expect(read.rowsRead).toBeLessThanOrEqual(8);
      expect(entryIdsBetween(db, "2026-10-12", "2026-10-14").size).toBe(2);
    }));

  it("lists only the ids of the account that is linked now", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13")]).toEqual(["syn-entry-1"]);

      // Another account is linked: the id of the first account is not its own.
      linkAccount(sql, "200000000000000000002");
      expect(entryIdsBetween(db, "2026-10-13", "2026-10-13").size).toBe(0);
      recordEntry(db, OTHER, "2026-10-13");
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13")]).toEqual(["syn-entry-2"]);

      // The first account again: its own id, and not the other one.
      linkAccount(sql, OWNER_SUB);
      expect([...entryIdsBetween(db, "2026-10-13", "2026-10-13")]).toEqual(["syn-entry-1"]);
      // No account linked: no entry is the server's own.
      sql.exec("DELETE FROM google_account");
      expect(entryIdsBetween(db, "2026-10-13", "2026-10-13").size).toBe(0);
    }));

  it("finds an entry through the primary key, and writes three rows for one", () =>
    withDb((db, sql) => {
      for (let n = 0; n < 200; n++) recordEntry(db, `users/1122334455/dataTypes/nutrition-log/dataPoints/syn-fill-${n}`, "2026-10-13");
      const written = sql.exec("INSERT INTO nutrition_entries (sub, name, day, created_at) VALUES (?, ?, '2026-10-13', 'x')", OWNER_SUB, NAME).rowsWritten;
      // The row, the entry of the primary key and the entry of the day index.
      expect(written).toBe(3);
      const lookup = sql.exec("SELECT COUNT(*) FROM nutrition_entries WHERE sub = ? AND name = ?", OWNER_SUB, NAME);
      lookup.toArray();
      expect(lookup.rowsRead).toBe(1);
      expect(hasEntry(db, NAME)).toBe(true);
    }));
});

// An entry belongs to the Google account that was linked when it was created.
// With another account linked, a delete would go out with the wrong token.
describe("the entries of the linked Google account", () => {
  const OTHER_SUB = "200000000000000000002";
  const owners = (sql: SqlStorage) => sql.exec("SELECT sub, name FROM nutrition_entries ORDER BY sub, name").toArray();

  it("records an entry for the account that is linked now", () =>
    withDb((db, sql) => {
      expect(linkedAccount(db)).toBe(OWNER_SUB);
      recordEntry(db, NAME, "2026-10-13");
      expect(owners(sql)).toEqual([{ sub: OWNER_SUB, name: NAME }]);
      // The row has the account, the name, the day and the creation time: nothing of the food.
      const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('nutrition_entries') ORDER BY cid").toArray();
      expect(columns.map((column) => column.name)).toEqual(["sub", "name", "day", "created_at"]);
    }));

  it("knows only the entries of the linked account, and keeps the rows of another account", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      expect(hasEntry(db, NAME)).toBe(true);

      // Another account is linked: the entry of the first one is not this server's own now.
      linkAccount(sql, OTHER_SUB);
      expect(linkedAccount(db)).toBe(OTHER_SUB);
      expect(hasEntry(db, NAME)).toBe(false);
      // Forgetting it does nothing: the row is not the linked account's.
      forgetEntry(db, NAME);
      expect(owners(sql)).toEqual([{ sub: OWNER_SUB, name: NAME }]);
      // The new account has entries of its own.
      recordEntry(db, OTHER, "2026-10-14");
      expect(hasEntry(db, OTHER)).toBe(true);

      // The first account is linked again: its entry is its own again, and the other one is not.
      linkAccount(sql, OWNER_SUB);
      expect(hasEntry(db, NAME)).toBe(true);
      expect(hasEntry(db, OTHER)).toBe(false);
      forgetEntry(db, NAME);
      expect(owners(sql)).toEqual([{ sub: OTHER_SUB, name: OTHER }]);
    }));

  it("keeps one row per account for a name that two accounts hold", () =>
    withDb((db, sql) => {
      const shared = "users/me/dataTypes/nutrition-log/dataPoints/syn-shared";
      recordEntry(db, shared, "2026-10-13");
      linkAccount(sql, OTHER_SUB);
      expect(hasEntry(db, shared)).toBe(false);
      recordEntry(db, shared, "2026-10-14");
      expect(sql.exec("SELECT sub, day FROM nutrition_entries ORDER BY sub").toArray()).toEqual([
        { sub: OWNER_SUB, day: "2026-10-13" },
        { sub: OTHER_SUB, day: "2026-10-14" },
      ]);
      // A delete for one account leaves the row of the other.
      forgetEntry(db, shared);
      expect(owners(sql)).toEqual([{ sub: OWNER_SUB, name: shared }]);
    }));

  it("knows no entry and records none when no account is linked", () =>
    withDb((db, sql) => {
      recordEntry(db, NAME, "2026-10-13");
      sql.exec("DELETE FROM google_account");
      expect(linkedAccount(db)).toBeUndefined();
      expect(hasEntry(db, NAME)).toBe(false);
      forgetEntry(db, NAME);
      expect(() => recordEntry(db, OTHER, "2026-10-13")).toThrow("store: no Google account is linked");
      expect(() => recordEntry(db, OTHER, "2026-10-13", OWNER_SUB)).toThrow("store: no Google account is linked");
      // The row of the account that was linked stays, for when it is linked again.
      expect(owners(sql)).toEqual([{ sub: OWNER_SUB, name: NAME }]);
    }));

  it("does not record an entry when the linked account is not the one the entry was created for", () =>
    withDb((db, sql) => {
      // The account that was linked before the create was sent.
      const owner = linkedAccount(db);
      linkAccount(sql, OTHER_SUB);
      expect(() => recordEntry(db, NAME, "2026-10-13", owner)).toThrow("store: another Google account was linked");
      expect(owners(sql)).toEqual([]);
      // The same account still: recorded.
      recordEntry(db, NAME, "2026-10-13", OTHER_SUB);
      expect(owners(sql)).toEqual([{ sub: OTHER_SUB, name: NAME }]);
    }));
});
