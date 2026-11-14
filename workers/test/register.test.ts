/// <reference types="vite/client" />
// Ports of internal/tools/register_test.go and guard_test.go, plus the
// tool-call log and the error contract of internal/server/middleware.go.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolError, type WireError } from "../src/coach/errors";
import { byteLength } from "../src/coach/text";
import { MAX_ECHOED_ERROR, type ToolHandler, type ToolOutcome, capture, defineTool, errorResult, invoke, schemaError } from "../src/tools/register";
import { inputSchema, s } from "../src/tools/schema";
import { SCHEMA_HINT } from "./memory-helpers";

const PROBE = defineTool({
  name: "probe",
  description: "test tool",
  inputSchema: inputSchema(s.object({ mode: s.string(), "day?": s.date() }), { mode: ["ok", "tool_error", "raw_error", "throw_text"] }),
  outputSchema: s.object({ steps: s.integer(), "day?": s.date() }),
});

// Exercises every outcome a real tool can have.
const probe: ToolHandler = (args) => {
  switch (args.mode) {
    case "tool_error":
      throw new ToolError("no_data", "no steps recorded");
    case "raw_error":
      throw new Error("resting hr 57 failed to parse");
    case "throw_text":
      throw "resting hr 57";
  }
  return { ok: true, output: { steps: 8000 } };
};

function payload(result: CallToolResult): WireError {
  expect(result.isError).toBe(true);
  // Never structured content: it would have to match the success output schema.
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  return JSON.parse(block?.type === "text" ? block.text : "") as WireError;
}

