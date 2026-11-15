import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GOOGLE_HEALTH_SCOPES } from "../src/google";
import { ACCESS_TOKEN_MARGIN_MS, coachStore, type GoogleLink, migrate, SCHEMA_VERSION } from "../src/store";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, mockGoogle, OWNER_EMAIL, OWNER_SUB } from "./helpers";
import { freshStore, MEMORY_TABLES } from "./memory-helpers";

function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
}

const ALL_TABLES = ["google_account", ...MEMORY_TABLES, "schema_version"].sort();

/** Undoes migration 3. The triggers and the FTS5 shadow tables go with their tables. */
function dropMemoryTables(sql: SqlStorage): void {
  sql.exec("DROP TABLE notes_fts");
  for (const table of ["profile", "targets", "health_items", "lab_results", "preferences", "notes"]) {
    sql.exec(`DROP TABLE ${table}`);
  }
}

function link(overrides: Partial<GoogleLink> = {}): GoogleLink {
  return {
    sub: OWNER_SUB,
    email: OWNER_EMAIL,
    refreshToken: GOOGLE_REFRESH_TOKEN,
    accessToken: GOOGLE_ACCESS_TOKEN,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: ["openid", "email", ...GOOGLE_HEALTH_SCOPES].join(" "),
    ...overrides,
  };
}

