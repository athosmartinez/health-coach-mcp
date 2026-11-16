// Coach notes.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolError } from "../src/coach/errors";
import { CorruptRowError, Db, formatStamp } from "../src/store/db";
import {
  DEFAULT_NOTE_LIMIT,
  MAX_NOTE_LIMIT,
  MAX_NOTE_TEXT,
  MAX_NOTES,
  MAX_QUERY_BYTES,
  MAX_QUERY_WORD_LEN,
  MAX_QUERY_WORDS,
  MAX_TAG_LEN,
  MAX_TAGS,
  type NoteFilter,
  type NoteInput,
  addNote,
  ftsQuery,
  ftsSyntaxError,
  searchNotes,
} from "../src/store/notes";
import { FIXED_NOW, SAO_PAULO, codeOf, freshStore, objectTool, withDb } from "./memory-helpers";

const SLOW = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notes", () => {
  it("searches by words, kind and date", () =>
    withDb((db) => {
      const knee = addNote(db, { kind: "symptom", text: "sore knee after squats", tags: ["knee", "legs"], related_date: "2026-10-10" });
      expect(knee).toEqual({
        id: expect.any(Number),
        kind: "symptom",
        text: "sore knee after squats",
        tags: ["knee", "legs"],
        related_date: "2026-10-10",
        created_at: "2026-10-14T12:00:00Z",
      });
      addNote(db, { kind: "decision", text: "cut carbs on rest days" });
      const weird = addNote(db, { kind: "checkin", text: 'a-b "quoted" AND weird text', related_date: "2026-09-01" });
      const acao = addNote(db, { kind: "insight", text: "Ação rápida: dor no joelho" });

      // Inserted after the migration: found only if the notes_ai trigger works.
      expect(searchNotes(db, { query: "knee" }).notes).toEqual([knee]);

      const cases: [string, number[]][] = [
        ["knee squats", [knee.id]],
        ["knee carbs", []], // words are ANDed
        ["KNEE", [knee.id]],
        ["kne", []], // no prefix matching
        ["legs", []], // tags are not indexed
        ["a-b", [weird.id]],
        ["AND", [weird.id]], // a literal word, not an operator
        ['"quoted"', [weird.id]],
        ['a-b "c" AND', []],
        ["acao", [acao.id]], // diacritics folded (unicode61)
        ["joelho dor", [acao.id]],
        ["knee\u0000", [knee.id]],
        ["NEAR(", []],
        ["text:x", []],
        ["*", []],
        ['"', []],
      ];
      for (const [query, want] of cases) {
        expect(searchNotes(db, { query }).notes.map((note) => note.id), `query ${JSON.stringify(query)}`).toEqual(want);
      }

      // A note without tags carries [], never null.
      expect(searchNotes(db, { kind: "decision" }).notes).toMatchObject([{ kind: "decision", tags: [] }]);
      // related_date wins over created_at (2026-10-14 for every note here).
      expect(searchNotes(db, { since: "2026-10-05" }).notes).toHaveLength(3);
      expect(searchNotes(db, { kind: "symptom", since: "2026-10-01", query: "knee" }).notes).toHaveLength(1);
      // kind narrows the FTS match.
      expect(searchNotes(db, { kind: "decision", query: "knee" }).notes).toEqual([]);
      expect(searchNotes(db, { limit: 1 })).toEqual({ notes: [acao], more: true });
      const all = searchNotes(db);
      expect(all.more).toBe(false);
      expect(all.notes).toHaveLength(4);

      const bad: NoteFilter[] = [
        { since: "bad" },
        { kind: "rant" },
        { query: "   " },
        { query: "\u0000" },
        { query: "w ".repeat(MAX_QUERY_WORDS + 1) },
      ];
      for (const filter of bad) expect(codeOf(() => searchNotes(db, filter)), JSON.stringify(filter).slice(0, 60)).toBe("invalid_input");
      expect(searchNotes(db, { query: "w ".repeat(MAX_QUERY_WORDS) }).notes).toEqual([]);
    }));

  it("clamps the limit", () =>
    withDb((db) => {
      for (let i = 0; i < MAX_NOTE_LIMIT + 5; i++) addNote(db, { kind: "checkin", text: "daily" });
      const clamped = searchNotes(db, { limit: 10_000 });
      expect(clamped.notes).toHaveLength(MAX_NOTE_LIMIT);
      expect(clamped.more).toBe(true);
      for (const limit of [undefined, 0, -3]) {
        const byDefault = searchNotes(db, { limit });
        expect(byDefault.notes).toHaveLength(DEFAULT_NOTE_LIMIT);
        expect(byDefault.more).toBe(true);
      }
    }));

  it("keeps the FTS index in sync with updates and deletes", () =>
    withDb((db, sql) => {
      const knee = addNote(db, { kind: "symptom", text: "sore knee" });
      sql.exec("UPDATE notes SET text = 'sore ankle' WHERE id = ?", knee.id);
      expect(searchNotes(db, { query: "knee" }).notes).toEqual([]);
      expect(searchNotes(db, { query: "ankle" }).notes).toHaveLength(1);

      sql.exec("DELETE FROM notes WHERE id = ?", knee.id);
      // The next note must not inherit the deleted note's index terms.
      const next = addNote(db, { kind: "checkin", text: "fresh start" });
      expect(next.id).not.toBe(knee.id);
      expect(searchNotes(db, { query: "ankle" }).notes).toEqual([]);
      // The FTS index matches the content table exactly (proves notes_ad ran).
      sql.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").toArray();
      expect(sql.exec("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH '\"ankle\"'").one().n).toBe(0);
    }));

  it("validates a note", () =>
    withDb((db) => {
      const bad: NoteInput[] = [
        { kind: "checkin", text: "  " },
        { kind: "rant", text: "x" },
        { kind: "checkin", text: "a".repeat(MAX_NOTE_TEXT + 1) },
        { kind: "checkin", text: "x", tags: Array.from({ length: MAX_TAGS + 1 }, () => "t") },
        { kind: "checkin", text: "x", tags: [""] },
        { kind: "checkin", text: "x", tags: ["t".repeat(MAX_TAG_LEN + 1)] },
        { kind: "checkin", text: "x", related_date: "today" },
        { kind: "checkin", text: "x", related_date: "2026-02-30" },
      ];
      for (const note of bad) expect(codeOf(() => addNote(db, note)), JSON.stringify(note).slice(0, 60)).toBe("invalid_input");
      expect(searchNotes(db).notes).toEqual([]);

      const tags = Array.from({ length: MAX_TAGS }, () => "t".repeat(MAX_TAG_LEN));
      const atLimits = addNote(db, { kind: "checkin", text: "a".repeat(MAX_NOTE_TEXT), tags });
      expect(atLimits.tags).toHaveLength(MAX_TAGS);
    }));

  it("orders notes written in the same second, and round-trips their stamps", () => {
    // 12:00:00.0 then 12:00:00.5: stamps must round-trip exactly and compare as
    // text, which variable-width stamps do not.
    const stamps = [new Date("2026-10-14T12:00:00Z"), new Date("2026-10-14T12:00:00.500Z")];
    let calls = 0;
    return withDb(
      (db, sql) => {
        const first = addNote(db, { kind: "checkin", text: "first" });
        const second = addNote(db, { kind: "checkin", text: "second" });
        const hits = searchNotes(db).notes;
        expect(hits.map((note) => note.id)).toEqual([second.id, first.id]);
        expect(hits.map((note) => note.created_at)).toEqual(["2026-10-14T12:00:00.5Z", "2026-10-14T12:00:00Z"]);
        expect(sql.exec("SELECT created_at FROM notes ORDER BY id").toArray()).toEqual([
          { created_at: "2026-10-14T12:00:00.000000000Z" },
          { created_at: "2026-10-14T12:00:00.500000000Z" },
        ]);
        const earlier = sql
          .exec("SELECT (SELECT created_at FROM notes WHERE id = ?) < (SELECT created_at FROM notes WHERE id = ?) AS lt", first.id, second.id)
          .one();
        expect(earlier.lt).toBe(1);
      },
      () => stamps[Math.min(calls++, 1)] ?? FIXED_NOW,
    );
  });

  it("uses the real clock by default", () =>
    runInDurableObject(freshStore(), (_instance, state) => {
      const before = Date.now();
      const note = addNote(new Db(state.storage), { kind: "checkin", text: "x" });
      const created = Date.parse(note.created_at);
      expect(created).toBeGreaterThanOrEqual(before - 1000);
      expect(created).toBeLessThanOrEqual(Date.now() + 1000);
    }));

  it("turns since into an instant with the given zone", () =>
    withDb(
      (db) => {
        // Created 2026-10-14 01:00 UTC = 2026-10-13 22:00 in São Paulo.
        addNote(db, { kind: "checkin", text: "late note" });
        expect(searchNotes(db, { since: "2026-10-14", zone: SAO_PAULO }).notes).toEqual([]);
        expect(searchNotes(db, { since: "2026-10-13", zone: SAO_PAULO }).notes).toHaveLength(1);
        // Without a zone the day is the UTC day.
        expect(searchNotes(db, { since: "2026-10-14" }).notes).toHaveLength(1);
      },
      () => new Date("2026-10-14T01:00:00Z"),
    ));

  it("filters with until, alone and with since", () =>
    withDb(
      (db) => {
        // Created 2026-10-14 01:00 UTC = 2026-10-13 22:00 in São Paulo.
        addNote(db, { kind: "decision", text: "early", related_date: "2026-10-10" });
        addNote(db, { kind: "decision", text: "late", related_date: "2026-10-20" });
        addNote(db, { kind: "decision", text: "undated" });
        const texts = (filter: NoteFilter) => searchNotes(db, filter).notes.map((note) => note.text).sort().join(",");
        const cases: [NoteFilter, string][] = [
          [{ until: "2026-10-12", zone: SAO_PAULO }, "early"],
          [{ until: "2026-10-13", zone: SAO_PAULO }, "early,undated"], // created on local Oct 13
          [{ until: "2026-10-13" }, "early"], // Oct 14 in UTC
          [{ since: "2026-10-11", until: "2026-10-20", zone: SAO_PAULO }, "late,undated"],
          [{ since: "2026-10-20", until: "2026-10-20", zone: SAO_PAULO }, "late"],
        ];
        for (const [filter, want] of cases) expect(texts(filter), JSON.stringify({ ...filter, zone: filter.zone?.name })).toBe(want);
        for (const filter of [{ until: "bad" }, { since: "2026-10-12", until: "2026-10-11" }]) {
          expect(codeOf(() => searchNotes(db, filter))).toBe("invalid_input");
        }
      },
      () => new Date("2026-10-14T01:00:00Z"),
    ));

  it("maps only an FTS5 syntax error to invalid_input", () => {
    const mapped = ftsSyntaxError(new Error('SQL logic error: fts5: syntax error near "AND"'));
    expect(mapped).toBeInstanceOf(ToolError);
    expect((mapped as ToolError).wire()).toEqual({ code: "invalid_input", message: "the search text could not be parsed", hint: "use plain words" });
    // Other FTS5 failures are real faults and must not be blamed on the input.
    for (const message of ["fts5: missing row 3 from content table", "no such module: fts5", "disk full"]) {
      const error = new Error(message);
      expect(ftsSyntaxError(error)).toBe(error);
    }
    expect(ftsSyntaxError("not an error")).toBe("not an error");
  });

  it("quotes every word of a query as a phrase", () => {
    expect(ftsQuery('knee  "squats" AND')).toBe('"knee" """squats""" "AND"');
    expect(ftsQuery("a\u0000b")).toBe('"ab"');
  });

  it("caps the length of a query and of its words", () =>
    withDb((db) => {
      expect(codeOf(() => searchNotes(db, { query: "ab ".repeat(MAX_QUERY_BYTES / 3 + 1) }))).toBe("invalid_input");
      expect(codeOf(() => searchNotes(db, { query: "a".repeat(MAX_QUERY_WORD_LEN + 1) }))).toBe("invalid_input");
      expect(searchNotes(db, { query: "a".repeat(MAX_QUERY_WORD_LEN) }).notes).toEqual([]);
      // Bytes, not characters: 32 two-byte letters are 64 bytes, 33 are 66.
      expect(searchNotes(db, { query: "é".repeat(MAX_QUERY_WORD_LEN / 2) }).notes).toEqual([]);
      expect(codeOf(() => searchNotes(db, { query: "é".repeat(MAX_QUERY_WORD_LEN / 2 + 1) }))).toBe("invalid_input");
    }));

  it("fails the search on a corrupt timestamp, but not on unreadable tags", () =>
    withDb((db, sql) => {
      addNote(db, { kind: "checkin", text: "x", tags: ["a"] });
      addNote(db, { kind: "checkin", text: "y", tags: ["b"] });
      sql.exec("UPDATE notes SET created_at = 'yesterday'");
      // A corrupt created_at is never read as an empty time.
      expect(() => searchNotes(db)).toThrow(CorruptRowError);

      sql.exec("UPDATE notes SET created_at = ?, tags = '[bad' WHERE text = 'x'", formatStamp(FIXED_NOW));
      sql.exec("UPDATE notes SET created_at = ? WHERE text = 'y'", formatStamp(FIXED_NOW));
      // One note with unreadable tags must not hide every other note.
      expect(searchNotes(db).notes).toMatchObject([
        { text: "y", tags: ["b"] },
        { text: "x", tags: [], tags_unreadable: true },
      ]);
      expect(searchNotes(db).notes[0]).not.toHaveProperty("tags_unreadable");
      for (const stored of ['{"a":1}', "[1, 2]", '"knee"']) {
        sql.exec("UPDATE notes SET tags = ? WHERE text = 'x'", stored);
        expect(searchNotes(db).notes[1], stored).toMatchObject({ tags: [], tags_unreadable: true });
      }
      sql.exec("UPDATE notes SET tags = NULL WHERE text = 'x'");
      expect(searchNotes(db).notes[1]).toEqual({ id: expect.any(Number), kind: "checkin", text: "x", tags: [], created_at: "2026-10-14T12:00:00Z" });
    }));

  it("caps the table", { timeout: SLOW }, () =>
    withDb((db, sql) => {
      // Filled straight through SQL: 50k calls would be slow.
      sql
        .exec(
          `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < ?)
           INSERT INTO notes (kind, text, created_at) SELECT 'checkin', 'n', ? FROM seq`,
          MAX_NOTES - 1,
          formatStamp(FIXED_NOW),
        )
        .toArray();
      expect(addNote(db, { kind: "checkin", text: "the last one" }).id).toBe(MAX_NOTES);
      expect(codeOf(() => addNote(db, { kind: "checkin", text: "one more" }))).toBe("invalid_input");
    }));

  // The Go test writes from 20 goroutines to prove busy_timeout works. Here the
  // calls arrive together at the object and every one must be stored.
  it("stores every note of calls that arrive together", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = freshStore();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => objectTool(stub, "note_add", { kind: "checkin", text: "concurrent note" })),
    );
    for (const outcome of outcomes) expect(outcome.ok).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM notes").one().n).toBe(20);
    });
  });
});
