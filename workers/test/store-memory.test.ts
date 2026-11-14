// Ports of internal/store/memory_test.go (profile, targets, health items,
// preferences) and of the schema and error cases of internal/store/store_test.go.
// Each test runs in its own Durable Object, with the clock fixed at 2026-10-14 12:00 UTC.
import { afterEach, describe, expect, it, vi } from "vitest";

import { CorruptRowError, formatStamp, notFound } from "../src/store/db";
import {
  HEALTH_ITEM_FIELDS,
  type HealthItem,
  type HealthItemInput,
  MAX_DETAILS_LEN,
  MAX_HEALTH_ITEMS,
  MAX_KCAL,
  MAX_PREF_VALUE,
  MAX_PREFERENCES,
  MAX_PROFILE_TEXT,
  MAX_PROTEIN_G,
  MAX_WEEKLY_SESSIONS,
  PROFILE_FIELDS,
  type Profile,
  type ProfilePatch,
  TARGET_FIELDS,
  type Target,
  type TargetInput,
  healthItems,
  preferences,
  profile,
  setPreference,
  setTarget,
  targetInForce,
  targets,
  updateProfile,
  upsertHealthItem,
} from "../src/store/memory";
import { FIXED_NOW, codeOf, freshStore, objectTool, toolError, withDb } from "./memory-helpers";

const NOW = "2026-10-14T12:00:00Z";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schema", () => {
  it("has the coach memory tables, the FTS index and its triggers", () =>
    withDb((_db, sql) => {
      const objects = [
        "profile", "targets", "health_items", "lab_results", "preferences", "notes", "notes_fts",
        "schema_version", "notes_ai", "notes_ad", "notes_au",
      ];
      for (const name of objects) {
        expect(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", name).one().n, name).toBe(1);
      }
      // The metrics cache comes with the code that fills it.
      expect(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'daily_metrics'").one().n).toBe(0);
    }));

  it("has the Go store's final columns, in the same order", () =>
    withDb((_db, sql) => {
      const columns = (table: string) =>
        sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", table).toArray().map((row) => row.name);
      expect(columns("profile")).toEqual(["id", "birth_date", "sex", "height_cm", "goal_json", "plan_json", "updated_at"]);
      expect(columns("targets")).toEqual(["effective_from", "kcal", "protein_g", "weekly_sessions", "created_at"]);
      expect(columns("health_items")).toEqual(["id", "kind", "name", "status", "details", "started_on", "ended_on", "updated_at"]);
      expect(columns("lab_results")).toEqual([
        "id", "collected_on", "lab", "analyte", "value", "unit", "ref_low", "ref_high", "source", "created_at",
        "ref_low_exclusive", "ref_high_exclusive", "ref_text", "report_flag",
      ]);
      expect(columns("preferences")).toEqual(["key", "value_json", "updated_at"]);
      expect(columns("notes")).toEqual(["id", "kind", "text", "tags", "related_date", "created_at"]);
    }));

  // Each valid control proves the statement shape; the bad twin breaks one rule.
  it.each([
    {
      name: "health item kind",
      ok: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 'k1', 'active', $T)",
      bad: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('hobby', 'k2', 'active', $T)",
      want: "CHECK constraint failed",
    },
    {
      name: "health item status",
      ok: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 's1', 'paused', $T)",
      bad: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 's2', 'gone', $T)",
      want: "CHECK constraint failed",
    },
    {
      name: "health item unique, case-insensitive",
      ok: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('allergy', 'Peanut', 'active', $T)",
      bad: "INSERT INTO health_items (kind, name, status, updated_at) VALUES ('allergy', 'peanut', 'active', $T)",
      want: "UNIQUE constraint failed",
    },
    {
      name: "lab source",
      ok: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-01', 'ldl', 1, 'mg/dL', 'pdf', $T)",
      bad: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-02', 'ldl', 1, 'mg/dL', 'fax', $T)",
      want: "CHECK constraint failed",
    },
    {
      name: "lab unique per date and analyte",
      ok: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-03', 'hdl', 1, 'mg/dL', 'chat', $T)",
      bad: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-03', 'hdl', 2, 'mg/dL', 'chat', $T)",
      want: "UNIQUE constraint failed",
    },
    {
      name: "lab exclusive flag is 0 or 1",
      ok: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at, ref_low_exclusive) VALUES ('2026-10-04', 'tsh', 1, 'u', 'chat', $T, 1)",
      bad: "INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at, ref_low_exclusive) VALUES ('2026-10-05', 'tsh', 1, 'u', 'chat', $T, 2)",
      want: "CHECK constraint failed",
    },
    {
      name: "note kind",
      ok: "INSERT INTO notes (kind, text, created_at) VALUES ('insight', 'x', $T)",
      bad: "INSERT INTO notes (kind, text, created_at) VALUES ('rant', 'x', $T)",
      want: "CHECK constraint failed",
    },
    {
      name: "single profile",
      ok: "INSERT INTO profile (id, updated_at) VALUES (1, $T)",
      bad: "INSERT INTO profile (id, updated_at) VALUES (2, $T)",
      want: "CHECK constraint failed",
    },
  ])("enforces: $name", ({ ok, bad, want }) =>
    withDb((_db, sql) => {
      const run = (query: string) => sql.exec(query.replaceAll("$T", `'${formatStamp(FIXED_NOW)}'`)).toArray();
      run(ok);
      expect(() => run(bad)).toThrow(want);
    }));
});

