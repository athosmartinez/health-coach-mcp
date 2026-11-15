import type { CallToolResult } from "@modelcontextprotocol/server";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { Zone } from "../src/coach/date";
import { ToolError, type WireError } from "../src/coach/errors";
import type { CoachStore } from "../src/store";
import { type Clock, Db } from "../src/store/db";
import { WRITE_TOOLS } from "../src/tools/foodlog";
import { MEMORY_TOOLS, runMemoryTool } from "../src/tools/memory";
import { COACH_TOOLS } from "../src/tools/moments";
import { invoke } from "../src/tools/register";
import { type JsonRpc, MCP_HEADERS, MCP_URL, parseRpc } from "./helpers";

export const MEMORY_TOOL_NAMES = MEMORY_TOOLS.map((tool) => tool.name);

/** The coach-moment tools, which read Google Health. */
export const COACH_TOOL_NAMES = COACH_TOOLS.map((tool) => tool.name);

/** The tools that write to Google Health. */
export const WRITE_TOOL_NAMES = WRITE_TOOLS.map((tool) => tool.name);

/** Every tool the Worker lists, sorted. */
export const ALL_TOOL_NAMES = ["google_account_status", "server_info", ...MEMORY_TOOL_NAMES, ...COACH_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort();

/** The tables the coach memory migration creates, with the FTS5 shadow tables. */
export const MEMORY_TABLES = [
  "health_items",
  "lab_results",
  "notes",
  "notes_fts",
  "notes_fts_config",
  "notes_fts_data",
  "notes_fts_docsize",
  "notes_fts_idx",
  "preferences",
  "profile",
  "targets",
];

/** The same instant every call, so stored timestamps are exact. */
export const FIXED_NOW = new Date("2026-10-14T12:00:00Z");
export const fixedClock: Clock = () => FIXED_NOW;

export const SAO_PAULO = new Zone("America/Sao_Paulo");

/** A new, empty coach store: each test gets its own Durable Object. */
export function freshStore(): DurableObjectStub<CoachStore> {
  return env.COACH_STORE.get(env.COACH_STORE.newUniqueId());
}

/** Runs `body` inside a new store, with the store's code on a controlled clock. */
export function withDb<T>(body: (db: Db, sql: SqlStorage) => T | Promise<T>, now: Clock = fixedClock): Promise<T> {
  return runInDurableObject(freshStore(), (_instance, state) => body(new Db(state.storage, now), state.storage.sql));
}

/** The code of the ToolError `body` throws; fails the test when it throws anything else or nothing. */
export function codeOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof ToolError) return error.code;
    throw error;
  }
  return "no error";
}

/** The ToolError `body` throws. */
export function toolError(body: () => unknown): ToolError {
  try {
    body();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a ToolError, nothing was thrown");
}

/** A POST to /mcp as the Worker forwards it to the object: the MCP headers, no Authorization. */
export function mcpRequest(body: unknown): Request {
  return new Request(MCP_URL, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
}

/** The CoachStore object or its stub: both serve MCP on fetch. */
export interface McpTarget {
  fetch(request: Request): Promise<Response>;
}

/** One JSON-RPC call served by the object itself, without the Worker in front. */
export async function objectRpc(target: McpTarget, body: unknown): Promise<JsonRpc> {
  const response = await target.fetch(mcpRequest(body));
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return parseRpc(response.headers.get("content-type"), text);
}

/** One tool call served by the object itself: its output, or the {code,message,hint} it sent. */
export async function objectTool(
  target: McpTarget,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; output: Record<string, any> } | { ok: false; error: WireError }> {
  const reply = await objectRpc(target, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  const result = reply.result as { isError?: boolean; content?: { text: string }[]; structuredContent?: Record<string, any> };
  if (result.isError) return { ok: false, error: JSON.parse(result.content?.[0]?.text ?? "") as WireError };
  return { ok: true, output: result.structuredContent ?? {} };
}

export const SCHEMA_HINT = "check the tool's input schema and retry";

export interface MemorySession {
  /** Calls a tool that must succeed and returns its structured result. */
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Calls a tool that must fail and returns the {code,message,hint} it sent. */
  fails(name: string, args?: Record<string, unknown>): Promise<WireError & { text: string; schema: boolean }>;
  /** The raw result of a call. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Direct SQL on the session's store, to corrupt or inspect rows. */
  sql<T>(body: (sql: SqlStorage) => T): Promise<T>;
}

/**
 * Serves the memory tools as the Worker does (argument check, then the body
 * inside the Durable Object), on a new store with a controlled clock and zone.
 * The default "now" is 2026-10-14 01:30 UTC = 2026-10-13 22:30 in São Paulo.
 */
export function memorySession(at = "2026-10-14T01:30:00Z", zone: Zone = SAO_PAULO): MemorySession {
  const stub = freshStore();
  const now: Clock = () => new Date(at);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = MEMORY_TOOLS.find((one) => one.name === name);
    if (!tool) throw new Error(`no memory tool named ${name}`);
    return invoke(
      tool,
      (checked) =>
        runInDurableObject(stub, (_instance, state) =>
          runMemoryTool({ db: new Db(state.storage, now), zone }, name, checked),
        ),
      args,
    );
  };
  const textOf = (result: CallToolResult) => {
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    return block?.type === "text" ? block.text : "";
  };
  return {
    call,
    async ok(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name}(${JSON.stringify(args)}) failed: ${textOf(result)}`).not.toBe(true);
      // The text content is the same JSON as the structured content.
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
      return result.structuredContent as Record<string, any>;
    },
    async fails(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name}(${JSON.stringify(args)}) succeeded, want an error`).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = textOf(result);
      const wire = JSON.parse(text) as WireError;
      expect(Object.keys(wire).sort()).toEqual(wire.hint === undefined ? ["code", "message"] : ["code", "hint", "message"]);
      return { ...wire, text, schema: wire.hint === SCHEMA_HINT };
    },
    sql: (body) => runInDurableObject(stub, (_instance, state) => body(state.storage.sql)),
  };
}
