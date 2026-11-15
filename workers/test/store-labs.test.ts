// Ports of internal/store/labs_test.go and of the lab cases of
// internal/store/memory_test.go and store_test.go.
import { describe, expect, it } from "vitest";

import { CorruptRowError, formatStamp } from "../src/store/db";
import {
  LAB_FLAGGED,
  LAB_HIGH,
  LAB_IN_RANGE,
  LAB_LOW,
  LAB_NO_REFERENCE,
  type LabValue,
  MAX_LAB_BATCH,
  MAX_LAB_ROWS,
  MAX_LAB_TOTAL,
  assess,
  criticalFlag,
  labStatus,
  needsReview,
  normalizeAnalyte,
  outOfRange,
  queryLabs,
  recordLabs,
  unitKey,
} from "../src/store/labs";
import { MAX_NAME_LEN } from "../src/store/memory";
import { FIXED_NOW, codeOf, toolError, withDb } from "./memory-helpers";

const NOW = "2026-10-14T12:00:00Z";
const STAMP = formatStamp(FIXED_NOW);
const SLOW = 60_000;

const value = (analyte: string, v: number, unit: string, extra: Partial<LabValue> = {}): LabValue => ({ analyte, value: v, unit, ...extra });

describe("lab statuses", () => {
  it.each([
    [{ value: 70, ref_low: 70, ref_high: 99 }, LAB_IN_RANGE], // inclusive bounds
    [{ value: 99, ref_low: 70, ref_high: 99 }, LAB_IN_RANGE],
    [{ value: 69.9, ref_low: 70, ref_high: 99 }, LAB_LOW],
    [{ value: 99.1, ref_low: 70, ref_high: 99 }, LAB_HIGH],
    [{ value: 5, ref_low: 10 }, LAB_LOW], // only a lower bound
    [{ value: 50, ref_low: 10 }, LAB_IN_RANGE],
    [{ value: 5.7, ref_high: 5.7, ref_high_exclusive: true }, LAB_HIGH], // "< 5.7"
    [{ value: 5.6, ref_high: 5.7, ref_high_exclusive: true }, LAB_IN_RANGE],
    [{ value: 60, ref_low: 60, ref_low_exclusive: true }, LAB_LOW], // "> 60"
    [{ value: 900 }, LAB_NO_REFERENCE], // no range is not "normal"
  ])("labStatus(%j) = %s", (fields, want) => {
    const v = value("x", fields.value, "u", fields);
    expect(labStatus(v)).toBe(want);
    expect(outOfRange(v)).toBe(want === LAB_LOW || want === LAB_HIGH);
  });

  it.each([
    [{ value: 4, ref_low: 3.5, ref_high: 5.1 }, LAB_IN_RANGE, false],
    [{ value: 4, ref_low: 3.5, ref_high: 5.1, report_flag: "H" }, LAB_FLAGGED, false], // wrong band picked
    [{ value: 4, ref_low: 3.5, ref_high: 5.1, report_flag: "crítico" }, LAB_FLAGGED, true],
    [{ value: 6.4, ref_low: 3.5, ref_high: 5.1, report_flag: "Crítico" }, LAB_HIGH, true],
    [{ value: 2, ref_low: 3.5, ref_high: 5.1, report_flag: "LL" }, LAB_LOW, true],
    [{ value: 9, report_flag: "*" }, LAB_FLAGGED, false], // no range, but marked
    [{ value: 9 }, LAB_NO_REFERENCE, false],
  ])("assess(%j) lets the report flag win: %s, urgent %s", (fields, status, urgent) => {
    expect(assess(value("x", fields.value, "u", fields))).toEqual({ status, urgent });
  });

  it("asks for a review of anything but in_range", () => {
    for (const status of [LAB_LOW, LAB_HIGH, LAB_FLAGGED, LAB_NO_REFERENCE]) expect(needsReview(status)).toBe(true);
    expect(needsReview(LAB_IN_RANGE)).toBe(false);
  });

  it("recognizes the marks of critical values", () => {
    for (const flag of ["crítico", "CRITICO", "Valor crítico", "critical", "pânico", "panic", "alerta", "HH", " ll ", "AA"]) {
      expect(criticalFlag(flag), flag).toBe(true);
    }
    for (const flag of ["", "H", "L", "*", "A", "alto", "baixo", "hhh"]) expect(criticalFlag(flag), flag).toBe(false);
  });

  it("lowercases flags, analytes and units as the Go server does", () => {
    // U+0130: JavaScript's toLowerCase gives "cri" + a combining dot + "tical", which has no "crit".
    expect(criticalFlag("CRİTICAL")).toBe(true);
    expect(assess(value("potassium", 6.6, "mmol/L", { report_flag: "CRİTICAL" }))).toEqual({ status: LAB_FLAGGED, urgent: true });
    // A final capital sigma: toLowerCase would end the word in U+03C2 and give a second key.
    expect(normalizeAnalyte("ΟΣ")).toBe("οσ");
    expect(normalizeAnalyte("ΟΣ")).toBe(normalizeAnalyte("οσ"));
    expect(unitKey("ΟΣ")).toBe(unitKey("οσ"));
  });

  it("rejects both spellings of one analyte in a batch as a duplicate", () =>
    withDb((db) => {
      const error = toolError(() => recordLabs(db, "2026-09-01", "", "chat", [value("ΟΣ", 1, "u"), value("οσ", 2, "u")]));
      expect(error.wire()).toMatchObject({
        code: "invalid_input",
        message: 'results 0 and 1 are both "οσ" on 2026-09-01; send one value per analyte',
      });
      // One spelling after the other is the same analyte, in the same unit.
      recordLabs(db, "2026-09-01", "", "chat", [value("ΟΣ", 1, "ΟΣ")]);
      const next = recordLabs(db, "2026-10-01", "", "chat", [value("οσ", 2, "οσ")]);
      expect(next.unit_changes).toEqual([]);
      expect(queryLabs(db, "ΟΣ").results.map((r) => r.analyte)).toEqual(["οσ", "οσ"]);
    }));

  it("normalizes analyte names and compares units without case or spaces", () => {
    expect(normalizeAnalyte("  Glucose \t Fasting ")).toBe("glucose_fasting");
    expect(normalizeAnalyte("LDL")).toBe("ldl");
    expect(unitKey("mg / dL")).toBe(unitKey("MG/dl"));
    expect(unitKey("mg/dL")).not.toBe(unitKey("mmol/L"));
  });
});