describe("profile", () => {
  it("merges patches", () =>
    withDb((db) => {
      expect(profile(db)).toBeUndefined();
      updateProfile(db, { birth_date: "1990-01-01", height_cm: 180 });
      const { profile: merged } = updateProfile(db, {
        goal: { type: "cut", target_weight_kg: 75, deadline: "2027-01-31" },
        training_plan: { split: "ppl" },
      });
      // The second patch keeps the earlier fields.
      expect(merged).toEqual({
        birth_date: "1990-01-01",
        height_cm: 180,
        goal: { type: "cut", target_weight_kg: 75, deadline: "2027-01-31" },
        training_plan: { split: "ppl" },
        updated_at: NOW,
      });
      expect(profile(db)).toEqual(merged);
    }));

  it("clears fields and validates the patch", () =>
    withDb((db) => {
      updateProfile(db, { sex: "m", height_cm: 180, goal: { type: "cut" } });
      const cleared = updateProfile(db, { clear: ["sex", "goal"] }).profile;
      expect(cleared).toEqual({ height_cm: 180, updated_at: NOW });
      expect(profile(db)).toEqual(cleared);

      const bad: ProfilePatch[] = [
        { clear: ["weight"] },
        { height_cm: -1 },
        { height_cm: Number.NaN },
        { height_cm: 400 },
        { birth_date: "01/01/1990" },
        { birth_date: "1850-01-01" },
        { birth_date: "2030-01-01" },
        { goal: { target_weight_kg: 0 } },
        { goal: { target_body_fat_pct: 90 } },
        { goal: { deadline: "soon" } },
        { goal: { type: "x".repeat(201) } },
        { sex: "x".repeat(201) },
        { training_plan: { notes: "x".repeat(MAX_PROFILE_TEXT + 1) } },
        { training_plan: { split: "x".repeat(201) } },
      ];
      for (const patch of bad) expect(codeOf(() => updateProfile(db, patch)), JSON.stringify(patch).slice(0, 80)).toBe("invalid_input");
      // Nothing of a rejected patch is stored.
      expect(profile(db)).toEqual(cleared);
    }));

  it("accepts a birth date up to one day past the UTC day", () =>
    withDb((db) => {
      // One day of slack: "today" in UTC can be yesterday in the user's zone.
      expect(updateProfile(db, { birth_date: "2026-10-15" }).profile.birth_date).toBe("2026-10-15");
      expect(codeOf(() => updateProfile(db, { birth_date: "2026-10-16" }))).toBe("invalid_input");
      expect(updateProfile(db, { birth_date: "1900-01-01" }).profile.birth_date).toBe("1900-01-01");
    }));

  it("reports the same validation error every time", () =>
    withDb((db) => {
      const patch = { height_cm: -1, goal: { target_weight_kg: -1, target_body_fat_pct: -1 } };
      const first = toolError(() => updateProfile(db, patch)).message;
      expect(first).toBe("height_cm must be between 50 and 280");
      for (let i = 0; i < 20; i++) expect(toolError(() => updateProfile(db, patch)).message).toBe(first);
    }));

  it("keeps a corrupt JSON field readable around it, and lets a patch repair it", () =>
    withDb((db, sql) => {
      updateProfile(db, { sex: "m", goal: { type: "cut" }, training_plan: { split: "ppl" } });
      for (const { column, field } of [
        { column: "goal_json", field: "goal" },
        { column: "plan_json", field: "training_plan" },
      ]) {
        sql.exec(`UPDATE profile SET ${column} = '{bad'`);
        // The rest of the profile stays readable and the field is named.
        expect(profile(db)).toMatchObject({ sex: "m", corrupt_fields: [field] });
        expect(profile(db)).not.toHaveProperty(field);

        const blocked = toolError(() => updateProfile(db, { sex: "f" }));
        expect(blocked.code).toBe("invalid_input");
        expect(blocked.message).toContain(field);
        expect(blocked.hint).toContain("clear");
        // The JSON cause is kept for the log's type names, and never shown.
        expect(blocked.cause).toBeInstanceOf(AggregateError);
        expect((blocked.cause as AggregateError).errors[0]).toBeInstanceOf(SyntaxError);
        expect(profile(db)?.sex).toBe("m");

        // Clearing (or setting) the corrupt field repairs the profile.
        const repaired = updateProfile(db, { clear: [field] });
        expect(repaired.profile.sex).toBe("m");
        expect(repaired.profile.corrupt_fields).toBeUndefined();
        // The previous profile says the repaired field was corrupt.
        expect(repaired.previous?.corrupt_fields).toEqual([field]);
        expect(profile(db)?.corrupt_fields).toBeUndefined();
      }

      sql.exec("UPDATE profile SET goal_json = '{bad', plan_json = '{bad'");
      expect(profile(db)?.corrupt_fields).toEqual(["goal", "training_plan"]);
      // Only the unrepaired field blocks the update.
      const partial = toolError(() => updateProfile(db, { goal: { type: "bulk" } }));
      expect(partial.message).toBe("the stored training_plan cannot be read");
      const fixed = updateProfile(db, { goal: { type: "bulk" }, clear: ["training_plan"] }).profile;
      expect(fixed.goal).toEqual({ type: "bulk" });
    }));

  it.each([
    ['{"type": 5}', true],
    ["[1]", true],
    ['"cut"', true],
    ['{"target_weight_kg": "75"}', true],
    ['{"deadline": "2026-02-30"}', true],
    // JSON null and unknown or null fields are not corrupt.
    ["null", false],
    ['{"type": "cut", "legacy": true, "deadline": null}', false],
  ])("reads the stored goal %s as corrupt: %s", (json, corrupt) =>
    withDb((db, sql) => {
      updateProfile(db, { sex: "m" });
      sql.exec("UPDATE profile SET goal_json = ?", json);
      expect(profile(db)?.corrupt_fields).toEqual(corrupt ? ["goal"] : undefined);
      if (!corrupt) expect(profile(db)?.goal).toEqual(json === "null" ? {} : { type: "cut" });
    }));

  it("fails the read on a corrupt timestamp instead of returning an empty time", () =>
    withDb((db, sql) => {
      updateProfile(db, { sex: "m" });
      sql.exec("UPDATE profile SET updated_at = 'yesterday'");
      expect(() => profile(db)).toThrow(CorruptRowError);
    }));

  it("rejects a field that is both set and cleared", () =>
    withDb((db) => {
      expect(codeOf(() => updateProfile(db, { sex: "m", clear: ["sex"] }))).toBe("invalid_input");
      expect(codeOf(() => setTarget(db, { effective_from: "2026-10-01", kcal: 2000, clear: ["kcal"] }))).toBe("invalid_input");
      const item = { kind: "injury", name: "x", status: "active", details: "d", clear: ["details"] };
      expect(codeOf(() => upsertHealthItem(db, item))).toBe("invalid_input");
      // An unknown clear field is rejected without echoing it whole.
      const long = "z".repeat(1000);
      const error = toolError(() => updateProfile(db, { clear: [long] }));
      expect(error.code).toBe("invalid_input");
      expect(error.message).not.toContain(long);
      expect(error.message).toContain(`"${"z".repeat(40)}…"`);
    }));
});

