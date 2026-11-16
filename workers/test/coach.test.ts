// Local dates, the coach zone, and the HCM_TZ cases. LocalDate decoding
// ("" = omitted, a bad date rejected while the arguments are read) is covered
// in register.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UTC, Zone, addDays, bounds, dateOf, instantOf, parseDate, sleepDay, today } from "../src/coach/date";
import { confidence, newEnvelope } from "../src/coach/envelope";
import { INTERNAL_ERROR, ToolError, errorTypes, toWire, wireText } from "../src/coach/errors";
import { byteLength, compareText, fields, goJsonLength, lower, trimSpace, truncate } from "../src/coach/text";
import { ConfigError, DEFAULT_TIME_ZONE, loadZone, timeZone } from "../src/config";
import { freshStore, objectTool } from "./memory-helpers";

const BRT = new Zone("America/Sao_Paulo");
const NEW_YORK = new Zone("America/New_York");
const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalDate", () => {
  it.each([
    ["2026-10-13", true],
    ["2028-02-29", true],
    ["2026-02-29", false],
    ["2026-13-01", false],
    ["13/10/2026", false],
    ["2026-1-3", false],
    [" 2026-10-13", false],
    ["2026-10-13\n", false],
    ["2026-10-13T00:00:00Z", false],
    ["+2026-10-13", false],
    ["", false],
  ])("parseDate(%j) accepts it: %s", (input, ok) => {
    expect(parseDate(input)).toBe(ok ? input : undefined);
  });

  it("bounds a day at its local midnights", () => {
    expect(bounds("2026-10-13", BRT)).toEqual({
      start: new Date("2026-10-13T03:00:00Z"),
      end: new Date("2026-10-14T03:00:00Z"),
    });
  });

  it.each([
    { day: "2026-03-08", hours: 23 }, // spring forward
    { day: "2026-11-01", hours: 25 }, // fall back
    { day: "2026-06-15", hours: 24 },
  ])("makes $day $hours hours long in New York, with no gap to the next day", ({ day, hours }) => {
    const { start, end } = bounds(day, NEW_YORK) ?? {};
    expect((end?.getTime() ?? 0) - (start?.getTime() ?? 0)).toBe(hours * HOUR);
    const next = bounds(addDays(day, 1) ?? "", NEW_YORK);
    expect(next?.start).toEqual(end);
  });

  it("starts the day at the first instant when midnight does not exist", () => {
    // Brazil started DST at 00:00 on 2018-11-04, so that local midnight was skipped.
    const { start, end } = bounds("2018-11-04", BRT) ?? {};
    // 01:00 local, at UTC-2.
    expect(start).toEqual(new Date("2018-11-04T03:00:00Z"));
    expect((end?.getTime() ?? 0) - (start?.getTime() ?? 0)).toBe(23 * HOUR);
  });

  it.each(["", "garbage", "2026-02-30"])("rejects the unvalidated date %j in bounds and addDays", (day) => {
    expect(bounds(day, UTC)).toBeUndefined();
    expect(addDays(day, 1)).toBeUndefined();
  });

  it.each([
    ["2026-10-14T01:30:00Z", "2026-10-13"], // still Oct 13 in BRT
    ["2026-10-14T03:00:00Z", "2026-10-14"], // exactly local midnight
    ["2026-10-13T23:00:00Z", "2026-10-13"],
  ])("today at %s is %s in São Paulo", (now, want) => {
    expect(today(new Date(now), BRT)).toBe(want);
  });

  it.each([
    ["2026-10-13T12:24:00Z", "2026-10-13"], // 09:24 local
    ["2026-10-14T02:59:59.999Z", "2026-10-13"], // 23:59:59.999 local
    ["2026-10-14T03:00:00Z", "2026-10-14"], // local midnight
  ])("a sleep ending at %s belongs to %s", (end, want) => {
    expect(sleepDay(new Date(end), BRT)).toBe(want);
  });

  it("keeps both 01:30 instants of a fall-back night on the same day", () => {
    // 01:30 occurs twice on 2026-11-01 in New York.
    const first = new Date("2026-11-01T05:30:00Z"); // 01:30 EDT
    const second = new Date(first.getTime() + HOUR); // 01:30 EST
    for (const t of [first, second]) expect(dateOf(t, NEW_YORK)).toBe("2026-11-01");
  });

  it.each([
    ["São Paulo", BRT, "2026-10-16", 11, 30, "2026-10-16T14:30:00Z"],
    ["São Paulo at midnight", BRT, "2026-10-16", 0, 0, "2026-10-16T03:00:00Z"],
    ["São Paulo at the last minute", BRT, "2026-10-16", 23, 59, "2026-10-17T02:59:00Z"],
    ["UTC", UTC, "2026-10-16", 9, 5, "2026-10-16T09:05:00Z"],
    ["a zone on the half hour", new Zone("Asia/Kolkata"), "2026-10-16", 8, 15, "2026-10-16T02:45:00Z"],
    ["a zone east of the date line", new Zone("Pacific/Kiritimati"), "2026-10-16", 1, 0, "2026-10-15T11:00:00Z"],
    ["New York the day before its clocks go forward", NEW_YORK, "2026-03-07", 2, 30, "2026-03-07T07:30:00Z"],
    ["New York the day after its clocks go back", NEW_YORK, "2026-11-02", 1, 30, "2026-11-02T06:30:00Z"],
  ])("instantOf reads a wall time in %s", (_name, zone, day, hour, minute, want) => {
    const t = instantOf(day, hour, minute, zone);
    expect(t).toEqual(new Date(want));
    expect(dateOf(t as Date, zone)).toBe(day);
  });

  it.each([
    // New York, 2026-03-08: 02:00 to 02:59 do not exist. 03:00 EDT is 07:00 UTC.
    ["the minute before the gap", NEW_YORK, "2026-03-08", 1, 59, "2026-03-08T06:59:00Z"],
    ["the first skipped minute", NEW_YORK, "2026-03-08", 2, 0, "2026-03-08T07:00:00Z"],
    ["a time inside the gap", NEW_YORK, "2026-03-08", 2, 30, "2026-03-08T07:00:00Z"],
    ["the last skipped minute", NEW_YORK, "2026-03-08", 2, 59, "2026-03-08T07:00:00Z"],
    ["the first minute after the gap", NEW_YORK, "2026-03-08", 3, 0, "2026-03-08T07:00:00Z"],
    ["a minute later", NEW_YORK, "2026-03-08", 3, 1, "2026-03-08T07:01:00Z"],
    // São Paulo, 2018-11-04: 00:00 to 00:59 do not exist. The day starts at 01:00, 03:00 UTC.
    ["a skipped midnight", BRT, "2018-11-04", 0, 0, "2018-11-04T03:00:00Z"],
    ["a time in a gap at midnight", BRT, "2018-11-04", 0, 30, "2018-11-04T03:00:00Z"],
    // Lord Howe Island, 2026-10-04: a gap of 30 minutes, 02:00 to 02:29.
    ["a time in a gap of half an hour", new Zone("Australia/Lord_Howe"), "2026-10-04", 2, 15, "2026-10-03T15:30:00Z"],
  ])("instantOf reads %s as the first instant after the gap, as the start of a day", (_name, zone, day, hour, minute, want) => {
    const t = instantOf(day, hour, minute, zone);
    expect(t).toEqual(new Date(want));
    // The instant is on the day that was asked for.
    expect(dateOf(t as Date, zone)).toBe(day);
  });

  it("instantOf agrees with bounds on a day whose midnight does not exist", () => {
    expect(instantOf("2018-11-04", 0, 0, BRT)).toEqual(bounds("2018-11-04", BRT)?.start);
    expect(instantOf("2026-03-08", 0, 0, NEW_YORK)).toEqual(bounds("2026-03-08", NEW_YORK)?.start);
    expect(instantOf("2026-11-01", 0, 0, NEW_YORK)).toEqual(bounds("2026-11-01", NEW_YORK)?.start);
  });

  it.each([
    // New York, 2026-11-01: 01:00 to 01:59 happen twice, first at UTC-4.
    ["the minute before the repeated hour", NEW_YORK, "2026-11-01", 0, 59, "2026-11-01T04:59:00Z"],
    ["the first repeated minute", NEW_YORK, "2026-11-01", 1, 0, "2026-11-01T05:00:00Z"],
    ["a time inside the repeated hour", NEW_YORK, "2026-11-01", 1, 30, "2026-11-01T05:30:00Z"],
    ["the last repeated minute", NEW_YORK, "2026-11-01", 1, 59, "2026-11-01T05:59:00Z"],
    ["the first minute after the repeated hour", NEW_YORK, "2026-11-01", 2, 0, "2026-11-01T07:00:00Z"],
    // São Paulo, 2018-02-17: 23:00 to 23:59 happen twice, first at UTC-2.
    ["a time repeated before midnight", BRT, "2018-02-17", 23, 30, "2018-02-18T01:30:00Z"],
  ])("instantOf reads %s as the first of its instants", (_name, zone, day, hour, minute, want) => {
    const t = instantOf(day, hour, minute, zone);
    expect(t).toEqual(new Date(want));
    expect(dateOf(t as Date, zone)).toBe(day);
  });

  it.each([
    ["2026-02-30", 10, 0],
    ["", 10, 0],
    ["2026-10-16", 24, 0],
    ["2026-10-16", 10, 60],
    ["2026-10-16", -1, 0],
    ["2026-10-16", 10, -1],
    ["2026-10-16", 10.5, 0],
    ["2026-10-16", 10, Number.NaN],
  ])("instantOf(%j, %d, %d) is not a time", (day, hour, minute) => {
    expect(instantOf(day, hour, minute, BRT)).toBeUndefined();
  });

  it.each([
    ["2026-10-01", -1, "2026-09-30"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-10-13", 0, "2026-10-13"],
    ["2026-10-13", 365, "2027-10-13"],
  ])("addDays(%s, %d) = %s", (day, n, want) => {
    expect(addDays(day, n)).toBe(want);
  });
});

