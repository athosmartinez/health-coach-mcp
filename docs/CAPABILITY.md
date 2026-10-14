# Capability Contract — Health Coach MCP

> Status: approved · 2026-10-13 · source: `docs/PRODUCT-BRIEF.md` + real reads from the
> Google Health API (Fitbit Air) · next lane: `tdd-workflow`

## 1. Capability

- **Name:** health-coach-mcp
- **Primary actor:** Athos (single user), through any MCP client (Claude Code, Claude Desktop,
  claude.ai, other LLMs, cron agents, chat bridges).
- **Outcome after ship:** any agent answers "how did I recover?", "did I hit my diet?",
  "how was my workout?" and "how was my week?" using **computed, comparable metrics** from my
  Google Health data plus my coach memory (profile, goals, history, lab tests, notes) —
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
| R2 | **Read-only on Google Health.** No write calls to the API in the MVP. |
| R3 | **The MCP doesn't diagnose or prescribe medication.** Out-of-range values come back flagged with `refer_to_doctor: true`; tool descriptions state the limit. |
| R4 | **No health data in logs, git or test fixtures.** Logs record only tool, duration and status. Fixtures are synthetic. |
| R5 | **stdout is reserved for JSON-RPC** in stdio mode. |
| R6 | **HTTP without auth binds to loopback only.** Any non-loopback bind requires a bearer token (phase 2). |

### Invariants (data)
| # | Invariant | Origin |
|---|---|---|
| I1 | Every aggregate metric returns `n_days` (coverage) and `confidence` (`low` < 7 days, `medium` 7–20, `high` ≥ 21 for 28d baselines). | 1 week of history today |
| I2 | **Steps, distance and calories are never summed across sources.** Use the API's `reconcile` (merges overlaps) or filter on the primary source (`Google Fitbit Air`). | Real data: steps arrive from Fitbit Air **and** `com.apple.health.*` |
| I3 | A missing day is `null`, never `0`. | ghealth behavior (presence-aware types) |
| I4 | The "day" is the **local day** in the configured time zone (default `America/Sao_Paulo`); sleep belongs to the day it **ends**. | Timestamps arrive `-03:00`; sleep runs 23:00→09:24 |
| I5 | Units: kg, kcal, g, bpm, ms, min. Conversion happens in the MCP, not in the LLM. | `weightGrams`, `rootMeanSquareOfSuccessiveDifferencesMilliseconds` |
| I6 | Targets (kcal, protein, weekly workouts) are **versioned** with `effective_from`; adherence uses the target in force on that day. | Targets will change during recomposition |
| I7 | Suspicious data comes back with `quality_flags`, it isn't hidden or "fixed". E.g. average HR of 81 bpm in 60 min of jiu-jitsu → `low_hr_for_activity`. | Real data: Jiu-jitsu 60 min, avg HR 81 |

### Architecture preferences (changeable)
- Go + official MCP SDK; SQLite via `modernc.org/sqlite`; Google Health client adapted from `ghealth`.
- Fetch live from the API + **cache of closed daily aggregates** in SQLite (see §5.3).

## 3. Actors and Surfaces

| Actor | Surface | Usage |
|---|---|---|
| Athos via chat | MCP **tools** | Questions on demand, profile/lab/note logging |
| Athos via chat | MCP **prompts** | `/morning_briefing`, `/weekly_report` as ready-made shortcuts in any client |
| Cron agent (phase 2) | Tools over HTTP | Proactive daily briefing and weekly report |
| Chat bridge (phase 2) | Tools over HTTP | WhatsApp/Telegram |
| Google Health API | Source | Read-only, OAuth 2.0 user |
| Local SQLite | Store | Coach memory + cache |

## 4. Interface Contract — Tools

Conventions for **every** tool:
- Dates `YYYY-MM-DD` in the local time zone; omitted = today (or the last closed week).
- Output is always structured (`StructuredContent`), with an envelope:
  ```json
  { "data": {…}, "coverage": {"n_days": 6, "confidence": "low"},
    "sources": ["Google Fitbit Air"], "quality_flags": [], "generated_at": "…" }
  ```
