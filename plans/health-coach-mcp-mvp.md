# Blueprint — health-coach-mcp MVP

> Objective: implement `docs/CAPABILITY.md` (approved 2026-10-13) as a Go MCP server, in PR-sized steps.
> Mode: **git + gh** (repo `athosmartinez/health-coach-mcp`, private, default branch `main`).
> Plan status: active · steps: 13 · max parallelism: 3 (after Step 1) · adversarial review: done (2026-10-13)

## How to execute a step (applies to every step)

1. `git switch main && git pull --ff-only && git switch -c <branch-of-the-step>` — **always from `main`**.
2. TDD: write the failing test → implement → green → refactor (`tdd-workflow`).
3. Gate: `make lint test build` green.
4. `git push -u origin <branch>` and `gh pr create --base main --head <branch>`; confirm with
   `gh pr view --json headRefName,baseRefName`.
5. Squash merge after review; tick the step in the Progress table below.

**No attribution lines** in commits or PRs (`Claude-Session`, `Co-Authored-By`, etc.).

### Invariants checked after EVERY step
- `make lint test build` passes; `go test -race ./...` with no data race.
- No real health data in code, fixtures, logs or commits (synthetic fixtures only — CAPABILITY R4).
- Nothing written to stdout outside the MCP SDK (R5); logs via `slog` to stderr.
- No write calls to the Google Health API (R2).
- Every new tool has an in-memory transport test (`mcp.NewInMemoryTransports`).
- `CLAUDE.md` "Layout" updated when a package is created.

### Fixed contracts (defined in Step 1 — do not change in later steps without updating this plan)
- **Wiring:** `server.New(deps server.Deps) (*mcp.Server, error)` with
  `Deps{Cfg config.Config; Now func() time.Time; Logger *slog.Logger}` (Step 1). `New` fails when
  `Cfg.TimeZone` is nil (no silent default) and is where later steps validate their dependencies. Each step that creates a
  package adds its field (`Store *store.Store` in 2/3, `Health healthdata.Source` in 6a/7). Each feature registers through its own `registerX(s, deps)` in
  `internal/tools/<feature>.go` and adds **one line** to `New`. Tools whose dependency is `nil` aren't registered.
- **Tool registration:** always `tools.Register[In, Out](s, tool, func(ctx, req, In) (Out, error))`, never
  `mcp.AddTool` directly. It turns any error into the JSON error contract (non-`ToolError` → `internal_error`,
  text hidden), skips output-schema validation on errors (a zero `Envelope` would fail it) and recovers panics.
- **Dates:** `coach.LocalDate` validates itself on JSON decode (`UnmarshalText`; `""` = omitted) and the
  inferred schema carries `coach.DatePattern`. `Bounds(loc) (start, end, error)` and `AddDays(n) (LocalDate, error)`
  return errors instead of panicking; `Bounds` handles DST days (23h/25h) and skipped midnights.
- **`main` wiring (single place, `cmd/health-coach-mcp/main.go`):** `config.Load` → `store.Open` (from Step 2)
  → `googlehealth.New` (client from Step 4b, wired in Step 6a) → `healthdata.New` (from Step 6a) → `server.New`. Subcommands
  (`auth login|status`) are dispatched **before** parsing the server flags (Step 4a).
