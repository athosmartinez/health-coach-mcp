// Lab results (Go: internal/store/labs.go).

import type { LocalDate } from "../coach/date";
import { byteLength, compareText, fields, lower, quote, trimSpace } from "../coach/text";
import { type Db, type Row, invalid, nullable, numberOrUndefined, oneOf, readStamp, text, validDate } from "./db";
import { MAX_NAME_LEN } from "./memory";

/** Where a lab result came from, mirrored by the schema CHECK. */
export const LAB_SOURCES: readonly string[] = ["pdf", "chat", "file"];

/** Bounds one report; a full panel is well under this. */
export const MAX_LAB_BATCH = 200;
/** Bounds one query result (years of panels for every analyte). */
export const MAX_LAB_ROWS = 2000;
/** Bounds the table: decades of monthly panels. */
export const MAX_LAB_TOTAL = 20_000;

// Lab value statuses. no_reference means the report gave no range, which is
// not the same as normal. flagged means the report marked a value that the
// recorded range does not put outside: the report's mark wins.
export const LAB_IN_RANGE = "in_range";
export const LAB_LOW = "low";
export const LAB_HIGH = "high";
export const LAB_NO_REFERENCE = "no_reference";
export const LAB_FLAGGED = "flagged";

/** One analyte measurement with its reference range as printed. */
export interface LabValue {
  analyte: string;
  value: number;
  unit: string;
  ref_low?: number;
  ref_high?: number;
  /** Exclusive bounds come from ranges printed as "> X" or "< X": a value equal to the bound is already outside. */
  ref_low_exclusive?: boolean;
  ref_high_exclusive?: boolean;
  /** The range exactly as printed, so the chosen bounds can be checked. */
  ref_text?: string;
  /** The lab's own mark (H, L, crítico, *), passed through. */
  report_flag?: string;
}

/** A stored LabValue. */
export interface LabResult extends LabValue {
  id: number;
  collected_on: LocalDate;
  lab?: string;
  source: string;
  created_at: string;
}

/** Compares the value with its own reference range. Values on an inclusive bound are in range. */
export function labStatus(v: LabValue): string {
  if (v.ref_low === undefined && v.ref_high === undefined) return LAB_NO_REFERENCE;
  if (v.ref_low !== undefined && (v.value < v.ref_low || (v.ref_low_exclusive === true && v.value === v.ref_low))) {
    return LAB_LOW;
  }
  if (v.ref_high !== undefined && (v.value > v.ref_high || (v.ref_high_exclusive === true && v.value === v.ref_high))) {
    return LAB_HIGH;
  }
  return LAB_IN_RANGE;
}

/** Whether the value falls outside its reference range. */
export function outOfRange(v: LabValue): boolean {
  const status = labStatus(v);
  return status === LAB_LOW || status === LAB_HIGH;
}

/**
 * The status to report: labStatus, except that a value the report itself
 * marked is never in_range or no_reference (the range may have been read for
 * the wrong sex or age band, and panic limits are not reference ranges).
 * `urgent` is set when the mark says critical.
 */
export function assess(v: LabValue): { status: string; urgent: boolean } {
  let status = labStatus(v);
  const flag = v.report_flag ?? "";
  if (flag !== "" && (status === LAB_IN_RANGE || status === LAB_NO_REFERENCE)) status = LAB_FLAGGED;
  return { status, urgent: criticalFlag(flag) };
}

/** Whether a status calls for mentioning the value and suggesting a doctor: anything but in_range. */
export function needsReview(status: string): boolean {
  return status !== LAB_IN_RANGE;
}

const ACCENTS: Record<string, string> = {
  á: "a", à: "a", â: "a", ã: "a", é: "e", ê: "e", í: "i", ó: "o", ô: "o", õ: "o", ú: "u", ç: "c",
};

/**
 * Recognizes the marks labs print for critical (panic) values: crítico/critical,
 * pânico/panic, alerta/alert and the HL7 codes HH, LL, AA.
 */
export function criticalFlag(flag: string): boolean {
  const f = lower(trimSpace(flag)).replace(/[áàâãéêíóôõúç]/g, (letter) => ACCENTS[letter] ?? letter);
  if (f === "hh" || f === "ll" || f === "aa") return true;
  return ["crit", "panic", "alert"].some((word) => f.includes(word));
}

/**
 * Lowercases and joins words with "_" ("Glucose Fasting" → "glucose_fasting"),
 * so the same analyte from different reports lines up.
 */
export function normalizeAnalyte(name: string): string {
  return fields(lower(name)).join("_");
}

/**
 * Compares units ignoring case and spaces ("mg/dL" = "mg / dl"). It does not
 * convert: equivalent units with different names stay different.
 */
export function unitKey(unit: string): string {
  return lower(fields(unit).join(""));
}

