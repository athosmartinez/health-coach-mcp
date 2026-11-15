// End to end for the two tools that write the exercise log: the OAuth sign-in
// through the Worker, then /mcp with the MCP access token: the tool list, an
// add, the day read back with workout_review, a delete, and a second delete.
//
// Every request goes Worker → CoachStore object, as in production. Google is
// behind a mocked `fetch`: the token endpoint and a fake Health API that
// checks an exercise create against the rules of Google's reference
// (test/healthdata-helpers.ts). No test calls Google.
// test/tools-exerciselog.test.ts holds the input rules of each tool,
// test/googlehealth-exercise-write.test.ts the rules of the client, and
// test/subrequests.test.ts the request counts.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireError } from "../src/coach/errors";
import { GOOGLE_SIGN_IN_SCOPES, RECONNECT_HINT, WRITE_SCOPES } from "../src/google";
import { CoachStore, coachStore } from "../src/store";
import { EXERCISE_LOG_NOTICE } from "../src/tools/exerciselog";
import { SESSION_NAME, TODAY, everything, googleMock } from "./e2e-helpers";
import { FAKE_CLIENT_ID, FAKE_USER_ID } from "./healthdata-helpers";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, OWNER_SUB, rpc, signInAsOwner } from "./helpers";
import { ALL_TOOL_NAMES, EXERCISE_LOG_TOOL_NAMES, WRITE_TOOL_NAMES } from "./memory-helpers";

const g = googleMock();

let accessToken = "";
let nextId = 1;

/** An activity that is not in the tool's list, 07:10 to 08:25 today. The kcal has a fraction that no status, count or duration has. */
const WORKOUT = { exercise_type: "Capoeira angola", start_time: "07:10", end_time: "08:25", kcal: 431.5, notes: "Roda de sexta" };

const createdName = (n: number) => `users/${FAKE_USER_ID}/dataTypes/exercise/dataPoints/syn-created-${n}`;
const listedName = (n: number) => `users/me/dataTypes/exercise/dataPoints/syn-created-${n}`;

