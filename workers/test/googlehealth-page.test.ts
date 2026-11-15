// The record-by-record page reader. It must accept exactly the pages that
// JSON.parse accepts as an object, and hand over the same records. It parses
// one record at a time, and never a top-level field other than the list and
// the page token: of those it gives the names.
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_DEPTH, MAX_RECORD_CHARS, PAGE_TOKEN_KEY, PageSyntaxError, scanPage } from "../src/googlehealth/page";

const KEY = "dataPoints";

interface Read {
  records: unknown[];
  /** The names of the other top-level fields, sorted. */
  fields: string[];
  token: string | null;
  hasList: boolean;
}

function scan(text: string): Read {
  const records: unknown[] = [];
  const page = scanPage(text, KEY, (record) => records.push(record));
  return { records, fields: [...page.fields].sort(), token: page.nextPageToken, hasList: page.hasList };
}

/** What JSON.parse says the page holds, or undefined when the page reader must refuse it. */
function reference(text: string): Read | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { [KEY]: list, [PAGE_TOKEN_KEY]: token = null, ...fields } = parsed as Record<string, unknown>;
  const hasList = Object.hasOwn(parsed, KEY);
  if (hasList && list !== null && !Array.isArray(list)) return undefined;
  if (token !== null && typeof token !== "string") return undefined;
  return { records: Array.isArray(list) ? list : [], fields: Object.keys(fields).sort(), token, hasList };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The length of the longest text that JSON.parse got while `body` ran. */
function longestParsed(body: () => void): number {
  const parse = vi.spyOn(JSON, "parse");
  try {
    body();
    return Math.max(0, ...parse.mock.calls.map(([text]) => String(text).length));
  } finally {
    parse.mockRestore();
  }
}

