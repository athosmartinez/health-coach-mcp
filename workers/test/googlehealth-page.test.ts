// The record-by-record page reader. It must accept exactly the pages that
// JSON.parse accepts as an object, and hand over the same records.
import { describe, expect, it } from "vitest";

import { PageSyntaxError, scanPage } from "../src/googlehealth/page";

const KEY = "dataPoints";

function scan(text: string): { records: unknown[]; fields: Record<string, unknown>; hasList: boolean } {
  const records: unknown[] = [];
  const page = scanPage(text, KEY, (record) => records.push(record));
  return { records, fields: Object.fromEntries(page.fields), hasList: page.hasList };
}

/** What JSON.parse says the page holds, or undefined when the page reader must refuse it. */
function reference(text: string): { records: unknown[]; fields: Record<string, unknown>; hasList: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { [KEY]: list, ...fields } = parsed as Record<string, unknown>;
  const hasList = Object.hasOwn(parsed, KEY);
  if (hasList && list !== null && !Array.isArray(list)) return undefined;
  return { records: Array.isArray(list) ? list : [], fields, hasList };
}

const VALID = [
  "{}",
  " \n\t{ \r\n } \n",
  '{"dataPoints":[]}',
  '{"dataPoints":null}',
  '{"dataPoints": [ ] , "nextPageToken" : "p2" }',
  '{"nextPageToken":""}',
  '{"nextPageToken":"p2","dataPoints":[{"a":1},{"a":2}],"other":{"deep":[1,[2,[3]]]}}',
  '{"dataPoints":[1,"a",null,true,false,-1.5e-3,[],{},[[]],{"x":[1,{"y":"}"}]}]}',
  // Brackets, quotes and escapes inside strings do not change the depth.
  '{"dataPoints":[{"name":"a]\\"}{[","note":"\\\\"},{"name":"\\u005d\\n\\t"}],"k\\"ey":"}"}',
  '{"dataPoints":[{"name":"café ł 日本 😀"}],"título":"ação"}',
  '{"dataPoints":[{"__proto__":{"x":1},"constructor":"c"}],"__proto__":"p"}',
  '{\n  "dataPoints": [\n    {\n      "name": "users/me/dataTypes/steps/dataPoints/a",\n      "steps": { "count": "12" }\n    },\n    {\n      "name": "b"\n    }\n  ],\n  "nextPageToken": "p2"\n}\n',
  '{"a":1,"a":2,"dataPoints":[0]}',
  '{"dataPoints":[1e999, 0.1, 12345678901234567890]}',
];

const INVALID = [
  "",
  " ",
  "null",
  "[]",
  '"x"',
  "7",
  "{",
  "}",
  '{"a"}',
  '{"a":}',
  '{"a":1,}',
  '{,"a":1}',
  '{"a":1 "b":2}',
  '{"a":1,,"b":2}',
  "{'a':1}",
  "{a:1}",
  '{"a":01}',
  '{"a":tru}',
  '{"a":"\\x"}',
  '{"a":"line\nbreak"}',
  '{"a":"unterminated}',
  '{"dataPoints":[1,]}',
  '{"dataPoints":[,1]}',
  '{"dataPoints":[1 2]}',
  '{"dataPoints":[}',
  '{"dataPoints":[{]}}',
  '{"dataPoints":[{"a":1}',
  '{"dataPoints":[[1,2}]}',
  '{"dataPoints":{}}',
  '{"dataPoints":"x"}',
  '{"dataPoints":7}',
  '{"dataPoints":nullx}',
  '{"dataPoints":[]} x',
  '{"dataPoints":[]}{}',
  '{"dataPoints":[]},',
  '﻿{"dataPoints":[]}',
  '{"dataPoints":[1]"nextPageToken":"p"}',
];