beforeEach(async () => {
  // The named store is shared by the tests of this file: start each one empty.
  await runInDurableObject(coachStore(env), (_instance, state) => {
    for (const table of ["profile", "targets", "health_items", "lab_results", "preferences", "notes", "daily_metrics", "google_account", "nutrition_entries", "exercise_entries"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  // The sign-in stores the Google link: a refresh token and an access token good for an hour.
  accessToken = (await signInAsOwner()).access_token;
  // The sign-in put its own mock on `fetch`: from here on Google is the fake API.
  g.install();
  g.clearLogs();
  // A month of the band's data: a walk yesterday, and no session today.
  everything(g.google);
});

/** The scopes the store holds for the linked account: what Google granted at the sign-in. */
const grantedScopes = () =>
  runInDurableObject(coachStore(env), (_instance, state) => (state.storage.sql.exec<{ scopes: string }>("SELECT scopes FROM google_account").one().scopes as string).split(" "));

/** No token, no part of the session, no entry id and no part of a Google answer. */
function expectNoSecret(text: string): void {
  const secrets = [accessToken, GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, SESSION_NAME, "Capoeira", "431.5", "Roda", "syn-created", FAKE_USER_ID, FAKE_CLIENT_ID];
  for (const secret of secrets) if (secret !== "") expect(text).not.toContain(secret);
}

/** One JSON-RPC request to /mcp of the Worker, with the MCP access token. */
async function mcp(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
  const reply = await rpc(accessToken, { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  return reply.result as Record<string, any>;
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
}

/** Calls a tool that must succeed and returns its structured content. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = (await mcp("tools/call", { name, arguments: args })) as ToolResult;
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  // The text content is the same JSON as the structured content.
  expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual(result.structuredContent);
  return result.structuredContent ?? {};
}

/** Calls a tool that must fail and returns the {code,message,hint} of its text content. */
async function fails(name: string, args: Record<string, unknown> = {}): Promise<WireError> {
  const result = (await mcp("tools/call", { name, arguments: args })) as ToolResult;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const text = result.content?.[0]?.text ?? "";
  // An error never holds the activity name, a value of the session or a part of Google's answer.
  expectNoSecret(text);
  return JSON.parse(text) as WireError;
}

const toolCall = (tool: string, code?: string) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: code !== undefined, ...(code === undefined ? {} : { code }) }];

/** The sessions the store holds as its own. */
const storedSessions = () =>
  runInDurableObject(coachStore(env), (_instance, state) => state.storage.sql.exec("SELECT sub, name, day, created_at FROM exercise_entries ORDER BY name").toArray());

describe("the exercise log writes, from the sign-in to a tool result", () => {
  it("asks Google for the exercise write scope at the sign-in, and the account status has no missing scope", async () => {
    expect(GOOGLE_SIGN_IN_SCOPES).toContain("https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly");
    // What Google granted is what the store holds: the write scope of both data types.
    const granted = await grantedScopes();
    for (const write of Object.values(WRITE_SCOPES)) expect(granted, write.addTool).toContain(write.scope);
    expect(await ok("google_account_status")).toMatchObject({ linked: true, token: "ok", scopes_missing: [], hint: null });
    expect(g.external).toEqual([]);
  });

  it("lists the 22 tools, with the two that write the exercise log after the two of the food log", async () => {
    const { tools } = await mcp("tools/list");
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);
    expect(tools).toHaveLength(22);
    expect(EXERCISE_LOG_TOOL_NAMES).toEqual(["exercise_log_add", "exercise_log_delete"]);
    const names = tools.map((tool: { name: string }) => tool.name) as string[];
    expect(names.slice(names.indexOf("nutrition_log_add"))).toEqual([...WRITE_TOOL_NAMES, ...EXERCISE_LOG_TOOL_NAMES]);
    const add = tools.find((tool: { name: string }) => tool.name === "exercise_log_add");
    const remove = tools.find((tool: { name: string }) => tool.name === "exercise_log_delete");
    expect(add.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(remove.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    for (const tool of [add, remove]) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.outputSchema.type, tool.name).toBe("object");
      expect(tool.description, tool.name).toContain("never suggest starting, stopping or dosing a medication or a supplement");
    }
    // The schema has no enum for the type: an activity that is not in the list is logged as OTHER.
    expect(add.inputSchema.properties.exercise_type.enum).toBeUndefined();
    expect(add.inputSchema.required).toEqual(["exercise_type"]);
    // The four write tools are the only ones that reach an open world.
    expect(tools.filter((tool: { annotations?: { openWorldHint?: boolean } }) => tool.annotations?.openWorldHint !== false).map((tool: { name: string }) => tool.name)).toEqual([
      ...WRITE_TOOL_NAMES,
      ...EXERCISE_LOG_TOOL_NAMES,
    ]);
    // A list asks nothing of Google.
    expect(g.external).toEqual([]);
  });

  it("adds a session, reads the day, deletes the session, and refuses a second delete", async () => {
    const served = vi.spyOn(CoachStore.prototype, "fetch");
    // Before the add, today has no session.
    expect((await ok("workout_review")).data.sessions).toEqual([]);
    g.takeExternal();

    // 1. The add: one create, with the Google token of the sign-in.
    const added = await ok("exercise_log_add", WORKOUT);
    expect(added).toEqual({
      entry_id: createdName(1),
      date: TODAY,
      start_time: "07:10",
      end_time: "08:25",
      duration_min: 75,
      // The activity is not in the list: the result shows that it was logged as OTHER.
      exercise_type: "OTHER",
      kcal: 431.5,
      notice: EXERCISE_LOG_NOTICE,
    });
    expect(g.takeExternal()).toEqual({ total: 1, "create exercise": 1 });
    expect(g.auths.at(-1)).toBe(`Bearer ${GOOGLE_ACCESS_TOKEN}`);
    // The body of the documented example: the fake API refuses a body that breaks a rule of the reference.
    expect(g.google.writes).toEqual([
      {
        kind: "create",
        body: {
          dataSource: { recordingMethod: "MANUAL", platform: "GOOGLE_WEB_API" },
          exercise: {
            interval: { startTime: "2026-10-16T10:10:00Z", startUtcOffset: "-10800s", endTime: "2026-10-16T11:25:00Z", endUtcOffset: "-10800s" },
            exerciseType: "OTHER",
            displayName: "Capoeira angola",
            activeDuration: "4500s",
            metricsSummary: { caloriesKcal: 431.5 },
            notes: "Roda de sexta",
          },
        },
      },
    ]);
    // The store knows the session as its own: the account, the name, the day and the creation time.
    expect(await storedSessions()).toEqual([{ sub: OWNER_SUB, name: createdName(1), day: TODAY, created_at: "2026-10-16T13:00:00.000000000Z" }]);

    // 2. The day read back. A session written through the API has the platform
    // GOOGLE_WEB_API, and the list names it under users/me. The exercise reads
    // keep it because its data point id is in the table of the sessions this
    // server created.
    const review = await ok("workout_review");
    expect(review.data.date).toBe(TODAY);
    expect(review.data.sessions).toEqual([
      {
        exercise_id: listedName(1),
        type: "OTHER",
        name: "Capoeira angola",
        start: "2026-10-16T07:10:00-03:00",
        end: "2026-10-16T08:25:00-03:00",
        active_min: 75,
        avg_hr_bpm: null,
        max_hr_bpm: null,
        heart_rate_zone_minutes: null,
        kcal: 431.5,
        azm_min: 0,
        quality_flags: ["manual_entry", "no_hr_data"],
        source: "GOOGLE_WEB_API",
        // The name the create answered: the id exercise_log_delete accepts.
        entry_id: createdName(1),
      },
    ]);
    // The week counts it next to the band's four sessions, and nothing was left out as another source.
    expect(review.data.week_context.sessions).toBe(5);
    expect(review.quality_flags).toEqual(expect.arrayContaining(["manual_entry", "no_hr_data", "partial_day"]));
    expect(review.quality_flags).not.toContain("other_source_sessions_excluded");
    expect(review.quality_flags).not.toContain("overlaps_band_session");
    // Two lists of sessions (the day and its week), and no heart-rate list: the session has none.
    expect(g.takeExternal()).toEqual({ total: 2, exercise: 2 });

    // 3. The delete, with the id that workout_review listed: one batchDelete, by the name under users/me.
    const entryId = review.data.sessions[0].entry_id as string;
    expect(await ok("exercise_log_delete", { entry_id: entryId })).toEqual({ entry_id: createdName(1), deleted: true });
    expect(g.takeExternal()).toEqual({ total: 1, "delete exercise": 1 });
    expect(g.google.writes.at(-1)).toEqual({ kind: "delete", body: { names: [listedName(1)] } });
    expect(g.google.createdPoints("exercise")).toEqual([]);
    expect(await storedSessions()).toEqual([]);
    // The day is as it was before the add.
    const after = await ok("workout_review");
    expect(after.data.sessions).toEqual([]);
    expect(after.data.week_context.sessions).toBe(4);
    g.takeExternal();

    // 4. A second delete of the same id: no_data, and nothing is asked of Google.
    expect(await fails("exercise_log_delete", { entry_id: entryId })).toEqual({
      code: "no_data",
      message: "this server created no entry with that id",
      hint: "it deletes only an entry that exercise_log_add created and that was not deleted yet",
    });
    expect(g.external).toEqual([]);

    // Each call is one request that the Worker forwards to the object.
    expect(served).toHaveBeenCalledTimes(6);
    // No call asked for a new token: every request carried the token of the sign-in.
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${GOOGLE_ACCESS_TOKEN}`]));
    // The whole log is one line per call: the tool name, the duration and the outcome.
    expect(g.logLines("log")).toEqual([
      toolCall("workout_review"),
      toolCall("exercise_log_add"),
      toolCall("workout_review"),
      toolCall("exercise_log_delete"),
      toolCall("workout_review"),
      toolCall("exercise_log_delete", "no_data"),
    ]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("never deletes a session that it did not log, also when asked for it by name", async () => {
    // The band's walk of yesterday, by the id that workout_review lists for it.
    const yesterday = await ok("workout_review", { date: "2026-10-15" });
    expect(yesterday.data.sessions).toMatchObject([{ type: "WALKING", entry_id: null }]);
    g.takeExternal();
    expect(await fails("exercise_log_delete", { entry_id: yesterday.data.sessions[0].exercise_id })).toMatchObject({ code: "no_data" });
    // An id of the food log is not an exercise entry at all.
    expect(await fails("exercise_log_delete", { entry_id: `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-created-1` })).toEqual({
      code: "invalid_input",
      message: "entry_id is not the id of an exercise log entry",
      hint: "use the entry_id that exercise_log_add returned or that workout_review lists",
    });
    expect(g.external).toEqual([]);
    expect((await ok("workout_review", { date: "2026-10-15" })).data.sessions).toHaveLength(1);
  });

  it("answers auth_expired with the reconnect hint when no Google account is linked", async () => {
    const added = await ok("exercise_log_add", WORKOUT);
    g.takeExternal();
    g.clearLogs();
    // The MCP grant is still valid; the Google link is gone.
    await runInDurableObject(coachStore(env), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });
    const notSignedIn = { code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT };
    expect(await fails("exercise_log_add", WORKOUT)).toEqual(notSignedIn);
    expect(await fails("exercise_log_delete", { entry_id: added.entry_id })).toEqual(notSignedIn);
    // Nothing is asked of Google, not even a token, and the row stays for when its account is linked again.
    expect(g.external).toEqual([]);
    expect(await storedSessions()).toMatchObject([{ name: createdName(1) }]);
    expect(g.logLines("log")).toEqual([toolCall("exercise_log_add", "auth_expired"), toolCall("exercise_log_delete", "auth_expired")]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });
});