function validateLabValue(v: LabValue, i: number): void {
  if (v.analyte === "" || byteLength(v.analyte) > MAX_NAME_LEN) {
    throw invalid(`result ${i}: analyte is required (max ${MAX_NAME_LEN} characters)`);
  }
  // Error messages name the analyte, never its value.
  const label = `result ${i} (${quote(v.analyte)})`;
  if (v.unit === "" || byteLength(v.unit) > MAX_NAME_LEN) throw invalid(`${label}: unit is required`);
  if (!Number.isFinite(v.value)) throw invalid(`${label}: value must be a finite number`);
  for (const ref of [v.ref_low, v.ref_high]) {
    if (ref !== undefined && !Number.isFinite(ref)) throw invalid(`${label}: reference range must be finite`);
  }
  if (v.ref_low !== undefined && v.ref_high !== undefined && v.ref_low > v.ref_high) {
    throw invalid(`${label}: ref_low is above ref_high`);
  }
  if ((v.ref_low_exclusive === true && v.ref_low === undefined) || (v.ref_high_exclusive === true && v.ref_high === undefined)) {
    throw invalid(`${label}: an exclusive flag needs its bound`);
  }
  if (byteLength(v.ref_text ?? "") > MAX_NAME_LEN || byteLength(v.report_flag ?? "") > MAX_NAME_LEN) {
    throw invalid(`${label}: ref_text or report_flag is too long`);
  }
}

/**
 * A stored value that a new batch overwrote (same date and analyte). The
 * previous status and mark keep a corrected critical value visible.
 */
export interface LabReplacement {
  analyte: string;
  previous_value: number;
  previous_unit: string;
  previous_lab?: string;
  previous_status: string;
  previous_report_flag?: string;
}

/**
 * An analyte recorded in a unit that differs from its nearest stored value
 * before or after the collection date: the two must not be compared as numbers.
 */
export interface LabUnitChange {
  analyte: string;
  unit: string;
  other_unit: string;
  other_on: LocalDate;
  /** earlier or later: where other_on falls relative to collected_on. */
  relation: "earlier" | "later";
}

/** The outcome of recordLabs. */
export interface LabBatch {
  results: LabResult[];
  replaced: LabReplacement[];
  unit_changes: LabUnitChange[];
  /** Analytes that already have a value after this collection date: a backfilled result is history, not today's state. */
  newer_stored: string[];
}

/** The reference fields of a row or an input, with the empty ones left out, in output order. */
function reference(v: {
  ref_low?: number;
  ref_high?: number;
  ref_low_exclusive?: boolean;
  ref_high_exclusive?: boolean;
  ref_text?: string;
  report_flag?: string;
}): Partial<LabValue> {
  return {
    ...(v.ref_low === undefined ? {} : { ref_low: v.ref_low }),
    ...(v.ref_high === undefined ? {} : { ref_high: v.ref_high }),
    ...(v.ref_low_exclusive === true ? { ref_low_exclusive: true } : {}),
    ...(v.ref_high_exclusive === true ? { ref_high_exclusive: true } : {}),
    ...(v.ref_text ? { ref_text: v.ref_text } : {}),
    ...(v.report_flag ? { report_flag: v.report_flag } : {}),
  };
}

function rowValue(row: Row): LabValue {
  return {
    analyte: text(row.analyte),
    value: Number(row.value),
    unit: text(row.unit),
    ...reference({
      ref_low: numberOrUndefined(row.ref_low),
      ref_high: numberOrUndefined(row.ref_high),
      ref_low_exclusive: row.ref_low_exclusive === 1,
      ref_high_exclusive: row.ref_high_exclusive === 1,
      ref_text: text(row.ref_text),
      report_flag: text(row.report_flag),
    }),
  };
}

/**
 * Stores a batch from one collection date. A result for an analyte already
 * recorded on that date replaces it (a correction) and is reported in
 * `replaced`. The batch is validated first and written in one transaction.
 */