/** A small deterministic generator, so a failure repeats. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const TEXTS = ["", "a", "}", "]", '"', "\\", "{[", "é", "日本", "😀", "line\nbreak", "tab\t", "a,b:c", " "];

function value(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 2 ? 5 : 7));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return next() < 0.5;
    case 2:
      return Math.round((next() - 0.5) * 1e6) / 1e3;
    case 3:
    case 4:
      return TEXTS[Math.floor(next() * TEXTS.length)];
    case 5:
      return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
    default: {
      const object: Record<string, unknown> = {};
      const size = Math.floor(next() * 4);
      for (let i = 0; i < size; i++) object[`k${i}${TEXTS[Math.floor(next() * TEXTS.length)]}`] = value(next, depth + 1);
      return object;
    }
  }
}

function page(next: () => number): string {
  const body: Record<string, unknown> = {};
  if (next() < 0.3) body.before = value(next, 1);
  if (next() < 0.9) body[KEY] = next() < 0.1 ? null : Array.from({ length: Math.floor(next() * 6) }, () => value(next, 0));
  if (next() < 0.5) body.nextPageToken = "p2";
  if (next() < 0.3) body.after = value(next, 1);
  const indent = [undefined, 0, 2, "\t"][Math.floor(next() * 4)];
  return JSON.stringify(body, null, indent);
}

describe("scanPage", () => {
  it.each(VALID)("reads %j as JSON.parse does", (text) => {
    expect(scan(text)).toEqual(reference(text));
  });

  it.each(INVALID)("refuses %j", (text) => {
    expect(reference(text)).toBeUndefined();
    expect(() => scan(text)).toThrow(PageSyntaxError);
  });

  it("hands the records over in order, one at a time", () => {
    const seen: unknown[] = [];
    const result = scanPage('{"dataPoints":[{"n":1},{"n":2},{"n":3}],"nextPageToken":"p2"}', KEY, (record) => {
      seen.push(record);
    });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(result.hasList).toBe(true);
    expect([...result.fields]).toEqual([["nextPageToken", "p2"]]);
  });

  it("reads the list under the key it is asked for", () => {
    const records: unknown[] = [];
    const result = scanPage('{"dataPoints":[1],"rollupDataPoints":[2,3]}', "rollupDataPoints", (record) => records.push(record));
    expect(records).toEqual([2, 3]);
    expect(result.fields.get("dataPoints")).toEqual([1]);
  });

  it("refuses a page that holds the list twice", () => {
    // JSON.parse keeps the last one; the records of the first are already handed over.
    expect(() => scan('{"dataPoints":[1],"dataPoints":[2]}')).toThrow(PageSyntaxError);
  });

  it("lets an error of the record handler through", () => {
    expect(() =>
      scanPage('{"dataPoints":[1]}', KEY, () => {
        throw new RangeError("handler");
      }),
    ).toThrow(RangeError);
  });

  it("never quotes the page in its error", () => {
    try {
      scan('{"dataPoints":[{"bpm":"72 secret"},]}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PageSyntaxError);
      expect((error as Error).message).not.toMatch(/72|secret|bpm/);
    }
  });

  it("agrees with JSON.parse on generated pages and on damaged ones", () => {
    const next = random(20261114);
    let accepted = 0;
    let refused = 0;
    for (let round = 0; round < 400; round++) {
      const text = page(next);
      expect(scan(text), text).toEqual(reference(text));
      // Damage the text at one place: drop, double or replace a character.
      for (let damage = 0; damage < 8; damage++) {
        const at = Math.floor(next() * text.length);
        const kind = Math.floor(next() * 3);
        const replacement = '{}[],:" \\x0'[Math.floor(next() * 11)] ?? "";
        const damaged =
          kind === 0
            ? text.slice(0, at) + text.slice(at + 1)
            : kind === 1
              ? text.slice(0, at) + text.charAt(at) + text.slice(at)
              : text.slice(0, at) + replacement + text.slice(at + 1);
        const want = reference(damaged);
        if (want === undefined) {
          refused++;
          expect(() => scan(damaged), damaged).toThrow(PageSyntaxError);
        } else {
          accepted++;
          expect(scan(damaged), damaged).toEqual(want);
        }
      }
    }
    // Both outcomes were exercised.
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(1000);
  });

  it("reads a record with a very long text, escapes included", () => {
    const long = `${"a".repeat(2_000_000)}"\\${"é]".repeat(1_000_000)}`;
    const text = JSON.stringify({ dataPoints: [{ note: long }, { n: 2 }], [long]: 1 });
    const records: unknown[] = [];
    const result = scanPage(text, KEY, (record) => records.push(record));
    expect(records).toEqual([{ note: long }, { n: 2 }]);
    expect(result.fields.get(long)).toBe(1);
  });

  it("reads a large page", () => {
    const record = (i: number) => ({
      name: `users/me/dataTypes/heart-rate/dataPoints/${i}`,
      dataSource: { recordingMethod: "PASSIVELY_MEASURED", platform: "FITBIT" },
      heartRate: { sampleTime: { physicalTime: "2026-10-10T22:00:00Z" }, beatsPerMinute: String(60 + (i % 40)) },
    });
    const text = JSON.stringify({ dataPoints: Array.from({ length: 10_000 }, (_, i) => record(i)), nextPageToken: "p2" }, null, 2);
    expect(text.length).toBeGreaterThan(2_000_000);
    let count = 0;
    let last: unknown;
    const result = scanPage(text, KEY, (item) => {
      count++;
      last = item;
    });
    expect(count).toBe(10_000);
    expect(last).toEqual(record(9_999));
    expect(result.fields.get("nextPageToken")).toBe("p2");
  });
});