async function row(): Promise<Record<string, SqlStorageValue> | undefined> {
  return runInDurableObject(coachStore(env), async (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM google_account").toArray()[0],
  );
}

describe("CoachStore schema", () => {
  it("migrates a new object to the latest version", async () => {
    const stub = coachStore(env);
    expect(SCHEMA_VERSION).toBe(3);
    expect(await stub.schemaVersion()).toBe(SCHEMA_VERSION);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(tableNames(state.storage.sql)).toEqual(ALL_TABLES);
      const version = state.storage.sql
        .exec<{ id: number; version: number }>("SELECT id, version FROM schema_version")
        .one();
      expect(version).toEqual({ id: 1, version: SCHEMA_VERSION });
    });
  });

  it("migrates an object left at the v1 scaffold", async () => {
    await runInDurableObject(coachStore(env), async (_instance, state) => {
      const sql = state.storage.sql;
      dropMemoryTables(sql);
      sql.exec("DROP TABLE google_account");
      sql.exec("UPDATE schema_version SET version = 1 WHERE id = 1");
      expect(tableNames(sql)).toEqual(["schema_version"]);

      migrate(state.storage);
      expect(tableNames(sql)).toEqual(ALL_TABLES);
      expect(sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version).toBe(SCHEMA_VERSION);

      // Running it again is a no-op.
      migrate(state.storage);
      expect(sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version).toBe(SCHEMA_VERSION);
    });
  });

  it("adds the coach memory to an object that already holds a Google link", async () => {
    await runInDurableObject(freshStore(), async (_instance, state) => {
      const sql = state.storage.sql;
      dropMemoryTables(sql);
      sql.exec("UPDATE schema_version SET version = 2 WHERE id = 1");
      sql.exec(
        `INSERT INTO google_account (id, sub, email, refresh_token, scopes, linked_at, updated_at)
         VALUES (1, ?, ?, ?, 'openid', 1, 1)`,
        OWNER_SUB,
        OWNER_EMAIL,
        GOOGLE_REFRESH_TOKEN,
      );

      migrate(state.storage);
      expect(tableNames(sql)).toEqual(ALL_TABLES);
      expect(sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version).toBe(3);
      // The link survives the upgrade.
      expect(sql.exec("SELECT email FROM google_account").one()).toEqual({ email: OWNER_EMAIL });
    });
  });

  it("rolls a failed migration back and keeps the version", async () => {
    await runInDurableObject(freshStore(), async (_instance, state) => {
      const sql = state.storage.sql;
      // Leave one memory table behind: migration 3 fails when it creates it again.
      for (const table of ["profile", "targets", "health_items", "lab_results", "preferences"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("DROP TABLE notes_fts");
      sql.exec("UPDATE schema_version SET version = 2 WHERE id = 1");

      expect(() => migrate(state.storage)).toThrow(/already exists/);
      expect(sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version).toBe(2);
      // Nothing of the failed step stays: the tables it created first are gone again.
      expect(tableNames(sql)).toEqual(["google_account", "notes", "schema_version"]);
    });
  });
});

describe("CoachStore Google token", () => {
  beforeEach(async () => {
    await runInDurableObject(coachStore(env), async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM google_account");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports not_linked without an account", async () => {
    const calls = mockGoogle(() => new Response(null, { status: 500 }));
    const stub = coachStore(env);
    expect(await stub.googleAccessToken()).toMatchObject({ ok: false, code: "not_linked" });
    expect(await stub.googleAccountStatus()).toEqual({
      linked: false,
      email: null,
      linkedAt: null,
      scopesGranted: [],
      scopesMissing: [...GOOGLE_HEALTH_SCOPES],
      token: "not_linked",
    });
    expect(calls.token).toEqual([]);
  });

  it("returns a cached access token without calling Google", async () => {
    const calls = mockGoogle(() => new Response(null, { status: 500 }));
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link());
    expect(await stub.googleAccessToken()).toMatchObject({ ok: true, accessToken: GOOGLE_ACCESS_TOKEN });
    expect(calls.token).toEqual([]);
  });

  it("renews a token close to expiry once for concurrent callers, keeping the refresh token", async () => {
    const calls = mockGoogle(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ access_token: "renewed-access-token", expires_in: 3599, token_type: "Bearer" });
    });
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: Date.now() + ACCESS_TOKEN_MARGIN_MS - 1000 }));

    const results = await Promise.all([stub.googleAccessToken(), stub.googleAccessToken(), stub.googleAccessToken()]);
    for (const result of results) expect(result).toMatchObject({ ok: true, accessToken: "renewed-access-token" });
    expect(calls.token).toHaveLength(1);
    expect(calls.token[0]?.get("grant_type")).toBe("refresh_token");
    expect(calls.token[0]?.get("refresh_token")).toBe(GOOGLE_REFRESH_TOKEN);
    expect(calls.token[0]?.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(calls.token[0]?.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);

    expect(await row()).toMatchObject({ access_token: "renewed-access-token", refresh_token: GOOGLE_REFRESH_TOKEN });
    expect(await stub.googleAccessToken()).toMatchObject({ ok: true, accessToken: "renewed-access-token" });
    expect(calls.token).toHaveLength(1);
  });

  it("stores a rotated refresh token and new scopes", async () => {
    mockGoogle(() =>
      Response.json({ access_token: "renewed", expires_in: 3599, refresh_token: "rotated-refresh", scope: "openid email" }),
    );
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    expect(await stub.googleAccessToken()).toMatchObject({ ok: true });
    expect(await row()).toMatchObject({ refresh_token: "rotated-refresh", scopes: "openid email" });
    const status = await stub.googleAccountStatus();
    expect(status.scopesMissing).toEqual([...GOOGLE_HEALTH_SCOPES]);
  });

  it("removes the link when Google answers invalid_grant", async () => {
    mockGoogle(() =>
      Response.json({ error: "invalid_grant", error_description: `Token has been revoked: ${GOOGLE_REFRESH_TOKEN}` }, { status: 400 }),
    );
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const result = await stub.googleAccessToken();
    expect(result).toEqual({ ok: false, code: "auth_expired", message: "Google token endpoint: invalid_grant (HTTP 400)" });
    expect(await row()).toBeUndefined();
  });

  it.each([
    { name: "invalid_grant", reply: () => Response.json({ error: "invalid_grant" }, { status: 400 }) },
    { name: "a new token", reply: () => Response.json({ access_token: "stale-link-token", expires_in: 3599 }) },
  ])("answers for the new link when a renewal with $name races a sign-in", async ({ reply }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockGoogle(async () => {
      await gate;
      return reply();
    });
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const pending = stub.googleAccessToken();
    const pendingStatus = stub.googleAccountStatus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stub.linkGoogleAccount(link({ refreshToken: "new-sign-in-refresh", accessToken: "new-sign-in-access" }));
    release();
    expect(await pending).toMatchObject({ ok: true, accessToken: "new-sign-in-access" });
    expect(await pendingStatus).toMatchObject({ linked: true, token: "ok" });
    expect(await row()).toMatchObject({ refresh_token: "new-sign-in-refresh", access_token: "new-sign-in-access" });
  });

  it("maps a body cut off after HTTP 200 to upstream_unavailable", async () => {
    mockGoogle(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    expect(await stub.googleAccessToken()).toMatchObject({ ok: false, code: "upstream_unavailable" });
    expect(await row()).toMatchObject({ refresh_token: GOOGLE_REFRESH_TOKEN });
  });

  it.each([
    { name: "HTTP 503", reply: () => new Response("<html>down</html>", { status: 503 }), code: "upstream_unavailable" },
    { name: "HTTP 429", reply: () => Response.json({ error: "rate_limit" }, { status: 429 }), code: "upstream_unavailable" },
    { name: "a network error", reply: () => Promise.reject(new TypeError("network down")), code: "upstream_unavailable" },
    { name: "invalid_client", reply: () => Response.json({ error: "invalid_client" }, { status: 401 }), code: "internal_error" },
    { name: "a malformed body", reply: () => Response.json({ token_type: "Bearer" }), code: "internal_error" },
  ])("maps $name to $code and keeps the link", async ({ reply, code }) => {
    mockGoogle(reply);
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ accessTokenExpiresAt: 0 }));
    const result = await stub.googleAccessToken();
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(GOOGLE_REFRESH_TOKEN);
    expect(await row()).toMatchObject({ refresh_token: GOOGLE_REFRESH_TOKEN });
  });

  it("reports the account without any token", async () => {
    mockGoogle(() => new Response(null, { status: 500 }));
    const stub = coachStore(env);
    await stub.linkGoogleAccount(link({ scopes: `openid email ${GOOGLE_HEALTH_SCOPES[0]}` }));
    const status = await stub.googleAccountStatus();
    expect(status).toMatchObject({
      linked: true,
      email: OWNER_EMAIL,
      token: "ok",
      scopesMissing: GOOGLE_HEALTH_SCOPES.slice(1),
    });
    expect(Date.parse(status.linkedAt ?? "")).not.toBeNaN();
    const text = JSON.stringify(status);
    expect(text).not.toContain(GOOGLE_REFRESH_TOKEN);
    expect(text).not.toContain(GOOGLE_ACCESS_TOKEN);
  });
});
