# Capability Contract — Health Coach MCP

> Status: approved · 2026-10-13 · source: `docs/PRODUCT-BRIEF.md` + real reads from the
> Google Health API (Fitbit Air) · next lane: `tdd-workflow`

## 1. Capability

- **Name:** health-coach-mcp
- **Primary actor:** the user (single user), through any MCP client (Claude Code, Claude Desktop,
  claude.ai, other LLMs, cron agents, chat bridges).
- **Outcome after ship:** any agent answers "how did I recover?", "did I hit my diet?",
  "how was my workout?" and "how was my week?" using **computed, comparable metrics** from the user's
  Google Health data plus the user's coach memory (profile, goals, history, lab tests, notes) —
  without each LLM having to reprocess raw series.
- **Success signal (30 days):** coach used on ≥ 5 of 7 days; adherence and decisions logged in
  the memory; metrics on the right trend (brief §7).

**Promise:** *the MCP computes, the LLM interprets.* Every number comes with its baseline,
coverage and source, so any model gives consistent advice.

## 2. Constraints

### Fixed rules (policy)
| # | Rule |
|---|---|
| R1 | **Single-user.** One Google account, one store. No tenant/user_id in the schema. |
| R2 | **Google Health writes are nutrition-log entries and exercise sessions.** The server reads Google Health and writes only two data types. Nutrition-log entries: `nutrition_log_add` creates one entry and returns `entry_id`, and `nutrition_log_delete` deletes only an entry this server created, or, with `date`, every entry this server created on that day. `nutrition_day` exposes `entry_id` on an item this server logged for the linked account (the id `nutrition_log_delete` accepts), and null on any other item. Exercise sessions: `exercise_log_add` creates one completed workout session and returns `entry_id`, and `exercise_log_delete` deletes only a session this server created, or, with `date`, every session this server created on that day. `workout_review` exposes `entry_id` on a session this server logged for the linked account (the id `exercise_log_delete` accepts), and null on any other session. A logged session and a session of the band stay two records (I2): a logged session that overlaps a session of the band carries the flag `overlaps_band_session`. |
| R3 | **The MCP doesn't diagnose or prescribe medication.** Out-of-range values come back flagged with `refer_to_doctor: true`; tool descriptions state the limit. |
| R4 | **No health data in logs, git or test fixtures.** Logs record only tool, duration and status. Fixtures are synthetic. |
| R5 | **Logs never carry health data or tokens.** The server logs with `console` (tool name, duration, outcome). There is no stdio transport. |
| R6 | **`/mcp` requires an OAuth access token.** `/` and `/privacy` are public. Only `ALLOWED_GOOGLE_EMAIL` may finish sign-in. |

### Invariants (data)
| # | Invariant | Origin |
|---|---|---|
| I1 | Every aggregate metric returns `n_days` (coverage) and `confidence` (`low` < 7 days, `medium` 7–20, `high` ≥ 21 for 28d baselines). | 1 week of history today |
| I2 | **Steps, distance and calories are never summed across sources.** Use the API's `reconcile` or daily rollup (both merge overlaps; the daily rollup is one total per local day) or filter on the primary source (`Google Fitbit Air`). | Steps can arrive from Fitbit Air **and** `com.apple.health.*` |
| I3 | A missing day is `null`, never `0`. | ghealth behavior (presence-aware types) |
| I4 | The "day" is the **local day** in the configured time zone (default `America/Sao_Paulo`); sleep belongs to the day it **ends**. | Timestamps arrive `-03:00`; a night starts on one local day and ends on the next |
| I5 | Units: kg, kcal, g, bpm, ms, min, ml/kg/min (daily VO2 max). Conversion happens in the MCP, not in the LLM. | `weightGrams`, `rootMeanSquareOfSuccessiveDifferencesMilliseconds`, `vo2Max` |
| I6 | Targets (kcal, protein, weekly workouts) are **versioned** with `effective_from`; adherence uses the target in force on that day. | Targets will change during recomposition |
| I7 | Suspicious data comes back with `quality_flags`, it isn't hidden or "fixed". E.g. average HR of 81 bpm in 60 min of jiu-jitsu → `low_hr_for_activity`. | A session can report an average HR far below what its activity type implies |