describe("tool errors", () => {
  it("finds the ToolError in a cause chain", () => {
    const error = new Error("fetching sleep", {
      cause: new ToolError("auth_expired", "token expired", "health-coach-mcp auth login"),
    });
    expect(toWire(error)).toEqual({ code: "auth_expired", message: "token expired", hint: "health-coach-mcp auth login" });
    expect(toWire(new ToolError("no_data", "no sleep recorded"))).toEqual({ code: "no_data", message: "no sleep recorded" });
  });

  it("hides the details of any other error", () => {
    for (const error of [new Error("resting hr 57 failed to parse"), "resting hr 57", undefined, { code: "no_data" }]) {
      const wire = toWire(error);
      expect(wire).toEqual({ code: "internal_error", message: "unexpected internal error" });
      // Raw error text may carry health data and must not be echoed.
      expect(wireText(wire)).not.toContain("57");
    }
    expect(INTERNAL_ERROR.hint).toBeUndefined();
  });

  it("writes the wire JSON as code, message, hint", () => {
    expect(wireText({ code: "scope_missing", message: "missing sleep scope", hint: "sign in again" })).toBe(
      '{"code":"scope_missing","message":"missing sleep scope","hint":"sign in again"}',
    );
    expect(wireText({ code: "no_data", message: "nothing recorded yet" })).toBe('{"code":"no_data","message":"nothing recorded yet"}');
    expect(wireText({ code: "no_data", message: "m", hint: "" })).toBe('{"code":"no_data","message":"m"}');
  });

  it("names the types along an error chain, never a message", () => {
    const joined = new Error("read", { cause: new AggregateError([new SyntaxError("bad json 57"), new Error("second")]) });
    expect(errorTypes(joined)).toBe("Error > AggregateError > SyntaxError > Error");
    const tool = new ToolError("invalid_input", "the stored goal cannot be read", undefined, { cause: new SyntaxError("x") });
    expect(errorTypes(tool)).toBe("ToolError > SyntaxError");
    expect(errorTypes(undefined)).toBe("");
    expect(errorTypes("resting hr 57")).toBe("string");
    // A long (or circular) chain is cut.
    const loop = new Error("a");
    loop.cause = loop;
    expect(errorTypes(loop).split(" > ")).toHaveLength(8);
  });
});

