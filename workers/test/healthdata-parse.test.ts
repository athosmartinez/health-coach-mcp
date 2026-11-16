// Record parsers. A record arrives parsed, so the decoding rules are applied
// to values.
import { describe, expect, it } from "vitest";

import { parseBodyFat, parseWeight } from "../src/healthdata/body";
import {
  type Obj,
  UNREADABLE,
  ZERO_TIME,
  clean,
  decode,
  flag,
  float,
  int,
  int64s,
  label,
  object,
  objects,
  optionalInt64s,
  parseDuration,
  root,
  text,
  time,
} from "../src/healthdata/decode";
import { minutes, parseExercise } from "../src/healthdata/exercise";
import { parseFood } from "../src/healthdata/nutrition";
import { civilDateTimeDay, parseHRV, parseResting, parseSleep } from "../src/healthdata/parse";
import { HOUR, at, bodyFatRec, civil, exerciseRec, foodRec, plus, weightRec } from "./healthdata-helpers";

const json = (raw: string): unknown => JSON.parse(raw);

function sleepJSON(summary: string): string {
  return (
    `{"dataSource":{"platform":"FITBIT"},"sleep":{"type":"STAGES","metadata":{"processed":true,"stagesStatus":"SUCCEEDED"},` +
    `"interval":{"startTime":"2026-10-10T00:00:00Z","endTime":"2026-10-10T08:00:00Z"},"summary":${summary}}}`
  );
}

const END = Date.parse("2026-10-10T08:00:00Z");