### Architecture preferences (changeable)
- TypeScript on Cloudflare Workers: MCP over Streamable HTTP, OAuth 2.1 (`workers-oauth-provider`), coach memory and the daily cache in a SQLite Durable Object (`CoachStore`), OAuth clients and grants in KV (`OAUTH_KV`). Google Health client adapted from `ghealth` (Apache-2.0, see `NOTICE`).
- Fetch live from the API + **cache of closed daily aggregates** in that SQLite store (see §5.3).

## 3. Actors and Surfaces

| Actor | Surface | Usage |
|---|---|---|
| The user via chat | MCP **tools** | Questions on demand, profile/lab/note logging |
| The user via chat | MCP **prompts** | `/morning_briefing`, `/weekly_report` as ready-made shortcuts in any client |
| Cron agent (phase 2) | Tools over HTTP | Proactive daily briefing and weekly report |
| Chat bridge (phase 2) | Tools over HTTP | WhatsApp/Telegram |
| Google Health API | Source | Read, plus the create and the delete of nutrition-log entries and of exercise sessions (R2); OAuth 2.0 user |
| Durable Object SQLite (`CoachStore`) | Store | Coach memory, daily cache, the Google refresh token, and the entries this server created |

## 4. Interface Contract — Tools

Conventions for **every** tool:
- Dates `YYYY-MM-DD` in the local time zone; omitted = today (or the last closed week).
- Output is always structured (`StructuredContent`), with an envelope:
  ```json
  { "data": {…}, "coverage": {"n_days": 6, "confidence": "low"},
    "sources": ["Google Fitbit Air"], "quality_flags": [], "generated_at": "…" }
  ```
