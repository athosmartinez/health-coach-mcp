// What the object keeps when another Google account is linked (the operator
// changes ALLOWED_GOOGLE_EMAIL, and the new account signs in). The cache of
// daily values holds the days of one account. The coach memory is the
// person's own and is not tied to the Google account.
//
// Every call is served by the CoachStore object, with the real client and
// store, and Google behind a mocked `fetch`. All values are synthetic.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { CoachStore } from "../src/store";
import { STORED_TOKEN, day, daysOfData, googleMock, link, linkedStore } from "./e2e-helpers";
import { OWNER_SUB } from "./helpers";
import { objectTool } from "./memory-helpers";

const g = googleMock();

/** A second Google account, with a valid access token of its own. */
const OTHER_SUB = "200000000000000000002";
const OTHER_TOKEN = "at-other-77d0";
const other = () => link({ sub: OTHER_SUB, email: "other@example.com", refreshToken: "fake-google-refresh-token-other-2b6e", accessToken: OTHER_TOKEN });

const count = (stub: DurableObjectStub<CoachStore>, table: string) =>
  runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n);

const linkedSub = (stub: DurableObjectStub<CoachStore>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ sub: string }>("SELECT sub FROM google_account").toArray()[0]?.sub);

describe("the cache of daily values, when a Google account is linked", () => {
  /** Sixteen settled days of nights: every one of them is cached after one read. */
  const NIGHTS = ["metric_series", { metric: "hrv", from: day(-20), to: day(-5) }] as const;

  /** Reads the nights and returns the Google requests of the call. */
  async function readNights(stub: DurableObjectStub<CoachStore>): Promise<number> {
    const outcome = await objectTool(stub, ...NIGHTS);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    return g.takeExternal().total ?? 0;
  }

  it("is emptied when another account is linked, and the next call reads Google again", async () => {
    daysOfData(g.google, 30);
    const stub = await linkedStore();
    const cold = await readNights(stub);
    expect(cold).toBeGreaterThan(0);
    const cached = await count(stub, "daily_metrics");
    expect(cached).toBeGreaterThan(0);
    // The settled nights are served from the cache: nothing is asked of Google.
    expect(await readNights(stub)).toBe(0);

    // The coach memory of the person, set before the switch.
    expect((await objectTool(stub, "targets_set", { effective_from: day(-30), kcal: 2200 })).ok).toBe(true);
    expect((await objectTool(stub, "note_add", { kind: "decision", text: "synthetic note" })).ok).toBe(true);

    await stub.linkGoogleAccount(other());
    expect(await linkedSub(stub)).toBe(OTHER_SUB);
    // The days of the old account are gone at once, before any read.
    expect(await count(stub, "daily_metrics")).toBe(0);
    // The coach memory is not tied to the Google account: it stays.
    expect(await count(stub, "targets")).toBe(1);
    expect(await count(stub, "notes")).toBe(1);

    // The same call now reads Google again, with the token of the new account.
    g.auths = [];
    expect(await readNights(stub)).toBe(cold);
    expect(new Set(g.auths)).toEqual(new Set([`Bearer ${OTHER_TOKEN}`]));
    expect(await count(stub, "daily_metrics")).toBe(cached);
    // No token and no account id in a log line.
    for (const secret of [OTHER_TOKEN, STORED_TOKEN, OTHER_SUB, OWNER_SUB, "other@example.com"]) expect(g.logged()).not.toContain(secret);
  });

  it("is kept when the same account is linked again", async () => {
    daysOfData(g.google, 30);
    const stub = await linkedStore();
    await readNights(stub);
    const cached = await count(stub, "daily_metrics");
    expect(cached).toBeGreaterThan(0);

    // A new sign-in of the same account: new tokens, the same `sub`.
    await stub.linkGoogleAccount(link({ refreshToken: "fake-google-refresh-token-again-51aa", accessToken: "at-again-90c3" }));
    expect(await linkedSub(stub)).toBe(OWNER_SUB);
    expect(await count(stub, "daily_metrics")).toBe(cached);
    expect(await readNights(stub)).toBe(0);
  });

  it("is emptied again when the first account comes back: its rows said nothing about whose they were", async () => {
    daysOfData(g.google, 30);
    const stub = await linkedStore();
    const cold = await readNights(stub);
    await stub.linkGoogleAccount(other());
    await readNights(stub);
    expect(await count(stub, "daily_metrics")).toBeGreaterThan(0);

    await stub.linkGoogleAccount(link());
    expect(await count(stub, "daily_metrics")).toBe(0);
    expect(await readNights(stub)).toBe(cold);
  });

  it("is emptied when an account is linked and no link is stored: a revoked link is removed, and its days stay behind", async () => {
    daysOfData(g.google, 30);
    const stub = await linkedStore();
    await readNights(stub);
    expect(await count(stub, "daily_metrics")).toBeGreaterThan(0);
    // What a refused token renewal does to the link.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });

    await stub.linkGoogleAccount(other());
    expect(await count(stub, "daily_metrics")).toBe(0);
  });

  it("links the first account of a new store without touching anything", async () => {
    const stub = await linkedStore();
    expect(await linkedSub(stub)).toBe(OWNER_SUB);
    expect(await count(stub, "daily_metrics")).toBe(0);
  });
});