export function recordLabs(db: Db, collectedOn: LocalDate, lab: string, source: string, input: readonly LabValue[]): LabBatch {
  validDate("collected_on", collectedOn, false);
  oneOf("source", source, LAB_SOURCES, false);
  if (input.length === 0 || input.length > MAX_LAB_BATCH) throw invalid(`a lab batch needs 1 to ${MAX_LAB_BATCH} results`);
  if (byteLength(lab) > MAX_NAME_LEN) throw invalid("lab name is too long");
  // Normalized copies: the caller's values are not changed.
  const values = input.map((v, i) => {
    const value: LabValue = {
      analyte: normalizeAnalyte(v.analyte),
      value: v.value,
      unit: trimSpace(v.unit),
      ...reference({ ...v, ref_text: trimSpace(v.ref_text ?? ""), report_flag: trimSpace(v.report_flag ?? "") }),
    };
    validateLabValue(value, i);
    return value;
  });
  // Two values for one analyte on one date would silently overwrite each other.
  const seen = new Map<string, number>();
  values.forEach((v, i) => {
    const first = seen.get(v.analyte);
    if (first !== undefined) {
      throw invalid(`results ${first} and ${i} are both ${quote(v.analyte)} on ${collectedOn}; send one value per analyte`);
    }
    seen.set(v.analyte, i);
  });

  return db.transaction(() => {
    if (db.count("SELECT COUNT(*) FROM lab_results") + values.length > MAX_LAB_TOTAL) {
      throw invalid(`lab history is full (${MAX_LAB_TOTAL} results)`);
    }
    const stamp = db.stamp();
    const out: LabBatch = { results: [], replaced: [], unit_changes: [], newer_stored: [] };
    for (const v of values) {
      const old = db.first(
        `SELECT analyte, value, unit, lab, ref_low, ref_high, ref_low_exclusive, ref_high_exclusive, ref_text, report_flag
         FROM lab_results WHERE collected_on = ? AND analyte = ?`,
        collectedOn,
        v.analyte,
      );
      if (old) {
        const previous = rowValue(old);
        const previousLab = text(old.lab);
        out.replaced.push({
          analyte: v.analyte,
          previous_value: previous.value,
          previous_unit: previous.unit,
          ...(previousLab === "" ? {} : { previous_lab: previousLab }),
          previous_status: assess(previous).status,
          ...(previous.report_flag ? { previous_report_flag: previous.report_flag } : {}),
        });
      }

      // The nearest value on each side: a backfilled old report can differ
      // from newer values as much as a new report from older ones.
      const sides = [
        { relation: "earlier", order: "collected_on < ? ORDER BY collected_on DESC" },
        { relation: "later", order: "collected_on > ? ORDER BY collected_on ASC" },
      ] as const;
      for (const side of sides) {
        const other = db.first(
          `SELECT unit, collected_on FROM lab_results WHERE analyte = ? AND ${side.order} LIMIT 1`,
          v.analyte,
          collectedOn,
        );
        if (!other) continue;
        if (side.relation === "later") out.newer_stored.push(v.analyte);
        if (unitKey(text(other.unit)) !== unitKey(v.unit)) {
          out.unit_changes.push({
            analyte: v.analyte,
            unit: v.unit,
            other_unit: text(other.unit),
            other_on: text(other.collected_on),
            relation: side.relation,
          });
        }
      }

      const inserted = db.first(
        `INSERT INTO lab_results (collected_on, lab, analyte, value, unit, ref_low, ref_high,
           ref_low_exclusive, ref_high_exclusive, ref_text, report_flag, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collected_on, analyte) DO UPDATE SET lab = excluded.lab, value = excluded.value,
           unit = excluded.unit, ref_low = excluded.ref_low, ref_high = excluded.ref_high,
           ref_low_exclusive = excluded.ref_low_exclusive, ref_high_exclusive = excluded.ref_high_exclusive,
           ref_text = excluded.ref_text, report_flag = excluded.report_flag,
           source = excluded.source, created_at = excluded.created_at
         RETURNING id`,
        collectedOn,
        nullable(lab),
        v.analyte,
        v.value,
        v.unit,
        v.ref_low ?? null,
        v.ref_high ?? null,
        v.ref_low_exclusive === true ? 1 : 0,
        v.ref_high_exclusive === true ? 1 : 0,
        nullable(v.ref_text),
        nullable(v.report_flag),
        source,
        stamp.stored,
      );
      if (!inserted) throw new Error("lab result upsert returned no row");
      out.results.push({
        id: Number(inserted.id),
        collected_on: collectedOn,
        ...(lab === "" ? {} : { lab }),
        ...v,
        source,
        created_at: stamp.at,
      });
    }
    return out;
  });
}

/** A query result. `truncated` means more rows matched than were returned; the oldest are the ones left out. */
export interface LabRows {
  results: LabResult[];
  truncated: boolean;
}

/**
 * Lists results ordered by analyte then date. analyte "" means all; since ""
 * means no lower bound. Past the row cap the oldest rows are dropped
 * (`truncated` is set): an analyte whose values all predate the cut is missing
 * entirely, so a caller that needs it should filter by analyte.
 */
export function queryLabs(db: Db, analyteFilter = "", since: LocalDate = ""): LabRows {
  validDate("since", since, true);
  if (byteLength(analyteFilter) > MAX_NAME_LEN) throw invalid(`analyte is too long (max ${MAX_NAME_LEN} characters)`);
  const analyte = normalizeAnalyte(analyteFilter);
  // Newest first, one extra row to detect truncation: the extra row is the
  // one dropped, then the rest is sorted by analyte and date.
  const rows = db.all(
    `SELECT id, collected_on, lab, analyte, value, unit, ref_low, ref_high,
       ref_low_exclusive, ref_high_exclusive, ref_text, report_flag, source, created_at
     FROM lab_results
     WHERE (? = '' OR analyte = ?) AND (? = '' OR collected_on >= ?)
     ORDER BY collected_on DESC, analyte DESC LIMIT ?`,
    analyte,
    analyte,
    since,
    since,
    MAX_LAB_ROWS + 1,
  );
  const results = rows.map((row): LabResult => {
    const lab = text(row.lab);
    return {
      id: Number(row.id),
      collected_on: text(row.collected_on),
      ...(lab === "" ? {} : { lab }),
      ...rowValue(row),
      source: text(row.source),
      created_at: readStamp(row.created_at),
    };
  });
  const truncated = results.length > MAX_LAB_ROWS;
  if (truncated) results.length = MAX_LAB_ROWS;
  results.sort((a, b) => compareText(a.analyte, b.analyte) || compareText(a.collected_on, b.collected_on));
  return { results, truncated };
}
