// End to end for the two tools that write the food log: the OAuth sign-in
// through the Worker, then /mcp with the MCP access token: the tool list, an
// add, the day read back, a delete, a second delete, and one error of each
// kind that a write can give.
//
// Every request goes Worker → CoachStore object, as in production. Google is
// behind a mocked `fetch`: the token endpoint and a fake Health API that takes
// the two writes in the shapes of Google's documentation
// (test/healthdata-helpers.ts). No test calls Google. test/tools-foodlog.test.ts
// holds the input rules of each tool, test/googlehealth-write.test.ts the
// rules of the client, and test/subrequests.test.ts the request counts.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireError } from "../src/coach/errors";
import { RECONNECT_HINT } from "../src/google";
import { MAY_EXIST_HINT } from "../src/googlehealth/client";
import { CoachStore, coachStore } from "../src/store";
import { FOOD_LOG_NOTICE } from "../src/tools/foodlog";
import { FOOD_NAME, TODAY, day, everything, googleMock, link, skipRetryWaits } from "./e2e-helpers";
import { FAKE_CLIENT_ID, FAKE_USER_ID } from "./healthdata-helpers";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, rpc, signInAsOwner } from "./helpers";
import { ALL_TOOL_NAMES, EXERCISE_LOG_TOOL_NAMES, WRITE_TOOL_NAMES } from "./memory-helpers";

const g = googleMock();

let accessToken = "";
let nextId = 1;

/** A marked text in every error body of the fake: it must never reach an error or a log line. */
const BODY_MARK = "synthetic body 7711";

/** Every number has a fraction that no status, count or duration has. */
const FOOD = { name: "Feijoada completa", meal_type: "LUNCH", kcal: 431.5, protein_g: 23.75, carbs_g: 51.25, fat_g: 17.5 };

const createdName = (n: number) => `users/${FAKE_USER_ID}/dataTypes/nutrition-log/dataPoints/syn-created-${n}`;

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
  // A month of the band's data: four meals on 2026-10-14 and a snack today.
  everything(g.google);
});

/** No token, no part of the entry, no entry id and no part of a Google answer. */
function expectNoSecret(text: string): void {
  const secrets = [accessToken, GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, FOOD_NAME, "Feijoada", "431.5", "23.75", "51.25", "17.5", "syn-created", FAKE_USER_ID, FAKE_CLIENT_ID, BODY_MARK];
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
  // An error never holds the food name, a value of the entry or a part of Google's answer.
  expectNoSecret(text);
  return JSON.parse(text) as WireError;
}

const toolCall = (tool: string, code?: string) => ["tool_call", { tool, duration_ms: expect.any(Number), is_error: code !== undefined, ...(code === undefined ? {} : { code }) }];

const googleError = (status: number, grpc: string) => () =>
  Response.json({ error: { code: status, message: `${BODY_MARK} for ${GOOGLE_ACCESS_TOKEN}`, status: grpc } }, { status });

/** The entries the store holds. Each one also carries the Google account it was created for (`sub`). */
const storedEntries = () =>
  runInDurableObject(coachStore(env), (_instance, state) => state.storage.sql.exec("SELECT name, day, created_at FROM nutrition_entries ORDER BY name").toArray());

const WRITE_SCOPE_HINT = `${RECONNECT_HINT} Allow the permission to add nutrition data (googlehealth.nutrition.writeonly), and check that the Google Health API is enabled in the Cloud project.`;