// An entry that nutrition_log_add created belongs to the Google account that
// was linked then. A delete goes out with the token of the linked account, so
// it must never be sent for an entry of another account.
describe("the food entries this server created, when a Google account is linked", () => {
  const FOOD = { name: "Feijoada completa", meal_type: "LUNCH", kcal: 431.5, protein_g: 23.75 };
  const NO_ENTRY = {
    ok: false,
    error: {
      code: "no_data",
      message: "this server created no entry with that id",
      hint: "it deletes only an entry that nutrition_log_add created and that was not deleted yet",
    },
  };

  const owners = (stub: DurableObjectStub<CoachStore>) =>
    runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT sub, name FROM nutrition_entries ORDER BY sub, name").toArray());

  /** Account A adds one entry. Returns its id. */
  async function entryOfTheFirstAccount(stub: DurableObjectStub<CoachStore>): Promise<string> {
    const added = await objectTool(stub, "nutrition_log_add", FOOD);
    if (!added.ok) throw new Error("the add failed");
    expect(g.takeExternal()).toEqual({ total: 1, "create nutrition-log": 1 });
    return added.output.entry_id as string;
  }

  it("does not delete an entry of the account before: no_data, no request, and the row stays", async () => {
    const stub = await linkedStore();
    const entryId = await entryOfTheFirstAccount(stub);
    expect(await owners(stub)).toEqual([{ sub: OWNER_SUB, name: entryId }]);

    await stub.linkGoogleAccount(other());
    g.auths = [];
    g.clearLogs();
    // The entry is not the new account's own: the delete stops before any request.
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);
    expect(g.external).toEqual([]);
    expect(g.auths).toEqual([]);
    // Google still holds the entry, and the store still holds its row.
    expect(g.google.createdPoints()).toHaveLength(1);
    expect(await owners(stub)).toEqual([{ sub: OWNER_SUB, name: entryId }]);
    for (const secret of [OTHER_TOKEN, STORED_TOKEN, OTHER_SUB, OWNER_SUB, "Feijoada", "431.5", "syn-created"]) expect(g.logged()).not.toContain(secret);
  });

  it("does not take Google's 'not found' for an entry of another account as a delete of it", async () => {
    const stub = await linkedStore();
    const entryId = await entryOfTheFirstAccount(stub);
    await stub.linkGoogleAccount(other());
    // What the new account's Google would answer for an id it does not have.
    g.healthReply = () => Response.json({ error: { code: 404, status: "NOT_FOUND", message: "synthetic" } }, { status: 404 });
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);
    // The answer was never asked for.
    expect(g.external).toEqual([]);
    expect(await owners(stub)).toEqual([{ sub: OWNER_SUB, name: entryId }]);
  });

  it("gives the new account entries of its own, and deletes each entry only for its own account", async () => {
    const stub = await linkedStore();
    const first = await entryOfTheFirstAccount(stub);

    await stub.linkGoogleAccount(other());
    const added = await objectTool(stub, "nutrition_log_add", FOOD);
    if (!added.ok) throw new Error("the add failed");
    const second = added.output.entry_id as string;
    expect(await owners(stub)).toEqual([
      { sub: OWNER_SUB, name: first },
      { sub: OTHER_SUB, name: second },
    ]);
    g.takeExternal();
    g.auths = [];

    // The new account deletes its own entry, with its own token.
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: second })).toEqual({ ok: true, output: { entry_id: second, deleted: true } });
    expect(g.takeExternal()).toEqual({ total: 1, "delete nutrition-log": 1 });
    expect(g.auths).toEqual([`Bearer ${OTHER_TOKEN}`]);
    expect(await owners(stub)).toEqual([{ sub: OWNER_SUB, name: first }]);
  });

  it("deletes the entry again for its own account, when that account is linked again", async () => {
    const stub = await linkedStore();
    const entryId = await entryOfTheFirstAccount(stub);
    await stub.linkGoogleAccount(other());
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);

    await stub.linkGoogleAccount(link());
    g.auths = [];
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toEqual({ ok: true, output: { entry_id: entryId, deleted: true } });
    expect(g.takeExternal()).toEqual({ total: 1, "delete nutrition-log": 1 });
    // The delete went out with the token of the account that owns the entry.
    expect(g.auths).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(g.google.createdPoints()).toEqual([]);
    expect(await owners(stub)).toEqual([]);
  });

  it("does not bind an entry to an account that is linked while Google creates it", async () => {
    const stub = await linkedStore();
    const id = stub.id.toString();
    // A sign-in of another account while the create is in flight. The mock
    // runs inside the object, so it reaches the store through a stub of its own.
    g.healthReply = async () => {
      const self = env.COACH_STORE.get(env.COACH_STORE.idFromString(id));
      await self.linkGoogleAccount(other());
      return undefined;
    };
    const outcome = await objectTool(stub, "nutrition_log_add", FOOD);
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "internal_error",
        message: "the entry was created in Google Health, but this server could not record it, so it cannot delete the entry",
        hint: "do not log the same food again",
      },
    });
    // The entry was created with the token of the first account, and no row binds it to the second.
    expect(g.auths).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(g.google.createdPoints()).toHaveLength(1);
    expect(await owners(stub)).toEqual([]);
    expect(g.logLines("error")).toEqual([["tool_internal_error", { tool: "nutrition_log_add", error_types: "ToolError > Error" }]]);
  });

  // The food reads keep an entry of the API only when it is the linked account's own.
  it("does not count the entry of the account before as the new account's own in a food read", async () => {
    const stub = await linkedStore();
    const entryId = await entryOfTheFirstAccount(stub);
    const today = { date: day(0) };
    // For its own account, the entry is the day's food.
    const own = await objectTool(stub, "nutrition_day", today);
    expect(own).toMatchObject({ ok: true, output: { data: { items_logged: 1 } } });

    // For another account, the same record is food of another source: the day has no food of its own.
    await stub.linkGoogleAccount(other());
    expect(await objectTool(stub, "nutrition_day", today)).toMatchObject({
      ok: false,
      error: { code: "no_data", message: "no food logged on that day", hint: "food was logged only in another app (such as Apple Health); the coach reads the Fitbit food log" },
    });

    // The first account again: the entry counts again, and can be deleted.
    await stub.linkGoogleAccount(link());
    expect(await objectTool(stub, "nutrition_day", today)).toMatchObject({ ok: true, output: { data: { items_logged: 1, per_meal: [{ items: [{ entry_id: entryId }] }] } } });
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toMatchObject({ ok: true });
  });

  it("lists the linked account's entry_id, and null once that account is no longer linked", async () => {
    const stub = await linkedStore();
    const entryId = await entryOfTheFirstAccount(stub);
    const today = { date: day(0) };
    expect(await objectTool(stub, "nutrition_day", today)).toMatchObject({
      ok: true,
      output: { data: { per_meal: [{ items: [{ entry_id: entryId }] }] } },
    });

    await stub.linkGoogleAccount(other());
    // The same record, read as food the log keeps. It is still the previous account's entry.
    const point = g.google.createdPoints()[0];
    if (point?.dataSource) point.dataSource.platform = "FITBIT";
    const next = await objectTool(stub, "nutrition_day", today);
    expect(next).toMatchObject({ ok: true, output: { data: { items_logged: 1, per_meal: [{ items: [{ entry_id: null }] }] } } });
    expect(await objectTool(stub, "nutrition_log_delete", { entry_id: entryId })).toEqual(NO_ENTRY);
  });
});