describe("parseSleep", () => {
  const stages = (deep: number, light: number, rem: number) =>
    `,"stagesSummary":[{"type":"DEEP","minutes":"${deep}"},{"type":"LIGHT","minutes":"${light}"},{"type":"REM","minutes":"${rem}"}]`;
  const rec = (asleep: number, awake: number, inBed: number, st: string) =>
    sleepJSON(`{"minutesAsleep":"${asleep}","minutesAwake":"${awake}","minutesInSleepPeriod":"${inBed}"${st}}`);
  const withAwake = `${stages(60, 300, 80).slice(0, -1)},{"type":"AWAKE","minutes":"40"}]`;

  it.each<[string, string, "session" | "bad" | "undated"]>([
    ["consistent", rec(440, 40, 480, stages(60, 300, 80)), "session"],
    ["rounding slack", rec(440, 42, 480, stages(60, 302, 80)), "session"],
    ["parts exceed the bed", rec(440, 43, 480, stages(60, 300, 80)), "bad"],
    ["stages exceed asleep", rec(440, 40, 480, stages(60, 303, 80)), "bad"],
    ["no time asleep", rec(0, 480, 480, stages(0, 0, 0)), "bad"],
    ["negative awake", rec(440, -1, 480, stages(60, 300, 80)), "bad"],
    ["negative stage", rec(440, 40, 480, stages(-1, 300, 80)), "bad"],
    ["stage beyond the bed", rec(440, 40, 480, stages(481, 0, 0)), "bad"],
    ["no stage list", rec(440, 40, 480, ""), "bad"],
    ["longer than a day", rec(1400, 41, 1441, stages(60, 300, 80)), "bad"],
    ["a full day", rec(1400, 40, 1440, stages(200, 1000, 200)), "session"],
    ["stages short of asleep", rec(440, 40, 480, stages(60, 297, 80)), "bad"],
    ["a renamed stage", rec(440, 40, 480, `,"stagesSummary":[{"type":"DEEP","minutes":"60"},{"type":"NREM_LIGHT","minutes":"300"},{"type":"REM","minutes":"80"}]`), "bad"],
    ["an extra unknown stage", rec(440, 40, 480, `,"stagesSummary":[{"type":"DEEP","minutes":"60"},{"type":"LIGHT","minutes":"300"},{"type":"REM","minutes":"80"},{"type":"ONSET","minutes":"5"}]`), "bad"],
    ["a stage listed twice", rec(440, 40, 480, `,"stagesSummary":[{"type":"DEEP","minutes":"60"},{"type":"LIGHT","minutes":"300"},{"type":"REM","minutes":"80"},{"type":"REM","minutes":"80"}]`), "bad"],
    ["a repeated stage", rec(440, 40, 480, `,"stagesSummary":[{"type":"DEEP","minutes":"60"},{"type":"LIGHT","minutes":"150"},{"type":"LIGHT","minutes":"150"},{"type":"REM","minutes":"80"}]`), "bad"],
    ["with the awake stage", rec(440, 40, 480, withAwake), "session"],
    ["empty summary", sleepJSON("{}"), "bad"],
    ["no summary", `{"dataSource":{"platform":"FITBIT"},"sleep":{"interval":{"startTime":"2026-10-10T00:00:00Z","endTime":"2026-10-10T08:00:00Z"}}}`, "bad"],
    ["no record", `{"dataSource":{"platform":"FITBIT"}}`, "undated"],
    ["not an object", `[]`, "undated"],
    ["end before start", `{"dataSource":{"platform":"FITBIT"},"sleep":{"interval":{"startTime":"2026-10-10T07:00:00Z","endTime":"2026-10-10T06:00:00Z"},"summary":{"minutesInSleepPeriod":"60"}}}`, "undated"],
    ["minutes not a number", sleepJSON(`{"minutesAsleep":"x"}`), "undated"],
    ["minutes as a float", sleepJSON(`{"minutesAsleep":"1.5"}`), "undated"],
  ])("%s", (_name, raw, kind) => {
    const read = parseSleep(json(raw));
    expect(read.kind).toBe(kind);
    if (read.kind === "session") {
      expect(read.session.stages).not.toBeNull();
      expect(read.session.settled).toBe(true);
    }
    // The interval is kept with an error, so the caller knows the day.
    if (read.kind === "bad") expect(read.end).toBe(END);
  });

  it("reads the values of a session", () => {
    expect(parseSleep(json(rec(440, 40, 480, stages(60, 300, 80))))).toEqual({
      kind: "session",
      session: {
        start: Date.parse("2026-10-10T00:00:00Z"),
        end: END,
        asleep: 440,
        awake: 40,
        inBed: 480,
        stages: { deepMin: 60, lightMin: 300, remMin: 80 },
        settled: true,
        unknownType: false,
        source: "FITBIT",
      },
    });
  });

  it("leaves another platform out on purpose, with its interval", () => {
    const raw = rec(440, 40, 480, stages(60, 300, 80)).replace("FITBIT", "HEALTH_KIT");
    expect(parseSleep(json(raw))).toEqual({ kind: "other", end: END });
  });

  it("checks a nap before it is left out", () => {
    const nap = (summary: string) => sleepJSON(summary).replace(`"processed":true`, `"processed":true,"nap":true`);
    expect(parseSleep(json(nap(`{"minutesAsleep":"20","minutesInSleepPeriod":"20"${stages(0, 20, 0)}}`)))).toEqual({ kind: "nap", end: END });
    expect(parseSleep(json(nap(`{"minutesAsleep":"500","minutesInSleepPeriod":"20"}`))).kind).toBe("bad");
  });

  it("never carries a value of a record it cannot read", () => {
    for (const raw of [
      `{"dataSource":{"platform":"FITBIT"},"sleep":{"summary":{"minutesAsleep":"417 secret"}}}`,
      sleepJSON(`{"minutesAsleep":"417","minutesInSleepPeriod":"60"}`),
    ]) {
      const read = parseSleep(json(raw));
      expect(read.kind).not.toBe("session");
      expect(JSON.stringify(read)).not.toContain("417");
      expect(JSON.stringify(read)).not.toContain("secret");
    }
  });
});

describe("parseHRV", () => {
  const rec = (platform: string, value: string) =>
    `{"dataSource":{"platform":"${platform}"},"heartRateVariability":{"sampleTime":{"physicalTime":"2026-10-10T06:00:00Z"}` +
    `${value === "" ? "" : `,"rootMeanSquareOfSuccessiveDifferencesMilliseconds":${value}`}}}`;
  const AT = Date.parse("2026-10-10T06:00:00Z");

  it.each<[string, object]>([
    [rec("FITBIT", "0.1"), { kind: "sample", at: AT, rmssd: 0.1 }],
    [rec("FITBIT", "500"), { kind: "sample", at: AT, rmssd: 500 }],
    [rec("FITBIT", "0"), { kind: "bad", at: AT }],
    [rec("FITBIT", "500.01"), { kind: "bad", at: AT }],
    [rec("FITBIT", "-1"), { kind: "bad", at: AT }],
    [rec("FITBIT", ""), { kind: "no_value", at: AT }],
    [rec("HEALTH_KIT", "50"), { kind: "other", at: AT }],
    [`[]`, { kind: "undated" }],
    [`{"dataSource":{"platform":"FITBIT"},"heartRateVariability":{}}`, { kind: "undated" }],
  ])("%s", (raw, want) => {
    expect(parseHRV(json(raw))).toEqual(want);
  });
});

