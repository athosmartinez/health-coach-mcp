// Reads one response page record by record.
//
// JSON.parse of a whole page builds one object tree, and for small values
// that tree takes several times the size of the text: a page under the byte
// limit can hold millions of them. An isolate has 128 MB, so the page is never
// parsed whole, and no part of it is parsed without a bound:
//
// - a record of the list is parsed alone and handed to the caller, which
//   keeps only what it needs. A record longer than MAX_RECORD_CHARS is
//   refused before it is parsed;
// - the page token is parsed only when it is a string: one value, no tree;
// - any other top-level field is checked as JSON and never parsed. The caller
//   gets its name alone.
//
// So a text is accepted only when JSON.parse accepts it and it is an object
// (the two limits apart: the record length, and MAX_DEPTH for a value that is
// checked here). The scanner checks the punctuation between values itself.

/** The page is not a JSON object, or its list is not a list. The message never quotes the page. */
export class PageSyntaxError extends Error {
  constructor(what: string) {
    super(`unreadable page: ${what}`);
    this.name = "PageSyntaxError";
  }
}

/** The key of the token that asks for the next page. */
export const PAGE_TOKEN_KEY = "nextPageToken";

/**
 * Bounds the text of one record, in characters, and so the object tree that
 * JSON.parse builds for it: at most about 350,000 values (3 characters each,
 * `[],`), by estimate some 10 MB for a moment.
 *
 * The largest real records are a night with its stage list and a session. A
 * stage is about 250 characters, and the band writes a few hundred per night
 * at most: a stage every 30 seconds for 8 hours is 960 stages, 240,000
 * characters. A session with a summary per lap or per kilometer is smaller.
 * 1 MiB is four times that night, and above a sleep of 24 hours at the same
 * rate (720,000 characters).
 */
export const MAX_RECORD_CHARS = 1 << 20;

/**
 * Bounds the nesting of a value that is checked without being parsed, and so
 * the list of its open containers. A Google Health record nests less than ten
 * levels.
 */
export const MAX_DEPTH = 512;

export interface PageScan {
  /** Whether the list key is in the page. Its value may be null, which is an empty list. */
  hasList: boolean;
  /**
   * The names of the other top-level fields, the page token apart: each once,
   * in the order they first appear. Their values are checked, never parsed.
   */
  fields: string[];
  /** The page token; null when the key is absent or its value is null. A key listed twice keeps its last value. */
  nextPageToken: string | null;
}

const WHITE_SPACE = /[ \t\n\r]*/y;
// The characters of a string up to its end or its next escape. Each pattern
// below loops over one character class at most, so the matcher keeps no
// backtrack state, however long the text: a loop over a group keeps some for
// every turn, and a string with millions of escapes would fill its stack.
const PLAIN = /[^"\\]*/y;
// The same for a string that is checked here: a control character is not JSON.
const STRICT_PLAIN = /[^"\\\u0000-\u001f]*/y;
const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL = /true|false|null/y;
// A number, true, false or null that JSON.parse checks: up to the next separator.
const SCALAR = /[^,\]}\s]+/y;
// What starts a string or changes the nesting depth.
const STRUCTURE = /["{}[\]]/g;

const QUOTE = 0x22;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const COLON = 0x3a;
const OPEN_LIST = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_LIST = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

function skip(text: string, from: number): number {
  WHITE_SPACE.lastIndex = from;
  WHITE_SPACE.test(text);
  return WHITE_SPACE.lastIndex;
}

/** The index after the run of `plain` characters that starts at `from`. */
function run(plain: RegExp, text: string, from: number): number {
  plain.lastIndex = from;
  plain.test(text);
  return plain.lastIndex;
}

/**
 * The index after the string whose opening quote is at `start`. Its escapes
 * are stepped over, not checked: JSON.parse checks the string afterwards.
 */
function stringEnd(text: string, start: number): number {
  for (let at = start + 1; ; at += 2) {
    at = run(PLAIN, text, at);
    const code = text.charCodeAt(at);
    if (code === QUOTE) return at + 1;
    if (code !== BACKSLASH || at + 1 >= text.length) throw new PageSyntaxError("a text does not end");
  }
}

/** The index after the value that starts at `start`: where it ends, not whether it is JSON. */
function valueEnd(text: string, start: number): number {
  const first = text.charCodeAt(start);
  if (first === QUOTE) return stringEnd(text, start);
  if (first !== OPEN_OBJECT && first !== OPEN_LIST) {
    SCALAR.lastIndex = start;
    if (!SCALAR.test(text)) throw new PageSyntaxError("a value is missing");
    return SCALAR.lastIndex;
  }
  STRUCTURE.lastIndex = start;
  let depth = 0;
  while (STRUCTURE.test(text)) {
    const at = STRUCTURE.lastIndex - 1;
    const code = text.charCodeAt(at);
    if (code === QUOTE) STRUCTURE.lastIndex = stringEnd(text, at);
    else if (code === OPEN_OBJECT || code === OPEN_LIST) depth++;
    else if (--depth === 0) return at + 1;
  }
  throw new PageSyntaxError("a value does not end");
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message can quote the text.
    throw new PageSyntaxError("a value is not JSON");
  }
}

/** Checks the string whose opening quote is at `start` and returns the index after it. */
function checkString(text: string, start: number): number {
  for (let at = start + 1; ; ) {
    at = run(STRICT_PLAIN, text, at);
    if (text.charCodeAt(at) === QUOTE) return at + 1;
    ESCAPE.lastIndex = at;
    if (!ESCAPE.test(text)) throw new PageSyntaxError("a text is not JSON");
    at = ESCAPE.lastIndex;
  }
}