describe("targets", () => {
  it("keeps versions and finds the one in force", () =>
    withDb((db) => {
      expect(targetInForce(db, "2026-10-14")).toBeUndefined();
      setTarget(db, { effective_from: "2026-10-01", kcal: 2400, weekly_sessions: 4 });
      setTarget(db, { effective_from: "2026-10-15", kcal: 2200 });

      const cases: [string, number][] = [
        ["2026-10-01", 2400],
        ["2026-10-14", 2400],
        ["2026-10-15", 2200],
        ["2026-12-01", 2200],
      ];
      for (const [day, kcal] of cases) expect(targetInForce(db, day)?.kcal, day).toBe(kcal);
      // Before the first version there is no target: a miss, not an error.
      expect(targetInForce(db, "2026-09-30")).toBeUndefined();
      expect(codeOf(() => targetInForce(db, "garbage"))).toBe("invalid_input");

      expect(targets(db).map((t) => t.effective_from)).toEqual(["2026-10-15", "2026-10-01"]);

      const bad: TargetInput[] = [
        { effective_from: "2026-10-01" },
        { effective_from: "bad", kcal: 1 },
        { effective_from: "2026-10-01", protein_g: -1 },
        { effective_from: "2026-10-01", kcal: MAX_KCAL + 1 },
        { effective_from: "2026-10-01", protein_g: MAX_PROTEIN_G + 1 },
        { effective_from: "2026-10-01", weekly_sessions: MAX_WEEKLY_SESSIONS + 1 },
        { effective_from: "2026-10-01", kcal: 2000.5 },
        { effective_from: "2026-10-01", clear: ["carbs"] },
      ];
      for (const input of bad) expect(codeOf(() => setTarget(db, input)), JSON.stringify(input)).toBe("invalid_input");
      // Exactly at the limits is accepted.
      const limits = { effective_from: "2026-11-01", kcal: MAX_KCAL, protein_g: MAX_PROTEIN_G, weekly_sessions: MAX_WEEKLY_SESSIONS };
      expect(setTarget(db, limits).target).toEqual({ ...limits, created_at: NOW });
    }));

  it("reports a missing target as no_data when a tool needs one", () => {
    expect(notFound().wire()).toEqual({ code: "no_data", message: "nothing recorded yet" });
  });

  it("carries the other fields forward on a partial change", () =>
    withDb((db) => {
      setTarget(db, { effective_from: "2026-10-01", kcal: 2000, protein_g: 150, weekly_sessions: 4 });
      const { target } = setTarget(db, { effective_from: "2026-10-20", kcal: 1900 });
      for (const t of [target, targetInForce(db, "2026-10-21")]) {
        expect(t).toEqual({ effective_from: "2026-10-20", kcal: 1900, protein_g: 150, weekly_sessions: 4, created_at: NOW });
      }
      // The earlier version is unchanged.
      expect(targetInForce(db, "2026-10-05")?.kcal).toBe(2000);
    }));

  it("carries from the same date's row when correcting it", () =>
    withDb((db) => {
      setTarget(db, { effective_from: "2026-10-01", kcal: 2000, protein_g: 150, weekly_sessions: 4 });
      setTarget(db, { effective_from: "2026-10-15", protein_g: 160 });
      setTarget(db, { effective_from: "2026-10-15", kcal: 1900 });
      expect(targetInForce(db, "2026-10-15")).toMatchObject({ kcal: 1900, protein_g: 160, weekly_sessions: 4 });
      // A back-dated version does not rewrite the later one.
      setTarget(db, { effective_from: "2026-10-10", kcal: 2100 });
      expect(targetInForce(db, "2026-10-15")).toMatchObject({ kcal: 1900, protein_g: 160 });
      // It carries protein 150 from the 10-01 version.
      expect(targetInForce(db, "2026-10-12")).toMatchObject({ kcal: 2100, protein_g: 150 });
      expect(targets(db)).toHaveLength(3);
    }));

  it("drops a cleared field instead of carrying it forward", () =>
    withDb((db) => {
      setTarget(db, { effective_from: "2026-10-01", kcal: 2000, protein_g: 150 });
      const { target } = setTarget(db, { effective_from: "2026-10-10", clear: ["protein_g"] });
      expect(target).toEqual({ effective_from: "2026-10-10", kcal: 2000, created_at: NOW });
      expect(targetInForce(db, "2026-10-10")).toEqual(target);
    }));

  it("fails the whole list on a corrupt row", () =>
    withDb((db, sql) => {
      setTarget(db, { effective_from: "2026-10-01", kcal: 2000 });
      setTarget(db, { effective_from: "2026-10-02", kcal: 2000 });
      sql.exec("UPDATE targets SET created_at = 'yesterday' WHERE effective_from = '2026-10-01'");
      // A partial list next to an error is easy to use by mistake.
      expect(() => targets(db)).toThrow(CorruptRowError);
      expect(targetInForce(db, "2026-10-02")?.kcal).toBe(2000);
    }));
});