describe("parseResting", () => {
  const rec = (platform: string, bpm: string, y: number, m: number, d: number) =>
    `{"dataSource":{"platform":"${platform}"},"dailyRestingHeartRate":{"beatsPerMinute":"${bpm}","date":{"year":${y},"month":${m},"day":${d}},` +
    `"dailyRestingHeartRateMetadata":{"calculationMethod":"WITH_SLEEP"}}}`;

  it.each<[string, boolean]>([
    [rec("FITBIT", "20", 2026, 10, 10), true],
    [rec("FITBIT", "250", 2026, 10, 10), true],
    [rec("FITBIT", "19", 2026, 10, 10), false],
    [rec("FITBIT", "251", 2026, 10, 10), false],
    [rec("FITBIT", "55", 0, 10, 10), false],
    [rec("FITBIT", "55", 2026, 2, 30), false],
    [rec("FITBIT", "55", 2026, 13, 1), false],
    [rec("FITBIT", "fifty", 2026, 2, 3), false],
    [`{"dataSource":{"platform":"FITBIT"}}`, false],
  ])("%s", (raw, good) => {
    const read = parseResting(json(raw));
    expect(read.kind === "value").toBe(good);
    if (read.kind === "value") expect(read).toMatchObject({ method: "WITH_SLEEP", date: "2026-10-10", source: "FITBIT" });
  });

  it("keeps the date of an out-of-range value, and of another platform", () => {
    expect(parseResting(json(rec("FITBIT", "9000", 2026, 10, 10)))).toEqual({ kind: "bad", date: "2026-10-10" });
    expect(parseResting(json(rec("HEALTH_KIT", "55", 2026, 10, 10)))).toEqual({ kind: "other", date: "2026-10-10" });
  });

  it("has no date when the date is not a real day", () => {
    expect(parseResting(json(rec("FITBIT", "55", 2026, 2, 30)))).toEqual({ kind: "undated" });
  });
});

describe("weight and body fat", () => {
  const ts = at("2026-10-10", 8, 0);

  it.each<[unknown, boolean]>([
    [weightRec(ts, 20000, "FITBIT"), true],
    [weightRec(ts, 400000, "FITBIT"), true],
    [weightRec(ts, 19999, "FITBIT"), false],
    [weightRec(ts, 400001, "FITBIT"), false],
    [{ weight: { weightGrams: 80000 } }, false],
    [{ weight: { sampleTime: { physicalTime: "2026-10-10T10:00:00Z" } } }, false],
    [[], false],
  ])("weight %#", (record, good) => {
    expect(parseWeight(record) !== null).toBe(good);
  });

  it.each<[unknown, boolean]>([
    [bodyFatRec(ts, 2), true],
    [bodyFatRec(ts, 75), true],
    [bodyFatRec(ts, 1), false],
    [bodyFatRec(ts, 76), false],
    [{ bodyFat: {} }, false],
    [{ bodyFat: { sampleTime: { physicalTime: "2026-10-10T10:00:00Z" } } }, false],
    [{ bodyFat: { percentage: 20 } }, false],
  ])("body fat %#", (record, good) => {
    expect(parseBodyFat(record) !== null).toBe(good);
  });

  it("converts grams to kilograms and labels the source", () => {
    expect(parseWeight(weightRec(ts, 80500, "HEALTH_KIT"))).toEqual({ at: ts.getTime(), value: 80.5, source: "Synthetic Scale" });
    expect(parseBodyFat(bodyFatRec(ts, 18.5))).toEqual({ at: ts.getTime(), value: 18.5, source: "FITBIT" });
  });
});