/** Checks the string, number, true, false or null at `start` and returns the index after it. */
function checkScalar(text: string, start: number): number {
  const first = text.charCodeAt(start);
  if (first === QUOTE) return checkString(text, start);
  const pattern = first === MINUS || (first >= DIGIT_0 && first <= DIGIT_9) ? NUMBER : LITERAL;
  pattern.lastIndex = start;
  if (!pattern.test(text)) throw new PageSyntaxError("a value is missing");
  return pattern.lastIndex;
}

/** Checks the key at `at` and its colon, and returns the index of its value. */
function checkKey(text: string, at: number): number {
  if (text.charCodeAt(at) !== QUOTE) throw new PageSyntaxError("a key is missing");
  const colon = skip(text, checkString(text, at));
  if (text.charCodeAt(colon) !== COLON) throw new PageSyntaxError("a key has no value");
  return skip(text, colon + 1);
}

/**
 * Checks that the value at `start` is JSON, without building it, and returns
 * the index after it. It keeps one flag per open container and nothing else,
 * whatever the number of values.
 */
function checkValue(text: string, start: number): number {
  // The open containers, the innermost last: true for an object.
  const open: boolean[] = [];
  let at = start;
  for (;;) {
    // A value starts at `at`.
    const first = text.charCodeAt(at);
    if (first === OPEN_OBJECT || first === OPEN_LIST) {
      const object = first === OPEN_OBJECT;
      at = skip(text, at + 1);
      if (text.charCodeAt(at) !== (object ? CLOSE_OBJECT : CLOSE_LIST)) {
        if (open.length === MAX_DEPTH) throw new PageSyntaxError("a value is nested too deep");
        open.push(object);
        if (object) at = checkKey(text, at);
        continue;
      }
      at++; // an empty container
    } else {
      at = checkScalar(text, at);
    }
    // A value ended at `at`: close its containers, up to the next value.
    for (;;) {
      if (open.length === 0) return at;
      const object = open[open.length - 1] === true;
      at = skip(text, at);
      const separator = text.charCodeAt(at);
      if (separator === COMMA) {
        at = skip(text, at + 1);
        if (object) at = checkKey(text, at);
        break;
      }
      if (separator !== (object ? CLOSE_OBJECT : CLOSE_LIST)) throw new PageSyntaxError("a value does not end");
      open.pop();
      at++;
    }
  }
}

/** Checks the value at `start` as JSON, never parsed, and says whether it is null. Returns the index after it too. */
function checkNull(text: string, start: number): { end: number; isNull: boolean } {
  const end = checkValue(text, start);
  return { end, isNull: end - start === 4 && text.startsWith("null", start) };
}

/** Reads the list that starts at `start` and returns the index after it. */
function scanList(text: string, start: number, onRecord: (record: unknown) => void): number {
  if (text.charCodeAt(start) !== OPEN_LIST) {
    const { end, isNull } = checkNull(text, start);
    if (!isNull) throw new PageSyntaxError("the list is not a list");
    return end;
  }
  let at = skip(text, start + 1);
  if (text.charCodeAt(at) === CLOSE_LIST) return at + 1;
  for (;;) {
    const end = valueEnd(text, at);
    if (end - at > MAX_RECORD_CHARS) throw new PageSyntaxError("a record is too long");
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
 * order, and returns the page token and the names of the other top-level
 * fields. Throws PageSyntaxError when the text is not a JSON object, when the
 * list is neither a list nor null, when the list key is there twice, when a
 * record is longer than MAX_RECORD_CHARS, or when the page token is neither a
 * string nor null. An error thrown by `onRecord` passes through as it is.
 */
export function scanPage(text: string, listKey: string, onRecord: (record: unknown) => void): PageScan {
  const fields = new Set<string>();
  let hasList = false;
  let nextPageToken: string | null = null;
  let tokenIsText = true;
  let at = skip(text, 0);
  if (text.charCodeAt(at) !== OPEN_OBJECT) throw new PageSyntaxError("not an object");
  at = skip(text, at + 1);
  if (text.charCodeAt(at) === CLOSE_OBJECT) {
    at++;
  } else {
    for (;;) {
      if (text.charCodeAt(at) !== QUOTE) throw new PageSyntaxError("a key is missing");
      const keyEnd = stringEnd(text, at);
      const key = parse(text.slice(at, keyEnd)) as string;
      at = skip(text, keyEnd);
      if (text.charCodeAt(at) !== COLON) throw new PageSyntaxError("a key has no value");
      at = skip(text, at + 1);
      if (key === listKey) {
        // The records of a first list are already with the caller.
        if (hasList) throw new PageSyntaxError("the list is there twice");
        hasList = true;
        at = scanList(text, at, onRecord);
      } else if (key === PAGE_TOKEN_KEY && text.charCodeAt(at) === QUOTE) {
        const end = stringEnd(text, at);
        nextPageToken = parse(text.slice(at, end)) as string;
        tokenIsText = true;
        at = end;
      } else if (key === PAGE_TOKEN_KEY) {
        const { end, isNull } = checkNull(text, at);
        nextPageToken = null;
        tokenIsText = isNull;
        at = end;
      } else {
        at = checkValue(text, at);
        fields.add(key);
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
  if (!tokenIsText) throw new PageSyntaxError("the page token is not a text");
  return { hasList, fields: [...fields], nextPageToken };
}