describe("recordLabs and queryLabs", () => {
  it("upserts by date and analyte, and queries by analyte and date", () =>
    withDb((db) => {
      const first = recordLabs(db, "2026-09-01", "LabX", "chat", [
        value("LDL", 110, "mg/dL", { ref_high: 130 }),
        value("Glucose Fasting", 105, "mg/dL", { ref_low: 70, ref_high: 99 }),
      ]);
      expect(first.results[0]).toEqual({
        id: expect.any(Number),
        collected_on: "2026-09-01",
        lab: "LabX",
        analyte: "ldl",
        value: 110,
        unit: "mg/dL",
        ref_high: 130,
        source: "chat",
        created_at: NOW,
      });
      expect(first.results[1]?.analyte).toBe("glucose_fasting");
      expect(first.results.map(outOfRange)).toEqual([false, true]);
      expect(first).toMatchObject({ replaced: [], unit_changes: [], newer_stored: [] });

      // A correction on the same date replaces value, lab and source.
      recordLabs(db, "2026-09-01", "LabY", "pdf", [value("ldl", 120, "mg/dL", { ref_high: 130 })]);
      recordLabs(db, "2026-10-01", "", "chat", [value("ldl", 100, "mg/dL")]);

      const ldl = queryLabs(db, "LDL").results;
      expect(ldl).toHaveLength(2);
      expect(ldl[0]).toMatchObject({ value: 120, source: "pdf", lab: "LabY", collected_on: "2026-09-01" });
      // Empty optional fields are left out, never "" or null.
      expect(ldl[1]).toEqual({ id: expect.any(Number), collected_on: "2026-10-01", analyte: "ldl", value: 100, unit: "mg/dL", source: "chat", created_at: NOW });

      expect(queryLabs(db, "", "2026-09-15").results.map((r) => r.collected_on)).toEqual(["2026-10-01"]);
      const all = queryLabs(db);
      expect(all.truncated).toBe(false);
      expect(all.results.map((r) => `${r.analyte}@${r.collected_on}`)).toEqual([
        "glucose_fasting@2026-09-01",
        "ldl@2026-09-01",
        "ldl@2026-10-01",
      ]);
      expect(codeOf(() => queryLabs(db, "", "garbage"))).toBe("invalid_input");
      expect(codeOf(() => queryLabs(db, "a".repeat(MAX_NAME_LEN + 1)))).toBe("invalid_input");
    }));

  it("validates the whole batch before it writes", () =>
    withDb((db) => {
      const ldl = value("ldl", 1, "mg/dL");
      const bad: { date: string; source: string; values: LabValue[] }[] = [
        { date: "2026-09-01", source: "chat", values: [] },
        { date: "bad", source: "chat", values: [ldl] },
        { date: "2026-09-01", source: "fax", values: [ldl] },
        { date: "2026-09-01", source: "chat", values: [value(" ", 1, "mg/dL")] },
        { date: "2026-09-01", source: "chat", values: [value("ldl", 1, "")] },
        { date: "2026-09-01", source: "chat", values: [value("ldl", Number.NaN, "mg/dL")] },
        { date: "2026-09-01", source: "chat", values: [value("ldl", 1, "mg/dL", { ref_high: Number.POSITIVE_INFINITY })] },
        { date: "2026-09-01", source: "chat", values: [value("ldl", 1, "mg/dL", { ref_low: 10, ref_high: 5 })] },
        { date: "2026-09-01", source: "chat", values: [value("x", 1, "u", { ref_high_exclusive: true })] },
        { date: "2026-09-01", source: "chat", values: [value("x", 1, "u", { ref_text: "r".repeat(MAX_NAME_LEN + 1) })] },
        // The same analyte twice, after normalization.
        { date: "2026-09-01", source: "chat", values: [ldl, value("LDL", 2, "mg/dL")] },
        { date: "2026-09-01", source: "chat", values: Array.from({ length: MAX_LAB_BATCH + 1 }, (_unused, i) => value(`a${i}`, 1, "u")) },
      ];
      for (const b of bad) {
        expect(codeOf(() => recordLabs(db, b.date, "", b.source, b.values)), `${b.date} ${b.source} ${b.values.length}`).toBe("invalid_input");
      }
      expect(codeOf(() => recordLabs(db, "2026-09-01", "l".repeat(MAX_NAME_LEN + 1), "chat", [ldl]))).toBe("invalid_input");

      // Errors name the analyte, never the value.
      const error = toolError(() => recordLabs(db, "2026-09-01", "", "chat", [value("ldl", 187.25, "mg/dL", { ref_low: 200, ref_high: 100 })]));
      expect(error.message).toBe('result 0 ("ldl"): ref_low is above ref_high');
      expect(error.message).not.toContain("187");

      // A batch with one bad row commits nothing.
      expect(codeOf(() => recordLabs(db, "2026-11-01", "", "chat", [value("hdl", 50, "mg/dL"), value("", 1, "x")]))).toBe("invalid_input");
      expect(queryLabs(db).results).toEqual([]);

      // The caller's values are not changed by normalization.
      const input = [value("Free T4", 1.1, " ng/dL ")];
      expect(recordLabs(db, "2026-09-02", "", "file", input).results[0]).toMatchObject({ analyte: "free_t4", unit: "ng/dL" });
      expect(input[0]).toEqual({ analyte: "Free T4", value: 1.1, unit: " ng/dL " });

      // Exactly MAX_LAB_BATCH distinct analytes is accepted.
      const full = Array.from({ length: MAX_LAB_BATCH }, (_unused, i) => value(`a${i}`, 1, "u"));
      expect(recordLabs(db, "2026-12-01", "", "pdf", full).results).toHaveLength(MAX_LAB_BATCH);
    }));

  it("overwrites every field on a correction", () =>
    withDb((db) => {
      recordLabs(db, "2026-09-01", "LabA", "pdf", [value("hdl", 50, "mg/dL", { ref_low: 40, ref_high: 90, ref_text: "40 a 90" })]);
      const fixed = value("hdl", 1.2, "mmol/L", {
        ref_low: 1,
        ref_high: 2,
        ref_low_exclusive: true,
        ref_high_exclusive: true,
        ref_text: "> 1,0",
        report_flag: "L",
      });
      recordLabs(db, "2026-09-01", "LabB", "chat", [fixed]);
      const rows = queryLabs(db, "hdl").results;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: expect.any(Number), collected_on: "2026-09-01", lab: "LabB", ...fixed, source: "chat", created_at: NOW });
      // A later correction without the optional fields erases them.
      recordLabs(db, "2026-09-01", "", "chat", [value("hdl", 1.3, "mmol/L")]);
      expect(queryLabs(db, "hdl").results[0]).toEqual({
        id: rows[0]?.id,
        collected_on: "2026-09-01",
        analyte: "hdl",
        value: 1.3,
        unit: "mmol/L",
        source: "chat",
        created_at: NOW,
      });
    }));

  it("reports replacements and unit changes", () =>
    withDb((db) => {
      recordLabs(db, "2025-09-01", "LabA", "pdf", [value("glucose", 100, "mg/dL")]);
      let batch = recordLabs(db, "2026-09-01", "LabB", "pdf", [
        value("glucose", 5.5, "mmol/L", { ref_text: " 3,9 a 5,5 ", report_flag: " H " }),
        value("creatinine", 1.0, "mg/dL"),
      ]);
      expect(batch.unit_changes).toEqual([{ analyte: "glucose", unit: "mmol/L", other_unit: "mg/dL", other_on: "2025-09-01", relation: "earlier" }]);
      expect(batch.replaced).toEqual([]);
      // Same date again: urine creatinine sent under the blood name replaces it, visibly.
      batch = recordLabs(db, "2026-09-01", "LabC", "chat", [value("creatinine", 80, "mg/dL")]);
      expect(batch.replaced).toEqual([
        { analyte: "creatinine", previous_value: 1.0, previous_unit: "mg/dL", previous_lab: "LabB", previous_status: LAB_NO_REFERENCE },
      ]);
      // A unit spelled differently is the same unit.
      expect(recordLabs(db, "2026-10-01", "", "chat", [value("creatinine", 1.1, "MG / dl")]).unit_changes).toEqual([]);
      // ref_text and report_flag are stored trimmed.
      expect(queryLabs(db, "glucose").results[1]).toMatchObject({ ref_text: "3,9 a 5,5", report_flag: "H" });
    }));

  it("keeps the previous status and flag of a replaced value", () =>
    withDb((db) => {
      const range = { ref_low: 3.5, ref_high: 5.1 };
      const sodium = { ref_low: 135, ref_high: 145 };
      recordLabs(db, "2026-09-01", "", "pdf", [
        value("potassium", 6.4, "mmol/L", { ...range, report_flag: "crítico" }),
        value("sodium", 140, "mmol/L", { ...sodium, report_flag: "*" }),
      ]);
      const batch = recordLabs(db, "2026-09-01", "", "chat", [value("potassium", 4.4, "mmol/L", range), value("sodium", 140, "mmol/L", sodium)]);
      // A corrected critical or flagged value leaves a trace.
      expect(batch.replaced).toEqual([
        { analyte: "potassium", previous_value: 6.4, previous_unit: "mmol/L", previous_status: LAB_HIGH, previous_report_flag: "crítico" },
        { analyte: "sodium", previous_value: 140, previous_unit: "mmol/L", previous_status: LAB_FLAGGED, previous_report_flag: "*" },
      ]);
    }));

  it("compares units with the nearest value on both sides", () =>
    withDb((db) => {
      const record = (on: string, unit: string) => recordLabs(db, on, "", "chat", [value("glucose", 1, unit)]);
      record("2026-01-01", "mg/dL");
      expect(record("2026-03-01", "mmol/L").unit_changes).toMatchObject([{ other_on: "2026-01-01" }]);
      // The nearest earlier value is mmol/L, not the oldest one in mg/dL.
      expect(record("2026-05-01", "mmol/L").unit_changes).toEqual([]);
      // A backfilled report: mg/dL on 2026-02-01 matches the earlier value but not the later one.
      const backfill = record("2026-02-01", "mg/dL");
      expect(backfill.unit_changes).toEqual([{ analyte: "glucose", unit: "mg/dL", other_unit: "mmol/L", other_on: "2026-03-01", relation: "later" }]);
      expect(backfill.newer_stored).toEqual(["glucose"]);
      // A same-date correction is compared with its neighbours, never with itself.
      const correction = record("2026-05-01", "mg/dL");
      expect(correction.replaced).toMatchObject([{ previous_unit: "mmol/L" }]);
      expect(correction.unit_changes).toMatchObject([{ other_on: "2026-03-01", relation: "earlier" }]);
      expect(correction.newer_stored).toEqual([]);
    }));

  it("fails the whole query on a corrupt timestamp", () =>
    withDb((db, sql) => {
      recordLabs(db, "2026-09-01", "", "chat", [value("ldl", 1, "mg/dL")]);
      sql.exec("UPDATE lab_results SET created_at = 'yesterday'");
      expect(() => queryLabs(db)).toThrow(CorruptRowError);
    }));
});

