// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Adapted from google-health-cli pkg/types/registry.go (filter paths, page and
// rollup range caps) and cmd/data.go (filter and dailyRollUp body builders),
// through this repository's internal/googlehealth/datatypes.go. Changes: a
// closed table of the read operations the coach uses instead of the full
// registry, ranges taken as inclusive local days, local midnights from the
// coach zone for physical-time fields, ranges longer than the rollup cap split
// into chunks instead of rejected, and a port from Go to TypeScript.

import { type LocalDate, type Zone, addDays, bounds, parseDate } from "../coach/date";

/** The Google Health API data types the coach reads, as used in request paths. */
export const DATA_TYPES = [
  "sleep",
  "heart-rate",
  "heart-rate-variability",
  "daily-heart-rate-variability",
  "daily-resting-heart-rate",
  "steps",
  "active-zone-minutes",
  "exercise",
  "nutrition-log",
  "total-calories",
  "weight",
  "body-fat",
] as const;

/** A Google Health API data type ID. */
export type DataType = (typeof DATA_TYPES)[number];

/**
 * The time field a type's list filter compares against:
 * - civilStart: interval.civil_start_time, local wall time without a zone;
 * - civilEnd: interval.civil_end_time (sleep filters only on its end);
 * - physical: sample_time.physical_time, a UTC instant;
 * - date: date, a plain YYYY-MM-DD.
 */
export type FilterKind = "civilStart" | "civilEnd" | "physical" | "date";

export type Operation = "list" | "reconcile" | "dailyRollup";

const OPERATION_NAMES: Record<Operation, string> = { list: "list", reconcile: "reconcile", dailyRollup: "daily rollup" };

export interface TypeInfo {
  /** The snake_case name used in filter expressions. */
  filterName: string;
  kind: FilterKind;
  ops: readonly Operation[];
  /** The largest page the API accepts: 25 for sleep and exercise, 10000 for the others. */
  pageSize: number;
  /** The longest dailyRollUp range per request: 14 days for total-calories, 90 for the others, 0 without a rollup. */
  rollupDays: number;
}

const LIST: readonly Operation[] = ["list", "reconcile"];
const ALL: readonly Operation[] = ["list", "reconcile", "dailyRollup"];

export const TYPE_TABLE: Readonly<Record<DataType, TypeInfo>> = {
  sleep: { filterName: "sleep", kind: "civilEnd", ops: LIST, pageSize: 25, rollupDays: 0 },
  "heart-rate": { filterName: "heart_rate", kind: "physical", ops: LIST, pageSize: 10000, rollupDays: 0 },
  "heart-rate-variability": { filterName: "heart_rate_variability", kind: "physical", ops: LIST, pageSize: 10000, rollupDays: 0 },
  "daily-heart-rate-variability": { filterName: "daily_heart_rate_variability", kind: "date", ops: LIST, pageSize: 10000, rollupDays: 0 },
  "daily-resting-heart-rate": { filterName: "daily_resting_heart_rate", kind: "date", ops: LIST, pageSize: 10000, rollupDays: 0 },
  steps: { filterName: "steps", kind: "civilStart", ops: ALL, pageSize: 10000, rollupDays: 90 },
  "active-zone-minutes": { filterName: "active_zone_minutes", kind: "civilStart", ops: ALL, pageSize: 10000, rollupDays: 90 },
  exercise: { filterName: "exercise", kind: "civilStart", ops: LIST, pageSize: 25, rollupDays: 0 },
  "nutrition-log": { filterName: "nutrition_log", kind: "civilStart", ops: ALL, pageSize: 10000, rollupDays: 90 },
  "total-calories": { filterName: "total_calories", kind: "civilStart", ops: ["dailyRollup"], pageSize: 10000, rollupDays: 14 },
  weight: { filterName: "weight", kind: "physical", ops: ALL, pageSize: 10000, rollupDays: 90 },
  "body-fat": { filterName: "body_fat", kind: "physical", ops: ALL, pageSize: 10000, rollupDays: 90 },
};

/**
 * The type's facts. Throws when the type is unknown or does not support `op`:
 * both are caller bugs, caught before any request.
 */