describe("health items", () => {
  it("upserts by kind and name, and filters", () =>
    withDb((db) => {
      const knee = upsertHealthItem(db, { kind: "injury", name: "knee", status: "active", details: "ACL", started_on: "2026-09-01" });
      expect(knee.previous).toBeUndefined();
      const others: HealthItemInput[] = [
        { kind: "supplement", name: "creatine", status: "active", details: "5 g/day" },
        { kind: "supplement", name: "omega 3", status: "paused" },
        { kind: "injury", name: "ankle", status: "resolved" },
      ];
      for (const item of others) upsertHealthItem(db, item);

      // A status-only update keeps details and dates. The name is trimmed and case-insensitive.
      const again = upsertHealthItem(db, { kind: "injury", name: "Knee ", status: "resolved", ended_on: "2026-10-10" }).item;
      expect(again).toEqual({
        id: knee.item.id,
        kind: "injury",
        name: "knee",
        status: "resolved",
        details: "ACL",
        started_on: "2026-09-01",
        ended_on: "2026-10-10",
        updated_at: NOW,
      });

      const order = healthItems(db).map((item) => `${item.kind}/${item.name}`);
      expect(order).toEqual(["injury/ankle", "injury/knee", "supplement/creatine", "supplement/omega 3"]);
      expect(healthItems(db, "injury", "resolved")).toHaveLength(2);
      expect(healthItems(db, "supplement", "active")).toMatchObject([{ details: "5 g/day" }]);
      for (const [kind, status] of [["bogus", ""], ["", "zzz"]] as const) {
        expect(codeOf(() => healthItems(db, kind, status))).toBe("invalid_input");
      }
    }));

  it("clears a field, and rolls back an update that leaves the dates out of order", () =>
    withDb((db) => {
      upsertHealthItem(db, { kind: "condition", name: "asthma", status: "active", details: "mild", started_on: "2010-01-01" });
      const cleared = upsertHealthItem(db, { kind: "condition", name: "asthma", status: "active", clear: ["details"] }).item;
      expect(cleared.details).toBeUndefined();
      expect(cleared.started_on).toBe("2010-01-01");
      // A new ended_on before the stored started_on is rejected and rolled back.
      const error = toolError(() => upsertHealthItem(db, { kind: "condition", name: "asthma", status: "resolved", ended_on: "2009-01-01" }));
      expect(error.wire()).toMatchObject({ code: "invalid_input", message: "ended_on is before the stored started_on" });
      expect(healthItems(db, "condition")).toEqual([cleared]);
    }));

  it("validates the item", () =>
    withDb((db) => {
      const base = { kind: "injury", name: "x", status: "active" };
      const bad: HealthItemInput[] = [
        { ...base, kind: "hobby" },
        { ...base, status: "gone" },
        { ...base, name: "  " },
        { ...base, name: "n".repeat(201) },
        { ...base, started_on: "yesterday" },
        { ...base, started_on: "2026-10-10", ended_on: "2026-10-01" },
        { ...base, details: "d".repeat(MAX_DETAILS_LEN + 1) },
        { ...base, clear: ["status"] },
      ];
      for (const item of bad) expect(codeOf(() => upsertHealthItem(db, item)), JSON.stringify(item).slice(0, 80)).toBe("invalid_input");
      expect(healthItems(db)).toEqual([]);
      // The limits count UTF-8 bytes: 2048 two-byte characters fit, one more byte does not.
      upsertHealthItem(db, { ...base, details: "é".repeat(MAX_DETAILS_LEN / 2) });
      expect(codeOf(() => upsertHealthItem(db, { ...base, details: `${"é".repeat(MAX_DETAILS_LEN / 2)}x` }))).toBe("invalid_input");
    }));

  it("caps the number of items, but still updates one at the cap", () =>
    withDb((db) => {
      for (let i = 0; i < MAX_HEALTH_ITEMS; i++) upsertHealthItem(db, { kind: "supplement", name: `s${i}`, status: "active" });
      expect(codeOf(() => upsertHealthItem(db, { kind: "supplement", name: "one more", status: "active" }))).toBe("invalid_input");
      expect(upsertHealthItem(db, { kind: "supplement", name: "s0", status: "paused" }).item.status).toBe("paused");
      expect(healthItems(db)).toHaveLength(MAX_HEALTH_ITEMS);
    }));
});