- Errors are tool errors (`IsError: true`) with a stable `code`: `auth_expired`, `scope_missing`,
  `upstream_unavailable`, `no_data`, `invalid_input`, `internal_error` (unexpected failure; the detail
  isn't exposed because it could contain health data). The error goes as JSON `{code, message, hint}` in the
  **text content**, with no `StructuredContent` (so as not to violate the tool's `outputSchema`).
  `auth_expired` tells the user to disconnect and reconnect the connector. Arguments that fail the input schema are `invalid_input`.
- **Partial days:** today (and any day with incomplete coverage) comes back with `quality_flags: ["partial_day"]`;
  energy balance and adherence don't count partial days as failure.
- Baselines: **7d** = last 7 closed days; **28d** = last 28 closed days, excluding the day being analyzed.

### 4.1 Coach moments (computed, read-only)

#### `morning_briefing(date?)`
Recovery for the night that ended on `date`.
- **sleep:** `asleep_min`, `awake_min`, `efficiency_pct` (asleep / in bed), `stages_min`
  {deep, light, rem, awake}, `start`, `end`; each vs 7d and 28d average.
- **hrv:** overnight median rMSSD (ms), `delta_pct_vs_28d`, `z_score_vs_28d`.
- **resting_hr:** bpm, `delta_bpm_vs_28d`.
- **yesterday_load:** exercises (type, minutes, average HR), AZM, steps (reconciled).
- **readiness:** `green | yellow | red` + `reasons[]` (rule in §8, Q1).
- **body:** last weight and its date.

#### `nutrition_day(date?)`
- **totals:** kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sodium_mg (whatever the log provides), each with
  `items_reporting` and `complete` (false = some items lack it, a lower bound); null when no item reports it.
- **per_meal:** grouped by `mealType` (BREAKFAST/LUNCH/DINNER/SNACK, then other types, then `UNSPECIFIED`) with
  items and per-meal totals; at most 60 items listed (`items_omitted`), totals over all.
- **targets:** target in force (I6) and `delta` for kcal and protein; `protein_g_per_kg` (last weight). The kcal
  delta only from a complete total; a partial protein total still gives the delta and per kg, marked
  `protein_g_lower_bound`; no target → null fields + `target_hint` naming `targets_set`.
- **energy_balance:** `intake_kcal − total_calories_kcal` (API `total-calories`), negative = estimated deficit,
  rounded to 50 kcal. Null when it would show a deficit that did not happen, with `unavailable` (in order:
  `intake_partial`, `other_source_food`, `unreadable_food`, `band_not_worn`, `no_total_calories`, `partial_day`,
  `log_likely_incomplete`). The kcal delta is null for the intake reasons too (`kcal_delta_unavailable`).
- **logging_completeness:** `meals_logged` (distinct meal types), flag `likely_incomplete` if kcal < 50% of target
  (of total calories without a target) or no main meal: meals not logged or very low intake; never raised today
  (`partial_day`). A day with no item is `no_data`. The output `notice` carries the guardrails (R3): trend over
  days, no encouragement of very low intake, doctor or registered dietitian referral.

#### `workout_review(date? | exercise_id?)`
- **sessions[]:** type, duration, average/max HR, `heart_rate_zone_durations`, kcal, AZM. **Worker only:** `notes` is the session's own note, or null when the record has none.
- **week_context:** sessions this week vs `weekly_sessions_target`, minutes per type.
- **recovery_context:** that night's HRV and resting HR (if available).
- **quality_flags:** `low_hr_for_activity`, `manual_entry`, `no_hr_data`.
- **Worker only (R2):** each session has `entry_id`, the id `exercise_log_delete` accepts for a session
  this server logged, else null. A logged session has `manual_entry` and `no_hr_data`, and
  `overlaps_band_session` when it covers time of a session of the band. The result's `quality_flags` has
  `overlaps_band_session` when any session that `week_context` counts carries it, also on a day other than the
  reviewed one: the week counts each record, so the same workout may be in it twice.

#### `weekly_report(week_end?)`
Week Mon–Sun (Q4, ISO), counted up to today (`through`; `partial_day` in the current week). For each metric:
`this_week`, `prev_week`, `avg_28d` (the 28 days before the week), `trend` (`up/down/flat` past a minimum change per
metric: weight 0.2 kg, body fat 0.5 pt, resting HR 1 bpm, HRV 3 ms, steps 1000, AZM 5 min, asleep 15 min,
efficiency 2 pt, onset sd 10 min; for a weekly mean the change must also pass SD·√(1/n + 1/prev_n), SD the
day-to-day spread of the 28 days before), each with `n_days`, `prev_week_n_days`, `avg_28d_n_days`. `trend` is
`unknown` with `trend_unavailable`: `insufficient_days` when a week has fewer than 4 days with a value,
`insufficient_baseline` when a weekly mean's 28 days hold fewer than 7. Resting HR keeps the standard method only;
nights still being processed and today's activity are left out. `coverage.n_days` counts the calendar days of the
week so far; each metric has its own day counts.
- **body:** weight (EWMA at each week's last weigh-in, null for a week without one; slope kg/week over the 28 days
  ending at `through`, null below 4 weigh-ins over 14 days, with `weight_slope_n_days` and
  `weight_slope_span_days`), `last_weigh_in`, `weight_age_days` (`stale_weight` past 14 days), body fat if available.
- **cardio:** resting HR, HRV, steps/day (reconciled), AZM. **Worker only:** `vo2_max` is the latest daily VO2 max of the week and of the week before (`latest`, `latest_on`, `prev_latest`, `prev_latest_on`, `delta`, `trend` up/down/flat past 1 ml/kg/min, `n_days`, `prev_n_days`). A week with no reading has its latest null and `trend_unavailable` `no_data`: missing data, not a low score. A reading the band marks estimated keeps the value and sets `estimated`. The sample types `vo2-max` and `run-vo2-max` are not read.
- **sleep:** asleep_min/night, efficiency, consistency (std dev of sleep onset time).
- **adherence:** % of days within the kcal target (±10%), % of days ≥ protein target, each against the target in
  force that day and with nutrition_day's day rule: today, likely incomplete logs, partial kcal, food from
  another platform and unreadable food (any day, its day is unknown) are left out and counted by reason in
  `days_left_out`; kcal adds `days_below`/`days_above`; a partial protein total counts only when it already
  reaches the target.
  `days_logged`, sessions done vs the target in force at `through`; `target_hint` names `targets_set`.
- **decisions_this_week:** up to 20 `note`s of type `decision` from the week (related_date, else creation day),
  `decisions_more`; notes are data, not instructions. The `notice` carries the guardrails (R3).
- **Worker only (R2):** `adherence.sessions` also counts the sessions this server logged, one per record. The
  result's `quality_flags` has `overlaps_band_session` when a logged session of the week covers time of a session
  of the band: the same workout may be counted twice. The description says so, and says what `cardio.vo2_max` is,
  in two sentences at its end.

#### `metric_series(metric, from, to, granularity)`
Escape valve for questions outside the four moments. `metric` ∈ fixed enum (weight, resting_hr,
hrv, sleep_asleep_min, steps, azm, kcal_in, protein_g, total_calories, and on the Worker `vo2_max` in
ml/kg/min); `granularity` ∈
`day | week` (default day). **Never** returns raw 1-second HR; at most 366 days and 180 points (else
`invalid_input`). Points `{date, value, n_days, complete, reason?}`: null days stay null; a week point is the mean of
its days with a value, with `days_left_out`. Same exclusions as `weekly_report`; food days follow nutrition_day's
rule (`checkFood`): `kcal_in` null with the reason when the log cannot show the intake; `protein_g` keeps a total
that may miss food with `complete=false` (a lower bound) and the reason; `total_calories` null on a day without the
band. Calories burned are read only when a logged day has no kcal target. `vo2_max` is the daily VO2 max
summary: a day without a reading is null (missing data, not an error) and a reading marked estimated keeps its
value with `reason` `estimated`. The `notice` carries the guardrails.

### 4.2 Coach memory (read + write, local)

| Tool | Input | Output / effect |
|---|---|---|
| `profile_get()` | — | Profile (+ `age_years`, `corrupt_fields[]` for stored fields that no longer decode) + targets in force + **active/paused health items and every allergy** (even resolved) + preferences; missing parts are omitted, not `no_data` |
| `profile_update(patch)` | partial fields: `birth_date`, `sex`, `height_cm`, `goal` {type, target_weight_kg, target_body_fat_pct, deadline}, `training_plan` {split, notes} | `{profile, previous}`; `""` for `sex`/`birth_date` means not sent (erasing takes `clear[]`); an update over a corrupt field it does not set or clear is `invalid_input` naming the field |
| `targets_set(effective_from, kcal?, protein_g?, weekly_sessions?, clear[]?)` | new version (I6); **sole source** of the weekly sessions target; omitted fields are carried forward from the version in force (the same date's row when correcting it), `clear[]` drops them | Version created; previous ones preserved |
| `health_item_upsert(kind, name, status, details?, started_on?, ended_on?, clear[]?)` | `kind` ∈ condition, medication, supplement, injury, allergy, restriction; `name` trimmed, case-insensitive | Item created/updated; on update omitted details/dates are kept (`clear[]` erases them), so a status change never wipes history |
| `health_items_list(kind?, status?)` | filters | List |
| `labs_record(collected_on, source, lab?, results[])` | `source` ∈ pdf, chat, file (default `chat`); `results[]` = {analyte, value, unit, ref_low?, ref_high?} | Batch stored; same (`collected_on`, `analyte`) **replaces** the value, listed in `replaced[]` with the previous value, unit, status and `report_flag`; per value `status` ∈ in_range, low, high, **flagged** (the report marked it although the recorded range does not put it outside: the mark wins), **no_reference** (no range ≠ normal); `urgent` per value when the mark says critical (crítico/critical, pânico/panic, alerta/alert, HH/LL/AA), and top-level `urgent` only when that analyte has no newer stored value (a backfilled old report is history); `needs_review[]` (R3: every low/high/flagged value with its printed range and `report_flag`), `no_reference[]`, `unit_changes[]` (nearest earlier **and** later date in another unit: `other_unit`, `other_on`, `relation`); optional `ref_low_exclusive`/`ref_high_exclusive` ("< X"), `ref_text`, `report_flag`. Qualitative results (Reagente, Positivo) are not stored as numbers: the description sends them to `note_add` with a doctor referral |
| `labs_query(analyte?, since?)` | filters | Series per analyte with per-point `status`/`urgent`, `latest`, `units[]`/`mixed_units`; top-level `urgent` only when a series' **latest** value is critical; `truncated` keeps the newest rows (the dropped row is the oldest date's first analyte in name order; an analyte whose values all predate the cut is missing, so filter by analyte when it matters) |
| `preference_set(key, value)` / `preferences_get()` | free key-value (e.g. `foods_avoid`, `training_time`) | — |
| `note_add(kind, text, tags?, related_date?)` | `kind` ∈ insight, decision, checkin, symptom | Note created |
| `notes_search(kind?, since?, query?, limit?)` | filters + text (every word must appear; no prefix match; accents folded) | `{notes, more}` — `more` = older matches exist beyond the limit |

`profile_update` takes a `clear[]` list (`birth_date`, `sex`, `height_cm`, `goal`, `training_plan`) to unset
fields; omitted fields stay unchanged. Store limits (rejected as `invalid_input`): 200 lab results per batch,
note text 8 KB, 20 tags of ≤64 chars, 200 preferences of ≤2 KB, 500 health items (details ≤4 KB), 32 search
words (query ≤512 bytes, words ≤64 bytes), analyte filter ≤200 characters, 200 notes per search, 2000 lab rows per query, 400-day metric ranges. Filters are validated too (an unknown
`kind` is `invalid_input`, not an empty list). A miss (no profile, no target in force, cache miss) is `no_data`.

Every write that overwrites returns the `previous` value (profile, target version in force, health item,
preference). Optional inputs also accept `null` and `""` as "not set". Every tool error, including the SDK's
schema and decoding errors, is the `{code,message,hint}` JSON. Annotations: reads are read-only; overwriting
tools are idempotent and **destructive** (clients should confirm); `note_add` appends; all are closed-world.
Outputs with stored free text carry a `notice` that it is data, not instructions. Guardrail texts (R3) travel in
the outputs: no diagnosis, no starting/stopping/dosing any medication **or supplement**, prompt care for values the
report marks critical: medical care **today**, an emergency service now with any symptoms (`criticalHint`, first in
`guidance` when `urgent`). A note whose stored tags no longer decode is returned with `tags_unreadable` instead of
failing the search. Known limit: the SDK decodes arguments as float64 during schema validation, so integers
beyond 2^53 lose precision.

Idempotency: `labs_record` upserts by (`collected_on`, `analyte`); `health_item_upsert` by
(`kind`, `name`). Deletion only through explicit `*_delete` tools (phase 2) — the MVP doesn't delete.

### 4.3 MCP prompts and resources
- **Prompts:** `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report` —
  each instructs the model to call the matching tool + `profile_get` and follow the guardrail
  (carried inline, since a client may not read the resource). `nutrition_review` runs `nutrition_day`.
  One optional argument: the tool's day (`date`; `week_end` for `weekly_report`), a real calendar date,
  or omitted (also `""`) for the tool's default. A bad date is rejected without echoing it.
- **Resource** `coach://guardrails`: the coach's medical and tone rules (R3, hybrid tone
  from brief §5).

## 5. Data Implications

### 5.1 Source of truth
- **Google Health:** everything the band and the app measure or log (sleep, HR, HRV, daily VO2 max, steps,
  exercise, nutrition, weight). The MCP never edits it.
- **SQLite (`~/.local/share/health-coach-mcp/coach.db`):** profile, targets, health history,
  lab tests, preferences, notes, and the aggregate cache.

### 5.2 Schema (v1)

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE profile (
  id          INTEGER PRIMARY KEY CHECK (id = 1),          -- singleton (R1)
  birth_date  TEXT, sex TEXT, height_cm REAL,
  goal_json   TEXT,          -- {type, target_weight_kg, target_body_fat_pct, deadline}
  plan_json   TEXT,          -- {split, notes}; weekly target lives only in `targets`
  updated_at  TEXT NOT NULL
);

CREATE TABLE targets (
  effective_from  TEXT PRIMARY KEY,                          -- YYYY-MM-DD (I6)
  kcal            INTEGER, protein_g INTEGER, weekly_sessions INTEGER,
  created_at      TEXT NOT NULL
);

CREATE TABLE health_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('condition','medication','supplement','injury','allergy','restriction')),
  name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','resolved','paused')),
  details TEXT, started_on TEXT, ended_on TEXT, updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE lab_results (
  id INTEGER PRIMARY KEY,
  collected_on TEXT NOT NULL, lab TEXT,
  analyte TEXT NOT NULL,     -- normalized name: ldl, hdl, hba1c, glucose_fasting, tsh…
  value REAL NOT NULL, unit TEXT NOT NULL, ref_low REAL, ref_high REAL,
  source TEXT NOT NULL CHECK (source IN ('pdf','chat','file')),
  created_at TEXT NOT NULL,
  UNIQUE (collected_on, analyte)
);

