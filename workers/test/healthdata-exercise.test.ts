// Ports of internal/healthdata/exercise_test.go: workout sessions and their
// max heart rate.
import { describe, expect, it } from "vitest";

import { MAX_HR_SESSIONS } from "../src/healthdata";
import { FLAG_LOW_HR_FOR_ACTIVITY, FLAG_MANUAL_ENTRY, FLAG_NO_HR_DATA } from "../src/metrics/quality";
import { HOUR, MINUTE, SECOND, at, exerciseRec, harness, hrSample, inStore, newData, plus, samplesEvery2s } from "./healthdata-helpers";

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
