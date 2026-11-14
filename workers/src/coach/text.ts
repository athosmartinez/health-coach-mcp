// String helpers with the Go server's semantics. The store limits and the
// normalization rules are defined on UTF-8 bytes and on Go's white space set,
// which differ from JavaScript's `length` and `trim()`.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 length of `s`, as Go's `len(string)`. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// Go's unicode.IsSpace. JavaScript's \s adds U+FEFF and leaves out U+0085.
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");
const RUN = new RegExp(`[${SPACE}]+`);

/** Go's strings.TrimSpace. */
export function trimSpace(s: string): string {
  return s.replace(EDGES, "");
}

/** Go's strings.Fields: the words of `s`, split on runs of white space. */
export function fields(s: string): string[] {
  const trimmed = trimSpace(s);
  return trimmed === "" ? [] : trimmed.split(RUN);
}

/**
 * Shortens text echoed in an error message to `maxBytes` UTF-8 bytes, cut at a
 * character boundary so an accented character is never split.
 */
export function truncate(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  let cut = maxBytes;
  // 0b10xxxxxx is a continuation byte: step back to the start of its character.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return `${decoder.decode(bytes.subarray(0, cut))}…`;
}

/** Quotes caller text inside an error message, as Go's %q does for plain text. */
export function quote(s: string): string {
  return JSON.stringify(s);
}

/** Orders strings by code point: the order of UTF-8 bytes and of SQLite's BINARY collation. */
export function compareText(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const diff = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
}
