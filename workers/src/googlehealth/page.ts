// Reads one response page record by record.
//
// JSON.parse of a whole page builds one object tree, and for small records
// that tree takes several times the size of the text. An isolate has 128 MB,
// so the page is never parsed whole: this module finds where each record of
// the list starts and ends, parses that record alone and hands it to the
// caller, which keeps only what it needs.
//
// The scanner checks the punctuation between values itself; every value (a
// record, a key, another field) goes through JSON.parse. So a text is accepted
// only when JSON.parse accepts it and it is an object.

/** The page is not a JSON object, or its list is not a list. The message never quotes the page. */
export class PageSyntaxError extends Error {
  constructor(what: string) {
    super(`unreadable page: ${what}`);
    this.name = "PageSyntaxError";
  }
}

export interface PageScan {
  /** Whether the list key is in the page. Its value may be null, which is an empty list. */
  hasList: boolean;
  /** Every other top-level field with its value. A key listed twice keeps its last value. */
  fields: Map<string, unknown>;
}

const WHITE_SPACE = /[ \t\n\r]*/y;
// A string literal. Its loops run over one character class each, so a long
// string does not grow the matcher's backtrack stack.
const STRING = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"/y;
// A number, true, false or null: up to the next separator.
const SCALAR = /[^,\]}\s]+/y;
// What changes the nesting depth, with string literals skipped as a whole.
const TOKEN = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|[{}[\]]/g;

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_LIST = 0x5b;
const CLOSE_LIST = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

function skip(text: string, from: number): number {
  WHITE_SPACE.lastIndex = from;
  WHITE_SPACE.test(text);
  return WHITE_SPACE.lastIndex;
}

/** The index after the value that starts at `start`. */
function valueEnd(text: string, start: number): number {
  const first = text.charCodeAt(start);
  if (first === OPEN_OBJECT || first === OPEN_LIST) {
    TOKEN.lastIndex = start;
    let depth = 0;
    while (TOKEN.test(text)) {
      // The last character of a match tells what it was, without a copy of it.
      const last = text.charCodeAt(TOKEN.lastIndex - 1);
      if (last === QUOTE) continue;
      if (last === OPEN_OBJECT || last === OPEN_LIST) depth++;
      else if (--depth === 0) return TOKEN.lastIndex;
    }
    throw new PageSyntaxError("a value does not end");
  }
  const pattern = first === QUOTE ? STRING : SCALAR;
  pattern.lastIndex = start;
  if (!pattern.test(text)) throw new PageSyntaxError("a value is missing");
  return pattern.lastIndex;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message can quote the text.
    throw new PageSyntaxError("a value is not JSON");
  }
}

/** Reads the list that starts at `start` and returns the index after it. */
function scanList(text: string, start: number, onRecord: (record: unknown) => void): number {
  if (text.charCodeAt(start) !== OPEN_LIST) {
    const end = valueEnd(text, start);
    if (parse(text.slice(start, end)) !== null) throw new PageSyntaxError("the list is not a list");
    return end;
  }
  let at = skip(text, start + 1);
  if (text.charCodeAt(at) === CLOSE_LIST) return at + 1;
  for (;;) {
    const end = valueEnd(text, at);
    onRecord(parse(text.slice(at, end)));
    at = skip(text, end);
    const separator = text.charCodeAt(at);
    if (separator === CLOSE_LIST) return at + 1;
    if (separator !== COMMA) throw new PageSyntaxError("the list does not end");
    at = skip(text, at + 1);
  }
}

/**
 * Reads a page: calls `onRecord` for each item of the list under `listKey`, in
 * order, and returns the other top-level fields. Throws PageSyntaxError when
 * the text is not a JSON object, when the list is neither a list nor null, or
 * when the list key is there twice. An error thrown by `onRecord` passes
 * through as it is.
 */
export function scanPage(text: string, listKey: string, onRecord: (record: unknown) => void): PageScan {
  const fields = new Map<string, unknown>();
  let hasList = false;
  let at = skip(text, 0);
  if (text.charCodeAt(at) !== OPEN_OBJECT) throw new PageSyntaxError("not an object");
  at = skip(text, at + 1);
  if (text.charCodeAt(at) === CLOSE_OBJECT) {
    at++;
  } else {
    for (;;) {
      STRING.lastIndex = at;
      if (!STRING.test(text)) throw new PageSyntaxError("a key is missing");
      const key = parse(text.slice(at, STRING.lastIndex)) as string;
      at = skip(text, STRING.lastIndex);
      if (text.charCodeAt(at) !== COLON) throw new PageSyntaxError("a key has no value");
      at = skip(text, at + 1);
      if (key === listKey) {
        // The records of a first list are already with the caller.
        if (hasList) throw new PageSyntaxError("the list is there twice");
        hasList = true;
        at = scanList(text, at, onRecord);
      } else {
        const end = valueEnd(text, at);
        fields.set(key, parse(text.slice(at, end)));
        at = end;
      }
      at = skip(text, at);
      const separator = text.charCodeAt(at);
      if (separator === CLOSE_OBJECT) {
        at++;
        break;
      }
      if (separator !== COMMA) throw new PageSyntaxError("the object does not end");
      at = skip(text, at + 1);
    }
  }
  if (skip(text, at) !== text.length) throw new PageSyntaxError("text after the object");
  return { hasList, fields };
}
