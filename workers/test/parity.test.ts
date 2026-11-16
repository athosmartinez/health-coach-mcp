/// <reference types="vite/client" />
// Schema parity with the frozen tools/list snapshot.
//
// fixtures/go-tools-list.json is a frozen snapshot of the former Go server's
// `tools/list` result. It is the source of truth for this comparison: do not
// regenerate it.
//
// The comparison is on parsed JSON, with one normalization: the order of the
// keys of a JSON object is ignored (objects are unordered). Everything else
// must be equal: the keys of each tool, every string, and the order of every
// array (required, enum, type).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OVERLAP_IN_WEEK } from "../src/tools/weekly";
import { LOGGED_SESSIONS } from "../src/tools/workout";
import fixtureText from "./fixtures/go-tools-list.json?raw";
import { rpc, signInAsOwner } from "./helpers";
import { COACH_TOOL_NAMES, EXERCISE_LOG_TOOL_NAMES, MEMORY_TOOL_NAMES, WRITE_TOOL_NAMES } from "./memory-helpers";

/**
 * Tools the Go server does not have, sorted: the two tools that write the
 * exercise log, the account status of the Worker's own sign-in, and the two
 * tools that write the food log (the Go server never writes to Google
 * Health).
 */
const NOT_IN_THE_GO_SERVER = ["exercise_log_add", "exercise_log_delete", "google_account_status", "nutrition_log_add", "nutrition_log_delete"];

interface ListedTool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

const goTools = new Map((JSON.parse(fixtureText) as { tools: ListedTool[] }).tools.map((tool) => [tool.name, tool]));
const workerTools = new Map<string, ListedTool>();

