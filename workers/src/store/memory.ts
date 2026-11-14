// Profile, targets, health history and preferences (Go: internal/store/memory.go).
// Records use the JSON field names of the tool outputs; an absent optional
// field is left out, never null or "".

import { type LocalDate, UTC, addDays, dateOf, parseDate } from "../coach/date";
import { ToolError } from "../coach/errors";
import { byteLength, goJsonLength, quote, trimSpace, truncate } from "../coach/text";
import { type Db, type Row, invalid, nullable, numberOrUndefined, oneOf, readStamp, text, validDate } from "./db";

// Size and count limits keep one bad tool call (or a loop) from bloating the
// store or flooding the model's context. Lengths are UTF-8 bytes.
export const MAX_NAME_LEN = 200;
export const MAX_DETAILS_LEN = 4 << 10;
export const MAX_PREF_KEY_LEN = 100;
export const MAX_PREF_VALUE = 2 << 10;
export const MAX_PREFERENCES = 200;
export const MAX_PROFILE_TEXT = 2 << 10;
export const MAX_HEALTH_ITEMS = 500;
export const MAX_KCAL = 10_000;
export const MAX_PROTEIN_G = 1_000;
export const MAX_WEEKLY_SESSIONS = 21;
export const MIN_HEIGHT_CM = 50;
export const MAX_HEIGHT_CM = 280;

/**
 * Checks a clear list: known fields only, and none that the same call also
 * sets (which would silently drop the new value).
 */
function validateClear(clear: readonly string[], fields: readonly string[], set: Record<string, boolean>): void {
  for (const field of clear) {
    if (!fields.includes(field)) {
      throw invalid(`cannot clear ${quote(truncate(field, 40))}; fields are ${fields.join(", ")}`);
    }
    if (set[field]) throw invalid(`${field} is both set and cleared; send one or the other`);
  }
}

// --- profile ---

/** The body-composition goal stored as profile.goal_json. */
export interface Goal {
  type?: string;
  target_weight_kg?: number;
  target_body_fat_pct?: number;
  deadline?: LocalDate;
}

/**
 * Stored as profile.plan_json. The weekly sessions target is deliberately
 * absent: it lives only in targets.
 */
export interface TrainingPlan {
  split?: string;
  notes?: string;
}

/** The singleton user profile. */
export interface Profile {
  birth_date?: LocalDate;
  sex?: string;
  height_cm?: number;
  goal?: Goal;
  training_plan?: TrainingPlan;
  updated_at: string;
  /**
   * Stored fields that no longer decode and are left out above; setting or
   * clearing them repairs the profile.
   */
  corrupt_fields?: string[];
}

/** The names accepted by ProfilePatch.clear. */
export const PROFILE_FIELDS: readonly string[] = ["birth_date", "sex", "height_cm", "goal", "training_plan"];

/**
 * Sets its defined fields and then clears the fields named in `clear`;
 * everything else is left unchanged. goal and training_plan replace the whole object.
 */
export interface ProfilePatch {
  birth_date?: LocalDate;
  sex?: string;
  height_cm?: number;
  goal?: Goal;
  training_plan?: TrainingPlan;
  clear?: readonly string[];
}

/** The goal with its empty fields left out, in the stored field order. */
function cleanGoal(goal: Goal): Goal {
  return {
    ...(goal.type ? { type: goal.type } : {}),
    ...(goal.target_weight_kg === undefined ? {} : { target_weight_kg: goal.target_weight_kg }),
    ...(goal.target_body_fat_pct === undefined ? {} : { target_body_fat_pct: goal.target_body_fat_pct }),
    ...(goal.deadline ? { deadline: goal.deadline } : {}),
  };
}

function cleanPlan(plan: TrainingPlan): TrainingPlan {
  return { ...(plan.split ? { split: plan.split } : {}), ...(plan.notes ? { notes: plan.notes } : {}) };
}

/** A stored JSON column as an object. JSON null reads as an empty object. */
function decodeObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("stored value is not a JSON object");
  return value as Record<string, unknown>;
}