CREATE TABLE preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('insight','decision','checkin','symptom')),
  text TEXT NOT NULL,
  tags TEXT,                 -- JSON array of strings
  related_date TEXT, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='id');
-- external-content FTS5 is only populated via triggers
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;

CREATE TABLE daily_metrics (                                 -- cache (5.3)
  date TEXT NOT NULL, metric TEXT NOT NULL,                  -- metric from the closed list in 5.3
  value REAL NOT NULL, n_samples INTEGER, source TEXT,
  algo_version INTEGER NOT NULL,                             -- bump when the derivation changes
  zone TEXT,                                                 -- IANA zone it was computed in (migration 0003)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, metric)
);
```

### 5.3 Cache
- Only **settled days** (≥ 3 days ago) are cached in `daily_metrics`. The last 3 days are always
  fetched live, because the band syncs late and nutrition is logged after the fact.
- **Never cache** a missing value (`null`), a partial value or a day that may still change — it gets fetched again
  next time. A settled night with no HRV samples at all is cached without an HRV row (absent, not partial).
- A row with `algo_version` different from the code's is ignored and recomputed, and so is a row computed in
  another time zone (or with none): the sleep start minute and the day a night belongs to depend on it.
- Closed list of keys (scalars per day): `sleep_asleep_min`, `sleep_awake_min`, `sleep_in_bed_min`,
  `sleep_deep_min`, `sleep_light_min`, `sleep_rem_min`, `sleep_start_min_of_day`, `sleep_end_min_of_day`, `hrv_rmssd_ms`,
  `resting_hr_bpm`, `steps`, `azm_min`, `total_calories_kcal`, `weight_kg`, `body_fat_pct`.
  Exercises and nutrition (lists of items) aren't cached in the MVP.
- "Closed day" for **baselines** ≠ "settled day" for the **cache**: a baseline uses every day before the
  analyzed day (live or cached); the cache only decides where the value comes from.
- The cache is disposable: deleting `daily_metrics` doesn't lose anything (source of truth = API).

### 5.4 Retention and deletion
- The shipped server keeps coach memory, the daily cache, the Google refresh token and the ids of entries it created in the `CoachStore` Durable Object. OAuth clients, grants and hashed MCP tokens are in KV. The Google refresh token is not in KV.
- The original plan was a local database, then an encrypted cloud disk. The MVP doesn't delete memory; deletion comes with explicit tools.

## 6. Security and Policy

- **OAuth:** a Web application client. The server requests `openid`, `email`, four read-only `googlehealth.*` scopes (`activity_and_fitness`, `health_metrics_and_measurements`, `sleep`, `nutrition`) and two write scopes. Profile, settings, location, ECG and irregular-rhythm scopes are not requested (2026-10-26; they were in the first sign-in). Each write scope is used only by its two tools: `googlehealth.nutrition.writeonly` for `nutrition_log_add` and `nutrition_log_delete`, and `googlehealth.activity_and_fitness.writeonly` for `exercise_log_add` and `exercise_log_delete`. An account that signed in before a write scope was requested gets it at the next sign-in. The Google refresh token lives in the `CoachStore` Durable Object, never in KV, logs or tool output.
- **Refresh token in Testing mode expires in ~7 days** → detect `invalid_grant`, return
  `auth_expired` with instructions; evaluate publishing the app as "In production" unverified (Q5).
- **HTTP:** `/mcp` requires the MCP access token from the OAuth flow (R6). TLS is the Worker's.
- **Abuse paths:** prompt injection via food name / notes → the MCP returns data as data and
  never executes instructions from stored content; the guardrail resource tells the LLM so.
- **Health data:** no values in logs (R4); errors don't echo payloads.

## 7. Non-Goals

- Writing to Google Health beyond nutrition-log entries and exercise sessions. The server writes only through `nutrition_log_add`, `nutrition_log_delete`, `exercise_log_add` and `exercise_log_delete`, and a delete removes only an entry this server created (one `entry_id`, or every entry it created on a `date`). Logging weight, or any type other than a nutrition-log entry or an exercise session, stays outside this server. So does changing a logged session (delete it and add it again), and logging heart rate, distance or pauses with a session.
- Multiple users, signup, billing.
- Own UI/dashboard; WhatsApp channel and cron (phase 2, they consume the same tools).
- Raw sensor series (1s HR, PPG, accelerometer) — not exposed.
- PDF parsing in the MCP — the LLM extracts, `labs_record` validates and stores.
- Diagnosis, prescription, medication dosing.

## 8. Decisions and Open Questions

### Decided (2026-10-13)
| # | Decision |
|---|---|
| Q1 | **Readiness:** `red` if HRV z < −1.5 **or** resting HR ≥ +5 bpm vs 28d **or** `asleep_min` < 360; `yellow` if HRV z < −0.5 **or** resting HR ≥ +3 **or** `asleep_min` < 420; otherwise `green`. A missing signal **doesn't count** (neither red nor green): it's left out and listed in `reasons` as `missing:<signal>`; with no signal at all → `level: unknown`. z-score only with ≥ 7 nights of baseline. `confidence: low` until 7 nights. Thresholds live in a single constant so they can be tuned. |
| Q2 | **Google sign-in is the MCP OAuth flow.** The refresh token is stored in the `CoachStore` Durable Object. The original decision was a Desktop-app token in `~/.config/health-coach-mcp/` with a CLI login; that path was removed with the Go server. |
| Q3 | **Targets set by the user** (or a nutritionist) via `targets_set`. The coach can suggest, but only saves after explicit confirmation in chat. |
| Q4 | **Week Monday–Sunday** (ISO). |

### Open (non-blocking, with defaults)
| # | Question | Default | Affects |
|---|---|---|---|
| Q5 | Publish the OAuth app as "In production" unverified to avoid the 7-day expiry? | Yes, after the first week of use | Stable operation |
| Q6 | Daily SpO2 came back empty | Recheck in 3–5 nights; if it stays empty, drop it from the MVP. **2026-10-26: still empty** (no daily point in 30 days, no sample in 7): dropped from the MVP | none (optional) |
| Q7 | Primary source per metric when there's overlap (Fitbit Air vs Apple Health) | daily rollup (merged) for steps/AZM/calories; Fitbit Air for HR/HRV/sleep/exercise/nutrition; every platform for weight and body fat (a scale may sync through the phone) | aggregates |

## 9. Handoff

**Status: shipped as the Cloudflare Worker in `workers/`.** Q1–Q4 decided; Q5–Q7 have defaults that don't block.

The original implementation order named Go packages. The code that runs is `workers/src/`: store and memory tools, the Google Health client, metrics, the coach-moment tools, the four write tools, the prompts and `coach://guardrails`.
