// Ports of internal/tools/schema_test.go. The Go test for a type with no JSON
// schema (a channel) has no equivalent: the builders only produce schemas.
import { describe, expect, it } from "vitest";

import { DATE_PATTERN } from "../src/coach/date";
import { MEMORY_TOOLS } from "../src/tools/memory";
import { type JsonSchema, inputSchema, invalidDate, s } from "../src/tools/schema";

const sample = () =>
  s.object({
    kind: s.string("what kind of item"),
    "notes?": s.string(),
    "tags?": s.list(s.string()),
    "maybe?": s.nullable(s.string()),
    "count?": s.integer(),
    "day?": s.date(),
    inner: s.object({ leaf: s.string() }),
  });

describe("schema builders", () => {
  it("builds a closed object with its required fields", () => {
    expect(s.object({})).toEqual({ type: "object", additionalProperties: false });
    expect(s.object({ "a?": s.string() })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect(s.object({ a: s.number(), "b?": s.boolean("flag") })).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "boolean", description: "flag" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("spells pointers, lists, maps, dates and free JSON as the Go server does", () => {
    expect(s.nullable(s.integer("n"))).toEqual({ type: ["null", "integer"], description: "n" });
    expect(s.list(s.string(), "names")).toEqual({ type: ["null", "array"], items: { type: "string" }, description: "names" });
    expect(s.map(s.anyJSON())).toEqual({ type: "object", additionalProperties: { description: "any JSON value" } });
    expect(s.date()).toEqual({ type: "string", description: "Local calendar day, YYYY-MM-DD", pattern: DATE_PATTERN });
    expect(s.date("first day").description).toBe("first day");
  });
});

describe("inputSchema", () => {
  it("applies an enum to a string and keeps its description", () => {
    const kind = inputSchema(sample(), { kind: ["condition", "injury"] }).properties?.kind;
    expect(kind?.enum).toEqual(["condition", "injury"]);
    expect(kind?.description).toBe("what kind of item");
  });

  it("applies an enum to the items of a list, not to the list", () => {
    const tags = inputSchema(sample(), { tags: ["a", "b"] }).properties?.tags;
    // An enum on the array itself would reject every list.
    expect(tags?.enum).toBeUndefined();
    expect(tags?.items?.enum).toEqual(["a", "b"]);
  });

  it("keeps null allowed for a nullable string, and adds the empty string", () => {
    // Optional: null and "" both mean not set.
    expect(inputSchema(sample(), { maybe: ["x"] }).properties?.maybe?.enum).toEqual(["x", null, ""]);
  });

  it("relaxes an optional date and keeps a required one strict", () => {
    const day = inputSchema(sample()).properties?.day;
    expect(day?.type).toEqual(["null", "string"]);
    expect(day?.pattern).toBe("^(?:\\d{4}-\\d{2}-\\d{2})?$");
    const strict = inputSchema(s.object({ day: s.date() })).properties?.day;
    expect(strict).toMatchObject({ type: "string", pattern: DATE_PATTERN });
  });

  it("relaxes optional properties: null for all, the empty string for strings", () => {
    const { properties = {}, required } = inputSchema(sample(), { kind: ["a"], notes: ["x", "y"] });
    expect(required).toEqual(["kind", "inner"]);
    // Required properties stay strict.
    expect(properties.kind).toEqual({ type: "string", description: "what kind of item", enum: ["a"] });
    expect(properties.inner?.properties?.leaf).toEqual({ type: "string" });
    expect(properties.notes).toEqual({ type: ["null", "string"], enum: ["x", "y", null, ""] });
    expect(properties.count).toEqual({ type: ["null", "integer"] });
    // The items of a list are not relaxed.
    expect(properties.tags).toEqual({ type: ["null", "array"], items: { type: "string" } });
  });

  it("relaxes the optional fields of an optional nested object", () => {
    const nested = inputSchema(s.object({ "goal?": s.nullable(s.object({ "type?": s.string(), "deadline?": s.date(), id: s.string() })) }));
    const goal = nested.properties?.goal;
    expect(goal?.type).toEqual(["null", "object"]);
    expect(goal?.properties?.type?.type).toEqual(["null", "string"]);
    expect(goal?.properties?.deadline?.pattern).toBe("^(?:\\d{4}-\\d{2}-\\d{2})?$");
    expect(goal?.properties?.id).toEqual({ type: "string" });
  });

  it("does not change the schema it was given", () => {
    const root = sample();
    const before = structuredClone(root);
    inputSchema(root, { kind: ["a"], tags: ["b"] });
    expect(root).toEqual(before);
  });

  it.each([
    ["unknown property", { missing: ["x"] }],
    ["nested path", { "inner.leaf": ["x"] }],
    ["non-string", { count: ["1"] }],
    ["object", { inner: ["x"] }],
    ["empty values", { kind: [] }],
  ])("rejects a bad enum: %s", (_name, enums) => {
    expect(() => inputSchema(sample(), enums)).toThrow(/enum for/);
  });
});

describe("invalidDate", () => {
  const schema = inputSchema(
    s.object({
      day: s.date(),
      "since?": s.date(),
      "goal?": s.nullable(s.object({ "deadline?": s.date() })),
      "results?": s.list(s.object({ on: s.date(), name: s.string() })),
      "note?": s.string(),
    }),
  );

  it("accepts real days, and the empty string or null for an optional date", () => {
    expect(invalidDate(schema, { day: "2028-02-29", since: "", goal: { deadline: null }, results: [{ on: "2026-10-13", name: "x" }] })).toBeUndefined();
    expect(invalidDate(schema, { day: "2026-10-13", goal: null, results: null })).toBeUndefined();
    // Only fields with the date pattern are checked.
    expect(invalidDate(schema, { day: "2026-10-13", note: "2026-02-30" })).toBeUndefined();
  });

  it.each([
    [{ day: "2026-02-30" }, "day"],
    [{ day: "2026-10-13", since: "2026-13-01" }, "since"],
    [{ day: "2026-10-13", goal: { deadline: "2027-02-29" } }, "goal.deadline"],
    [{ day: "2026-10-13", results: [{ on: "2026-10-13", name: "a" }, { on: "2026-04-31", name: "b" }] }, "results[1].on"],
  ])("finds a day that does not exist: %j", (value, path) => {
    const found = invalidDate(schema, value);
    expect(found).toBe(`${path}: not a real calendar date, want YYYY-MM-DD`);
    // The value is not echoed.
    expect(found).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// Client interop: zod-based clients (the MCP Inspector among them) reject
// `true` or `false` as a property schema.
describe("tool schemas", () => {
  function booleanSchemas(path: string, schema: unknown): string[] {
    if (typeof schema === "boolean") return [path];
    if (typeof schema !== "object" || schema === null) return [];
    const node = schema as JsonSchema;
    return [
      ...Object.entries(node.properties ?? {}).flatMap(([name, property]) => booleanSchemas(`${path}.properties.${name}`, property)),
      ...(node.items === undefined ? [] : booleanSchemas(`${path}.items`, node.items)),
      // additionalProperties: false closes an object; it is not a property schema.
      ...(typeof node.additionalProperties === "object" ? booleanSchemas(`${path}.additionalProperties`, node.additionalProperties) : []),
    ];
  }

  it("finds a boolean schema when there is one", () => {
    const bad = { type: "object", properties: { a: true, b: { type: "array", items: false } } };
    expect(booleanSchemas("t", bad)).toEqual(["t.properties.a", "t.properties.b.items"]);
  });

  it.each(MEMORY_TOOLS.map((tool) => [tool.name, tool] as const))("%s has no boolean schema in its properties", (name, tool) => {
    expect(booleanSchemas(`${name}.input`, tool.inputSchema)).toEqual([]);
    expect(booleanSchemas(`${name}.output`, tool.outputSchema)).toEqual([]);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema.type).toBe("object");
  });
});