function field<T>(object: Record<string, unknown>, name: string, type: "string" | "number"): T | undefined {
  const value = object[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type) throw new TypeError(`stored ${name} has the wrong type`);
  return value as T;
}

function decodeGoal(json: string): Goal {
  const object = decodeObject(json);
  const deadline = field<string>(object, "deadline", "string");
  if (deadline && parseDate(deadline) === undefined) throw new TypeError("stored deadline is not a date");
  return cleanGoal({
    type: field<string>(object, "type", "string"),
    target_weight_kg: field<number>(object, "target_weight_kg", "number"),
    target_body_fat_pct: field<number>(object, "target_body_fat_pct", "number"),
    deadline,
  });
}

function decodePlan(json: string): TrainingPlan {
  const object = decodeObject(json);
  return cleanPlan({ split: field<string>(object, "split", "string"), notes: field<string>(object, "notes", "string") });
}

/** The profile row while it is merged: "" is an unset text field. */
interface ProfileState {
  birth_date: string;
  sex: string;
  height_cm?: number;
  goal?: Goal;
  training_plan?: TrainingPlan;
}

/** A JSON column that no longer decodes. */
interface CorruptField {
  field: string;
  cause: unknown;
}

interface StoredProfile {
  state: ProfileState;
  updatedAt: string;
  corrupt: CorruptField[];
}

/**
 * Reads the profile row. JSON columns that fail to decode are left out and
 * returned with their cause, so updateProfile can still overwrite them.
 */
function readProfile(db: Db): StoredProfile | undefined {
  const row = db.first("SELECT birth_date, sex, height_cm, goal_json, plan_json, updated_at FROM profile WHERE id = 1");
  if (!row) return undefined;
  const state: ProfileState = {
    birth_date: text(row.birth_date),
    sex: text(row.sex),
    height_cm: numberOrUndefined(row.height_cm),
  };
  const corrupt: CorruptField[] = [];
  if (row.goal_json !== null) {
    try {
      state.goal = decodeGoal(text(row.goal_json));
    } catch (cause) {
      corrupt.push({ field: "goal", cause });
    }
  }
  if (row.plan_json !== null) {
    try {
      state.training_plan = decodePlan(text(row.plan_json));
    } catch (cause) {
      corrupt.push({ field: "training_plan", cause });
    }
  }
  return { state, updatedAt: readStamp(row.updated_at), corrupt };
}

function toProfile(state: ProfileState, updatedAt: string, corrupt: string[]): Profile {
  return {
    ...(state.birth_date === "" ? {} : { birth_date: state.birth_date }),
    ...(state.sex === "" ? {} : { sex: state.sex }),
    ...(state.height_cm === undefined ? {} : { height_cm: state.height_cm }),
    ...(state.goal ? { goal: state.goal } : {}),
    ...(state.training_plan ? { training_plan: state.training_plan } : {}),
    updated_at: updatedAt,
    ...(corrupt.length > 0 ? { corrupt_fields: corrupt } : {}),
  };
}

/**
 * The profile, or undefined before the first update. Fields that no longer
 * decode are left out and named in corrupt_fields, so the rest stays readable.
 */
export function profile(db: Db): Profile | undefined {
  const stored = readProfile(db);
  return stored && toProfile(stored.state, stored.updatedAt, stored.corrupt.map((c) => c.field));
}

/** Whether the patch overwrites or clears `name`, so a corrupt stored value does not block the update. */
function replaces(patch: ProfilePatch, name: string): boolean {
  if (patch.clear?.includes(name)) return true;
  if (name === "goal") return patch.goal !== undefined;
  if (name === "training_plan") return patch.training_plan !== undefined;
  return false;
}