- Errors are tool errors (`IsError`) with a stable `code`: `auth_expired`, `scope_missing`,
  `upstream_unavailable`, `no_data`, `invalid_input`. `auth_expired` includes the re-login command.
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
- **totals:** kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sodium_mg (whatever the log provides).
- **per_meal:** grouped by `mealType` (BREAKFAST/LUNCH/DINNER/SNACK) with items.
- **targets:** target in force (I6) and `delta` for kcal and protein; `protein_g_per_kg` (last weight).
- **energy_balance:** `intake_kcal − total_calories_kcal` (API `total-calories`), estimated deficit.
- **logging_completeness:** `meals_logged`, flag `likely_incomplete` if kcal < 50% of target or no main meal.

#### `workout_review(date? | exercise_id?)`
- **sessions[]:** type, duration, average/max HR, `heart_rate_zone_durations`, kcal, AZM.
- **week_context:** sessions this week vs `weekly_sessions_target`, minutes per type.
- **recovery_context:** that night's HRV and resting HR (if available).
- **quality_flags:** `low_hr_for_activity`, `manual_entry`, `no_hr_data`.

#### `weekly_report(week_end?)`
Week Mon–Sun (Q4, ISO). For each metric: `this_week`, `prev_week`, `avg_28d`, `trend`
(`up/down/flat` with a minimum threshold per metric).
- **body:** weight (EWMA of the week and slope kg/week), body fat if available.
- **cardio:** resting HR, HRV, steps/day (reconciled), AZM.
- **sleep:** asleep_min/night, efficiency, consistency (std dev of sleep onset time).
- **adherence:** % of days within the kcal target (±10%), % of days ≥ protein target, sessions done vs target.
- **decisions_this_week:** `note`s of type `decision` from the week (success metric).

#### `metric_series(metric, from, to, granularity)`
Escape valve for questions outside the four moments. `metric` ∈ fixed enum (weight, resting_hr,
hrv, sleep_asleep_min, steps, azm, kcal_in, protein_g, total_calories); `granularity` ∈
`day | week`. **Never** returns raw 1-second HR; maximum 180 points.

### 4.2 Coach memory (read + write, local)

| Tool | Input | Output / effect |
|---|---|---|
| `profile_get()` | — | Profile + targets in force + preferences |
| `profile_update(patch)` | partial fields: `birth_date`, `sex`, `height_cm`, `goal` {type, target_weight_kg, target_body_fat_pct, deadline}, `training_plan` {split, weekly_sessions_target} | Updated profile |
| `targets_set(effective_from, kcal?, protein_g?, weekly_sessions?)` | new version (I6) | Version created; previous ones preserved |
| `health_item_upsert(kind, name, status, details?, started_on?, ended_on?)` | `kind` ∈ condition, medication, supplement, injury, allergy, restriction | Item created/updated |
| `health_items_list(kind?, status?)` | filters | List |
| `labs_record(collected_on, lab?, results[])` | `results[]` = {analyte, value, unit, ref_low?, ref_high?} | Batch stored; `out_of_range[]` flagged (R3) |
| `labs_query(analyte?, since?)` | filters | Series per analyte with the reference |
| `preference_set(key, value)` / `preferences_get()` | free key-value (e.g. `foods_avoid`, `training_time`) | — |
| `note_add(kind, text, tags?, related_date?)` | `kind` ∈ insight, decision, checkin, symptom | Note created |
| `notes_search(kind?, since?, query?)` | filters + text | List |

Idempotency: `labs_record` deduplicates by (`collected_on`, `analyte`); `health_item_upsert` by
(`kind`, `name`). Deletion only through explicit `*_delete` tools (phase 2) — the MVP doesn't delete.

### 4.3 MCP prompts and resources
- **Prompts:** `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report` —
  each instructs the model to call the matching tool + `profile_get` and follow the guardrail.
- **Resource** `coach://guardrails`: the coach's medical and tone rules (R3, hybrid tone
  from brief §5).

## 5. Data Implications

### 5.1 Source of truth
- **Google Health:** everything the band and the app measure or log (sleep, HR, HRV, steps,
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
  plan_json   TEXT,          -- {split, weekly_sessions_target}
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
  text TEXT NOT NULL, tags TEXT, related_date TEXT, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='id');