let log: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("register", () => {
  it("returns the output as structured content and as text", async () => {
    const result = await invoke(PROBE, probe, { mode: "ok" });
    expect(result).toEqual({ content: [{ type: "text", text: '{"steps":8000}' }], structuredContent: { steps: 8000 } });
  });

  it("sends a tool error to the client as {code,message,hint}", async () => {
    expect(payload(await invoke(PROBE, probe, { mode: "tool_error" }))).toEqual({ code: "no_data", message: "no steps recorded" });
    // The same contract when the error comes back in an outcome (the Durable Object path).
    const viaOutcome = await invoke(PROBE, () => ({ ok: false, error: { code: "auth_expired", message: "sign in again", hint: "reconnect" } }), { mode: "ok" });
    expect(payload(viaOutcome)).toEqual({ code: "auth_expired", message: "sign in again", hint: "reconnect" });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("hides raw errors and thrown values, and stays usable", async () => {
    for (const mode of ["raw_error", "throw_text"]) {
      const result = await invoke(PROBE, probe, { mode });
      expect(payload(result)).toEqual({ code: "internal_error", message: "unexpected internal error" });
      // No health value in what the client reads.
      expect(JSON.stringify(result)).not.toContain("57");
    }
    // Only the tool name and the error's type names are logged.
    expect(errorLog.mock.calls).toEqual([
      ["tool_internal_error", { tool: "probe", error_types: "Error" }],
      ["tool_internal_error", { tool: "probe", error_types: "string" }],
    ]);
    expect((await invoke(PROBE, probe, { mode: "ok" })).isError).toBeUndefined();
  });

  it("rejects arguments that fail the input schema, before the handler runs", async () => {
    const handler = vi.fn(probe);
    const bad: unknown[] = [
      { mode: "not-a-mode" },
      { mode: "ok", day: "garbage" },
      { mode: "ok", day: "2026-02-30" }, // matches the pattern, is not a real day
      { mode: "ok", unexpected: true },
      { day: "2026-10-13" },
      { mode: null },
      {},
      undefined,
      "ok",
    ];
    for (const args of bad) {
      const error = payload(await invoke(PROBE, handler, args));
      expect(error.code, JSON.stringify(args)).toBe("invalid_input");
      expect(error.hint).toBe(SCHEMA_HINT);
      expect(error.message).toMatch(/^the arguments do not match the tool's input schema: /);
    }
    expect(handler).not.toHaveBeenCalled();

    // Optional inputs also accept null and "" as "not set".
    for (const day of ["2026-10-13", "", null]) {
      expect((await invoke(PROBE, handler, { mode: "ok", day })).isError, String(day)).toBeUndefined();
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("bounds the validator text it echoes, at a character boundary", async () => {
    // The validator quotes the unknown property name the client sent.
    const error = payload(await invoke(PROBE, probe, { mode: "ok", ["ç".repeat(600)]: 1 }));
    expect(error.code).toBe("invalid_input");
    expect(error.message.endsWith("…")).toBe(true);
    expect(byteLength(error.message)).toBeLessThanOrEqual(MAX_ECHOED_ERROR + byteLength("…"));
    // No character was cut in half.
    expect(error.message).not.toContain("�");
    expect(schemaError("x").message).toBe("the arguments do not match the tool's input schema: x");
  });

  it("logs one line per call with the tool name, duration and outcome only", async () => {
    await invoke(PROBE, probe, { mode: "ok", day: "2026-10-13" });
    await invoke(PROBE, probe, { mode: "tool_error" });
    await invoke(PROBE, probe, { mode: "nope", secret: "resting hr 57" });
    await invoke(PROBE, probe, { mode: "raw_error" });
    expect(log.mock.calls).toEqual([
      ["tool_call", { tool: "probe", duration_ms: expect.any(Number), is_error: false }],
      ["tool_call", { tool: "probe", duration_ms: expect.any(Number), is_error: true, code: "no_data" }],
      ["tool_call", { tool: "probe", duration_ms: expect.any(Number), is_error: true, code: "invalid_input" }],
      ["tool_call", { tool: "probe", duration_ms: expect.any(Number), is_error: true, code: "internal_error" }],
    ]);
    expect(JSON.stringify([log.mock.calls, errorLog.mock.calls])).not.toMatch(/57|2026-10-13|secret/);
  });

  it("builds an error result with the JSON in the text content", () => {
    expect(errorResult({ code: "no_data", message: "nothing recorded yet" })).toEqual({
      content: [{ type: "text", text: '{"code":"no_data","message":"nothing recorded yet"}' }],
      isError: true,
    });
  });
});

describe("capture", () => {
  const run = (body: () => Record<string, unknown>): ToolOutcome => capture(PROBE, body);

  it("returns the output of a body", () => {
    expect(run(() => ({ steps: 1, day: "2026-10-13" }))).toEqual({ ok: true, output: { steps: 1, day: "2026-10-13" } });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("turns a ToolError into its wire form, without logging it", () => {
    expect(run(() => { throw new ToolError("invalid_input", "kcal must be between 0 and 10000", "fix it"); })).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "kcal must be between 0 and 10000", hint: "fix it" },
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("turns any other error into internal_error and logs its type names only", () => {
    const cause = new SyntaxError("Unexpected token in resting hr 57");
    expect(run(() => { throw new Error("row 57 is corrupt", { cause }); })).toEqual({
      ok: false,
      error: { code: "internal_error", message: "unexpected internal error" },
    });
    expect(errorLog.mock.calls).toEqual([["tool_internal_error", { tool: "probe", error_types: "Error > SyntaxError" }]]);
  });

  it("refuses a result that does not match the output schema", () => {
    for (const output of [{ steps: "many" }, { steps: 1, extra: 57 }, {}, { steps: 1, day: "13/10/2026" }]) {
      expect(run(() => output)).toEqual({ ok: false, error: { code: "internal_error", message: "unexpected internal error" } });
    }
    expect(errorLog).toHaveBeenCalledTimes(4);
    expect(errorLog).toHaveBeenLastCalledWith("tool_internal_error", { tool: "probe", error_types: "OutputSchemaError" });
  });
});

// A tool added with McpServer.registerTool directly would send raw error text
// (which may carry health values) to the client.
describe("source guard", () => {
  const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

  it("registers every tool through tools/register.ts", () => {
    const paths = Object.keys(sources);
    expect(paths).toContain("../src/tools/register.ts");
    expect(paths).toContain("../src/mcp.ts");
    const direct = paths.filter((path) => sources[path]?.includes(".registerTool(")).sort();
    expect(direct).toEqual(["../src/tools/register.ts"]);
  });

  it("writes no task or ticket reference into the sources", () => {
    for (const [path, source] of Object.entries(sources)) expect(source, path).not.toMatch(/\bDEV-\d+\b|\bPR [A-C]\b/);
  });
});
