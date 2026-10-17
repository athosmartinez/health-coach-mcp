# health-coach-mcp

Personal, single-user MCP server that exposes Google Health API data (Fitbit Air) plus a
coach memory (profile, history, labs) to any MCP client. Product context: `docs/PRODUCT-BRIEF.md`.

## Commands
- Build: `make build` (binary in `bin/health-coach-mcp`)
- Test: `make test` (`go test -race ./...`)
- Lint: `make lint` (`gofmt -l` + `go vet`)
- Run (stdio): `make run` · Run (HTTP on 127.0.0.1:8787): `make run-http`
- Inspect tools interactively: `npx @modelcontextprotocol/inspector bin/health-coach-mcp`

## Layout
- `cmd/health-coach-mcp/` — entry point; picks the transport (`-transport=stdio|http`) and wires
  `auth.LazyTokenSource` → `googlehealth.New` → `healthdata.New` into `server.Deps.Health` (nothing is read at
  startup: without `client_secret.json` or a sign-in, health calls return `auth_expired`). `DataDir` and `ConfigDir`
  must be absolute.
- `internal/config/` — env config: `HCM_TZ` (IANA zone, default America/Sao_Paulo, `Local` rejected,
  tzdata embedded), `HCM_DATA_DIR`, `HCM_CONFIG_DIR` (absolute after `~` expansion), `HCM_HTTP_TOKEN`
  (≥32 chars, required to bind HTTP beyond loopback).