CREATE TABLE daily_metrics (                                 -- cache (5.3)
  date TEXT NOT NULL, metric TEXT NOT NULL,
  value REAL, n_samples INTEGER, source TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, metric)
);
```

### 5.3 Cache
- Only **closed days** (≥ 3 days ago) are cached in `daily_metrics`. The last 3 days are always
  fetched live, because the band syncs late and nutrition is logged after the fact.
- The cache is disposable: deleting `daily_metrics` doesn't lose anything (source of truth = API).

### 5.4 Retention and deletion
- Data lives on your machine (phase 1). In phase 2 (cloud): disk encryption + backup encrypted with
  your own key. The MVP doesn't delete memory; deletion comes with explicit tools (phase 2).

## 6. Security and Policy

- **OAuth:** own client in project `health-coach-mcp-511601`, 9 read-only `googlehealth.*`
  scopes. Token in `~/.config/health-coach-mcp/` (0600), own login (Q2).
- **Refresh token in Testing mode expires in ~7 days** → detect `invalid_grant`, return
  `auth_expired` with instructions; evaluate publishing the app as "In production" unverified (Q5).
- **HTTP (phase 2):** bearer token from an env var, TLS terminated in front, never public without auth (R6).
- **Abuse paths:** prompt injection via food name / notes → the MCP returns data as data and
  never executes instructions from stored content; the guardrail resource tells the LLM so.
- **Health data:** no values in logs (R4); errors don't echo payloads.

## 7. Non-Goals

- Writing to Google Health (log meals/weight via chat) — outside the MVP (brief §6).
- Multiple users, signup, billing.
- Own UI/dashboard; WhatsApp channel and cron (phase 2, they consume the same tools).
- Raw sensor series (1s HR, PPG, accelerometer) — not exposed.
- PDF parsing in the MCP — the LLM extracts, `labs_record` validates and stores.
- Diagnosis, prescription, medication dosing.

## 8. Decisions and Open Questions

### Decided (2026-10-13)
| # | Decision |
|---|---|
| Q1 | **Readiness:** `red` if HRV z < −1.5 **or** resting HR ≥ +5 bpm vs 28d **or** sleep < 6h; `yellow` if HRV z < −0.5 **or** resting HR ≥ +3 **or** sleep < 7h; otherwise `green`. `confidence: low` until 7 nights. Thresholds live in a single constant so they can be tuned. |
| Q2 | **Token in its own directory** `~/.config/health-coach-mcp/` (0600), with its own login `health-coach-mcp auth login`. Independent from ghealth. |
| Q3 | **Targets set by Athos** (or a nutritionist) via `targets_set`. The coach can suggest, but only saves after explicit confirmation in chat. |
| Q4 | **Week Monday–Sunday** (ISO). |

### Open (non-blocking, with defaults)
| # | Question | Default | Affects |
|---|---|---|---|
| Q5 | Publish the OAuth app as "In production" unverified to avoid the 7-day expiry? | Yes, after the first week of use | Stable operation |
| Q6 | Daily SpO2 came back empty | Recheck in 3–5 nights; if it stays empty, drop it from the MVP | none (optional) |
| Q7 | Primary source per metric when there's overlap (Fitbit Air vs Apple Health) | `reconcile` for steps/distance/calories; Fitbit Air for HR/HRV/sleep | aggregates |

## 9. Handoff

**Status: ready for direct implementation.** Q1–Q4 decided; Q5–Q7 have defaults that don't block.

Suggested order (each step in `tdd-workflow`, with in-memory tool tests and synthetic fixtures):
1. `internal/store` — migrations + memory tools (`profile_*`, `targets_set`, `health_item_*`,
   `labs_*`, `preference_*`, `note_*`). Doesn't depend on the API → immediate value.
2. `internal/googlehealth` — client + OAuth (adapted from `ghealth`, Apache-2.0 with NOTICE),
   error mapping to stable `code`s.
3. `internal/metrics` — baselines, deltas, z-score, EWMA, reconciliation, quality flags; pure
   unit tests on fixtures.
4. Coach-moment tools, in order: `morning_briefing` → `nutrition_day` → `workout_review` →
   `weekly_report` → `metric_series`.
5. MCP prompts + `coach://guardrails` resource.
6. `verification-loop`: wire into Claude Code/Desktop and use it for real for 1 week.