describe("envelope", () => {
  it.each([
    [-1, "low"],
    [0, "low"],
    [6, "low"],
    [7, "medium"],
    [20, "medium"],
    [21, "high"],
    [28, "high"],
  ])("confidence(%d) = %s", (days, want) => {
    expect(confidence(days)).toBe(want);
  });

  it("never returns missing lists", () => {
    const envelope = newEnvelope(42, 5, undefined, undefined, new Date("2026-10-13T12:00:00Z"));
    expect(envelope).toEqual({
      data: 42,
      coverage: { n_days: 5, confidence: "low" },
      sources: [],
      quality_flags: [],
      generated_at: "2026-10-13T12:00:00Z",
    });
    expect(newEnvelope(1, 21, ["fitbit"], ["partial_day"], new Date("2026-10-13T12:00:00.500Z"))).toMatchObject({
      sources: ["fitbit"],
      quality_flags: ["partial_day"],
      generated_at: "2026-10-13T12:00:00.5Z",
    });
  });
});

describe("text helpers", () => {
  it("truncates at a character boundary", () => {
    expect(truncate("críti", 3)).toBe("cr…");
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("ação", 4)).toBe("aç…");
  });

  it("measures UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("ação")).toBe(6);
    expect(byteLength("😀")).toBe(4);
  });

  it("trims and splits on the same white space as the Go server", () => {
    expect(trimSpace(" \t\n \u0085 knee 　\r")).toBe("knee");
    // U+FEFF is not white space there.
    expect(trimSpace("﻿knee")).toBe("﻿knee");
    expect(fields("  Glucose \t Fasting\n")).toEqual(["Glucose", "Fasting"]);
    expect(fields("   ")).toEqual([]);
  });

  it("measures JSON text as Go's encoder writes it", () => {
    expect(goJsonLength('"morning"')).toBe(9);
    expect(goJsonLength('"ação"')).toBe(8);
    // <, > and & are 6 bytes each there; U+2028 and U+2029 too.
    expect(goJsonLength('"<>&"')).toBe(2 + 3 * 6);
    expect(goJsonLength('"  "')).toBe(2 + 2 * 6);
    // Text that is already escaped has nothing to add.
    expect(goJsonLength('"\\u003c"')).toBe(8);
  });

  it("lowercases code point by code point, as Go's strings.ToLower", () => {
    expect(lower("Glucose FASTING")).toBe("glucose fasting");
    expect(lower("CRÍTICO")).toBe("crítico");
    // U+0130 becomes a plain i; toLowerCase writes i plus a combining dot.
    expect(lower("CRİTICAL")).toBe("critical");
    expect("CRİTICAL".toLowerCase()).not.toBe("critical");
    // No final sigma: toLowerCase ends the word in U+03C2.
    expect(lower("ΟΣ")).toBe("οσ");
    expect("ΟΣ".toLowerCase()).toBe("ος");
    expect(lower("😀A")).toBe("😀a");
    expect(lower("")).toBe("");
  });

  it("orders text by code point, as SQLite's BINARY collation", () => {
    expect(compareText("aaa", "aab")).toBe(-1);
    expect(compareText("ab", "a")).toBe(1);
    expect(compareText("ldl", "ldl")).toBe(0);
    // An astral character sorts after U+FFFF, although its UTF-16 units do not.
    expect(compareText("￿", "😀")).toBe(-1);
  });
});