function validateProfilePatch(patch: ProfilePatch, today: LocalDate): void {
  validateClear(patch.clear ?? [], PROFILE_FIELDS, {
    birth_date: patch.birth_date !== undefined,
    sex: patch.sex !== undefined,
    height_cm: patch.height_cm !== undefined,
    goal: patch.goal !== undefined,
    training_plan: patch.training_plan !== undefined,
  });
  if (patch.birth_date !== undefined) {
    validDate("birth_date", patch.birth_date, false);
    if (patch.birth_date < "1900-01-01" || patch.birth_date > today) {
      throw invalid("birth_date must be between 1900-01-01 and today");
    }
  }
  if (patch.sex !== undefined && byteLength(patch.sex) > MAX_NAME_LEN) throw invalid("sex is too long");
  const numbers: { name: string; value: number | undefined; min: number; max: number }[] = [
    { name: "height_cm", value: patch.height_cm, min: MIN_HEIGHT_CM, max: MAX_HEIGHT_CM },
  ];
  const goal = patch.goal;
  if (goal !== undefined) {
    if (byteLength(goal.type ?? "") > MAX_NAME_LEN) throw invalid("goal type is too long");
    numbers.push(
      { name: "goal target_weight_kg", value: goal.target_weight_kg, min: 20, max: 400 },
      { name: "goal target_body_fat_pct", value: goal.target_body_fat_pct, min: 2, max: 70 },
    );
    validDate("goal deadline", goal.deadline ?? "", true);
  }
  for (const n of numbers) {
    if (n.value !== undefined && (!Number.isFinite(n.value) || n.value < n.min || n.value > n.max)) {
      throw invalid(`${n.name} must be between ${n.min} and ${n.max}`);
    }
  }
  const plan = patch.training_plan;
  if (plan !== undefined && (byteLength(plan.split ?? "") > MAX_NAME_LEN || byteLength(plan.notes ?? "") > MAX_PROFILE_TEXT)) {
    throw invalid("training plan is too long");
  }
}

/**
 * Merges the patch into the stored profile (creating it if needed) and also
 * returns the profile as it was before (absent on the first update). A stored
 * goal or plan that no longer decodes blocks the update unless the patch sets
 * or clears it, which is how it gets repaired.
 */
