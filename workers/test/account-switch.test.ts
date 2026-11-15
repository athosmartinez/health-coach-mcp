// What the object keeps when another Google account is linked (the operator
// changes ALLOWED_GOOGLE_EMAIL, and the new account signs in). The cache of
// daily values holds the days of one account. The coach memory is the
// person's own and is not tied to the Google account.
//
// Every call is served by the CoachStore object, with the real client and
// store, and Google behind a mocked `fetch`. All values are synthetic.
import { runInDurableObject } from "cloudflare:test";
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