describe("HCM_TZ", () => {
  it("defaults to São Paulo and loads IANA zones", () => {
    expect(loadZone(undefined).name).toBe(DEFAULT_TIME_ZONE);
    expect(loadZone("").name).toBe("America/Sao_Paulo");
    expect(loadZone("UTC").name).toBe("UTC");
    expect(today(new Date("2026-10-13T23:30:00Z"), loadZone("Asia/Tokyo"))).toBe("2026-10-14");
  });

  it.each(["Mars/Olympus", "Local", "local", " Local ", " ", "+03:00", "America/Sao_Paulo; DROP"])("rejects %j, naming the variable", (name) => {
    expect(() => loadZone(name)).toThrow(ConfigError);
    expect(() => loadZone(name)).toThrow(/HCM_TZ/);
  });

  it("builds the Worker's zone once and follows a changed value", () => {
    const first = timeZone({ HCM_TZ: "Asia/Tokyo" });
    expect(timeZone({ HCM_TZ: "Asia/Tokyo" })).toBe(first);
    expect(timeZone({ HCM_TZ: "UTC" }).name).toBe("UTC");
    expect(timeZone({}).name).toBe(DEFAULT_TIME_ZONE);
  });

  it("needs no zone data for UTC", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    const utc = new Zone("UTC");
    expect(dateOf(new Date("2026-10-13T23:59:59.999Z"), utc)).toBe("2026-10-13");
    expect(utc.offsetMs(Date.parse("2026-10-13T23:59:59.999Z"))).toBe(0);
    expect(bounds("2026-10-13", utc)).toEqual({ start: new Date("2026-10-13T00:00:00Z"), end: new Date("2026-10-14T00:00:00Z") });
    expect(formatter).not.toHaveBeenCalled();
  });

  it("fails every memory tool, and names the variable in the log, with a zone it cannot use", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runInDurableObject(freshStore(), async (instance) => {
      expect(await objectTool(instance, "preferences_get")).toMatchObject({ ok: true });
      expect(logged).not.toHaveBeenCalled();

      // The Go server refuses to start in this case.
      Object.assign(instance, { env: { ...env, HCM_TZ: "Local" } });
      const calls: [string, Record<string, unknown>][] = [
        ["preferences_get", {}],
        ["profile_get", {}],
        ["note_add", { kind: "checkin", text: "x" }],
      ];
      for (const [tool, args] of calls) {
        expect(await objectTool(instance, tool, args)).toEqual({ ok: false, error: { code: "internal_error", message: "unexpected internal error" } });
      }
      expect(logged.mock.calls).toEqual(Array.from({ length: 3 }, () => ["config_error", { variable: "HCM_TZ" }]));
      // A tool that does not use the memory still answers.
      expect(await objectTool(instance, "server_info")).toMatchObject({ ok: true });
    });
  });
});