describe("civil dates", () => {
  it("reads a real day and refuses the others", () => {
    expect(civilDateTimeDay(civil("2026-02-28"))).toBe("2026-02-28");
    expect(civilDateTimeDay(civil("2024-02-29"))).toBe("2024-02-29");
    for (const bad of ["2026-02-30", "0-01-01", "2026-13-01", "2026-00-10", "2025-02-29"]) {
      expect(civilDateTimeDay(civil(bad)), bad).toBeUndefined();
    }
    expect(civilDateTimeDay(undefined)).toBeUndefined();
    expect(civilDateTimeDay({})).toBeUndefined();
  });

  it("writes a year as the Go server does", () => {
    expect(civilDateTimeDay({ date: { year: 987, month: 1, day: 2 } })).toBe("0987-01-02");
    expect(civilDateTimeDay({ date: { year: 12026, month: 1, day: 2 } })).toBe("12026-01-02");
    expect(civilDateTimeDay({ date: { year: -44, month: 3, day: 15 } })).toBe("-0044-03-15");
  });

  it("refuses a date field that is not a whole number", () => {
    expect(decode(() => civilDateTimeDay({ date: { year: 2026.5, month: 1, day: 2 } }))).toBeUndefined();
    expect(decode(() => civilDateTimeDay({ date: { year: "2026", month: 1, day: 2 } }))).toBeUndefined();
    expect(decode(() => civilDateTimeDay({ date: "2026-01-02" }))).toBeUndefined();
  });
});

describe("parseExercise", () => {
  const [s, e] = [at("2026-10-10", 19, 0), at("2026-10-10", 20, 0)];
  const z: [number, number, number, number] = [10, 20, 20, 10];
  const edited = (from: string, to: string, options = { type: "RUNNING", avgHR: 0 }) => {
    const raw = JSON.stringify(exerciseRec(s, e, options));
    expect(raw).toContain(from);
    return json(raw.replace(from, to));
  };

  it.each<[string, unknown, boolean]>([
    ["fine", exerciseRec(s, e, { type: "RUNNING", avgHR: 150, zones: z }), true],
    ["HR 20", exerciseRec(s, e, { type: "RUNNING", avgHR: 20, zones: z }), true],
    ["HR 250", exerciseRec(s, e, { type: "RUNNING", avgHR: 250, zones: z }), true],
    ["HR 19", exerciseRec(s, e, { type: "RUNNING", avgHR: 19, zones: z }), false],
    ["HR 251", exerciseRec(s, e, { type: "RUNNING", avgHR: 251, zones: z }), false],
    ["active over span", exerciseRec(s, e, { type: "RUNNING", activeMin: 62 }), false],
    ["zone over span", exerciseRec(s, e, { type: "RUNNING", avgHR: 150, zones: [70, 0, 0, 0] }), false],
    ["AZM over twice span", exerciseRec(s, e, { type: "RUNNING", azm: 121 }), false],
    ["calories", exerciseRec(s, e, { type: "RUNNING", kcal: 10_001 }), false],
    ["over a day", exerciseRec(s, plus(s, 25 * HOUR), { type: "HIKING" }), false],
    ["end before start", exerciseRec(e, s, { type: "RUNNING" }), false],
    ["not an object", [], false],
    ["bad duration", edited(`"3600s"`, `"an hour"`), false],
    ["no duration", edited(`"activeDuration":"3600s",`, ``), false],
    ["HR without zones", edited(`"heartRateZoneDurations"`, `"zones"`, { type: "RUNNING", avgHR: 150 }), false],
    ["AZM twice span", exerciseRec(s, e, { type: "RUNNING", azm: 120 }), true],
    ["negative AZM", exerciseRec(s, e, { type: "RUNNING", azm: -1 }), false],
    ["negative calories", exerciseRec(s, e, { type: "RUNNING", kcal: -1 }), false],
    ["zero length", exerciseRec(s, s, { type: "RUNNING" }), false],
    ["active span+30s", edited(`"3600s"`, `"3630s"`), true],
    ["active span+90s", edited(`"3600s"`, `"3690s"`), false],
  ])("%s", (_name, record, good) => {
    expect(parseExercise(record).kind === "session").toBe(good);
  });

  it("keeps the start of a session it cannot use", () => {
    expect(parseExercise(exerciseRec(s, e, { type: "RUNNING", avgHR: 300, zones: z }))).toEqual({ kind: "bad", start: s.getTime() });
    expect(parseExercise(exerciseRec(s, e, { type: "RUNNING", platform: "HEALTH_KIT" }))).toEqual({ kind: "other", start: s.getTime() });
    expect(parseExercise(exerciseRec(e, s, { type: "RUNNING" }))).toEqual({ kind: "undated" });
  });

  it("does not pass an unexpected record name on as an ID", () => {
    const read = parseExercise(exerciseRec(s, e, { type: "RUNNING", name: "users/me/../../etc" }));
    expect(read.kind === "session" && read.session.id).toBe("");
  });

  it("parses durations within the session's span", () => {
    expect(minutes("", HOUR)).toBe(0);
    expect(minutes("-5s", HOUR)).toBeUndefined();
    expect(minutes("3600s", HOUR)).toBe(60);
    expect(minutes("3660s", HOUR)).toBe(61);
    expect(minutes("3661s", HOUR)).toBeUndefined();
    // The whole minutes and the rest are divided apart, as the Go server does.
    expect(minutes("3130s", HOUR)).toBe(52 + 10e9 / 60e9);
    expect(minutes("90.5s", HOUR)).toBe(1 + 30.5e9 / 60e9);
  });
});

