// JSON schemas of the tools (Go: internal/tools/schema.go). The Go server
// infers them from its structs; the builders in `s` follow the same rules, one
// per Go type, and a parity test compares the result with the Go server's
// tools/list.

import { DATE_PATTERN, parseDate } from "../coach/date";

/** The JSON Schema keywords the tools use. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  pattern?: string;
  maxLength?: number;
  enum?: (string | null)[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false | JsonSchema;
  items?: JsonSchema;
}

const DATE_DESCRIPTION = "Local calendar day, YYYY-MM-DD";

function described(schema: JsonSchema, description?: string): JsonSchema {
  return description === undefined ? schema : { ...schema, description };
}

/** Schema builders, named after the Go types they stand for. */
export const s = {
  string: (description?: string): JsonSchema => described({ type: "string" }, description),
  number: (description?: string): JsonSchema => described({ type: "number" }, description),
  integer: (description?: string): JsonSchema => described({ type: "integer" }, description),
  boolean: (description?: string): JsonSchema => described({ type: "boolean" }, description),

  /** A local day. The pattern carries the format; calendar validity is checked by {@link invalidDate}. */
  date: (description = DATE_DESCRIPTION): JsonSchema => ({ type: "string", description, pattern: DATE_PATTERN }),

  /**
   * Any JSON value. Spelled as an object with a description, not {}: {} can
   * serialize as the boolean schema `true`, which zod-based clients (the MCP
   * Inspector among them) reject in properties.
   */
  anyJSON: (): JsonSchema => ({ description: "any JSON value" }),

  /** A Go pointer: the value, or null. */
  nullable: (schema: JsonSchema): JsonSchema => ({ ...schema, type: ["null", String(schema.type)] }),

  /** A Go slice: a list, or null. */
  list: (items: JsonSchema, description?: string): JsonSchema => described({ type: ["null", "array"], items }, description),

  /** A Go map keyed by string. */
  map: (values: JsonSchema): JsonSchema => ({ type: "object", additionalProperties: values }),

  /**
   * A Go struct: a closed object. A key that ends in "?" is an optional
   * (omitempty) field; every other field is required.
   */
  object: (fields: Record<string, JsonSchema>): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, schema] of Object.entries(fields)) {
      const optional = key.endsWith("?");
      const name = optional ? key.slice(0, -1) : key;
      properties[name] = schema;
      if (!optional) required.push(name);
    }
    return {
      type: "object",
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  },
};

const typesOf = (schema: JsonSchema): string[] => (Array.isArray(schema.type) ? schema.type : []);

/**
 * The input schema of a tool: `root` with the named top-level properties
 * restricted to the given values, and every optional property relaxed (see
 * {@link relaxOptional}). A property may be a string, a nullable string (null
 * stays allowed) or a list of strings, where the enum applies to each item.
 * A bad enum is a programming error and throws when the module loads.
 */
export function inputSchema(root: JsonSchema, enums: Record<string, readonly string[]> = {}): JsonSchema {
  const schema = structuredClone(root);
  for (const [name, values] of Object.entries(enums)) {
    const property = schema.properties?.[name];
    if (!property) throw new Error(`enum for unknown property "${name}"`);
    if (values.length === 0) throw new Error(`enum for "${name}" is empty`);
    applyEnum(name, property, values);
  }
  relaxOptional(schema);
  return schema;
}

function applyEnum(name: string, property: JsonSchema, values: readonly string[]): void {
  const types = typesOf(property);
  const nullable = types.length === 2 && types.includes("null");
  const is = (type: string) => property.type === type || (nullable && types.includes(type));
  if (is("string")) {
    property.enum = nullable ? [...values, null] : [...values];
  } else if (is("array") && property.items?.type === "string") {
    property.items.enum = [...values];
  } else {
    throw new Error(`enum for "${name}": property is ${JSON.stringify(property.type)}, want a string or a list of strings`);
  }
}

/**
 * Lets every optional property be null, and optional strings (plain, enum or
 * patterned) also "" (LLM clients often send those for "not set"). Numbers,
 * booleans and objects accept null but not "". Tool bodies treat both as
 * omitted. Required properties stay strict, and so do the items of a list.
 */
export function relaxOptional(object: JsonSchema): void {
  for (const [name, property] of Object.entries(object.properties ?? {})) {
    if (object.required?.includes(name)) continue;
    if (typeof property.type === "string") property.type = ["null", property.type];
    const types = typesOf(property);
    const isString = types.includes("string");
    if (property.enum) {
      if (!property.enum.includes(null)) property.enum.push(null);
      if (isString && !property.enum.includes("")) property.enum.push("");
    }
    if (isString && property.pattern?.startsWith("^") && property.pattern.endsWith("$")) {
      property.pattern = `^(?:${property.pattern.slice(1, -1)})?$`;
    }
    if (types.includes("object")) relaxOptional(property);
  }
}

function holdsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value !== "object" || value === null) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsNonFinite);
}

/**
 * Finds an argument that holds, at any depth, a number JSON cannot carry: a
 * literal such as 1e999 parses to Infinity, and JSON.stringify would then
 * write null for it. Returns the name of the argument (free-form values can
 * have keys the client chose, so the path inside is not echoed), or undefined
 * when every number is finite. The Go server fails to decode such arguments.
 */
export function nonFiniteNumber(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  for (const [name, value] of Object.entries(args)) {
    if (holdsNonFinite(value)) return `${name}: holds a number outside the range of a JSON number`;
  }
  return undefined;
}

const DATE_PATTERNS = new Set([DATE_PATTERN, `^(?:${DATE_PATTERN.slice(1, -1)})?$`]);

/**
 * The text for a property that the schema does not declare. Its name is the
 * client's own text (it can be a food name or an entry id), so it is never
 * repeated.
 */
export const UNKNOWN_PROPERTY = "the arguments hold a property that the tool does not have";

/** The text for arguments that fail a rule {@link plainProblem} does not name. */
export const NOT_MATCHED = "a value does not match its rule";

const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: "a text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  object: "an object",
  array: "a list",
};

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeProblem(name: string, schema: JsonSchema, value: unknown): string | undefined {
  if (schema.type === undefined) return undefined;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = jsonType(value);
  const fits = allowed.some((type) => type === actual || (type === "integer" && actual === "number" && Number.isInteger(value)));
  if (fits) return undefined;
  const words = allowed.filter((type) => type !== "null").map((type) => TYPE_WORDS[type] ?? type);
  if (allowed.includes("null")) words.push("null");
  return `${name} must be ${words.join(" or ")}`;
}

/**
 * Why `args` fail a flat input schema, in words that hold nothing the client
 * sent: the name of a property that the schema declares and the rule that
 * failed, never a key or a value of the arguments. Undefined when it finds no
 * problem.
 *
 * It reads the keywords a flat schema uses: `required`, a closed object
 * (`additionalProperties: false`), `type`, `enum`, `pattern` and `maxLength`
 * of each property. It is not a full validator: the caller still runs one
 * after it, and answers {@link NOT_MATCHED} for what only that one finds.
 */
export function plainProblem(schema: JsonSchema, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "the arguments must be an object";
  const properties = schema.properties ?? {};
  const given = args as Record<string, unknown>;
  if (schema.additionalProperties === false && Object.keys(given).some((key) => !Object.hasOwn(properties, key))) return UNKNOWN_PROPERTY;
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(given, name) || given[name] === undefined) return `${name} is required`;
  }
  for (const [name, property] of Object.entries(properties)) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value === undefined) continue;
    const wrongType = typeProblem(name, property, value);
    if (wrongType !== undefined) return wrongType;
    if (typeof value === "number" && !Number.isFinite(value)) return `${name} must be a finite number`;
    if (property.enum && !property.enum.includes(value as string | null)) {
      return `${name} must be one of ${property.enum.filter((one) => one !== null && one !== "").join(", ")}`;
    }
    if (typeof value !== "string") continue;
    if (property.maxLength !== undefined && [...value].length > property.maxLength) return `${name} must be at most ${property.maxLength} characters`;
    if (property.pattern !== undefined && !new RegExp(property.pattern, "u").test(value)) {
      return DATE_PATTERNS.has(property.pattern) ? `${name} must be a date, YYYY-MM-DD` : `${name} does not have the format that its description gives`;
    }
  }
  return undefined;
}

/**
 * Finds a date in `value` that matches the schema's pattern but is not a real
 * calendar day (2026-02-30). Returns where it is, without echoing the value,
 * or undefined when every date is real. "" is "not set" and passes.
 */
export function invalidDate(schema: JsonSchema, value: unknown, path = ""): string | undefined {
  if (typeof value === "string") {
    const isDate = schema.pattern !== undefined && DATE_PATTERNS.has(schema.pattern);
    return isDate && value !== "" && parseDate(value) === undefined
      ? `${path === "" ? "value" : path}: not a real calendar date, want YYYY-MM-DD`
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = schema.items && invalidDate(schema.items, item, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const found = invalidDate(property, (value as Record<string, unknown>)[name], path === "" ? name : `${path}.${name}`);
      if (found) return found;
    }
  }
  return undefined;
}