/** `count` empty lists in a list: three characters per value, the smallest value JSON has. */
const manyValues = (count: number) => `[${"[],".repeat(count - 1)}[]]`;

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
    expect(result).toEqual({ hasList: true, fields: [], nextPageToken: "p2" });
  });

  it("reads the list under the key it is asked for", () => {
    const records: unknown[] = [];
    const result = scanPage('{"dataPoints":[1],"rollupDataPoints":[2,3]}', "rollupDataPoints", (record) => records.push(record));
    expect(records).toEqual([2, 3]);
    // The other list is a field like any other: its name, not its value.
    expect(result).toEqual({ hasList: true, fields: ["dataPoints"], nextPageToken: null });
  });

  it("gives the name of each other field once, in the order of the page", () => {
    const result = scanPage('{"b":1,"a":{"x":[1]},"dataPoints":[],"b":"again","c":null}', KEY, () => undefined);
    expect(result).toEqual({ hasList: true, fields: ["b", "a", "c"], nextPageToken: null });
  });

  describe("the page token", () => {
    it.each<[string, string | null]>([
      ['{"nextPageToken":"p2"}', "p2"],
      ['{"nextPageToken":""}', ""],
      ['{"nextPageToken":"a\\u0062\\n"}', "ab\n"],
      ['{"nextPageToken":null}', null],
      ['{"dataPoints":[]}', null],
      // A key listed twice keeps its last value, as JSON.parse does.
      ['{"nextPageToken":7,"nextPageToken":"p2"}', "p2"],
      ['{"nextPageToken":"p2","nextPageToken":null}', null],
    ])("of %j is %j", (text, token) => {
      expect(scan(text).token).toBe(token);
      expect(reference(text)?.token).toBe(token);
    });

    it.each(['{"nextPageToken":7}', '{"nextPageToken":true}', '{"nextPageToken":{"a":"p2"}}', '{"nextPageToken":["p2"]}', '{"nextPageToken":"p2","nextPageToken":0}'])(
      "must be a string or null: %j is refused",
      (text) => {
        expect(reference(text)).toBeUndefined();
        expect(() => scan(text)).toThrow(PageSyntaxError);
      },
    );

    it("is not parsed when it is not a string", () => {
      const text = `{"dataPoints":[],"nextPageToken":${manyValues(400_000)}}`;
      expect(longestParsed(() => expect(() => scan(text)).toThrow(PageSyntaxError))).toBeLessThan(20);
    });
  });

  // A page under the byte limit can hold millions of small values. The reader
  // never hands JSON.parse more than one record, and never a record over the cap.
  describe("a page that is small in bytes and large in the count of values", () => {
    /** 700,000 values in 2.1 million characters. */
    const VALUES = 700_000;

    it("does not parse a top-level field that is not the list", () => {
      const text = `{"dataPoints":[{"n":1}],"extra":${manyValues(VALUES)},"nextPageToken":"p2"}`;
      let read: Read | undefined;
      const longest = longestParsed(() => {
        read = scan(text);
      });
      expect(read).toEqual({ records: [{ n: 1 }], fields: ["extra"], token: "p2", hasList: true });
      // The keys, the record and the page token: nothing of the field.
      expect(longest).toBeLessThan(20);
    });

    it.each([
      ["an object with many keys", `{${Array.from({ length: 100_000 }, (_unused, i) => `"k${i}":{}`).join(",")}}`],
      ["a list of numbers, texts and literals", `[${"0,\"\",null,true,false,-1.5e-3,".repeat(100_000)}{"deep":[[[[{"x":[1]}]]]]}]`],
    ])("checks %s without parsing it", (_name, value) => {
      const text = `{"extra":${value},"dataPoints":[]}`;
      expect(reference(text)).toEqual({ records: [], fields: ["extra"], token: null, hasList: true });
      let read: Read | undefined;
      const longest = longestParsed(() => {
        read = scan(text);
      });
      expect(read).toEqual({ records: [], fields: ["extra"], token: null, hasList: true });
      expect(longest).toBeLessThan(20);
    });

    it("does not parse a value of the list key that is not a list", () => {
      const text = `{"dataPoints":{"a":${manyValues(VALUES)}}}`;
      expect(longestParsed(() => expect(() => scan(text)).toThrow(PageSyntaxError))).toBeLessThan(20);
    });

    it("still refuses a field that is not JSON, wherever the fault is", () => {
      const big = manyValues(VALUES);
      for (const value of [`${big.slice(0, -1)},]`, `${big.slice(0, -1)}`, `${big}]`, `[${big} ${big}]`, `{"a":${big},"b"}`, `{"a":${big},"b":01}`, `["\\x",${big}]`]) {
        const text = `{"dataPoints":[],"extra":${value}}`;
        expect(reference(text), value.slice(-12)).toBeUndefined();
        expect(() => scan(text), value.slice(-12)).toThrow(PageSyntaxError);
      }
    });

    it("refuses a record longer than the cap before it is parsed", () => {
      // 350,000 values in a little more than 1 MiB.
      const record = `{"samples":${manyValues(350_000)}}`;
      expect(record.length).toBeGreaterThan(MAX_RECORD_CHARS);
      expect(record.length).toBeLessThan(MAX_RECORD_CHARS + 2000);
      const text = `{"dataPoints":[{"n":1},${record},{"n":3}]}`;
      // JSON.parse reads the page: only the cap refuses it.
      expect(reference(text)?.records).toHaveLength(3);
      const seen: unknown[] = [];
      const longest = longestParsed(() => {
        expect(() => scanPage(text, KEY, (item) => seen.push(item))).toThrow(new PageSyntaxError("a record is too long"));
      });
      expect(longest).toBeLessThan(20);
      // The reader stops there. The client drops the records of a page that fails.
      expect(seen).toEqual([{ n: 1 }]);
    });

    it("reads a record of exactly the cap", () => {
      const record = (length: number) => `{"note":"${"a".repeat(length - '{"note":""}'.length)}"}`;
      const atCap = record(MAX_RECORD_CHARS);
      expect(atCap).toHaveLength(MAX_RECORD_CHARS);
      expect(scan(`{"dataPoints":[${atCap}, {"n":2}]}`).records).toHaveLength(2);
      expect(() => scan(`{"dataPoints":[${record(MAX_RECORD_CHARS + 1)}]}`)).toThrow(PageSyntaxError);
      // 1 MiB: four times a night with a stage every 30 seconds.
      expect(MAX_RECORD_CHARS).toBe(1_048_576);
    });

    it("bounds the nesting of a field it checks", () => {
      const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
      // The innermost list is empty: it opens no level of its own.
      expect(scan(`{"extra":${nested(MAX_DEPTH + 1)}}`).fields).toEqual(["extra"]);
      expect(() => scan(`{"extra":${nested(MAX_DEPTH + 2)}}`)).toThrow(new PageSyntaxError("a value is nested too deep"));
      expect(() => scan(`{"extra":${"[".repeat(3_000_000)}}`)).toThrow(PageSyntaxError);
      expect(MAX_DEPTH).toBe(512);
    });

    it("reads texts with millions of escapes: in a key, in a field and in the page token", () => {
      const escapes = "\\n".repeat(4_000_000);
      const text = `{"${escapes}":"${escapes}","nextPageToken":"${escapes}","dataPoints":[{"note":"${"\\n".repeat(400_000)}"}]}`;
      const read = scan(text);
      expect(read.fields).toEqual(["\n".repeat(4_000_000)]);
      expect(read.token).toHaveLength(4_000_000);
      expect(read.records).toEqual([{ note: "\n".repeat(400_000) }]);
      // In a record over the cap too: the reader finds its end, then refuses it.
      expect(() => scan(`{"dataPoints":[{"note":"${escapes}"}]}`)).toThrow(new PageSyntaxError("a record is too long"));
    });
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

  it("reads a very long text, escapes included: in a record up to the cap, and in a key and a field beyond it", () => {
    const long = `${"a".repeat(2_000_000)}"\\${"é]".repeat(1_000_000)}`;
    const note = `${"a".repeat(500_000)}"\\${"é]".repeat(250_000)}`;
    const text = JSON.stringify({ dataPoints: [{ note }, { n: 2 }], [long]: long });
    const records: unknown[] = [];
    const result = scanPage(text, KEY, (record) => records.push(record));
    expect(records).toEqual([{ note }, { n: 2 }]);
    expect(result.fields).toEqual([long]);
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
    expect(result.nextPageToken).toBe("p2");
  });
});