describe("parseFood", () => {
  const ts = at("2026-10-10", 12, 0);
  const item = (record: unknown) => {
    const read = parseFood(record);
    if (read.kind !== "item") throw new Error(`the record read as ${read.kind}`);
    return read.item;
  };

  it.each<[string, unknown, string[]]>([
    ["fine", foodRec(ts, { kcal: 500 }), []],
    ["no energy", foodRec(ts, { carb: 10 }), []],
    ["kcal 10000", foodRec(ts, { kcal: 10_000 }), []],
    ["kcal over", foodRec(ts, { kcal: 10_001, carb: 5 }), ["kcal"]],
    ["negative carb", foodRec(ts, { carb: -1 }), ["carb_g"]],
    ["fat over", foodRec(ts, { fat: 2_001 }), ["fat_g"]],
    ["protein over", foodRec(ts, { list: { PROTEIN: 2_001 } }), ["protein_g"]],
    ["sodium 20 g", foodRec(ts, { list: { SODIUM: 20 } }), []],
    ["sodium over", foodRec(ts, { list: { SODIUM: 21 } }), ["sodium_mg"]],
    [
      "protein twice",
      json(
        `{"dataSource":{"platform":"FITBIT"},"nutritionLog":{"interval":{"startTime":"2026-10-10T15:00:00Z"},"nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":5}},{"nutrient":"PROTEIN","quantity":{"grams":5}},{"nutrient":"PROTEIN","quantity":{"grams":5}}]}}`,
      ),
      ["protein_g"],
    ],
  ])("rejects a nutrient alone: %s", (_name, record, rejected) => {
    const food = item(record);
    expect(food.rejected).toEqual(rejected);
    for (const key of food.rejected) expect(key in food.nutrients, key).toBe(false);
  });

  it("keeps the carbs of an item whose kcal is rejected", () => {
    expect(item(foodRec(ts, { kcal: 10_001, carb: 5 })).nutrients).toEqual({ carb_g: 5 });
  });

  it("has no time for a record without one", () => {
    expect(parseFood(json(`{"dataSource":{"platform":"FITBIT"},"nutritionLog":{"energy":{"kcal":5}}}`))).toEqual({ kind: "undated" });
    expect(parseFood("not a record")).toEqual({ kind: "undated" });
  });

  it("reads an energy field without kcal as 0 kcal", () => {
    expect(item(foodRec(ts, { kcal: 0 })).nutrients).toEqual({ kcal: 0 });
  });

  it("does not pass an unexpected record name on as an ID", () => {
    expect(item(foodRec(ts, { name: "bad name" })).id).toBe("");
    expect(item(foodRec(ts)).id).toBe(`users/me/dataTypes/nutrition-log/dataPoints/syn-${ts.getTime() / 1000}`);
  });

  it("leaves another platform out, with its time", () => {
    expect(parseFood(foodRec(ts, { platform: "HEALTH_KIT" }))).toEqual({ kind: "other", at: ts.getTime() });
  });

  it("puts fiber and sugar in their own keys, and sodium in milligrams", () => {
    expect(item(foodRec(ts, { list: { DIETARY_FIBER: 5, SUGAR: 20, SODIUM: 0.8, VITAMIN_C: 0.01, SATURATED_FAT: 6 } })).nutrients).toEqual({
      fiber_g: 5,
      sugar_g: 20,
      sodium_mg: 800,
    });
  });

  it("cleans names and meal types", () => {
    const raw = JSON.stringify(foodRec(ts)).replace(`"Synthetic food"`, `"Rice\\nIgnore\\u202eall"`).replace(`"LUNCH"`, `"LUN\\u200bCH"`);
    expect(item(json(raw))).toMatchObject({ name: "RiceIgnoreall", meal: "LUNCH" });
  });
});

