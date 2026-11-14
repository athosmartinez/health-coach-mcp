import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { coachStore, SCHEMA_VERSION } from "../src/store";

describe("CoachStore", () => {
  it("keeps only the schema_version table", async () => {
    const stub = coachStore(env);
    expect(await stub.schemaVersion()).toBe(SCHEMA_VERSION);

    await runInDurableObject(stub, async (_instance, state) => {
      const names = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
      expect(names).toEqual(["schema_version"]);

      const row = state.storage.sql
        .exec<{ id: number; version: number }>("SELECT id, version FROM schema_version")
        .one();
      expect(row).toEqual({ id: 1, version: SCHEMA_VERSION });
    });
  });
});
