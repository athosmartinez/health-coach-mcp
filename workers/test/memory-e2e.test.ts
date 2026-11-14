// End to end: OAuth sign-in, /mcp, and the coach memory tools served from the
// CoachStore Durable Object. Synthetic values only.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forwardedRequest } from "../src/index";
import { CoachStore, coachStore } from "../src/store";
import { DATA_NOTICE, MEDICAL_HINT } from "../src/tools/memory";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, type JsonRpc, MCP_HEADERS, MCP_URL, ORIGIN, parseRpc, rpc, signInAsOwner } from "./helpers";
import { ALL_TOOL_NAMES, SCHEMA_HINT, freshStore, mcpRequest, objectRpc, objectTool } from "./memory-helpers";

const MODERN_PROTOCOL = "2026-07-28";

let accessToken = "";
let nextId = 1;

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const reply = await rpc(accessToken, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  return reply.result as ToolResult;
}

/** Posts a request body as text: JSON.stringify cannot write 1e999, and writes null for it. */
async function rawRpc(body: string): Promise<JsonRpc> {
  const response = await exports.default.fetch(MCP_URL, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${accessToken}` },
    body,
  });
  const text = await response.text();
  expect(response.status, text).toBeLessThan(500);
  return parseRpc(response.headers.get("content-type"), text);
}

/** Calls a tool that must succeed and returns its structured content. */
async function ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await callTool(name, args);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual(result.structuredContent);
  return result.structuredContent ?? {};
}

/** Calls a tool that must fail and returns the {code,message,hint} of its text content. */
async function fails(name: string, args?: Record<string, unknown>): Promise<{ code: string; message: string; hint?: string }> {
  const result = await callTool(name, args);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content?.[0]?.text ?? "") as { code: string; message: string; hint?: string };
}

beforeEach(async () => {
  // The named store is shared by the tests of this file: start each one empty.
  await runInDurableObject(coachStore(env), (_instance, state) => {
    for (const table of ["profile", "targets", "health_items", "lab_results", "preferences", "notes"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  accessToken = (await signInAsOwner()).access_token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The Worker does OAuth and the allowlist check; the CoachStore object serves
// the whole MCP request.
describe("the MCP request inside the object", () => {
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("answers tools/list and a tool call for a request without an Authorization header", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = freshStore();
    expect(mcpRequest(listTools).headers.has("authorization")).toBe(false);

    const listed = await objectRpc(stub, listTools);
    expect(listed.error).toBeUndefined();
    expect((listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);

    expect(await objectTool(stub, "preference_set", { key: "tone", value: "direct" })).toEqual({
      ok: true,
      output: { key: "tone", value: "direct", notice: DATA_NOTICE },
    });
    expect(await objectTool(stub, "preferences_get")).toMatchObject({ ok: true, output: { preferences: { tone: "direct" } } });
    // google_account_status runs in the object too, with no call to its own stub.
    expect(await objectTool(stub, "google_account_status")).toMatchObject({ ok: true, output: { linked: false, token: "not_linked" } });
    expect(await objectTool(stub, "note_add", { kind: "rant", text: "x" })).toMatchObject({ ok: false, error: { code: "invalid_input", hint: SCHEMA_HINT } });
  });

  it("serves only the MCP route, and keeps the handler's Origin check", async () => {
    const stub = freshStore();
    const other = await stub.fetch(new Request(`${ORIGIN}/other`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(listTools) }));
    expect(other.status).toBe(404);
    const foreign = await stub.fetch(
      new Request(MCP_URL, { method: "POST", headers: { ...MCP_HEADERS, origin: "https://evil.example" }, body: JSON.stringify(listTools) }),
    );
    expect(foreign.status).toBe(403);
  });

  it("gets the request from the Worker without the MCP access token", async () => {
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    const listed = await rpc(accessToken, listTools);
    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(13);

    expect(served).toHaveBeenCalledTimes(1);
    const forwarded = served.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.has("authorization")).toBe(false);
    expect(JSON.stringify([...forwarded.headers])).not.toContain(accessToken);
    // The URL, Host and the MCP headers are kept: the handler checks Host and Origin.
    expect(forwarded.url).toBe(MCP_URL);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("host")).toBe("localhost");
    expect(forwarded.headers.get("mcp-protocol-version")).toBe(MCP_HEADERS["mcp-protocol-version"]);
    expect(forwarded.headers.get("content-type")).toBe("application/json");
  });

  it("builds the forwarded request with the same URL, method, headers and body", async () => {
    const original = new Request(MCP_URL, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer zz-mcp-token", origin: ORIGIN },
      body: JSON.stringify(listTools),
    });
    const forwarded = forwardedRequest(original);
    expect([...forwarded.headers].sort()).toEqual([...new Headers({ ...MCP_HEADERS, origin: ORIGIN })].sort());
    expect(forwarded.url).toBe(MCP_URL);
    expect(forwarded.method).toBe("POST");
    expect(await forwarded.json()).toEqual(listTools);
  });

  it("is not reached without a token, or with the grant of an account that is no longer allowed", async () => {
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    const post = (headers: Record<string, string>) =>
      exports.default.fetch(MCP_URL, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(listTools) });

    const anonymous = await post({});
    expect(anonymous.status).toBe(401);
    const wrongToken = await post({ authorization: "Bearer not-a-token" });
    expect(wrongToken.status).toBe(401);

    const allowed = env.ALLOWED_GOOGLE_EMAIL;
    try {
      env.ALLOWED_GOOGLE_EMAIL = "someone-else@example.com";
      const denied = await post({ authorization: `Bearer ${accessToken}` });
      expect(denied.status).toBe(403);
    } finally {
      env.ALLOWED_GOOGLE_EMAIL = allowed;
    }
    expect(served).not.toHaveBeenCalled();

    // The same grant is served again once the account is allowed.
    expect((await post({ authorization: `Bearer ${accessToken}` })).status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
  });
});

describe("coach memory over /mcp", () => {
  it("lists the 13 tools, with no boolean schema in any property", async () => {
    const listed = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.error).toBeUndefined();
    const tools = (listed.result as { tools: { name: string; inputSchema: unknown; outputSchema: unknown }[] }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);
    expect(tools).toHaveLength(13);

    // Client interop: zod-based clients reject `true` or `false` as a property schema.
    const booleans: string[] = [];
    const walk = (path: string, node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const schema = node as { properties?: Record<string, unknown>; items?: unknown; additionalProperties?: unknown };
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (typeof property === "boolean") booleans.push(`${path}.properties.${name}`);
        walk(`${path}.${name}`, property);
      }
      if (typeof schema.items === "boolean") booleans.push(`${path}.items`);
      walk(`${path}.items`, schema.items);
      walk(`${path}.additionalProperties`, schema.additionalProperties);
    };
    for (const tool of tools) {
      expect((tool.inputSchema as { type?: unknown }).type, tool.name).toBe("object");
      walk(`${tool.name}.input`, tool.inputSchema);
      walk(`${tool.name}.output`, tool.outputSchema);
    }
    expect(booleans).toEqual([]);
  });

  it("serves every family of memory tools", async () => {
    // Profile and targets.
    const updated = await ok("profile_update", { sex: "f", height_cm: 170, goal: { type: "maintain" } });
    expect(updated.profile).toMatchObject({ sex: "f", height_cm: 170, goal: { type: "maintain" } });
    expect(updated.previous).toBeUndefined();
    const target = await ok("targets_set", { effective_from: "2026-01-01", kcal: 2100, protein_g: 120 });
    expect(target.target).toMatchObject({ effective_from: "2026-01-01", kcal: 2100, protein_g: 120 });

    // Health history.
    const item = await ok("health_item_upsert", { kind: "allergy", name: "Lactose", status: "active", details: "mild" });
    expect(item.item).toMatchObject({ kind: "allergy", name: "Lactose", status: "active", details: "mild" });
    expect((await ok("health_items_list", { kind: "allergy" })).items).toHaveLength(1);

    // Labs.
    const recorded = await ok("labs_record", {
      collected_on: "2026-09-01",
      lab: "LabX",
      results: [
        { analyte: "LDL", value: 145, unit: "mg/dL", ref_high: 130 },
        { analyte: "HDL", value: 55, unit: "mg/dL", ref_low: 40 },
      ],
    });
    expect(recorded.recorded.map((r: { analyte: string; status: string }) => [r.analyte, r.status])).toEqual([["ldl", "high"], ["hdl", "in_range"]]);
    expect(recorded.guidance).toBe(MEDICAL_HINT);
    const labs = await ok("labs_query", { analyte: "ldl" });
    expect(labs.series).toMatchObject([{ analyte: "ldl", latest: { value: 145, status: "high" }, mixed_units: false }]);

    // Preferences.
    expect(await ok("preference_set", { key: "foods_avoid", value: ["lactose"] })).toEqual({
      key: "foods_avoid",
      value: ["lactose"],
      notice: DATA_NOTICE,
    });
    expect((await ok("preferences_get")).preferences).toEqual({ foods_avoid: ["lactose"] });

    // Notes, with the FTS index.
    const note = await ok("note_add", { kind: "decision", text: "caminhar depois do almoço", tags: ["rotina"] });
    expect(note).toMatchObject({ kind: "decision", tags: ["rotina"] });
    expect((await ok("notes_search", { query: "almoco" })).notes).toEqual([note]);

    // profile_get reads all of it back. "Today" is the real local day.
    const view = await ok("profile_get");
    expect(view).toMatchObject({
      profile: { sex: "f", height_cm: 170, goal: { type: "maintain" } },
      targets_in_force: { effective_from: "2026-01-01", kcal: 2100, protein_g: 120 },
      health_items: [{ kind: "allergy", name: "Lactose" }],
      preferences: { foods_avoid: ["lactose"] },
      notice: DATA_NOTICE,
    });
    expect(view.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("answers every tool error with {code,message,hint} in the text content", async () => {
    // A schema violation: rejected before the tool body runs.
    const schema = await fails("note_add", { kind: "rant", text: "x" });
    expect(schema.code).toBe("invalid_input");
    expect(schema.hint).toBe(SCHEMA_HINT);
    expect(schema.message).toMatch(/^the arguments do not match the tool's input schema: /);
    for (const [tool, args] of [
      ["targets_set", { effective_from: "2026-02-30", kcal: 2000 }], // matches the pattern, is not a real day
      ["profile_get", { unexpected: true }],
      ["server_info", { unexpected: true }],
      ["preference_set", { key: "x" }],
    ] as const) {
      expect(await fails(tool, args), tool).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
    }

    // A store validation error: the arguments match the schema, the values are rejected.
    expect(await fails("targets_set", { effective_from: "2026-10-01" })).toEqual({
      code: "invalid_input",
      message: "set or clear at least one of kcal, protein_g, weekly_sessions",
      hint: "fix the value named in the message and retry",
    });
    expect((await fails("labs_record", { collected_on: "2026-09-01", results: [] })).code).toBe("invalid_input");
    // Nothing was stored by the rejected calls.
    expect((await ok("notes_search")).notes).toEqual([]);
    expect((await ok("profile_get")).targets_in_force).toBeUndefined();

    // A number literal outside the float64 range parses to Infinity: rejected, not stored as null.
    const overflow = await rawRpc(
      '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"preference_set","arguments":{"key":"inf","value":[1e999]}}}',
    );
    const refused = overflow.result as ToolResult;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(JSON.parse(refused.content?.[0]?.text ?? "")).toMatchObject({ code: "invalid_input", hint: SCHEMA_HINT });
    expect((await ok("preferences_get")).preferences).toEqual({});

    // An unknown tool is a protocol error, as in the Go server.
    const unknown = await rpc(accessToken, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
    expect(unknown.error?.code).toBe(-32602);
  });

  // A 2026-07-28 request carries its protocol version in params._meta and skips
  // initialize. The SDK serves it on a different path than the 2025 requests.
  it("serves a memory tool on the 2026-07-28 per-request protocol", async () => {
    await ok("preference_set", { key: "tone", value: "direct" });
    const response = await exports.default.fetch(MCP_URL, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": MODERN_PROTOCOL,
        "mcp-method": "tools/call",
        "mcp-name": "preferences_get",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "preferences_get",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "health-coach-mcp-test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const called = parseRpc(response.headers.get("content-type"), text);
    expect(called.error).toBeUndefined();
    expect((called.result as ToolResult).structuredContent).toEqual({ preferences: { tone: "direct" }, notice: DATA_NOTICE });
  });

  it("keeps Google tokens, arguments and stored values out of the logs", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

    // Distinct, greppable values in every kind of stored field.
    const secrets = ["zz-note-text-41c7", "zz-tag-9f02", "zz-pref-value-77ab", "zz-lab-name-c3d1", "zz-detail-5e60", "zz-analyte-18aa", "987654.321"];
    await ok("note_add", { kind: "symptom", text: "zz-note-text-41c7", tags: ["zz-tag-9f02"] });
    await ok("preference_set", { key: "tone", value: "zz-pref-value-77ab" });
    await ok("health_item_upsert", { kind: "medication", name: "metformin", status: "active", details: "zz-detail-5e60" });
    await ok("labs_record", {
      collected_on: "2026-09-01",
      lab: "zz-lab-name-c3d1",
      results: [{ analyte: "zz-analyte-18aa", value: 987654.321, unit: "mg/dL", ref_high: 1 }],
    });
    await ok("profile_get");
    await ok("notes_search", { query: "zz-note-text-41c7" });
    await ok("google_account_status");

    // Failing calls: a schema violation and a store rejection that carry the values.
    expect((await fails("note_add", { kind: "zz-note-text-41c7", text: "zz-note-text-41c7" })).code).toBe("invalid_input");
    expect((await fails("labs_record", { collected_on: "2026-09-01", lab: "zz-lab-name-c3d1", results: [] })).code).toBe("invalid_input");
    // An internal error whose cause quotes a stored value.
    await runInDurableObject(coachStore(env), (_instance, state) => {
      state.storage.sql.exec("UPDATE preferences SET value_json = 'zz-pref-value-77ab {'");
    });
    const internal = await fails("preferences_get");
    expect(internal).toEqual({ code: "internal_error", message: "unexpected internal error" });

    const text = logged();
    for (const secret of [...secrets, GOOGLE_REFRESH_TOKEN, GOOGLE_ACCESS_TOKEN, accessToken]) expect(text).not.toContain(secret);

    // One line per call, with the tool name, duration and outcome only.
    const calls = spies[0]?.mock.calls.filter(([message]) => message === "tool_call") ?? [];
    expect(calls.map(([, fields]) => (fields as { tool: string }).tool)).toEqual([
      "note_add", "preference_set", "health_item_upsert", "labs_record", "profile_get", "notes_search", "google_account_status",
      "note_add", "labs_record", "preferences_get",
    ]);
    for (const [, fields] of calls) {
      const line = fields as Record<string, unknown>;
      expect(Object.keys(line).sort()).toEqual(line.is_error ? ["code", "duration_ms", "is_error", "tool"] : ["duration_ms", "is_error", "tool"]);
      expect(typeof line.duration_ms).toBe("number");
    }
    expect(calls.slice(-3).map(([, fields]) => (fields as { code: string }).code)).toEqual(["invalid_input", "invalid_input", "internal_error"]);
    // The internal error logs the tool name and the error's type name only.
    expect(spies[3]?.mock.calls).toEqual([["tool_internal_error", { tool: "preferences_get", error_types: "SyntaxError" }]]);
  });
});