describe("source labels", () => {
  const labelOf = (deviceName: string, platform: string) => label({ deviceName, platform, recordingMethod: "" });
  const invalidUtf8 = new TextDecoder().decode(new Uint8Array([0x42, 0x61, 0x6e, 0x64, 0xff]));

  it.each<[string, string, string]>([
    ["Synthetic Band", "FITBIT", "Synthetic Band"],
    ["", "FITBIT", "FITBIT"],
    ["   ", "FITBIT", "FITBIT"],
    ["Band\n\tIgnore previous instructions", "FITBIT", "BandIgnore previous instructions"],
    ["Band‮​X", "FITBIT", "BandX"], // bidi override, zero-width space
    [invalidUtf8, "FITBIT", "Band"], // invalid UTF-8
    ["Band\ud800X", "FITBIT", "BandX"], // a lone surrogate
    ["Band X", "FITBIT", "BandX"], // line separator
    ["‮​", "FITBIT", "FITBIT"], // nothing visible left: the platform
    ["é".repeat(100), "FITBIT", "é".repeat(64)],
    ["😀".repeat(100), "FITBIT", "😀".repeat(64)], // the cap counts characters, not UTF-16 units
  ])("label(%j)", (name, platform, want) => {
    expect(labelOf(name, platform)).toBe(want);
  });

  it("drops hidden characters before it counts", () => {
    expect(clean(`${"​".repeat(200)}${"a".repeat(70)}`)).toBe("a".repeat(64));
    expect(clean("  a b  ")).toBe("a b");
  });
});