describe("preferences", () => {
  it("stores JSON under a trimmed key and replaces it", () =>
    withDb((db) => {
      setPreference(db, " training_time ", '"morning"');
      setPreference(db, "foods_avoid", '["lactose"]');
      setPreference(db, "training_time", '"evening"');
      expect([...preferences(db)]).toEqual([
        ["foods_avoid", '["lactose"]'],
        ["training_time", '"evening"'],
      ]);
      const big = `"${"a".repeat(MAX_PREF_VALUE)}"`;
      for (const [key, value] of [["x", "not json"], ["x", ""], ["", "1"], ["k".repeat(101), "1"], ["big", big]] as const) {
        expect(codeOf(() => setPreference(db, key, value)), key).toBe("invalid_input");
      }
      const atLimit = `"${"a".repeat(MAX_PREF_VALUE - 2)}"`;
      expect(setPreference(db, "notes", atLimit).key).toBe("notes");
      // A key that looks like an object internal is an ordinary key.
      setPreference(db, "__proto__", "1");
      expect(preferences(db).get("__proto__")).toBe("1");
    }));

  it("caps the number of keys, but still overwrites one at the cap", () =>
    withDb((db) => {
      for (let i = 0; i < MAX_PREFERENCES; i++) setPreference(db, `k${i}`, "1");
      expect(codeOf(() => setPreference(db, "one_more", "1"))).toBe("invalid_input");
      expect(setPreference(db, "k0", "2")).toEqual({ key: "k0", previous: "1" });
      expect(preferences(db).size).toBe(MAX_PREFERENCES);
    }));
});