export function lookup(dataType: string, op: Operation): TypeInfo {
  if (!Object.hasOwn(TYPE_TABLE, dataType)) {
    throw new Error(`googlehealth: unknown data type ${JSON.stringify(dataType)}`);
  }
  const info = TYPE_TABLE[dataType as DataType];
  if (!info.ops.includes(op)) throw new Error(`googlehealth: ${dataType} does not support ${OPERATION_NAMES[op]}`);
  return info;
}

/** Validates an inclusive local-day range and returns its exclusive end (the day after `to`). */
function span(from: LocalDate, to: LocalDate): LocalDate {
  if (typeof from !== "string" || parseDate(from) === undefined) throw new Error("googlehealth: from: invalid date, want YYYY-MM-DD");
  if (typeof to !== "string" || parseDate(to) === undefined) throw new Error("googlehealth: to: invalid date, want YYYY-MM-DD");
  // YYYY-MM-DD orders as text.
  if (to < from) throw new Error(`googlehealth: range ends (${to}) before it starts (${from})`);
  return addDays(to, 1) as LocalDate;
}

/** A UTC instant as the filters write it: seconds, no fraction. */
function utc(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

function between(info: TypeInfo, field: string, low: string, high: string): string {
  const path = `${info.filterName}.${field}`;
  return `${path} >= "${low}" AND ${path} < "${high}"`;
}

/**
 * The AIP-160 expression selecting the local days [from, to]. The API supports
 * only >= and <, so the upper bound is the next day's start.
 */
export function filter(info: TypeInfo, from: LocalDate, to: LocalDate, zone: Zone): string {
  const end = span(from, to);
  switch (info.kind) {
    case "civilStart":
      return between(info, "interval.civil_start_time", `${from}T00:00:00`, `${end}T00:00:00`);
    case "civilEnd":
      return between(info, "interval.civil_end_time", `${from}T00:00:00`, `${end}T00:00:00`);
    case "physical": {
      const low = bounds(from, zone);
      const high = bounds(to, zone);
      if (!low || !high) throw new Error("googlehealth: invalid date, want YYYY-MM-DD");
      return between(info, "sample_time.physical_time", utc(low.start), utc(high.end));
    }
    case "date":
      return between(info, "date", from, end);
  }
}

/**
 * Bounds a listBetween request: the band writes about one heart-rate sample
 * every 2 seconds, so a day is already four full pages.
 */
export const MAX_WINDOW_MS = 24 * 3_600_000;

/** Selects the instants [start, end) of a physical-time type. */
export function windowFilter(dataType: string, info: TypeInfo, start: Date, end: Date): string {
  if (info.kind !== "physical") throw new Error(`googlehealth: ${dataType} is not filtered by instant`);
  const length = end.getTime() - start.getTime();
  // An invalid Date makes the length NaN, which fails both comparisons.
  if (!(length > 0 && length <= MAX_WINDOW_MS)) {
    throw new Error("googlehealth: a window must end after it starts and span at most 24h");
  }
  return between(info, "sample_time.physical_time", utc(start), utc(end));
}

/** The API's CivilDateTime at a day's midnight. */
export interface CivilDate {
  date: { year: number; month: number; day: number };
}

function toCivil(d: LocalDate): CivilDate {
  const [year, month, day] = d.split("-").map(Number);
  return { date: { year: year as number, month: month as number, day: day as number } };
}

/**
 * The dailyRollUp body. windowSizeDays is documented as optional, but the API
 * answers 400 without it. The keys are in the order the Go server writes them.
 */
export interface RollupRequest {
  range: { start: CivilDate; end: CivilDate };
  windowSizeDays: number;
  pageSize: number;
  pageToken?: string;
}

/** Splits [from, to] into requests of at most info.rollupDays days. */
export function rollupChunks(info: TypeInfo, from: LocalDate, to: LocalDate): RollupRequest[] {
  const last = span(from, to); // exclusive
  if (!(info.rollupDays > 0)) throw new Error("googlehealth: the type has no daily rollup");
  const chunks: RollupRequest[] = [];
  for (let start = from; start < last; ) {
    const next = addDays(start, info.rollupDays) as LocalDate;
    const end = next < last ? next : last;
    chunks.push({ range: { start: toCivil(start), end: toCivil(end) }, windowSizeDays: 1, pageSize: info.pageSize });
    start = end;
  }
  return chunks;
}
