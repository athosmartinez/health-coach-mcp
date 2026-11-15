/// <reference types="vite/client" />
// Schema parity with the Go server, the contract of this Worker.
//
// fixtures/go-tools-list.json is the `tools/list` result of the Go server over
// stdio. To generate it again, from workers/:
//
//   (cd .. && make build) && node scripts/go-tools-list.mjs
//
// The script runs the Go binary with new empty data and config folders.
//
// The comparison is on parsed JSON, with one normalization: the order of the
// keys of a JSON object is ignored (objects are unordered; the Go SDK and
// JSON.stringify write them in different orders). Everything else must be
// equal: the keys of each tool, every string, and the order of every array
// (required, enum, type).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fixtureText from "./fixtures/go-tools-list.json?raw";
import { rpc, signInAsOwner } from "./helpers";
import { COACH_TOOL_NAMES, MEMORY_TOOL_NAMES } from "./memory-helpers";

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
    expect(COACH_TOOL_NAMES).toEqual(["morning_briefing", "workout_review", "nutrition_day"]);
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

    expect(worker?.description).toBe(go?.description);
    expect(worker?.annotations).toEqual(go?.annotations);
    expect(worker?.inputSchema).toEqual(go?.inputSchema);
    expect(worker?.outputSchema).toEqual(go?.outputSchema);
    expect(canonical(worker)).toBe(canonical(go));
  });

  it("knows which Go tools the Worker does not serve yet", () => {
    // server_info exists on both sides but differs on purpose: the Worker adds
    // `transport` to its output and annotations to the tool.
    const missing = [...goTools.keys()].filter((name) => !workerTools.has(name)).sort();
    expect(missing).toEqual(["metric_series", "weekly_report"]);
    expect([...workerTools.keys()].filter((name) => !goTools.has(name))).toEqual(["google_account_status"]);
  });
});