describe("writes", () => {
  it("return the previous value", () =>
    withDb((db) => {
      expect(updateProfile(db, { sex: "m" }).previous).toBeUndefined();
      expect(updateProfile(db, { sex: "f" }).previous?.sex).toBe("m");

      expect(setTarget(db, { effective_from: "2026-10-01", kcal: 2000 }).previous).toBeUndefined();
      // The same date's row when correcting it.
      expect(setTarget(db, { effective_from: "2026-10-01", kcal: 2100 }).previous).toMatchObject({ kcal: 2000, effective_from: "2026-10-01" });

      expect(upsertHealthItem(db, { kind: "allergy", name: "peanut", status: "active" }).previous).toBeUndefined();
      expect(upsertHealthItem(db, { kind: "allergy", name: "Peanut", status: "resolved" }).previous?.status).toBe("active");

      expect(setPreference(db, "  tone ", '"direct"')).toEqual({ key: "tone" });
      expect(setPreference(db, "tone", '"gentle"').previous).toBe('"direct"');
    }));

  // Every clearable field, one at a time: clearing erases only that field.
  it("clear one field and keep the others", () =>
    withDb((db) => {
      const full: ProfilePatch = { birth_date: "1990-05-01", sex: "m", height_cm: 180, goal: { type: "cut" }, training_plan: { split: "ppl" } };
      for (const cleared of PROFILE_FIELDS) {
        updateProfile(db, full);
        const result = updateProfile(db, { clear: [cleared] }).profile;
        for (const name of PROFILE_FIELDS) {
          expect(result[name as keyof Profile] === undefined, `clear ${cleared}: ${name}`).toBe(name === cleared);
        }
      }

      TARGET_FIELDS.forEach((cleared, i) => {
        setTarget(db, { effective_from: `2026-0${i + 1}-01`, kcal: 2000, protein_g: 150, weekly_sessions: 4 });
        const { target } = setTarget(db, { effective_from: `2026-0${i + 1}-15`, clear: [cleared] });
        for (const name of TARGET_FIELDS) {
          expect(target[name as keyof Target] === undefined, `clear target ${cleared}: ${name}`).toBe(name === cleared);
        }
      });

      const base = { kind: "injury", name: "knee", status: "active", details: "left", started_on: "2026-01-01", ended_on: "2026-02-01" };
      for (const cleared of HEALTH_ITEM_FIELDS) {
        upsertHealthItem(db, base);
        // Omitted fields are kept; only the cleared one goes.
        const { item } = upsertHealthItem(db, { kind: "injury", name: "knee", status: "active", clear: [cleared] });
        for (const name of HEALTH_ITEM_FIELDS) {
          expect(item[name as keyof HealthItem] === undefined, `clear item ${cleared}: ${name}`).toBe(name === cleared);
        }
      }
    }));

  // The Go test runs these from 48 goroutines to prove its transactions wait
  // for the write lock. A Durable Object runs one call at a time, so here the
  // calls arrive together at the object and must leave the same single rows.
  it("arriving together leave one row per key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = freshStore();
    const run = (name: string, args: Record<string, unknown>) => objectTool(stub, name, args);
    const calls = Array.from({ length: 16 }, (_unused, i) => [
      run("profile_update", { height_cm: 170 + i }),
      run("targets_set", { effective_from: "2026-10-01", kcal: 2000 + i }),
      run("health_item_upsert", { kind: "supplement", name: "creatine", status: "active" }),
    ]).flat();
    for (const outcome of await Promise.all(calls)) expect(outcome.ok).toBe(true);

    const read = await run("profile_get", {});
    expect(read.ok).toBe(true);
    const view = (read.ok ? read.output : {}) as { profile?: Profile; health_items?: HealthItem[]; targets_in_force?: Target };
    expect(view.health_items).toHaveLength(1);
    expect(view.profile?.height_cm).toBeGreaterThanOrEqual(170);
    expect(view.profile?.height_cm).toBeLessThanOrEqual(185);
    expect(view.targets_in_force?.effective_from).toBe("2026-10-01");
  });
});