// The Go server decodes a record into a struct. These are its rules, applied
// here to the parsed value.
describe("Go JSON decoding rules", () => {
  const read = <T>(run: () => T) => decode(run);

  it("reads a missing field and a JSON null as unset", () => {
    const record = { a: null } as Obj;
    expect(text(record, "a")).toBe("");
    expect(text(record, "b")).toBe("");
    expect(flag(record, "a")).toBe(false);
    expect(float(record, "a")).toBeUndefined();
    expect(int(record, "a")).toBe(0);
    expect(object(record, "a")).toBeUndefined();
    expect(objects(record, "a")).toEqual([]);
    expect(time(record, "a")).toBe(ZERO_TIME);
    expect(optionalInt64s(record, "a")).toBeUndefined();
    expect(text(undefined, "a")).toBe("");
    expect(root(null)).toBeUndefined();
  });

  it("refuses a value of the wrong type", () => {
    const record: Obj = { s: 5, b: "true", f: "1.5", i: 1.5, o: [], l: {}, t: 1760076000, n: true };
    expect(read(() => text(record, "s"))).toBeUndefined();
    expect(read(() => flag(record, "b"))).toBeUndefined();
    expect(read(() => float(record, "f"))).toBeUndefined();
    expect(read(() => int(record, "i"))).toBeUndefined();
    expect(read(() => object(record, "o"))).toBeUndefined();
    expect(read(() => objects(record, "l"))).toBeUndefined();
    expect(read(() => time(record, "t"))).toBeUndefined();
    expect(read(() => int64s(record, "n"))).toBeUndefined();
    for (const top of [[], "text", 5, true]) expect(read(() => root(top))).toBeUndefined();
  });

  it("passes any other error on", () => {
    expect(() => decode(() => {
      throw new TypeError("a bug");
    })).toThrow(TypeError);
    expect(typeof UNREADABLE).toBe("symbol");
  });

  it("ignores a key of the object prototype", () => {
    expect(text({}, "toString")).toBe("");
    expect(object({}, "constructor")).toBeUndefined();
  });

  it("reads a null element of a list as an element with every field unset", () => {
    expect(objects({ l: [null, { a: 1 }] }, "l")).toEqual([undefined, { a: 1 }]);
    expect(read(() => objects({ l: [5] }, "l"))).toBeUndefined();
  });

  it("reads an int64 written as a string or as a number", () => {
    const ok: [unknown, number][] = [
      ["123", 123],
      [123, 123],
      ["-5", -5],
      ["+5", 5],
      ["0", 0],
      ["007", 7],
      ["9223372036854775807", 2 ** 63],
      ["-9223372036854775808", -(2 ** 63)],
    ];
    for (const [value, want] of ok) expect(int64s({ v: value }, "v"), String(value)).toBe(want);
    for (const bad of ["", " 5", "5 ", "1.5", "1e3", "0x10", "five", "9223372036854775808", "-9223372036854775809", 1.5, true, [], {}]) {
      expect(read(() => int64s({ v: bad }, "v")), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("reads a missing int64 as 0 and refuses a null one", () => {
    // Proto3 JSON leaves a zero out. A null goes to the type's own decoder in Go, which refuses it.
    expect(int64s({}, "v")).toBe(0);
    expect(int64s(undefined, "v")).toBe(0);
    expect(read(() => int64s({ v: null }, "v"))).toBeUndefined();
    expect(optionalInt64s({ v: null }, "v")).toBeUndefined();
    expect(optionalInt64s({ v: "12" }, "v")).toBe(12);
  });

  it("refuses a number too large for a float64", () => {
    expect(read(() => float(json(`{"v":1e999}`) as Obj, "v"))).toBeUndefined();
    expect(float({ v: 0 }, "v")).toBe(0);
  });

  it("makes the whole record unreadable for a wrong type in a field the caller would not use", () => {
    // Another platform's sample: without the bad value it is left out with its time.
    const sample = (rmssd: unknown) => ({
      dataSource: { platform: "HEALTH_KIT" },
      heartRateVariability: { sampleTime: { physicalTime: "2026-10-10T06:00:00Z" }, rootMeanSquareOfSuccessiveDifferencesMilliseconds: rmssd },
    });
    expect(parseHRV(sample(50)).kind).toBe("other");
    expect(parseHRV(sample("50")).kind).toBe("undated");
    // A nap flag that is not a boolean, and a null minute count.
    const sleep = (metadata: unknown, awake: unknown) => ({
      dataSource: { platform: "HEALTH_KIT" },
      sleep: {
        interval: { startTime: "2026-10-10T00:00:00Z", endTime: "2026-10-10T08:00:00Z" },
        metadata,
        summary: { minutesAsleep: "440", minutesAwake: awake, minutesInSleepPeriod: "480" },
      },
    });
    expect(parseSleep(sleep({ nap: false }, "40")).kind).toBe("other");
    expect(parseSleep(sleep({ nap: "false" }, "40")).kind).toBe("undated");
    expect(parseSleep(sleep(null, null)).kind).toBe("undated");
    expect(parseSleep(sleep(null, 40)).kind).toBe("other");
  });
});

describe("times", () => {
  const ms = (value: unknown) => decode(() => time({ t: value }, "t"));
  const base = Date.parse("2026-10-10T06:00:00Z");

  it.each<[string, number]>([
    ["2026-10-10T06:00:00Z", base],
    ["2026-10-10T03:00:00-03:00", base],
    ["2026-10-10T11:30:00+05:30", base],
    ["2026-10-10T06:00:00.5Z", base + 500],
    // Below the millisecond the fraction is cut to steps of 1/1024 ms: 0.456789 ms is 467 of them.
    ["2026-10-10T06:00:00.123456789Z", base + 123 + 467 / 1024],
    ["2026-10-10T06:00:00.123Z", base + 123],
    ["2026-10-10T06:00:00.1239Z", base + 123 + 921 / 1024],
    ["2024-02-29T00:00:00Z", Date.parse("2024-02-29T00:00:00Z")],
    ["0001-01-01T00:00:00Z", ZERO_TIME],
    ["0099-12-31T23:59:59Z", Date.parse("0099-12-31T23:59:59Z")],
  ])("reads %s", (value, want) => {
    expect(ms(value)).toBe(want);
  });

  it.each([
    "2026-10-10t06:00:00Z",
    "2026-10-10T06:00:00z",
    "2026-10-10 06:00:00Z",
    "2026-10-10T06:00Z",
    "2026-10-10T6:00:00Z",
    "2026-10-10T06:00:00",
    "2026-10-10T06:00:60Z",
    "2026-10-10T24:00:00Z",
    "2026-02-30T06:00:00Z",
    "2026-13-01T06:00:00Z",
    "2026-10-10T06:00:00,5Z",
    "2026-10-10T06:00:00.Z",
    "2026-10-10T06:00:00+24:00",
    "2026-10-10T06:00:00+0300",
    "2026-10-10",
    "",
  ])("refuses %j", (value) => {
    expect(ms(value)).toBeUndefined();
  });

  it("never rounds an instant up: the last nanosecond of a second stays in that second", () => {
    // 23:59:59.999999999 in São Paulo. Rounded up it is the next second, and the next local day.
    const next = Date.parse("2026-10-16T03:00:00Z");
    for (const value of [
      "2026-10-15T23:59:59.999999999-03:00",
      "2026-10-16T02:59:59.999999999Z",
      "2026-10-16T02:59:59.9999995Z",
      // More digits than a nanosecond: the Go server cuts them too.
      "2026-10-16T02:59:59.99999999999999999999Z",
    ]) {
      const read = ms(value) as number;
      expect(read, value).toBeLessThan(next);
      expect(Math.floor(read), value).toBe(next - 1);
      expect(new Date(read).toISOString(), value).toBe("2026-10-16T02:59:59.999Z");
    }
    // Every fraction of a second keeps its whole milliseconds, exactly.
    for (let n = 0; n < 1000; n++) {
      const digits = String(n).padStart(3, "0");
      expect(ms(`2026-10-10T06:00:00.${digits}Z`), digits).toBe(base + n);
      expect(Math.floor(ms(`2026-10-10T06:00:00.${digits}999999Z`) as number), digits).toBe(base + n);
    }
    for (const [digits, whole] of [["9", 900], ["29", 290], ["57", 570], ["07", 70], ["0009", 0], ["99999", 999]] as const) {
      expect(Math.floor(ms(`2026-10-10T06:00:00.${digits}Z`) as number), digits).toBe(base + whole);
    }
    // Before 1970 too: the instant is never after the text.
    const old = Date.parse("1969-12-31T23:59:59Z");
    expect(Math.floor(ms("1969-12-31T23:59:59.999999999Z") as number)).toBe(old + 999);
    expect(ms("1969-12-31T23:59:59.999999999Z")).toBeLessThan(0);
  });

  it("keeps the order of instants inside one millisecond, down to about a microsecond", () => {
    const inMs = ["000000", "000001", "000003", "0000035", "00025", "0005", "000999", "000999999"].map((digits) => ms(`2026-10-10T06:00:00.${digits}Z`) as number);
    expect(inMs[0]).toBe(base);
    for (let i = 1; i < inMs.length; i++) expect(inMs[i], String(i)).toBeGreaterThanOrEqual(inMs[i - 1] as number);
    // A microsecond apart: different instants.
    expect(new Set(inMs.slice(0, 3)).size).toBe(3);
    expect(inMs.at(-1)).toBeLessThan(base + 1);
    // Far from 1970 a double holds no such step: the instant is cut to its millisecond.
    expect(ms("9000-01-01T00:00:00.123999Z")).toBe(Date.parse("9000-01-01T00:00:00.123Z"));
  });

  it("refuses a time that is not a string", () => {
    expect(ms(1_760_076_000)).toBeUndefined();
    expect(ms({})).toBeUndefined();
  });

  it("is the zero time of the Go server when unset", () => {
    expect(new Date(ZERO_TIME).toISOString()).toBe("0001-01-01T00:00:00.000Z");
  });
});

describe("parseDuration", () => {
  it.each<[string, number]>([
    ["3600s", 3600e9],
    ["1h30m", 5400e9],
    ["1.5s", 1.5e9],
    ["0.3s", 300_000_000],
    ["0", 0],
    ["+5s", 5e9],
    ["-5s", -5e9],
    [".5s", 0.5e9],
    ["5.s", 5e9],
    ["1ns", 1],
    ["1us", 1e3],
    ["1µs", 1e3],
    ["1μs", 1e3],
    ["1ms", 1e6],
    ["1.9ns", 1],
    ["2562047h", 2562047 * 3600e9],
  ])("reads %s", (value, want) => {
    expect(parseDuration(value)).toBe(want);
  });

  it.each(["", "+", "5", "s", ".s", "an hour", "5 s", " 5s", "5sx", "5mh", "1e3s", "3600S", "2562048h", "5s3"])("refuses %j", (value) => {
    expect(parseDuration(value)).toBeUndefined();
  });
});