describe("lab limits", () => {
  const fill = (sql: SqlStorage, analyte: string, from: string, rows: number) =>
    sql
      .exec(
        `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < ?)
         INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at)
         SELECT date(?, '+' || i || ' days'), ?, i, 'u', 'chat', ? FROM seq`,
        rows,
        from,
        analyte,
        STAMP,
      )
      .toArray();

  it("truncates a query to the newest rows", { timeout: SLOW }, () =>
    withDb((db, sql) => {
      // MAX_LAB_ROWS old "aaa" rows, then one recent "zzz": the cut must drop old rows, not the newest.
      fill(sql, "aaa", "2000-01-01", MAX_LAB_ROWS);
      recordLabs(db, "2026-10-01", "", "chat", [value("zzz", 1, "u")]);
      const rows = queryLabs(db);
      expect(rows.truncated).toBe(true);
      expect(rows.results).toHaveLength(MAX_LAB_ROWS);
      expect(rows.results.at(-1)?.analyte).toBe("zzz");
      // The oldest row is the one left out.
      expect(rows.results[0]?.collected_on).toBe("2000-01-03");
      expect(queryLabs(db, "zzz")).toMatchObject({ truncated: false, results: [{ analyte: "zzz" }] });
    }));

  it("drops exactly the oldest row past the cap", { timeout: SLOW }, () =>
    withDb((db, sql) => {
      // Two analytes share the oldest date, plus enough newer rows to reach the cap exactly.
      recordLabs(db, "2000-01-01", "", "chat", [value("bbb", 1, "u"), value("ccc", 1, "u")]);
      fill(sql, "mmm", "2001-01-01", MAX_LAB_ROWS - 2);
      let rows = queryLabs(db);
      expect(rows.truncated).toBe(false);
      expect(rows.results).toHaveLength(MAX_LAB_ROWS);

      // One more row on the oldest date: newest-first order puts "aaa" last, so it is the one left out.
      recordLabs(db, "2000-01-01", "", "chat", [value("aaa", 1, "u")]);
      rows = queryLabs(db);
      expect(rows.truncated).toBe(true);
      expect(rows.results).toHaveLength(MAX_LAB_ROWS);
      const present = new Set(rows.results.map((r) => r.analyte));
      expect([present.has("aaa"), present.has("bbb"), present.has("ccc")]).toEqual([false, true, true]);
      // Ordered by analyte, then date.
      const keys = rows.results.map((r) => `${r.analyte}/${r.collected_on}`);
      expect(keys).toEqual([...keys].sort());
      // since is inclusive.
      expect(queryLabs(db, "bbb", "2000-01-01").results).toHaveLength(1);
    }));

  it("caps the table", { timeout: SLOW }, () =>
    withDb((db, sql) => {
      // Filled straight through SQL: one call per row would be slow.
      sql
        .exec(
          `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < ?)
           INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at)
           SELECT '2000-01-01', 'a' || i, 1, 'u', 'chat', ? FROM seq`,
          MAX_LAB_TOTAL - 1,
          STAMP,
        )
        .toArray();
      const two = [value("x", 1, "u"), value("y", 1, "u")];
      expect(codeOf(() => recordLabs(db, "2026-10-01", "", "chat", two))).toBe("invalid_input");
      expect(recordLabs(db, "2026-10-01", "", "chat", two.slice(0, 1)).results).toHaveLength(1);
    }));
});
