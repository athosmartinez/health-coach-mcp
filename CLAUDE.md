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
- `cmd/health-coach-mcp/` — entry point; picks the transport (`-transport=stdio|http`).
- `internal/config/` — env config: `HCM_TZ` (IANA zone, default America/Sao_Paulo, `Local` rejected,
  tzdata embedded), `HCM_DATA_DIR`, `HCM_CONFIG_DIR` (absolute after `~` expansion), `HCM_HTTP_TOKEN`
  (≥32 chars, required to bind HTTP beyond loopback).
- `internal/coach/` — shared domain: `LocalDate` (validated on decode; DST-safe `Bounds`; sleep → day it
  ends), `Envelope[T]` + `Coverage`/`ConfidenceLevel`, `ToolError` codes, `WireError`, `ErrorResult`.
- `internal/server/` — `Deps` + `New(Deps) (*mcp.Server, error)` (one `registerX` line per feature),
  tool-call logging middleware (name/duration/outcome only), HTTP bind guard, bearer auth, `NewHTTPServer`.
- `internal/tools/` — tool implementations; `Register` (the only way to add a tool; infers input and
  output schemas with the domain schemas) and `MustInputSchema` (enums, date pattern). `memory.go`:
  the 11 coach memory tools (CAPABILITY §4.2), registered by `server.New` when `Deps.Store` is set.
- `internal/store/` — SQLite (`<DataDir>/coach.db`, dir 0700, file 0600, WAL): embedded migrations
  (`migrations/NNNN_name.sql`, recorded in `schema_migrations`), coach memory (profile, versioned
  targets, health items, labs upsert by date+analyte, preferences, notes with FTS5) and the
  `daily_metrics` cache (closed key list, `algo_version` mismatch = miss).
- `internal/version/` — version injected via `-ldflags`.
- Planned (see `plans/health-coach-mcp-mvp.md`): `internal/googlehealth/`, `internal/metrics/`,
  `internal/healthdata/`.

## Rules
- **The MCP computes, the LLM interprets.** Tools return aggregates (7d/28d averages, deltas,
  adherence) with `n_days`/coverage, not raw 1-second series. Raw data only on demand, paginated.
- **Read-only on Google Health.** Writes go only to the local store.
- **stdout is the JSON-RPC channel in stdio mode.** Log only via `slog` to stderr; never `fmt.Print`.
- **No health data or secrets in git.** OAuth client JSON, tokens, `*.db` and exports stay out
  (see `.gitignore`). Tests use synthetic fixtures only.
- **HTTP beyond loopback requires `HCM_HTTP_TOKEN`** (bearer auth, ≥32 chars); startup fails otherwise.
  Without `-tls-cert/-tls-key` it is plain HTTP: use a TLS proxy or private tunnel (Tailscale) on a LAN.
- **Register tools with `tools.Register`, never `mcp.AddTool`.** Handlers return `(Out, error)`; a
  `coach.ToolError` reaches the client as JSON `{code,message,hint}` text (never `StructuredContent`),
  any other error or panic becomes `internal_error`. `ToolError` messages must not contain health values.
- **Schema changes are new migration files**, never edits to an applied one. Notes search quotes
  every word as an FTS5 phrase; user text is never FTS syntax.
- **No boolean JSON schemas in tool properties.** `{}` serializes as `true`, which zod-based clients
  (the MCP Inspector) reject; "any JSON" is `tools.anyJSON()`. A test walks every tool schema.
- **Dates in tool inputs are `coach.LocalDate`**; `Bounds`/`AddDays` return errors, never panic.
- **Enums** in tool inputs come from `tools.MustInputSchema`; the `jsonschema` tag is description only.
- **Medical guardrail.** Tool descriptions and outputs must not diagnose or suggest starting,
  stopping or dosing any medication or supplement; flag out-of-range values (a value without a range is
  `no_reference`, never "normal") and point to a doctor. The texts live in `tools/memory.go`
  (`medicalHint`, `noAdvice`, `dataNotice`) and travel in the outputs; tests pin their wording.
- **Annotations:** a tool that can replace or erase stored data is `DestructiveHint: true`; every tool
  is `OpenWorldHint: false` (local store only).
- Code reused from `ghealth` (Google-Health-API/google-health-cli, Apache-2.0) is copied with
  its license header and noted in `NOTICE`; its module path (`ghealth`) is not importable.
- Every tool gets an in-memory transport test (`mcp.NewInMemoryTransports`).

## Stack
Go 1.27 · `github.com/modelcontextprotocol/go-sdk` · `modernc.org/sqlite` (pure Go, keeps
cross-compiling cgo-free) · planned: `golang.org/x/oauth2`.