export function updateProfile(db: Db, patch: ProfilePatch): { profile: Profile; previous?: Profile } {
  const stamp = db.stamp();
  // One day of slack: "today" in UTC can be yesterday in the user's zone.
  const tomorrow = addDays(dateOf(stamp.time, UTC), 1) ?? "";
  validateProfilePatch(patch, tomorrow);
  return db.transaction(() => {
    const stored = readProfile(db);
    const blocking = (stored?.corrupt ?? []).filter((c) => !replaces(patch, c.field));
    if (blocking.length > 0) {
      // Names the fields, never their content; the decode errors stay as the cause.
      const names = blocking.map((c) => c.field).join(", ");
      throw new ToolError(
        "invalid_input",
        `the stored ${names} cannot be read`,
        `set a new value or add it to clear in this same call to repair it (clear: ${names})`,
        { cause: new AggregateError(blocking.map((c) => c.cause), "stored profile fields do not decode") },
      );
    }
    const state: ProfileState = stored ? { ...stored.state } : { birth_date: "", sex: "" };
    if (patch.birth_date !== undefined) state.birth_date = patch.birth_date;
    if (patch.sex !== undefined) state.sex = patch.sex;
    if (patch.height_cm !== undefined) state.height_cm = patch.height_cm;
    if (patch.goal !== undefined) state.goal = cleanGoal(patch.goal);
    if (patch.training_plan !== undefined) state.training_plan = cleanPlan(patch.training_plan);
    for (const name of patch.clear ?? []) {
      if (name === "birth_date") state.birth_date = "";
      if (name === "sex") state.sex = "";
      if (name === "height_cm") state.height_cm = undefined;
      if (name === "goal") state.goal = undefined;
      if (name === "training_plan") state.training_plan = undefined;
    }
    db.all(
      `INSERT INTO profile (id, birth_date, sex, height_cm, goal_json, plan_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET birth_date = excluded.birth_date, sex = excluded.sex,
         height_cm = excluded.height_cm, goal_json = excluded.goal_json,
         plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
      nullable(state.birth_date),
      nullable(state.sex),
      state.height_cm ?? null,
      state.goal ? JSON.stringify(state.goal) : null,
      state.training_plan ? JSON.stringify(state.training_plan) : null,
      stamp.stored,
    );
    // Every corrupt field was replaced above; `previous` still names them.
    const previous = stored && toProfile(stored.state, stored.updatedAt, stored.corrupt.map((c) => c.field));
    return { profile: toProfile(state, stamp.at, []), ...(previous ? { previous } : {}) };
  });
}

// --- targets ---

/** The names accepted by TargetInput.clear. */
export const TARGET_FIELDS: readonly string[] = ["kcal", "protein_g", "weekly_sessions"];

/**
 * One version of the user's targets: a new version starts on effective_from
 * and earlier versions are kept for history.
 */
export interface Target {
  effective_from: LocalDate;
  kcal?: number;
  protein_g?: number;
  weekly_sessions?: number;
  created_at: string;
}

export interface TargetInput {
  effective_from: LocalDate;
  kcal?: number;
  protein_g?: number;
  weekly_sessions?: number;
  /** Fields to drop instead of carrying them forward. */
  clear?: readonly string[];
}

function validateTarget(t: TargetInput): void {
  validDate("effective_from", t.effective_from, false);
  const clear = t.clear ?? [];
  validateClear(clear, TARGET_FIELDS, {
    kcal: t.kcal !== undefined,
    protein_g: t.protein_g !== undefined,
    weekly_sessions: t.weekly_sessions !== undefined,
  });
  if (t.kcal === undefined && t.protein_g === undefined && t.weekly_sessions === undefined && clear.length === 0) {
    throw invalid(`set or clear at least one of ${TARGET_FIELDS.join(", ")}`);
  }
  const limits: [string, number | undefined, number][] = [
    ["kcal", t.kcal, MAX_KCAL],
    ["protein_g", t.protein_g, MAX_PROTEIN_G],
    ["weekly_sessions", t.weekly_sessions, MAX_WEEKLY_SESSIONS],
  ];
  for (const [name, value, max] of limits) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > max)) {
      throw invalid(`${name} must be between 0 and ${max}`);
    }
  }
}

const TARGET_COLUMNS = "effective_from, kcal, protein_g, weekly_sessions, created_at";

const TARGET_IN_FORCE = `SELECT ${TARGET_COLUMNS} FROM targets WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`;

function toTarget(row: Row): Target {
  const kcal = numberOrUndefined(row.kcal);
  const protein = numberOrUndefined(row.protein_g);
  const sessions = numberOrUndefined(row.weekly_sessions);
  return {
    effective_from: text(row.effective_from),
    ...(kcal === undefined ? {} : { kcal }),
    ...(protein === undefined ? {} : { protein_g: protein }),
    ...(sessions === undefined ? {} : { weekly_sessions: sessions }),
    created_at: readStamp(row.created_at),
  };
}

/**
 * Stores a target version. Fields left out are carried forward from the
 * version in force on effective_from (the same date's row when correcting it),
 * so changing only kcal keeps the protein and sessions targets; fields in
 * `clear` are dropped instead. Setting the same effective_from again replaces
 * that version, never an earlier or later one.
 *
 * It also returns the version that was in force on effective_from before the
 * call, read in the same transaction.
 */
export function setTarget(db: Db, input: TargetInput): { target: Target; previous?: Target } {
  validateTarget(input);
  return db.transaction(() => {
    const row = db.first(TARGET_IN_FORCE, input.effective_from);
    const previous = row && toTarget(row);
    let kcal = input.kcal ?? previous?.kcal;
    let protein = input.protein_g ?? previous?.protein_g;
    let sessions = input.weekly_sessions ?? previous?.weekly_sessions;
    for (const name of input.clear ?? []) {
      if (name === "kcal") kcal = undefined;
      if (name === "protein_g") protein = undefined;
      if (name === "weekly_sessions") sessions = undefined;
    }
    const stamp = db.stamp();
    db.all(
      `INSERT INTO targets (effective_from, kcal, protein_g, weekly_sessions, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (effective_from) DO UPDATE SET kcal = excluded.kcal, protein_g = excluded.protein_g,
         weekly_sessions = excluded.weekly_sessions, created_at = excluded.created_at`,
      input.effective_from,
      kcal ?? null,
      protein ?? null,
      sessions ?? null,
      stamp.stored,
    );
    const target: Target = {
      effective_from: input.effective_from,
      ...(kcal === undefined ? {} : { kcal }),
      ...(protein === undefined ? {} : { protein_g: protein }),
      ...(sessions === undefined ? {} : { weekly_sessions: sessions }),
      created_at: stamp.at,
    };
    return { target, ...(previous ? { previous } : {}) };
  });
}

/** The latest version that started on or before `day`, or undefined when there is none. */
export function targetInForce(db: Db, day: LocalDate): Target | undefined {
  validDate("day", day, false);
  const row = db.first(TARGET_IN_FORCE, day);
  return row && toTarget(row);
}

/** Every version, newest first. */
export function targets(db: Db): Target[] {
  return db.all(`SELECT ${TARGET_COLUMNS} FROM targets ORDER BY effective_from DESC`).map(toTarget);
}

// --- health items ---

// Health item kinds and statuses, mirrored by the schema CHECK constraints.
export const HEALTH_ITEM_KINDS: readonly string[] = ["condition", "medication", "supplement", "injury", "allergy", "restriction"];
export const HEALTH_ITEM_STATUSES: readonly string[] = ["active", "resolved", "paused"];
/** The names accepted by HealthItemInput.clear. */
export const HEALTH_ITEM_FIELDS: readonly string[] = ["details", "started_on", "ended_on"];

/** One entry of the health history, unique by (kind, name), with name compared case-insensitively. */
export interface HealthItem {
  id: number;
  kind: string;
  name: string;
  status: string;
  details?: string;
  started_on?: LocalDate;
  ended_on?: LocalDate;
  updated_at: string;
}

export interface HealthItemInput {
  kind: string;
  name: string;
  status: string;
  details?: string;
  started_on?: LocalDate;
  ended_on?: LocalDate;
  /** Optional fields to erase on update. */
  clear?: readonly string[];
}

const HEALTH_ITEM_SELECT = "SELECT id, kind, name, status, details, started_on, ended_on, updated_at FROM health_items";

function toHealthItem(row: Row): HealthItem {
  const details = text(row.details);
  const started = text(row.started_on);
  const ended = text(row.ended_on);
  return {
    id: Number(row.id),
    kind: text(row.kind),
    name: text(row.name),
    status: text(row.status),
    ...(details === "" ? {} : { details }),
    ...(started === "" ? {} : { started_on: started }),
    ...(ended === "" ? {} : { ended_on: ended }),
    updated_at: readStamp(row.updated_at),
  };
}

/**
 * Creates the item or updates the one with the same kind and name (trimmed,
 * case-insensitive). On update, status always changes but details and dates
 * keep their stored value unless given or listed in `clear`, so marking an
 * injury resolved does not erase its history.
 *
 * It also returns the item as it was before (absent when it is new).
 */
export function upsertHealthItem(db: Db, input: HealthItemInput): { item: HealthItem; previous?: HealthItem } {
  const name = trimSpace(input.name);
  const details = input.details ?? "";
  const started = input.started_on ?? "";
  const ended = input.ended_on ?? "";
  const clear = input.clear ?? [];

  oneOf("kind", input.kind, HEALTH_ITEM_KINDS, false);
  oneOf("status", input.status, HEALTH_ITEM_STATUSES, false);
  if (name === "" || byteLength(name) > MAX_NAME_LEN) throw invalid(`name is required (max ${MAX_NAME_LEN} characters)`);
  if (byteLength(details) > MAX_DETAILS_LEN) throw invalid(`details exceed ${MAX_DETAILS_LEN} bytes`);
  validateClear(clear, HEALTH_ITEM_FIELDS, { details: details !== "", started_on: started !== "", ended_on: ended !== "" });
  validDate("started_on", started, true);
  validDate("ended_on", ended, true);
  if (started !== "" && ended !== "" && ended < started) throw invalid("ended_on is before started_on");

  return db.transaction(() => {
    const existing = db.first(`${HEALTH_ITEM_SELECT} WHERE kind = ? AND name = ?`, input.kind, name);
    const previous = existing && toHealthItem(existing);
    if (!previous && db.count("SELECT COUNT(*) FROM health_items") >= MAX_HEALTH_ITEMS) {
      throw invalid(`health history is full (${MAX_HEALTH_ITEMS} items); resolve or merge old items first`);
    }
    const stamp = db.stamp();
    const cleared = (name: string) => (clear.includes(name) ? 1 : 0);
    const row = db.first(
      `INSERT INTO health_items (kind, name, status, details, started_on, ended_on, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, name) DO UPDATE SET status = excluded.status,
         details    = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.details, details) END,
         started_on = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.started_on, started_on) END,
         ended_on   = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.ended_on, ended_on) END,
         updated_at = excluded.updated_at
       RETURNING id, kind, name, status, details, started_on, ended_on, updated_at`,
      input.kind,
      name,
      input.status,
      nullable(details),
      nullable(started),
      nullable(ended),
      stamp.stored,
      cleared("details"),
      cleared("started_on"),
      cleared("ended_on"),
    );
    if (!row) throw new Error("health item upsert returned no row");
    const item = toHealthItem(row);
    if (item.started_on && item.ended_on && item.ended_on < item.started_on) {
      // The merged row is inconsistent (a new ended_on before the stored
      // started_on); the throw rolls the upsert back.
      throw invalid("ended_on is before the stored started_on");
    }
    return { item, ...(previous ? { previous } : {}) };
  });
}

/** Lists items, optionally filtered by kind and status ("" = any). */
export function healthItems(db: Db, kind = "", status = ""): HealthItem[] {
  oneOf("kind", kind, HEALTH_ITEM_KINDS, true);
  oneOf("status", status, HEALTH_ITEM_STATUSES, true);
  return db
    .all(
      `${HEALTH_ITEM_SELECT} WHERE (? = '' OR kind = ?) AND (? = '' OR status = ?) ORDER BY kind, name LIMIT ?`,
      kind,
      kind,
      status,
      status,
      MAX_HEALTH_ITEMS,
    )
    .map(toHealthItem);
}

// --- preferences ---

/**
 * Stores a free-form JSON value (as JSON text) under the trimmed key. It
 * returns the key as stored and the JSON text it replaced (absent when the key
 * is new). The size limit counts the bytes of the text as Go's JSON encoder
 * writes it (see goJsonLength); the text is stored as given.
 */
export function setPreference(db: Db, rawKey: string, valueJson: string): { key: string; previous?: string } {
  const key = trimSpace(rawKey);
  if (key === "" || byteLength(key) > MAX_PREF_KEY_LEN) {
    throw invalid(`preference key is required (max ${MAX_PREF_KEY_LEN} characters)`);
  }
  // The limit is on the text as the Go server would hold it, not on these bytes.
  if (goJsonLength(valueJson) > MAX_PREF_VALUE) throw invalid(`preference ${quote(key)} exceeds ${MAX_PREF_VALUE} bytes`);
  try {
    JSON.parse(valueJson);
  } catch {
    throw invalid(`preference ${quote(key)}: value is not valid JSON`);
  }
  return db.transaction(() => {
    const old = db.first("SELECT value_json FROM preferences WHERE key = ?", key);
    if (!old && db.count("SELECT COUNT(*) FROM preferences") >= MAX_PREFERENCES) {
      throw invalid(`at most ${MAX_PREFERENCES} preferences; reuse or overwrite an existing key`);
    }
    db.all(
      `INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      valueJson,
      db.stamp().stored,
    );
    return { key, ...(old ? { previous: text(old.value_json) } : {}) };
  });
}

/** Every preference as JSON text by key, in key order (at most MAX_PREFERENCES exist). */
export function preferences(db: Db): Map<string, string> {
  const rows = db.all("SELECT key, value_json FROM preferences ORDER BY key LIMIT ?", MAX_PREFERENCES);
  return new Map(rows.map((row) => [text(row.key), text(row.value_json)]));
}
