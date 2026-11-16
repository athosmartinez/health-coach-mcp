// Ports of internal/healthdata/exercise_test.go: workout sessions and their
// max heart rate.
import { describe, expect, it } from "vitest";

import { MAX_DISPLAY_NAME_CHARS, MAX_KCAL, MAX_SESSION_SECONDS, type NewExerciseSession, createBody } from "../src/googlehealth/exerciselog";
import { type Cache, MAX_HR_SESSIONS, MAX_SESSION_KCAL, dbCache } from "../src/healthdata";
import { parseExercise } from "../src/healthdata/exercise";
import { FLAG_LOW_HR_FOR_ACTIVITY, FLAG_MANUAL_ENTRY, FLAG_NO_HR_DATA, FLAG_OVERLAPS_BAND_SESSION } from "../src/metrics/quality";
import type { Db } from "../src/store/db";
import { recordEntry } from "../src/store/entries";
import { MAX_NAME_CHARS } from "../src/tools/foodlog";
import { DiskError, HOUR, MINUTE, SECOND, at, exerciseRec, failingCache, harness, hrSample, inStore, newData, plus, samplesEvery2s } from "./healthdata-helpers";

const h = harness();

const D10 = "2026-10-10";
const ZONES: [number, number, number, number] = [10, 20, 20, 10];
const between = (calls: string[]) => calls.filter((call) => call.startsWith("between "));
const unavailable = () => Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });

describe("exercises", () => {
  it("reads the sessions of each day, oldest first", () =>
    inStore(async (db) => {
      h.google.add(
        "exercise",
        exerciseRec(at(D10, 19, 0), at(D10, 20, 0), { type: "JIU_JITSU", avgHR: 81, kcal: 450, azm: 12, zones: [30, 20, 5, 0] }),
        exerciseRec(at(D10, 7, 0), at(D10, 8, 0), { type: "STRENGTH_TRAINING", avgHR: 105, kcal: 300.5, activeMin: 52 }),
        // Logged by hand, but the band measured it.
        exerciseRec(at("2026-10-11", 18, 0), at("2026-10-11", 19, 0), { type: "PILATES", method: "MANUAL", avgHR: 95, kcal: 200 }),
        exerciseRec(at("2026-10-11", 9, 0), at("2026-10-11", 9, 30), { type: "CORE_TRAINING" }), // no heart rate
      );
      const ex = await newData(db).exercises(D10, "2026-10-11", false);
      expect(ex.sessions.map((session) => session.type)).toEqual(["STRENGTH_TRAINING", "JIU_JITSU", "CORE_TRAINING", "PILATES"]);
      const [strength, jiuJitsu, core, manual] = ex.sessions;
      // Average HR 81 over 60 minutes of jiu-jitsu: the band probably missed the effort.
      expect(jiuJitsu).toEqual({
        id: `users/me/dataTypes/exercise/dataPoints/syn-${at(D10, 19, 0).getTime() / 1000}`,
        day: D10,
        type: "JIU_JITSU",
        name: "JIU JITSU",
        start: at(D10, 19, 0),
        end: at(D10, 20, 0),
        activeMin: 60,
        kcal: 450,
        azm: 12,
        hr: { avgBpm: 81, maxBpm: null, zoneMin: { light: 30, moderate: 20, vigorous: 5, peak: 0 } },
        manual: false,
        source: "Synthetic Band",
        flags: [FLAG_LOW_HR_FOR_ACTIVITY],
      });
      expect(strength).toMatchObject({ activeMin: 52, flags: [], kcal: 300.5 });
      expect(manual).toMatchObject({ manual: true, hr: { avgBpm: 95 }, flags: [FLAG_MANUAL_ENTRY], source: "FITBIT" });
      expect(core).toMatchObject({ hr: null, flags: [FLAG_NO_HR_DATA], kcal: 0 });
      expect(ex).toMatchObject({ skipped: 0, otherSource: 0, maxHROmitted: 0, from: D10, to: "2026-10-11" });
      // The max heart rate is not fetched unless asked for.
      expect(between(h.google.takeCalls())).toEqual([]);
    }));

  it("takes the highest median of 5 consecutive samples as the max heart rate", () =>
    inStore(async (db) => {
      const [start, end] = [at(D10, 19, 0), at(D10, 20, 0)];
      h.google.add(
        "exercise",
        exerciseRec(start, end, { type: "RUNNING", avgHR: 150, zones: ZONES }),
        exerciseRec(at(D10, 7, 0), at(D10, 7, 30), { type: "CORE_TRAINING" }), // no HR: no request
      );
      h.google.add("heart-rate", ...samplesEvery2s(start, plus(start, 10 * MINUTE), 150));
      // A sustained 172 for 12 s near the end is the max.
      h.google.add("heart-rate", ...samplesEvery2s(plus(end, -12 * SECOND), end, 172));
      h.google.add(
        "heart-rate",
        hrSample(plus(start, 5 * MINUTE + SECOND), 215), // a one-sample optical spike
        hrSample(plus(start, 20 * MINUTE), 190, "HEALTH_KIT"), // not the band
        hrSample(plus(start, 30 * MINUTE), 260), // implausible
      );
      h.google.add("heart-rate", ...samplesEvery2s(plus(end, MINUTE), plus(end, 2 * MINUTE), 199)); // after the session
      const ex = await newData(db).exercises(D10, D10, true);
      expect(ex.sessions[1]?.hr?.maxBpm).toBe(172);
      expect(between(h.google.takeCalls())).toEqual(["between heart-rate 2026-10-10T22:00:00Z..2026-10-10T23:00:01Z"]);
    }));

  it("has no max heart rate with fewer samples than one window", () =>
    inStore(async (db) => {
      const [start, end] = [at(D10, 19, 0), at(D10, 20, 0)];
      h.google.add("exercise", exerciseRec(start, end, { type: "RUNNING", avgHR: 150, zones: ZONES }));
      h.google.add("heart-rate", ...samplesEvery2s(start, plus(start, 8 * SECOND), 160));
      const data = newData(db);
      const ex = await data.exercises(D10, D10, true);
      expect(ex.sessions[0]?.hr).toMatchObject({ avgBpm: 150, maxBpm: null });
      h.google.fail = unavailable;
      await expect(data.exercises(D10, D10, true)).rejects.toMatchObject({ code: "upstream_unavailable" });
    }));

  it("logs heart-rate samples that arrive unreadable, without their values", () =>
    inStore(async (db) => {
      const [start, end] = [at(D10, 19, 0), at(D10, 20, 0)];
      h.google.add("exercise", exerciseRec(start, end, { type: "RUNNING", avgHR: 150, zones: ZONES }));
      // The value field was renamed: the samples have a time and no rate.
      for (let i = 0; i < 7; i++) {
        h.google.add("heart-rate", { dataSource: { platform: "FITBIT" }, heartRate: { bpm: "187", sampleTime: { physicalTime: plus(start, i * SECOND).toISOString() } } });
      }
      const ex = await newData(db).exercises(D10, D10, true);
      expect(ex.sessions[0]?.hr?.maxBpm).toBeNull();
      expect(h.warnings()).toEqual([["heart rate samples arrived but none were usable", { unreadable: 7 }]]);
      expect(h.logged()).not.toContain("187");
    }));

  it("caps the max heart rate requests of one call", () =>
    inStore(async (db) => {
      const first = at("2026-09-01", 19, 0);
      for (let i = 0; i < MAX_HR_SESSIONS + 2; i++) {
        const start = plus(first, i * 24 * HOUR);
        h.google.add("exercise", exerciseRec(start, plus(start, HOUR), { type: "RUNNING", avgHR: 150, zones: ZONES }));
        h.google.add("heart-rate", ...samplesEvery2s(start, plus(start, MINUTE), 160));
      }
      const ex = await newData(db).exercises("2026-09-01", "2026-10-03", true);
      // The newest sessions get a max; the two oldest are counted as omitted.
      expect(between(h.google.takeCalls())).toHaveLength(MAX_HR_SESSIONS);
      expect(ex.maxHROmitted).toBe(2);
      expect(ex.sessions).toHaveLength(MAX_HR_SESSIONS + 2);
      expect(ex.sessions.map((session) => session.hr?.maxBpm)).toEqual([null, null, ...new Array(MAX_HR_SESSIONS).fill(160)]);
    }));

  it("reads the heart rate of one session when asked for it by ID, with the cap counted as in a read of all", () =>
    inStore(async (db) => {
      const first = at("2026-09-01", 19, 0);
      const id = (i: number) => `users/me/dataTypes/exercise/dataPoints/syn-only-${i}`;
      const count = MAX_HR_SESSIONS + 2;
      for (let i = 0; i < count; i++) {
        const start = plus(first, i * 24 * HOUR);
        h.google.add("exercise", exerciseRec(start, plus(start, HOUR), { type: "RUNNING", avgHR: 150, zones: ZONES, name: id(i) }));
        h.google.add("heart-rate", ...samplesEvery2s(start, plus(start, MINUTE), 130 + i));
      }
      const data = newData(db);
      const all = await data.exercises("2026-09-01", "2026-10-03", true);
      expect(between(h.google.takeCalls())).toHaveLength(MAX_HR_SESSIONS);
      const maxOf = (ex: typeof all, i: number) => ex.sessions.find((session) => session.id === id(i))?.hr?.maxBpm;

      // A session under the cap: one heart-rate list, for its own hour.
      const newest = await data.exercises("2026-09-01", "2026-10-03", true, id(count - 1));
      expect(between(h.google.takeCalls())).toEqual(["between heart-rate 2026-10-03T22:00:00Z..2026-10-03T23:00:01Z"]);
      expect(maxOf(newest, count - 1)).toBe(130 + count - 1);
      expect(maxOf(newest, count - 1)).toBe(maxOf(all, count - 1));
      // The last session under the cap, counted from the newest.
      const last = await data.exercises("2026-09-01", "2026-10-03", true, id(2));
      expect(between(h.google.takeCalls())).toHaveLength(1);
      expect(maxOf(last, 2)).toBe(132);
      expect(maxOf(last, 2)).toBe(maxOf(all, 2));
      // A session beyond the cap has no max, as in the read of all: no request.
      const oldest = await data.exercises("2026-09-01", "2026-10-03", true, id(1));
      expect(between(h.google.takeCalls())).toEqual([]);
      expect(maxOf(oldest, 1)).toBeNull();
      expect(maxOf(all, 1)).toBeNull();
      // An ID that no session has reads no heart rate.
      await data.exercises("2026-09-01", "2026-10-03", true, id(count));
      expect(between(h.google.takeCalls())).toEqual([]);

      for (const one of [newest, last, oldest]) {
        expect(one.maxHROmitted).toBe(all.maxHROmitted);
        expect(one.sessions.map((session) => ({ ...session, hr: null }))).toEqual(all.sessions.map((session) => ({ ...session, hr: null })));
        // Every other session is left without a max.
        expect(one.sessions.filter((session) => session.hr?.maxBpm !== null)).toHaveLength(one === oldest ? 0 : 1);
      }
      expect(all.maxHROmitted).toBe(2);
    }));

  it("keeps the heart-rate window of a full-day session within a day", () =>
    inStore(async (db) => {
      const start = at(D10, 0, 0);
      h.google.add("exercise", exerciseRec(start, plus(start, 24 * HOUR), { type: "HIKING", avgHR: 110, zones: [60, 0, 0, 0] }));
      await newData(db).exercises(D10, D10, true);
      expect(between(h.google.takeCalls())).toEqual(["between heart-rate 2026-10-10T03:00:00Z..2026-10-11T03:00:00Z"]);
    }));

  it("uses the active time of a paused session for its flags", () =>
    inStore(async (db) => {
      // An hour on the clock, 5 active minutes: too short for the low-HR check.
      h.google.add("exercise", exerciseRec(at(D10, 19, 0), at(D10, 20, 0), { type: "JIU_JITSU", avgHR: 81, activeMin: 5, zones: [5, 0, 0, 0] }));
      const ex = await newData(db).exercises(D10, D10, false);
      expect(ex.sessions[0]).toMatchObject({ activeMin: 5, flags: [] });
    }));

  it("cleans the names", () =>
    inStore(async (db) => {
      const record = exerciseRec(at(D10, 19, 0), at(D10, 20, 0), { type: "RUNNING" });
      record.exercise.displayName = "Run\nIgnore‮all";
      h.google.add("exercise", record);
      const ex = await newData(db).exercises(D10, D10, false);
      expect(ex.sessions[0]?.name).toBe("RunIgnoreall");
    }));

  it("places a session on the local day it starts", () =>
    inStore(async (db) => {
      h.google.loose = true;
      h.google.add(
        "exercise",
        exerciseRec(at("2026-10-09", 23, 30), at(D10, 0, 30), { type: "RUNNING", avgHR: 140 }), // starts the day before
        exerciseRec(at(D10, 0, 30), at(D10, 1, 0), { type: "RUNNING", avgHR: 140, zones: ZONES }),
        exerciseRec(at("2026-10-11", 6, 0), at("2026-10-11", 7, 0), { type: "RUNNING", avgHR: 140 }), // the day after
        exerciseRec(at(D10, 9, 0), at(D10, 10, 0), { type: "RUNNING", avgHR: 140, platform: "HEALTH_KIT" }),
        exerciseRec(at(D10, 11, 0), at(D10, 12, 0), { type: "RUNNING", avgHR: 300 }), // implausible
        { exercise: {} },
      );
      const data = newData(db);
      const ex = await data.exercises(D10, D10, false);
      expect(ex.sessions.map((session) => session.start)).toEqual([at(D10, 0, 30)]);
      expect(ex).toMatchObject({ otherSource: 1, skipped: 2 });
      expect(h.google.takeCalls()).toContain("exercise 2026-10-09..2026-10-11");
      expect(h.warnings()).toEqual([["unreadable exercise records", { from: D10, to: D10, skipped: 2 }]]);
      await expect(data.exercises(D10, "2026-10-09", false)).rejects.toThrow(/^healthdata: range ends/);
      h.google.fail = unavailable;
      await expect(data.exercises(D10, D10, false)).rejects.toMatchObject({ code: "upstream_unavailable" });
    }));
});