beforeAll(async () => {
  const { access_token: accessToken } = await signInAsOwner();
  const listed = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(listed.error).toBeUndefined();
  for (const tool of (listed.result as { tools: ListedTool[] }).tools) workerTools.set(tool.name, tool);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * nutrition_day as the Go server lists it. The Worker adds `entry_id` to each
 * food item and one sentence to the description; everything else is the Go tool.
 */
function withoutEntryId(tool: ListedTool | undefined): ListedTool | undefined {
  if (!tool) return undefined;
  const copy = structuredClone(tool);
  copy.description = goTools.get("nutrition_day")?.description;
  const output = copy.outputSchema as {
    properties?: {
      data?: {
        properties?: {
          per_meal?: { items?: { properties?: { items?: { items?: { properties?: Record<string, unknown>; required?: string[] } } } } };
        };
      };
    };
  };
  const item = output.properties?.data?.properties?.per_meal?.items?.properties?.items?.items;
  if (item?.properties) delete item.properties.entry_id;
  if (item?.required) item.required = item.required.filter((field) => field !== "entry_id");
  return copy;
}

/**
 * workout_review as the Go server lists it. The Worker adds `entry_id` to each
 * session and, at the end of the description, the sentences about the
 * sessions it logged; everything else is the Go tool.
 */
function withoutSessionEntryId(tool: ListedTool | undefined): ListedTool | undefined {
  if (!tool) return undefined;
  const copy = structuredClone(tool);
  copy.description = goTools.get("workout_review")?.description;
  const output = copy.outputSchema as {
    properties?: { data?: { properties?: { sessions?: { items?: { properties?: Record<string, unknown>; required?: string[] } } } } };
  };
  const session = output.properties?.data?.properties?.sessions?.items;
  if (session?.properties) delete session.properties.entry_id;
  if (session?.required) session.required = session.required.filter((field) => field !== "entry_id");
  return copy;
}

/** JSON with the keys of every object sorted, to show a difference as text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) =>
    node !== null && typeof node === "object" && !Array.isArray(node)
      ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => (a < b ? -1 : 1)))
      : node,
  );
}

describe("parity with the Go server's tools/list", () => {
  it("has the 11 coach memory tools in the fixture and in the Worker", () => {
    expect(MEMORY_TOOL_NAMES).toHaveLength(11);
    for (const name of MEMORY_TOOL_NAMES) {
      expect(goTools.has(name), `${name} in the Go fixture`).toBe(true);
      expect(workerTools.has(name), `${name} in the Worker`).toBe(true);
    }
  });

  it("has the coach-moment tools of this Worker in the fixture and in the Worker", () => {
    expect(COACH_TOOL_NAMES).toEqual(["morning_briefing", "workout_review", "nutrition_day", "weekly_report", "metric_series"]);
    for (const name of COACH_TOOL_NAMES) {
      expect(goTools.has(name), `${name} in the Go fixture`).toBe(true);
      expect(workerTools.has(name), `${name} in the Worker`).toBe(true);
    }
  });

  it.each([...MEMORY_TOOL_NAMES, ...COACH_TOOL_NAMES])("%s has the same name, description, annotations and schemas", (name) => {
    const go = goTools.get(name);
    const worker = workerTools.get(name);
    // The same fields are listed: nothing extra, nothing missing.
    expect(Object.keys(worker ?? {}).sort()).toEqual(["annotations", "description", "inputSchema", "name", "outputSchema"]);
    expect(Object.keys(go ?? {}).sort()).toEqual(Object.keys(worker ?? {}).sort());

    expect(worker?.annotations).toEqual(go?.annotations);
    expect(worker?.inputSchema).toEqual(go?.inputSchema);
    if (name === "nutrition_day") {
      // The Worker adds entry_id to each food item, and one sentence that says where it comes from.
      const sentence = " An item this server logged has entry_id, the id nutrition_log_delete accepts; an item from another app, or logged for another linked Google account, has entry_id null.";
      expect(worker?.description).toBe(`${go?.description}${sentence}`);
      expect(canonical(withoutEntryId(worker))).toBe(canonical(go));
      return;
    }
    if (name === "workout_review") {
      // The Worker adds entry_id to each session, and says what a session it logged looks like and which flag it can carry.
      expect(worker?.description).toBe(`${go?.description}${LOGGED_SESSIONS}`);
      expect(LOGGED_SESSIONS).toContain("A session this server logged has entry_id, the id exercise_log_delete accepts");
      expect(LOGGED_SESSIONS).toContain("overlaps_band_session marks a logged session that overlaps a band session in time");
      expect(LOGGED_SESSIONS).toContain("In the result's quality_flags it also covers the sessions of the week");
      // The field is there, required and nullable, before it is taken out for the comparison.
      const session = (worker?.outputSchema as any).properties.data.properties.sessions.items;
      expect(session.properties.entry_id).toEqual({ type: ["null", "string"], description: expect.stringContaining("exercise_log_delete") });
      expect(session.required).toContain("entry_id");
      expect(canonical(withoutSessionEntryId(worker))).toBe(canonical(go));
      return;
    }
    if (name === "weekly_report") {
      // The Worker counts the sessions it logged, and says which flag marks a week that may count a workout twice.
      expect(worker?.description).toBe(`${go?.description}${OVERLAP_IN_WEEK}`);
      expect(OVERLAP_IN_WEEK).toContain("overlaps_band_session in quality_flags marks a week in which a session this server logged overlaps a band session in time");
      // Everything else is the Go tool.
      expect(worker?.outputSchema).toEqual(go?.outputSchema);
      expect(canonical({ ...worker, description: go?.description })).toBe(canonical(go));
      return;
    }
    expect(worker?.description).toBe(go?.description);
    expect(worker?.outputSchema).toEqual(go?.outputSchema);
    expect(canonical(worker)).toBe(canonical(go));
  });

  it("serves every tool of the Go server, and only the listed tools of its own", () => {
    // server_info exists on both sides but differs on purpose: the Worker adds
    // `transport` to its output and annotations to the tool.
    const missing = [...goTools.keys()].filter((name) => !workerTools.has(name)).sort();
    expect(missing).toEqual([]);
    // A tool of the Worker that is neither in the Go fixture nor in this list fails here.
    expect([...workerTools.keys()].filter((name) => !goTools.has(name)).sort()).toEqual(NOT_IN_THE_GO_SERVER);
    expect(goTools.size).toBe(17);
    expect(workerTools.size).toBe(goTools.size + NOT_IN_THE_GO_SERVER.length);
    expect(NOT_IN_THE_GO_SERVER).toHaveLength(5);
    expect(workerTools.size).toBe(22);
  });

  it("lists the write tools as not in the Go server, which only reads Google Health", () => {
    expect(WRITE_TOOL_NAMES).toEqual(["nutrition_log_add", "nutrition_log_delete"]);
    expect(EXERCISE_LOG_TOOL_NAMES).toEqual(["exercise_log_add", "exercise_log_delete"]);
    for (const name of [...WRITE_TOOL_NAMES, ...EXERCISE_LOG_TOOL_NAMES]) {
      expect(NOT_IN_THE_GO_SERVER, name).toContain(name);
      expect(goTools.has(name), `${name} in the Go fixture`).toBe(false);
      expect(workerTools.has(name), `${name} in the Worker`).toBe(true);
      // The same fields as a tool of the Go server lists.
      expect(Object.keys(workerTools.get(name) ?? {}).sort()).toEqual(["annotations", "description", "inputSchema", "name", "outputSchema"]);
    }
  });
});