- **Tool schemas:** built with `jsonschema.For[In]()` from `github.com/google/jsonschema-go` and patched
  with `Enum`s/`Format`s through helpers in `internal/tools/schema.go` (the `jsonschema` tag is a **description
  only**, it doesn't create an enum). Pass it as `Tool.InputSchema`. An invalid argument is rejected by the SDK
  before the handler — tests assert the SDK error, not `invalid_input`.
- **Errors:** handlers return `coach.ToolError{Code, Message, Hint}` (value or pointer); `tools.Register` sends it as
  `CallToolResult{IsError: true, Content: [TextContent(JSON)]}`, **no** `StructuredContent` (it would break `outputSchema`).
  `coach.ErrorResult` is only for low-level handlers. Enums on `[]string` go on `items`; on `*string`, `null` stays allowed.
- **HTTP (R6):** `server.CheckHTTPBind` returns `(exposed, err)`; beyond loopback `HCM_HTTP_TOKEN` must be ≥32 chars;
  `main` warns when exposed without `-tls-cert/-tls-key`. `server.NewHTTPServer` sets timeouts (no `WriteTimeout`, SSE)
  and a 30-min session timeout; bearer scheme is case-insensitive, failures logged with remote addr only.

### Expected conflicts
Parallel steps touch shared files: `go.mod`/`go.sum` and `CLAUDE.md` (2, 4a, 5), `main.go` (3, 4a), `server.go`
(7, 8). Expected rebase — resolve by keeping both changes.

## Dependency graph

```
             ┌──► 2 store ──► 3 memory tools ─────────────────────────────┐
             │       │                                                    │
1 foundation ┼──► 4a auth ──► 4b API client ──┐                           │
             │       │                        ├──► 6a data: sleep/HRV/RHR + cache ──► 6b data: activity/nutrition/body
             └──► 5 metrics (pure) ───────────┘      (also needs 2)                       │
                                                                                          ├──► 7 briefing + workout ──┐
                                                                                          └──► 8 nutrition_day ───────┼──► 9 weekly + series ──► 10 prompts/guardrails ──► 11 verification
                                                                                     (3 for targets, in 7/8) ─────────┘
```
- **Parallel after 1:** {2, 4a, 5}. After 4a: 4b (in parallel with 2/3/5). After 6b: {7, 8}.

## Progress

| Step | Branch | Depends on | Tier | Status |
|---|---|---|---|---|
| 1 Foundation: config, Deps, envelope, errors, middleware | `feat/foundation` | — | strongest | ☑ #1 |
| 2 SQLite store + migrations | `feat/store` | 1 | default | ☑ #2 |
| 3 Coach memory tools | `feat/memory-tools` | 1, 2 | default | ☑ #3 |
| 4a OAuth: login, token, refresh | `feat/googlehealth-auth` | 1 | default | ☑ #4 |
| 4b API client: requests, pagination, retry, errors | `feat/googlehealth-client` | 4a | default | ☑ #6 |
| 5 Metrics engine (pure) | `feat/metrics` | 1 | strongest | ☑ #5 |
| 6a Data: sleep, HRV, resting HR + cache | `feat/data-recovery` | 2, 4b, 5 | strongest | ☑ #7 |
| 6b Data: steps, AZM, exercise, nutrition, calories, weight, body fat | `feat/data-activity` | 6a | strongest | ☐ |
| 7 `morning_briefing` + `workout_review` | `feat/briefing-workout-tools` | 3, 6b | default | ☐ |
| 8 `nutrition_day` | `feat/nutrition-tool` | 3, 6b | default | ☐ |
| 9 `weekly_report` + `metric_series` | `feat/weekly-series-tools` | 7, 8 | default | ☐ |
| 10 MCP prompts + `coach://guardrails` | `feat/prompts-guardrails` | 9 | default | ☐ |
| 11 Verification + real use (1 week) | `chore/verification` | 10 | default | ☐ |

---

## Step 1 — Foundation: config, Deps, envelope, errors, middleware
**Branch:** `feat/foundation` · **Tier:** strongest (freezes the contracts every step depends on)

**Context brief.** The repo has a Go MCP server skeleton (`cmd/health-coach-mcp/main.go` with
`-transport=stdio|http` and `-addr`, `internal/server/server.go` with a `server_info` tool, SDK
`github.com/modelcontextprotocol/go-sdk` v1.8.0). `docs/CAPABILITY.md` §4 requires a standard envelope,
stable error codes and partial-day handling; §2 fixes TZ and units; R4 (logs without health data) and R6
(HTTP without auth only on loopback). This step implements the "Fixed contracts" above.

**Tasks.**
- `internal/config`: `Config{TimeZone *time.Location (default America/Sao_Paulo), DataDir (default ~/.local/share/health-coach-mcp), ConfigDir (default ~/.config/health-coach-mcp), HTTPToken string}` via env `HCM_TZ`, `HCM_DATA_DIR`, `HCM_CONFIG_DIR`, `HCM_HTTP_TOKEN`; expand `~` with `os.UserHomeDir`; validate TZ.
- `internal/coach`:
  - `Envelope[T]{Data T; Coverage{NDays int; Confidence string}; Sources []string; QualityFlags []string; GeneratedAt time.Time}`.
  - `Confidence(nDays)` → `low` (<7) / `medium` (7–20) / `high` (≥21) — I1.
  - `ToolError{Code, Message, Hint}` + `ErrorResult(err) *mcp.CallToolResult` (JSON in `TextContent`, no `StructuredContent`); codes `auth_expired`, `scope_missing`, `upstream_unavailable`, `no_data`, `invalid_input`.
  - `LocalDate` (`YYYY-MM-DD`): parse/validate, `Bounds(tz)`, `Today(now, tz)`; `SleepDay(end time.Time, tz)` = local day of `end` (I4).
- `internal/server`: `Deps` + `New(Deps)` as in "Fixed contracts"; `Now` injectable (default `time.Now`).
- **R4 middleware:** wrap tool calls (`AddReceivingMiddleware` or a wrapper on the handler) logging only `tool`, `duration_ms`, `is_error`, `code` — never arguments or results.
- **R6:** in `main`, `-transport=http` with a non-loopback `-addr` and no `HCM_HTTP_TOKEN` → error at startup.
- `internal/tools/schema.go`: helper `inputSchema[In](enums map[string][]string)` over `jsonschema.For[In]()`.

**Verification.** Table tests: `Confidence` (6/7/20/21), `LocalDate` (invalid, 29-02), `SleepDay` (23:00→09:24 BRT lands on the end day), `ErrorResult` checked **via the in-memory client** (`IsError=true`, text parses as JSON with `code`), middleware doesn't log arguments (captured `slog` handler), `-addr 0.0.0.0:8787` without a token fails.

**Exit criteria.** `server_info` passes with `New(Deps{Cfg: {TimeZone}})`; godoc on the contracts; CLAUDE.md Layout updated.
PR review (Go/security/test reviewers) fixes applied in the same PR: see "Fixed contracts".
**Rollback.** Revert the PR.

---

## Step 2 — SQLite store + migrations
**Branch:** `feat/store` · **Tier:** default · **Depends on:** 1

**Context brief.** CAPABILITY §5.2 defines schema v1 (with FTS5 triggers, `daily_metrics.algo_version`,
`lab_results.source`, `notes.tags` as a JSON array). Driver `modernc.org/sqlite` (pure Go). File
`<DataDir>/coach.db`. Single-user (R1). Labs: upsert by (`collected_on`, `analyte`). Weekly sessions
target lives **only** in `targets`.

**Tasks.**
- `internal/store.Open(path)`: DSN with per-connection pragmas —
  `file:<path>?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)`;
  `os.MkdirAll(dir, 0700)` (protects the `-wal`/`-shm` files too); migrations in `embed.FS`
  (`migrations/0001_init.sql`, §5.2 except `schema_migrations`, which the migrator creates first) recorded in `schema_migrations`.
- Repository: `Profile{Get, Upsert}`, `Targets{Set, InForce(date), List}`, `HealthItems{Upsert, List}`,
  `Labs{Record(batch, source) upsert, Query}`, `Preferences{Set, All}`, `Notes{Add(tags []string), Search}`,
  `DailyMetrics{Get(date, metric, algoVersion), Put, Range}`.
- `Notes.Search`: each user term is quoted as an FTS5 phrase (`"term"`, inner `"` escaped); FTS error → `invalid_input`.

**Verification.** In `t.TempDir()`: migration idempotent; invalid CHECK rejected; `InForce` across a boundary;
lab upsert replaces the value; FTS finds a note **inserted after** the migration (proves the trigger) and
`Search("a-b \"c\" AND")` doesn't error; `DailyMetrics.Get` with a different `algo_version` → miss;
`CGO_ENABLED=0 go build ./...`.

**Exit criteria.** `go test -cover ./internal/store` ≥ 85%; every table and trigger in §5.2 covered.
**Rollback.** Revert; delete `coach.db` (disposable at this stage).

---

## Step 3 — Coach memory tools
**Branch:** `feat/memory-tools` · **Depends on:** 1, 2

**Context brief.** CAPABILITY §4.2: 11 tools over the store. Q3: targets set by Athos — the
`targets_set` `Description` says it should only be called after explicit confirmation from the user.
`labs_record` takes `source` (default `chat`) and upserts. Schemas via `internal/tools/schema.go` (enums
for `kind`, `status`, `source`). Wire `store.Open` into `main` and `Deps.Store`.

**Tasks.** `internal/tools/memory.go` with `registerMemory(s, deps)`: `profile_get` (profile + target in force
+ preferences), `profile_update`, `targets_set`, `health_item_upsert`, `health_items_list`, `labs_record`
(returns `out_of_range[]` with `refer_to_doctor: true` — R3), `labs_query`, `preference_set`, `preferences_get`,
`note_add`, `notes_search`.

**Verification.** In-memory transport: `tools/list` contains exactly the 11 names + `server_info`, each with
`inputSchema` containing the enums; profile round-trip; versioned target and `profile_get` returns the one in
force on `Now()`; lab outside the reference flagged; invalid enum → SDK error (assert `err`/protocol error);
`notes_search` finds a note.

**Exit criteria.** All of the above green; smoke test with `npx @modelcontextprotocol/inspector bin/health-coach-mcp` calling `profile_update` + `profile_get`.
**Rollback.** Revert; tables stay (compatible).

---

## Step 4a — OAuth: login, token, refresh
**Branch:** `feat/googlehealth-auth` · **Depends on:** 1

**Context brief.** Project `health-coach-mcp-511601`, OAuth **Desktop app** client, 9 read-only scopes
(`https://www.googleapis.com/auth/googlehealth.{activity_and_fitness,health_metrics_and_measurements,sleep,nutrition,profile,settings,location,ecg,irn}.readonly`).
Q2: `<ConfigDir>/client_secret.json` and `<ConfigDir>/credentials.json` (0600), independent from ghealth.
Reference to **adapt** (not importable, module `ghealth`): `~/Documents/github/google-health-cli/pkg/auth/auth.go`
(Apache-2.0 → keep the header in the adapted files and create `NOTICE`). The app is in "Testing": the refresh
token expires in ~7 days.

**Tasks.**
- `internal/googlehealth/auth`: loopback flow on `127.0.0.1:<ephemeral>` (not `localhost`), PKCE, random
  `state`, `access_type=offline` + `prompt=consent` (guarantees a refresh token on re-login).
- Persisting `TokenSource`: saves every refreshed token; **never** overwrites the refresh token with an
  empty one (keeps the previous one if the response doesn't bring one).
- `invalid_grant` (comes as `*oauth2.RetrieveError` from the token endpoint) → `ToolError{auth_expired, Hint: "health-coach-mcp auth login"}`.
- Re-read `credentials.json` if the mtime changed (a running server picks up a new login without restarting).
- `main`: dispatch `auth login | auth status` before the server flags; `status` shows scopes and expiry, never the token.

**Verification.** Tests: fake token endpoint returning `invalid_grant` → `auth_expired`; refresh without a new
refresh_token keeps the old one; file written with 0600; mtime reload. Manual: `auth login` with your account
+ `auth status`.

**Exit criteria.** No real token in fixtures; `NOTICE` created.
**Rollback.** Revert; delete `<ConfigDir>/credentials.json`.

---

## Step 4b — API client: requests, pagination, retry, errors
**Branch:** `feat/googlehealth-client` · **Depends on:** 4a

**Context brief.** Google Health API v4, read-only. Reference for paths, data-type IDs and request formats:
`~/Documents/github/google-health-cli/pkg/client/client.go` and `pkg/types/registry.go` (40 types; e.g.
`sleep`, `heart-rate-variability`, `daily-resting-heart-rate`, `steps`, `active-zone-minutes`, `exercise`,
`nutrition-log`, `total-calories`, `weight`, `body-fat`; operations `list`, `daily-rollup`, `reconcile`).
To see a real request without executing it: `ghealth data <type> list --dry-run`.

**Tasks.** `internal/googlehealth`: `Client` with `List(type, from, to)`, `DailyRollup(type, from, to)`,
`Reconcile(type, from, to)` — automatic pagination (`pageToken`), retry with backoff+jitter on 429/5xx
(max 3), on **API 401** forces one token refresh and retries once; mapping 403 → `scope_missing`,
5xx/timeout → `upstream_unavailable`. No write method (R2).

**Verification.** `httptest.Server` with **synthetic** JSON in the format of `--dry-run`/docs: 3 pages,
429→200, 401→refresh→200, 401 twice → `auth_expired`, 403 → `scope_missing`.

**Exit criteria.** Coverage ≥ 80% on the package. Read-only (R2) is enforced in code: the one request builder
(`do`) allows only `GET …/dataPoints`, `GET …/dataPoints:reconcile` and `POST …/dataPoints:dailyRollUp` (the API
defines dailyRollUp as a POST that reads), and a test asserts every other method/path is refused before sending.
(The original grep criterion could not hold: dailyRollUp itself is a POST.)
**`main` wiring** moves to Step 6a: nothing consumes the client before `healthdata.New`, and building the token
source needs `client_secret.json`, whose absence must not stop the memory tools from starting.
**Rollback.** Revert.

---

## Step 5 — Metrics engine (pure)
**Branch:** `feat/metrics` · **Tier:** strongest · **Depends on:** 1

**Context brief.** Pure package, no I/O and no TZ (receives already localized dates). Input
`[]Point{Date LocalDate; Value *float64}`, `nil` = missing day (I3). Q1 (CAPABILITY §8): `red` if HRV z <
−1.5 OR resting HR ≥ +5 bpm vs 28d OR `asleep_min` < 360; `yellow` if z < −0.5 OR resting HR ≥ +3 OR `asleep_min`
< 420; otherwise `green`; **a missing signal doesn't count** (`missing:<signal>` in `reasons`); with no signal →
`unknown`; z only with ≥ 7 nights of baseline.

**Tasks.**
- `Baseline(series, before LocalDate, days)` → `{mean, sd, n}` ignoring `nil`; `ZScore` → `nil` if n < 7 or sd = 0;
  `Delta`; `EWMA(alpha = 0.25)` (≈ 7-day window); `Slope` (least squares, kg/week); `Trend(this, prev, minThreshold)`;
  `Adherence(values, target, tolerance)` ignoring days flagged partial.
- `AssessReadiness(th, hrvZ, rhrDelta Signal{Value, Nights}, asleepMin *float64)` → `{level, reasons[], confidence}`; thresholds in one place (`DefaultThresholds()`); a signal with a baseline under 7 nights counts as missing.
- `QualityFlags`: `low_hr_for_activity` (vigorous types — JIU_JITSU, RUNNING, STRENGTH_TRAINING, HIIT… — with average HR < 100 bpm over ≥ 30 min), `no_hr_data`, `manual_entry`, `partial_day`, `likely_incomplete_nutrition`.
- `SleepOnsetConsistency(startMinutesOfDay []int)` → sd in minutes with midnight wraparound.

**Verification.** Table tests: gaps, n = 6 → z `nil`, sd = 0, exact boundaries (−1.5, +5, 360), HRV missing +
good sleep → not `green` with full confidence, everything `nil` → `unknown`, wraparound 23:50/00:10 → sd ≈ 10 min,
EWMA against values computed by hand.

**Exit criteria.** `go test -cover ./internal/metrics` ≥ 90%.
**Rollback.** Revert.

---

## Step 6a — Data: sleep, HRV, resting HR + cache
**Branch:** `feat/data-recovery` · **Tier:** strongest · **Depends on:** 2, 4b, 5

**Context brief.** Bridge API (4b) → metrics (5) with the cache (2). Real shapes observed on 2026-10-13
(reproduce them as **synthetic** fixtures):
- `sleep`: `{start, end, minutesAsleep, minutesAwake, minutesToFallAsleep, sleepType:"STAGES", stageMinutes{…}, stages[…], totalMinutes, source:"Google Fitbit Air"}`.
- `heart-rate-variability`: samples `{time, rootMeanSquareOfSuccessiveDifferencesMilliseconds, metadata{highFrequencyPower, lowFrequencyPower}}`.
- `daily-resting-heart-rate`: `{date, beatsPerMinute:"57" (string), dailyRestingHeartRateMetadata{calculationMethod}}`.
Cache rules in CAPABILITY §5.3 (settled ≥ 3 days, never `null`/partial, `algo_version`, closed list of keys).

**Tasks — first, the client fixes from the PR #6 review** (in `internal/googlehealth`, before building on it):
a 2xx page is valid only with keys ⊆ {list key, `nextPageToken`} (`null`/unknown key/error object → bad response, log key
names only); strip `*url.Error` to its cause (no URL in error text); refuse redirects; `http` base URL only on
loopback, no userinfo/query/fragment; page cap → `invalid_input` with a "shorter range" hint; overflowing
Retry-After fails fast; no retry on DNS not-found/x509 (log the cause type); 403 `RESOURCE_EXHAUSTED` retried like
429; cap on total bytes across pages; `Invalidate` reports whether it acted (log "renewing" only then). Tests: no
body leak on every error path, rollup pages within each chunk and exact chunk boundaries, per-type table values,
a renewal does not use a retry, Retry-After 8s vs 9s and on 503, 408 and dropped-connection recovery, cancel
in flight, one test with the real `auth.TokenSource`.

**Tasks.** `internal/healthdata`: `Source` interface (consumed by the tools) + implementation over the client;
`SleepNight(date)` = **longest** session ending on the local day `date` (naps ignored);
`HRVNightly(range)` = median rMSSD of the samples **inside the window of that night's main session**
(not by calendar date); `RestingHR(range)` (parse the string bpm); cache read/write per §5.3, rows keyed by
`metrics.AlgoVersion` (one constant for the whole cache); `Now` from `Deps`. *(Built as one call,
`Source.Recovery(from, to)`, returning nights with their HRV and resting HR plus `Series(key)`: one live fetch fills
both sleep and HRV, since the HRV median needs the night's window. Fitbit records only — Apple Health copies of sleep
and resting HR exist in the real data.)* Wire `googlehealth.New` + `auth.NewTokenSource` in `main` so a missing
`client_secret.json` or sign-in does not stop startup (health tools then answer `auth_expired`; memory tools keep
working). The client filters by the local day of each record: HRV samples of a night that starts the evening before
need `List(HeartRateVariability, date−1, date)`, then the session window narrows them. *(PR #7 review: main-sleep
records ≤ 3 h apart are one night split by a wake-up, overlapping copies keep the longer; HRV needs ≥ 12 samples
covering ≥ 50% of the night's 5-min slots and ≥ 25% of each half; stages only when `SUCCEEDED`, minute bounds with 2 min
of rounding slack (checked against the real records); resting HR carries its method and only a lone `WITH_SLEEP` value
is cached; `BaselineSeries` drops provisional nights and non-standard resting HR; rows carry their zone; an unreadable
record taints only its day; `Excluded`/`Empty` report what was left out.)*

**Verification.** Fake API: sleep 23:10→07:40 counted on the end day; a 20-min nap the same day ignored;
HRV sample at 23:30 belongs to the night that ends the next day; D-5 cache hit, D-1 always live; `nil` value
not cached; changing `algoVersion` forces a refetch; deleting the table → identical results.

**Exit criteria.** No direct API call outside `internal/googlehealth`; coverage ≥ 85%.
**Rollback.** Revert; `DELETE FROM daily_metrics`.

---

## Step 6b — Data: steps, AZM, exercise, nutrition, calories, weight, body fat
**Branch:** `feat/data-activity` · **Tier:** strongest · **Depends on:** 6a

**Context brief.** Real shapes (2026-10-13, reproduce as synthetic): `steps` arrives from `Google Fitbit Air`
**and** `com.apple.health.<UUID>` → use `Reconcile` (I2), never a raw sum; `exercise`
`{displayName, exerciseType:"JIU_JITSU", activeDuration:"3600s", start, end, metricsSummary{averageHeartRateBeatsPerMinute (string), caloriesKcal, heartRateZoneDurations}}`;
`nutrition-log` per item `{foodDisplayName, mealType, energy{kcal}, nutrients[{nutrient, quantity{grams}}], totalCarbohydrate, totalFat, serving, start, end}`;
`weight` `{time, weightGrams}` → kg (I5). Check with `--dry-run` and with docs which day boundary
`daily-rollup`/`reconcile` use; if it's UTC, request by local bounds (`Bounds(tz)`).

**Tasks.** `Steps(range)` (reconcile), `AZM(range)`, `TotalCalories(range)` (+ `partial_day` for today),
`Exercises(range)` (with average HR, **max HR** via `heart-rate` in the window if the summary doesn't have it,
zones, `manual_entry` if there's no HR), `Nutrition(date)` (items + totals; totals with partial coverage
flagged — e.g. protein present in only some items), `Weight(range)`, `BodyFat(range)`.
Check the low-HR list (`metrics.IsVigorous`) against the `exerciseType` values the API really returns (only
`JIU_JITSU` is confirmed), and `metrics.IsMainMeal` against the real `mealType` values.

**Verification.** Fake API: steps from 2 sources not doubled; exercise without HR → `manual_entry`;
average HR 81 in 60 min of JIU_JITSU → `low_hr_for_activity`; today with `partial_day`; nutrition with protein
in 1 of 3 items → partial total.

**Exit criteria.** Every method of the `Source` interface covered; coverage ≥ 85%.
**Rollback.** Revert.

---

## Step 7 — `morning_briefing` + `workout_review`
**Branch:** `feat/briefing-workout-tools` · **Depends on:** 3, 6b

**Context brief.** Contracts in CAPABILITY §4.1, over `healthdata.Source` + `metrics` + store (weekly target
in `Targets.InForce`). Output in `coach.Envelope`.

**Tasks.** `internal/tools/briefing.go`, `workout.go` (`registerBriefing`, `registerWorkout`).

**Verification.** In-memory transport with a fake `Source`: `morning_briefing` returns **exactly** the fields
`sleep{asleep_min, awake_min, efficiency_pct, stages_min, start, end, vs_7d, vs_28d}`, `hrv{median_ms, delta_pct_vs_28d, z_score_vs_28d}`,
`resting_hr{bpm, delta_bpm_vs_28d}`, `yesterday_load`, `readiness{level, reasons, confidence}`, `body{weight_kg, date}`;
green/yellow/red/unknown cases; `confidence: low` with 5 nights; day with no sleep → `no_data`; `auth_expired` propagated
as `IsError`. `workout_review`: zones, week context vs target, `low_hr_for_activity` flag.

**Exit criteria.** Real manual call: valid envelope, readiness ≠ `unknown` after ≥ 7 nights, no value in the logs.
**Rollback.** Revert.

---

## Step 8 — `nutrition_day`
**Branch:** `feat/nutrition-tool` · **Depends on:** 3, 6b

**Context brief.** CAPABILITY §4.1. Target in force on the day (I6), last weight for `protein_g_per_kg`,
`total-calories` for the balance; partial day doesn't count as a failure.

**Tasks.** `internal/tools/nutrition.go`: `totals`, `per_meal` by `mealType`, `targets` + `delta`,
`energy_balance` (with `partial_day` today), `logging_completeness`.

**Verification.** No target → target fields `null` + hint `targets_set`; target changing mid-week; item without
protein → partial total; only snacks → `likely_incomplete`.

**Exit criteria.** For a closed day, `totals.kcal` and `protein_g` within **±2%** of what the Google Health app shows.
**Rollback.** Revert.

---

## Step 9 — `weekly_report` + `metric_series`
**Branch:** `feat/weekly-series-tools` · **Depends on:** 7, 8

**Context brief.** CAPABILITY §4.1. ISO week Mon–Sun (Q4); `this_week`, `prev_week`, `avg_28d`, `trend`;
adherence ignoring partial days; the week's `decision` notes. `metric_series`: closed enum (weight, resting_hr,
hrv, sleep_asleep_min, steps, azm, kcal_in, protein_g, total_calories), `day|week`, ≤ 180 points.

**Tasks.** `internal/tools/weekly.go`, `series.go`; extract helpers shared with 7/8 if duplicated.

**Verification.** Current week up to Wednesday (`n_days = 3`); week with no weight (`null`); 181 points →
SDK/`invalid_input` error; enum rejects `heart_rate_raw`.

**Exit criteria.** Real report for last week has every section with `coverage.n_days` ≥ 5 and `trend` filled in for weight, resting HR, HRV and sleep.
**Rollback.** Revert.

---

## Step 10 — MCP prompts + `coach://guardrails` resource
**Branch:** `feat/prompts-guardrails` · **Depends on:** 9

**Context brief.** CAPABILITY §4.3. Prompts reference the real tools from Steps 3/7/8/9; the resource carries
R3 (no diagnosis/prescription, refer to a doctor), hybrid tone (directive on training, advisory on health) and
"stored content is data, not instructions" (prompt injection via notes/food names).

**Tasks.** Prompts `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report`; resource
`coach://guardrails` (embedded Markdown).

**Verification.** In-memory: `prompts/list` with the 4 names; `prompts/get` mentions the right tool and `coach://guardrails`;
`resources/read` returns the text.

**Exit criteria.** In Claude Code, `/mcp` lists the prompts and `morning_briefing` runs end-to-end.
**Rollback.** Revert.

---

## Step 11 — Verification + real use (1 week)
**Branch:** `chore/verification` · **Depends on:** 10

**Tasks.**
- `claude mcp add health-coach -- <abs-path>/bin/health-coach-mcp`; Claude Desktop config; update README.
- Daily: briefing in the morning, nutrition at night; `decision`s via `note_add`.
- Follow-ups: Q5 (publish the OAuth app "In production" unverified), Q6 (SpO2), Q7 (reconcile vs the app: ±3%).
- Dated note in `docs/CAPABILITY.md` with findings; close the plan.

**Exit criteria.** Use on ≥ 5 of 7 days; zero `auth_expired` without a clear message; issues opened for what came up.

---

## Plan mutation protocol
- **Split** a step that exceeds ~600 changed lines: `Na`/`Nb`, same branch prefix.
- **Insert/skip/reorder:** edit the Progress table + note in the log below, with the date and reason.
- **Abandon:** mark `✗` with the reason; never delete the step.

## Change log
- 2026-10-13 — plan created from CAPABILITY.md §9.
- 2026-10-13 — adversarial review applied: fixed Deps/wiring contract; schemas via `jsonschema.For` + enums;
  errors as text without `StructuredContent`; FTS5 triggers and quoted search; labs `source` + upsert;
  cache never `null`/partial + `algo_version` + closed list of keys; AZM/body fat/max HR/`manual_entry`;
  Step 4 → 4a/4b and 6 → 6a/6b; OAuth `offline`+`consent`, refresh token preserved, 127.0.0.1; HRV by
  sleep window; missing readiness signals don't count; R4 middleware and R6 guard in Step 1; per-connection
  pragmas via DSN; objective exit criteria; Step 10 after 9.