- `internal/coach/` — shared domain: `LocalDate` (validated on decode; DST-safe `Bounds`; sleep → day it
  ends), `Envelope[T]` + `Coverage`/`ConfidenceLevel`, `ToolError` codes, `WireError`, `ErrorResult`, `ErrorTypes` (an
  error chain's types, every branch of a multi-`%w`/joined error; the only error detail logs carry).
- `internal/server/` — `Deps` + `New(Deps) (*mcp.Server, error)` (one `registerX` line per feature),
  tool-call logging middleware (name/duration/outcome only; it hands the logger to tools via
  `tools.WithLogger`), HTTP bind guard, bearer auth, `NewHTTPServer`.
- `internal/tools/` — tool implementations; `Register` (the only way to add a tool; infers input and
  output schemas with the domain schemas) and `MustInputSchema` (enums, date pattern). `memory.go`:
  the 11 coach memory tools (CAPABILITY §4.2), registered by `server.New` when `Deps.Store` is set.
- `internal/store/` — SQLite (`<DataDir>/coach.db`, dir 0700, file 0600, WAL): embedded migrations
  (`migrations/NNNN_name.sql`, recorded in `schema_migrations`), coach memory (profile, versioned
  targets, health items, labs upsert by date+analyte, preferences, notes with FTS5) and the
  `daily_metrics` cache (closed key list, `algo_version` mismatch = miss; `zone` column; `DeleteMetric`).
- `internal/googlehealth/auth/` — OAuth Desktop sign-in (`Login`: loopback on `127.0.0.1:0`, PKCE,
  `access_type=offline` + `prompt=consent`), `LazyTokenSource` (loads the client on first use, retried until the file exists; a missing, unreadable, non-JSON or
  non-Desktop client file is `auth_expired` with the path in the hint), `credentials.json` I/O (atomic replace, 0600, dir 0700) and
  `TokenSource` (`Invalidate(rejected) bool` forces the next renewal, ignored (false) once that token was replaced; renews and saves, keeps the old refresh token when Google omits it, reloads the file when
  another process signs in and lets that login win over a renewal in flight; `invalid_grant` → `auth_expired`,
  408/429/5xx/timeouts → `upstream_unavailable`). Token endpoint errors are redacted to code + HTTP status
  (`endpointError`): `oauth2.RetrieveError` text quotes the response body. `cmd/health-coach-mcp/auth.go`: the
  `auth login|status` subcommands, dispatched before the server flags.
- `internal/googlehealth/` — read-only API v4 client (`New(TokenSource, Options)`; makes no request and reads no file):
  `List`/`Reconcile`/`DailyRollup(ctx, DataType, from, to coach.LocalDate)` return raw points (`json.RawMessage`) for
  the inclusive local days. A closed `DataType` table (`datatypes.go`) holds each type's filter field (civil start,
  sleep's civil end, physical UTC instant from `LocalDate.Bounds`, or date), page size (25 for sleep/exercise) and
  dailyRollUp range cap (14 days for total-calories, 90 otherwise; longer ranges are split). `do` allows only
  `GET …/dataPoints`, `GET …/dataPoints:reconcile` and `POST …/dataPoints:dailyRollUp` (a read). Retries 429/408/5xx/
  network 3 times (1s/2s/4s, jittered, Retry-After up to 8s, longer fails fast); one token renewal
  (`auth.TokenSource.Invalidate`) on a 401 or the stale-token 403; then 401 → `auth_expired`, 403 → `scope_missing`,
  exhausted → `upstream_unavailable`, other 4xx → internal; a quota 403 (`RESOURCE_EXHAUSTED`) is retried like 429;
  DNS not-found/x509 fail fast. Errors keep HTTP status + Google's status enum (`StatusError`), never the body, and
  network errors drop `url.Error`'s URL. Redirects are refused; `http` base URLs only on loopback. A page without
  the list key is valid only when nothing but `nextPageToken` is in it (`{}` = no points); next to the list a new field
  is logged at Warn and tolerated unless its name looks like paging (token, page, next, cursor, more, contin, offset,
  after, trunc, partial, remain → `upstream_unavailable`); other 4xx rejections log the HTTP status and Google's enum; page cap (200)
  or byte budget (64 MiB) → `invalid_input` "shorter range"; a repeated page token → `upstream_unavailable`. One renewal per page.
- `internal/healthdata/` — Google Health records → daily values through the `daily_metrics` cache. `Source.Recovery(ctx,
  from, to)` returns `Nights` (main sleep ending on each local day: Fitbit only, naps dropped, sleep fetched ±1 day and
  assigned with `coach.SleepDay`; overlapping copies keep the longer, records ≤ 3 h apart are joined as one split night,
  the group with most time in bed wins; stage values only from `STAGES` records with `stagesStatus` `SUCCEEDED` (each
  type known and once, deep+light+REM = asleep ± 2 min), a `STAGES` night without them or an unprocessed record is
  `Provisional`, a processed `CLASSIC` night has nil stages and is not; median rMSSD of the
  samples inside the night, nil below 12 samples or under 50% of its 5-min slots (25% per half), with `HRVCoverage`) and
  `RestingHR` (`{BPM, Method}`; `WITH_SLEEP` wins a duplicate, then the lower), plus `Skipped` unreadable records,
  `Excluded` counts by reason and `Empty` types (records only from another platform or without a value). `Series(key)`
  gives one `metrics.Point` per day; `BaselineSeries(key)` drops provisional nights and non-`WITH_SLEEP` resting HR.
  `Excluded` counts only days fetched live in the call. `KeySleepStart` wraps at midnight (circular metrics only).
  Cache: settled days (≤ today−3) only; a night is cached when settled, with a final HRV or no samples at all (none
  of its samples left out for another platform or a missing value), and
  written commit-row-last (`KeyAsleep` deleted first, written last; stage/HRV rows written or deleted); resting HR only
  as a day's single `WITH_SLEEP` value. An unreadable record keeps its day out of the cache (its whole fetch when the
  day is unknown). Rows carry `metrics.AlgoVersion` and the zone; a mismatch is a miss. Missing days are fetched in
  runs of consecutive days. Source labels and the resting-HR method are stripped of control, format and separator characters and capped at 64
  runes; a label left empty falls back to the platform.