describe("the food log writes, from the sign-in to a tool result", () => {
  it("lists the 22 tools, with the two that write the food log of Google Health", async () => {
    const { tools } = await mcp("tools/list");
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);
    expect(tools).toHaveLength(22);
    expect(WRITE_TOOL_NAMES).toEqual(["nutrition_log_add", "nutrition_log_delete"]);
    const add = tools.find((tool: { name: string }) => tool.name === "nutrition_log_add");
    const remove = tools.find((tool: { name: string }) => tool.name === "nutrition_log_delete");
    expect(add.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(remove.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    for (const tool of [add, remove]) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.outputSchema.type, tool.name).toBe("object");
      expect(tool.description, tool.name).toContain("never suggest starting, stopping or dosing a medication or a supplement");
    }
    // Every tool that does not write to Google Health stays inside the server: no other tool reaches an open world.
    expect(tools.filter((tool: { annotations?: { openWorldHint?: boolean } }) => tool.annotations?.openWorldHint !== false).map((tool: { name: string }) => tool.name)).toEqual([
      ...WRITE_TOOL_NAMES,
      ...EXERCISE_LOG_TOOL_NAMES,
    ]);
    // A list asks nothing of Google.
    expect(g.external).toEqual([]);
  });

  it("adds an entry, reads the day, deletes the entry, and refuses a second delete", async () => {
    const served = vi.spyOn(CoachStore.prototype, "fetch");

    // 1. The add: one create, with the Google token of the sign-in.
    const added = await ok("nutrition_log_add", { ...FOOD, time: "08:15" });
    expect(added).toEqual({
      entry_id: createdName(1),
      date: TODAY,
      time: "08:15",
      meal_type: "LUNCH",
      kcal: 431.5,
      protein_g: 23.75,
      carbs_g: 51.25,
      fat_g: 17.5,
      notice: FOOD_LOG_NOTICE,
    });
    expect(g.takeExternal()).toEqual({ total: 1, "create nutrition-log": 1 });
    expect(g.auths).toEqual([`Bearer ${GOOGLE_ACCESS_TOKEN}`]);
    expect(g.google.writes).toEqual([
      {
        kind: "create",
        body: {
          nutritionLog: {
            interval: { startTime: "2026-10-16T11:15:00Z", startUtcOffset: "-10800s", endTime: "2026-10-16T11:15:01Z", endUtcOffset: "-10800s" },
            foodDisplayName: "Feijoada completa",
            mealType: "LUNCH",
            energy: { kcal: 431.5 },
            totalCarbohydrate: { grams: 51.25 },
            totalFat: { grams: 17.5 },
            nutrients: [{ nutrient: "PROTEIN", quantity: { grams: 23.75 } }],
          },
        },
      },
    ]);
    // The store knows the entry as its own: the name, the day and the creation time.
    expect(await storedEntries()).toEqual([{ name: createdName(1), day: TODAY, created_at: "2026-10-16T13:00:00.000000000Z" }]);

    // 2. The day read back. An entry written through the API has the platform
    // GOOGLE_WEB_API, and the list names it under users/me. The food reads
    // keep it, next to the band's own snack, because its data point id is in
    // the table of the entries this server created.
    const review = await ok("nutrition_day", { date: TODAY });
    expect(review.data).toMatchObject({ date: TODAY, items_logged: 2 });
    expect(review.data.totals.kcal).toEqual({ value: 631.5, items_reporting: 2, complete: true });
    expect(review.data.totals.protein_g).toEqual({ value: 33.8, items_reporting: 2, complete: true });
    // The snack of the band reports no carbohydrate: a partial total.
    expect(review.data.totals.carb_g).toEqual({ value: 51.3, items_reporting: 1, complete: false });
    expect(review.data.per_meal.map((meal: { meal_type: string }) => meal.meal_type)).toEqual(["LUNCH", "SNACK"]);
    expect(review.data.per_meal[0].items).toEqual([
      {
        name: "Feijoada completa",
        time: "2026-10-16T08:15:00-03:00",
        nutrients: { kcal: 431.5, protein_g: 23.8, carb_g: 51.3, fat_g: 17.5, fiber_g: null, sugar_g: null, sodium_mg: null },
        rejected_nutrients: [],
        // The name the create answered. The list names the same point under users/me.
        entry_id: createdName(1),
      },
    ]);
    // No food was left out as food of another source.
    expect(review.quality_flags).not.toContain("other_source_food_excluded");
    expect(review.sources).toContain("GOOGLE_WEB_API");
    expect(g.takeExternal()).toMatchObject({ "nutrition-log": 1 });

    // 3. The delete: one batchDelete for that entry, by its name under users/me.
    expect(await ok("nutrition_log_delete", { entry_id: added.entry_id })).toEqual({ entry_id: createdName(1), deleted: true });
    expect(g.takeExternal()).toEqual({ total: 1, "delete nutrition-log": 1 });
    expect(g.google.writes.at(-1)).toEqual({ kind: "delete", body: { names: ["users/me/dataTypes/nutrition-log/dataPoints/syn-created-1"] } });
    expect(g.google.createdPoints()).toEqual([]);
    expect(await storedEntries()).toEqual([]);
    // The day is as it was before the add.
    const after = await ok("nutrition_day", { date: TODAY });
    expect(after.data.items_logged).toBe(1);
    expect(after.quality_flags).not.toContain("other_source_food_excluded");
    g.takeExternal();

    // 4. A second delete of the same id: no_data, and nothing is asked of Google.
    expect(await fails("nutrition_log_delete", { entry_id: added.entry_id })).toEqual({
      code: "no_data",
      message: "this server created no entry with that id",
      hint: "it deletes only an entry that nutrition_log_add created and that was not deleted yet",
    });
    expect(g.external).toEqual([]);

    // Each call is one request that the Worker forwards to the object.
    expect(served).toHaveBeenCalledTimes(5);
    // No call asked for a new token: every request carried the token of the sign-in.
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${GOOGLE_ACCESS_TOKEN}`]));
    // The whole log is one line per call: the tool name, the duration and the outcome.
    expect(g.logLines("log")).toEqual([
      toolCall("nutrition_log_add"),
      toolCall("nutrition_day"),
      toolCall("nutrition_log_delete"),
      toolCall("nutrition_day"),
      toolCall("nutrition_log_delete", "no_data"),
    ]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("never deletes food that it did not log, also when asked for it by name", async () => {
    // The band's own snack of today, as a list names it.
    const snack = `users/me/dataTypes/nutrition-log/dataPoints/syn-${Math.trunc(new Date("2026-10-16T07:00:00-03:00").getTime() / 1000)}`;
    expect(await fails("nutrition_log_delete", { entry_id: snack })).toMatchObject({ code: "no_data" });
    expect(g.external).toEqual([]);
    expect((await ok("nutrition_day", { date: TODAY })).data.items_logged).toBe(1);
  });
});

describe("one error of each kind that a write can give, as the client reads it", () => {
  it("answers invalid_input for a value out of bounds and for an id of another data type, without a request to Google", async () => {
    expect(await fails("nutrition_log_add", { ...FOOD, kcal: 10_431.5 })).toEqual({
      code: "invalid_input",
      message: "kcal must be at most 10000",
      hint: "fix the value named in the message and retry",
    });
    expect(await fails("nutrition_log_add", { ...FOOD, date: day(1) })).toEqual({ code: "invalid_input", message: "date is after today", hint: "omit date for today" });
    expect(await fails("nutrition_log_delete", { entry_id: `users/${FAKE_USER_ID}/dataTypes/exercise/dataPoints/syn-run` })).toEqual({
      code: "invalid_input",
      message: "entry_id is not the id of a food log entry",
      hint: "use the entry_id that nutrition_log_add returned or that nutrition_day lists",
    });
    expect(g.external).toEqual([]);
    expect(await storedEntries()).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("nutrition_log_add", "invalid_input"), toolCall("nutrition_log_add", "invalid_input"), toolCall("nutrition_log_delete", "invalid_input")]);
    expect(g.logged()).not.toContain("10431.5");
    expectNoSecret(g.logged());
  });

  it("answers scope_missing for an HTTP 403, with the write scope in the hint and no retry", async () => {
    const added = await ok("nutrition_log_add", FOOD);
    g.takeExternal();
    g.clearLogs();
    g.healthReply = googleError(403, "PERMISSION_DENIED");
    const expected = { code: "scope_missing", message: "Google Health denied the write of nutrition-log data", hint: WRITE_SCOPE_HINT };
    expect(await fails("nutrition_log_add", FOOD)).toEqual(expected);
    expect(g.takeExternal()).toEqual({ total: 1, "create nutrition-log": 1 });
    expect(await fails("nutrition_log_delete", { entry_id: added.entry_id })).toEqual(expected);
    expect(g.takeExternal()).toEqual({ total: 1, "delete nutrition-log": 1 });
    // The entry was not deleted: its row stays, so the delete can be asked again.
    expect(await storedEntries()).toMatchObject([{ name: createdName(1) }]);
    expect(g.logLines("log")).toEqual([toolCall("nutrition_log_add", "scope_missing"), toolCall("nutrition_log_delete", "scope_missing")]);
    expect(g.logLines("warn")).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("answers auth_expired with the reconnect hint when no Google account is linked", async () => {
    const added = await ok("nutrition_log_add", FOOD);
    g.takeExternal();
    g.clearLogs();
    // The MCP grant is still valid; the Google link is gone.
    await runInDurableObject(coachStore(env), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });
    const notSignedIn = { code: "auth_expired", message: "not signed in to Google Health", hint: RECONNECT_HINT };
    expect(await fails("nutrition_log_add", FOOD)).toEqual(notSignedIn);
    // The entry exists, and it is the entry of the account that must sign in
    // again: the delete names that step, and does not say "no such entry".
    expect(await fails("nutrition_log_delete", { entry_id: added.entry_id })).toEqual(notSignedIn);
    // An id that this server never created has the same answer: it says nothing about which entries exist.
    expect(await fails("nutrition_log_delete", { entry_id: createdName(77) })).toEqual(notSignedIn);
    // The shape of the id is checked first.
    expect(await fails("nutrition_log_delete", { entry_id: `${createdName(1)}/x` })).toMatchObject({ code: "invalid_input", message: "entry_id is not the id of a food log entry" });
    // Nothing is asked of Google, not even a token.
    expect(g.external).toEqual([]);
    // The row stays, for when its account is linked again.
    expect(await storedEntries()).toMatchObject([{ name: createdName(1) }]);
    expect(g.logLines("log")).toEqual([
      toolCall("nutrition_log_add", "auth_expired"),
      toolCall("nutrition_log_delete", "auth_expired"),
      toolCall("nutrition_log_delete", "auth_expired"),
      toolCall("nutrition_log_delete", "invalid_input"),
    ]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());

    // The same account signs in again: the same delete now happens.
    await coachStore(env).linkGoogleAccount(link());
    g.clearLogs();
    expect(await ok("nutrition_log_delete", { entry_id: added.entry_id })).toEqual({ entry_id: added.entry_id, deleted: true });
    expect(g.takeExternal()).toEqual({ total: 1, "delete nutrition-log": 1 });
    expect(await storedEntries()).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("nutrition_log_delete")]);
    for (const level of ["info", "warn", "error", "debug"] as const) expect(g.logLines(level), level).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("answers upstream_unavailable for a 503 on an add, once: the entry may exist, and it is not sent again", async () => {
    const waited = skipRetryWaits(g);
    g.healthReply = googleError(503, "UNAVAILABLE");
    expect(await fails("nutrition_log_add", FOOD)).toEqual({ code: "upstream_unavailable", message: "Google Health API is unavailable", hint: MAY_EXIST_HINT });
    expect(MAY_EXIST_HINT).toBe(
      "the entry may exist: check the day with nutrition_day before a new try (an entry this server has no id for shows there as food from another source; when the day already had food from another source, check the food log in the Fitbit app instead)",
    );
    // One attempt, no wait: a second create could log the food twice.
    expect(g.takeExternal()).toEqual({ total: 1, "create nutrition-log": 1 });
    expect(waited).toEqual([]);
    expect(await storedEntries()).toEqual([]);
    expect(g.logLines("log")).toEqual([toolCall("nutrition_log_add", "upstream_unavailable")]);
    expect(g.logLines("warn")).toEqual([]);
    expectNoSecret(g.logged());
  });

  it("answers upstream_unavailable after four 429 answers on an add: the entry was not created", async () => {
    const waited = skipRetryWaits(g);
    g.healthReply = googleError(429, "RESOURCE_EXHAUSTED");
    expect(await fails("nutrition_log_add", FOOD)).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "the entry was not created; try again in a few minutes",
    });
    // A 429 proves that Google did not take the entry: 4 attempts, with a wait of about 1, 2 and 4 seconds between them.
    expect(g.takeExternal()).toEqual({ total: 4, "create nutrition-log": 4 });
    expect(waited).toHaveLength(3);
    expect(g.google.createdPoints()).toEqual([]);
    // The log has the data type, the HTTP status and the retry count: never the body.
    expect(g.logLines("warn")).toEqual(
      [1, 2, 3].map((retry) => ["google health request failed; retrying", { data_type: "nutrition-log", http_status: 429, retry, wait_ms: expect.any(Number) }]),
    );
    expect(g.logLines("log")).toEqual([toolCall("nutrition_log_add", "upstream_unavailable")]);
    expectNoSecret(g.logged());
  });

  it("answers upstream_unavailable for a delete after four attempts, and keeps the entry as its own", async () => {
    const added = await ok("nutrition_log_add", FOOD);
    g.takeExternal();
    g.clearLogs();
    const waited = skipRetryWaits(g);
    g.healthReply = googleError(503, "UNAVAILABLE");
    expect(await fails("nutrition_log_delete", { entry_id: added.entry_id })).toEqual({
      code: "upstream_unavailable",
      message: "Google Health API is unavailable",
      hint: "the entry may still exist; call nutrition_log_delete again in a few minutes (a repeated delete is safe)",
    });
    // A delete of a name is idempotent: it is tried 4 times.
    expect(g.takeExternal()).toEqual({ total: 4, "delete nutrition-log": 4 });
    expect(waited).toHaveLength(3);
    expect(await storedEntries()).toMatchObject([{ name: createdName(1) }]);

    // Google answers again: the same delete now happens.
    g.healthReply = undefined;
    expect(await ok("nutrition_log_delete", { entry_id: added.entry_id })).toEqual({ entry_id: createdName(1), deleted: true });
    expect(await storedEntries()).toEqual([]);
    expectNoSecret(g.logged());
  });
});