// The Worker's own rule: the Go server writes nothing to Google Health, so it
// has no session of its own to keep.
describe("the sessions this server created", () => {
  /** The name the create answered, which the store holds, and the name a list gives the same point. */
  const stored = (id: string) => `users/1122334455/dataTypes/exercise/dataPoints/${id}`;
  const listed = (id: string) => `users/me/dataTypes/exercise/dataPoints/${id}`;
  /** A session as a list shows one that was written through the API: the API's platform, entered by hand. */
  const apiRec = (id: string, start: Date, end: Date, options: Partial<Parameters<typeof exerciseRec>[2]> = {}) =>
    exerciseRec(start, end, { type: "OTHER", platform: "GOOGLE_WEB_API", method: "MANUAL", name: listed(id), ...options });
  const own = (db: Db, id: string, day = D10) => recordEntry(db, stored(id), day, undefined, "exercise");
  const LOGGED = [FLAG_MANUAL_ENTRY, FLAG_NO_HR_DATA];

  /** 2026-10-16 07:10 to 08:25 in São Paulo, as the client writes a session. */
  const WRITTEN: NewExerciseSession = {
    exerciseType: "OTHER",
    displayName: "Capoeira angola",
    start: new Date("2026-10-16T10:10:00Z"),
    end: new Date("2026-10-16T11:25:00Z"),
    startUtcOffsetSeconds: -10_800,
    endUtcOffsetSeconds: -10_800,
    kcal: 431.5,
    notes: "Roda de sexta",
  };

  it("keeps the body that the client writes, with its calories and its length, only as a session this server created", () => {
    const record = { name: listed("syn-own"), ...createBody(WRITTEN) };
    // The body says GOOGLE_WEB_API, the platform of the documented answer: without its id, such a session is another source.
    expect(parseExercise(record)).toEqual({ kind: "other", start: Date.parse("2026-10-16T10:10:00Z") });
    expect(parseExercise(record, new Set(["syn-other"]))).toEqual({ kind: "other", start: Date.parse("2026-10-16T10:10:00Z") });
    expect(parseExercise(record, new Set(["syn-own"]))).toEqual({
      kind: "session",
      session: {
        id: listed("syn-own"),
        type: "OTHER",
        name: "Capoeira angola",
        start: Date.parse("2026-10-16T10:10:00Z"),
        end: Date.parse("2026-10-16T11:25:00Z"),
        activeMin: 75,
        kcal: 431.5,
        azm: 0,
        hr: null,
        manual: true,
        source: "GOOGLE_WEB_API",
      },
    });
  });

  it("has the bounds of a written session: a value the client writes is a value the reader keeps", () => {
    expect(MAX_KCAL).toBe(MAX_SESSION_KCAL);
    expect(MAX_DISPLAY_NAME_CHARS).toBe(MAX_NAME_CHARS);
    const start = new Date("2026-10-15T03:00:00Z");
    // The longest session, the most calories, the longest name.
    const longest = createBody({ ...WRITTEN, start, end: new Date(start.getTime() + MAX_SESSION_SECONDS * 1000), kcal: MAX_KCAL, displayName: "a".repeat(MAX_DISPLAY_NAME_CHARS) });
    expect(parseExercise({ name: listed("syn-own"), ...longest }, new Set(["syn-own"]))).toMatchObject({
      kind: "session",
      session: { activeMin: 1440, kcal: 10_000, name: "a".repeat(64) },
    });
    // Without calories the session has none: unknown, not zero.
    const bare = createBody({ ...WRITTEN, kcal: undefined });
    expect(parseExercise({ name: listed("syn-own"), ...bare }, new Set(["syn-own"]))).toMatchObject({ kind: "session", session: { kcal: null } });
  });

  it("keeps a session of the API's platform only when this server created it", () =>
    inStore(async (db) => {
      own(db, "syn-own");
      h.google.add(
        "exercise",
        apiRec("syn-own", at(D10, 12, 0), at(D10, 12, 45), { kcal: 250.5 }),
        // Written through the API by another app, and a session of another platform.
        apiRec("syn-foreign", at(D10, 13, 0), at(D10, 14, 0)),
        exerciseRec(at(D10, 9, 0), at(D10, 10, 0), { type: "RUNNING", platform: "HEALTH_KIT" }),
      );
      const ex = await newData(db).exercises(D10, D10, true);
      expect(ex.sessions).toEqual([
        {
          id: listed("syn-own"),
          day: D10,
          type: "OTHER",
          name: "OTHER",
          start: at(D10, 12, 0),
          end: at(D10, 12, 45),
          activeMin: 45,
          kcal: 250.5,
          azm: 0,
          hr: null,
          // Entered by hand through the tool.
          manual: true,
          source: "GOOGLE_WEB_API",
          flags: LOGGED,
        },
      ]);
      expect(ex).toMatchObject({ otherSource: 2, skipped: 0 });
      // The stored name by data point id: what workout_review returns as entry_id.
      expect([...ex.ownNames]).toEqual([["syn-own", stored("syn-own")]]);
      // A session without heart rate costs no heart-rate request.
      expect(between(h.google.takeCalls())).toEqual([]);

      // A source without the table of logged sessions keeps the rule of the Go server.
      const bare = await newData(db, { cache: failingCache(db, {}) }).exercises(D10, D10, false);
      expect(bare).toMatchObject({ sessions: [], otherSource: 3 });
      expect(bare.ownNames.size).toBe(0);
    }));

  it("has no heart rate for a logged session of the API's platform, whatever its record carries", () =>
    inStore(async (db) => {
      for (const id of ["syn-a", "syn-b", "syn-c"]) own(db, id);
      const [start, end] = [at(D10, 19, 0), at(D10, 20, 0)];
      h.google.add(
        "exercise",
        // An average heart rate with its zones, and one that no band reports: neither is the band's reading.
        apiRec("syn-a", start, end, { avgHR: 150, zones: ZONES }),
        apiRec("syn-b", at(D10, 7, 0), at(D10, 8, 0), { avgHR: 300 }),
        // The other checks of a session stay: this one reports more calories than a session can hold.
        apiRec("syn-c", at(D10, 9, 0), at(D10, 10, 0), { kcal: 10_000.5 }),
      );
      h.google.add("heart-rate", ...samplesEvery2s(start, end, 160));
      const ex = await newData(db).exercises(D10, D10, true);
      expect(ex.sessions.map((session) => [session.id, session.hr, session.manual, session.flags])).toEqual([
        [listed("syn-b"), null, true, LOGGED],
        [listed("syn-a"), null, true, LOGGED],
      ]);
      expect(ex).toMatchObject({ skipped: 1, otherSource: 0, maxHROmitted: 0 });
      expect(between(h.google.takeCalls())).toEqual([]);
    }));

  it("marks a logged session as manual also when a list shows it under the band's platform", () =>
    inStore(async (db) => {
      own(db, "syn-own");
      // Google's pages do not say how a list shows a session that was written through the API.
      h.google.add("exercise", apiRec("syn-own", at(D10, 19, 0), at(D10, 20, 0), { platform: "FITBIT", method: "ACTIVELY_MEASURED", type: "YOGA", avgHR: 96, zones: ZONES }));
      const ex = await newData(db).exercises(D10, D10, false);
      // The band's platform: its heart rate is read as the band's.
      expect(ex.sessions).toMatchObject([{ id: listed("syn-own"), manual: true, hr: { avgBpm: 96 }, flags: [FLAG_MANUAL_ENTRY] }]);
    }));

  it("flags a logged session that overlaps a session of the band, and merges nothing of the two", () =>
    inStore(async (db) => {
      for (const id of ["syn-inside", "syn-touching", "syn-apart", "syn-pair"]) own(db, id);
      h.google.add(
        "exercise",
        exerciseRec(at(D10, 19, 0), at(D10, 20, 0), { type: "JIU_JITSU", avgHR: 130, kcal: 450, zones: ZONES }),
        // 19:30 to 20:30: half of it is inside the band's session.
        apiRec("syn-inside", at(D10, 19, 30), at(D10, 20, 30), { type: "JIU_JITSU", kcal: 500 }),
        // It starts when the band's session ends: no time is covered twice.
        apiRec("syn-touching", at(D10, 20, 0), at(D10, 20, 30)),
        apiRec("syn-apart", at(D10, 7, 0), at(D10, 8, 0)),
        // It overlaps another logged session, not a session of the band.
        apiRec("syn-pair", at(D10, 7, 30), at(D10, 8, 30)),
      );
      const ex = await newData(db).exercises(D10, D10, false);
      expect(ex.sessions.map((session) => [session.id.split("/").at(-1), session.flags])).toEqual([
        ["syn-apart", LOGGED],
        ["syn-pair", LOGGED],
        // The band's own session carries no new flag.
        [`syn-${at(D10, 19, 0).getTime() / 1000}`, []],
        ["syn-inside", [...LOGGED, FLAG_OVERLAPS_BAND_SESSION]],
        ["syn-touching", LOGGED],
      ]);
      expect(FLAG_OVERLAPS_BAND_SESSION).toBe("overlaps_band_session");
      // Two records, each with its own values and its own source (CAPABILITY I2).
      const [band, logged] = [ex.sessions[2], ex.sessions[3]];
      expect(band).toMatchObject({ kcal: 450, activeMin: 60, hr: { avgBpm: 130 }, manual: false, source: "Synthetic Band" });
      expect(logged).toMatchObject({ kcal: 500, activeMin: 60, hr: null, manual: true, source: "GOOGLE_WEB_API" });
      expect(ex.sessions).toHaveLength(5);
    }));

  it("sees an overlap with a session of the band that starts on the day before or after the range", () =>
    inStore(async (db) => {
      for (const id of ["syn-early", "syn-late", "syn-noon"]) own(db, id);
      h.google.add(
        "exercise",
        // The band's sessions start outside the range: on the 9th at 23:30, and on the 11th at 00:10.
        exerciseRec(at("2026-10-09", 23, 30), at(D10, 0, 30), { type: "RUNNING" }),
        exerciseRec(at("2026-10-11", 0, 10), at("2026-10-11", 1, 0), { type: "RUNNING" }),
        apiRec("syn-early", at(D10, 0, 10), at(D10, 0, 40)),
        apiRec("syn-late", at(D10, 23, 30), at("2026-10-11", 0, 30)),
        apiRec("syn-noon", at(D10, 12, 0), at(D10, 13, 0)),
      );
      const ex = await newData(db).exercises(D10, D10, false);
      // The band's two sessions are not sessions of the 10th; the logged ones that they overlap say so.
      expect(ex.sessions.map((session) => [session.id.split("/").at(-1), session.flags])).toEqual([
        ["syn-early", [...LOGGED, FLAG_OVERLAPS_BAND_SESSION]],
        ["syn-noon", LOGGED],
        ["syn-late", [...LOGGED, FLAG_OVERLAPS_BAND_SESSION]],
      ]);
      expect(ex).toMatchObject({ skipped: 0, otherSource: 0 });
    }));

  it("reads the names of the logged sessions once, with a day of margin, before any request", () =>
    inStore(async (db) => {
      own(db, "syn-own");
      own(db, "syn-margin", "2026-10-11");
      own(db, "syn-far", "2026-10-13");
      const real = dbCache(db);
      const asked: string[] = [];
      const cache: Cache = {
        ...real,
        createdExerciseNames: (from, to) => {
          // Nothing was asked of Google yet: a relink during the list request cannot change the names of this read.
          expect(h.google.takeRequests().total).toBe(0);
          asked.push(`${from}..${to}`);
          return real.createdExerciseNames?.(from, to) ?? new Map();
        },
      };
      h.google.add("exercise", apiRec("syn-own", at(D10, 12, 0), at(D10, 13, 0)));
      const ex = await newData(db, { cache }).exercises(D10, D10, false);
      expect(asked).toEqual(["2026-10-09..2026-10-11"]);
      expect([...ex.ownNames.keys()].sort()).toEqual(["syn-margin", "syn-own"]);
      expect(ex.sessions).toHaveLength(1);
      expect(h.google.takeRequests()).toEqual({ total: 1, exercise: 1 });
    }));

  it("fails the read, before any request, when the store cannot list the logged sessions", () =>
    inStore(async (db) => {
      const cache: Cache = {
        ...dbCache(db),
        createdExerciseNames: () => {
          throw new DiskError();
        },
      };
      await expect(newData(db, { cache }).exercises(D10, D10, false)).rejects.toThrow("healthdata: read created entries");
      expect(h.google.takeRequests()).toEqual({ total: 0 });
      expect(h.logged()).not.toContain("4242");
    }));
});