- `internal/metrics/` — pure math, no I/O or time zone (`nil` = missing day, always skipped; NaN/Inf count as
  missing in judgments and are rejected in series): `Baseline` (window `[before−days, before−1]`, sample sd; only
  in-window rows are validated), `ZScore` (nil below 7 nights or with no spread), `Delta`/`DeltaPct`, `EWMA` (over
  logged values; a missing day stays nil), `SlopePerWeek` (x = real day gaps), `Trend`, `AdherenceWithin`/
  `AdherenceAtLeast` (per-day versioned target; partial days and non-positive targets skipped; nil pct with no
  eligible day), `SleepOnsetConsistency` (circular, population sd), `AssessReadiness` (thresholds from
  `DefaultThresholds()`, each baselined signal carries its own night count, reason codes are relative to the
  person's baseline) and quality flags (`ExerciseFlags`, `PartialDay`, `CheckLogging`). `AlgoVersion` keys the
  `daily_metrics` cache: bump it when a stored value's math changes.
- `internal/version/` — version injected via `-ldflags`.

## Rules
- **The MCP computes, the LLM interprets.** Tools return aggregates (7d/28d averages, deltas,
  adherence) with `n_days`/coverage, not raw 1-second series. Raw data only on demand, paginated.
- **Read-only on Google Health.** Writes go only to the local store.
- **stdout is the JSON-RPC channel in stdio mode.** Log only via `slog` to stderr; never `fmt.Print`.
- **No health data or secrets in git.** OAuth client JSON, tokens, `*.db` and exports stay out
  (see `.gitignore`). Tests use synthetic fixtures only.
- **Tokens never leave `credentials.json`:** not in logs, errors, `auth status` or tool output. Decode errors
  for the client or credentials file name the path only (the JSON error could quote a secret).
- **HTTP beyond loopback requires `HCM_HTTP_TOKEN`** (bearer auth, ≥32 chars); startup fails otherwise.
  Without `-tls-cert/-tls-key` it is plain HTTP: use a TLS proxy or private tunnel (Tailscale) on a LAN.
- **Register tools with `tools.Register`, never `mcp.AddTool`.** Handlers return `(Out, error)`; a
  `coach.ToolError` reaches the client as JSON `{code,message,hint}` text (never `StructuredContent`),
  any other error or panic becomes `internal_error`. `ToolError` messages must not contain health values.
  Internal errors are logged with the tool name and the error's type chain, panics with the panic type and
  stack — never an error message or panic value, which may quote health data.
- **Schema changes are new migration files**, never edits to an applied one. Notes search quotes
  every word as an FTS5 phrase; user text is never FTS syntax.
- **No boolean JSON schemas in tool properties.** `{}` serializes as `true`, which zod-based clients
  (the MCP Inspector) reject; "any JSON" is `tools.anyJSON()`. A test walks every tool schema.
- **Dates in tool inputs are `coach.LocalDate`**; `Bounds`/`AddDays` return errors, never panic.
- **Enums** in tool inputs come from `tools.MustInputSchema`; the `jsonschema` tag is description only.
- **Medical guardrail.** Tool descriptions and outputs must not diagnose or suggest starting,
  stopping or dosing any medication or supplement; flag out-of-range values (a value without a range is
  `no_reference`, never "normal") and point to a doctor. The lab's own mark wins over the computed range
  (`store.LabValue.Assess`: `flagged`, and `urgent` for critical marks). The texts live in `tools/memory.go`
  (`medicalHint`, `criticalHint`, `unitHint`, `noAdvice`, `dataNotice`) and travel in the outputs; tests pin
  literal phrases of each. Every output that returns stored free text carries `notice: dataNotice`.
- **Annotations:** a tool that can replace or erase stored data is `DestructiveHint: true`; every tool
  is `OpenWorldHint: false` (local store only).
- Code reused from `ghealth` (Google-Health-API/google-health-cli, Apache-2.0) is copied with
  its license header and noted in `NOTICE`; its module path (`ghealth`) is not importable.
- Every tool gets an in-memory transport test (`mcp.NewInMemoryTransports`).

## Stack
Go 1.27 · `github.com/modelcontextprotocol/go-sdk` · `modernc.org/sqlite` (pure Go, keeps
cross-compiling cgo-free) · `golang.org/x/oauth2` (core only, not `oauth2/google`, which pulls the GCE metadata client).
