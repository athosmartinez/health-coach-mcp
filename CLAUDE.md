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
- `internal/config/` — env config: `HCM_TZ` (default America/Sao_Paulo), `HCM_DATA_DIR`,
  `HCM_CONFIG_DIR`, `HCM_HTTP_TOKEN` (required to bind HTTP beyond loopback).
- `internal/coach/` — shared domain: `LocalDate` (local-day bucketing, sleep → day it ends),
  `Envelope[T]` + `Coverage`, `ToolError` codes and `ErrorResult`.
- `internal/server/` — `Deps` + `New(Deps)` (one `registerX` line per feature), tool-call logging
  middleware (name/duration/outcome only), HTTP bind guard and bearer auth. Transport-agnostic.
- `internal/tools/` — tool implementations; `MustInputSchema` patches enums onto inferred schemas.
- `internal/version/` — version injected via `-ldflags`.
- Planned (see `plans/health-coach-mcp-mvp.md`): `internal/store/`, `internal/googlehealth/`,
  `internal/metrics/`, `internal/healthdata/`.

## Rules
- **The MCP computes, the LLM interprets.** Tools return aggregates (7d/28d averages, deltas,
  adherence) with `n_days`/coverage, not raw 1-second series. Raw data only on demand, paginated.
- **Read-only on Google Health.** Writes go only to the local store.
- **stdout is the JSON-RPC channel in stdio mode.** Log only via `slog` to stderr; never `fmt.Print`.
- **No health data or secrets in git.** OAuth client JSON, tokens, `*.db` and exports stay out
  (see `.gitignore`). Tests use synthetic fixtures only.
- **HTTP beyond loopback requires `HCM_HTTP_TOKEN`** (bearer auth); startup fails otherwise.
- **Tool errors** go through `coach.ErrorResult`: JSON `{code,message,hint}` as text, never
  `StructuredContent`. Messages must not contain health values.
- **Enums** in tool inputs come from `tools.MustInputSchema`; the `jsonschema` tag is description only.
- **Medical guardrail.** Tool descriptions and outputs must not diagnose or prescribe medication;
  flag out-of-range values and point to a doctor.
- Code reused from `ghealth` (Google-Health-API/google-health-cli, Apache-2.0) is copied with
  its license header and noted in `NOTICE`; its module path (`ghealth`) is not importable.
- Every tool gets an in-memory transport test (`mcp.NewInMemoryTransports`).

## Stack
Go 1.27 · `github.com/modelcontextprotocol/go-sdk` · planned: `golang.org/x/oauth2`,
`modernc.org/sqlite` (pure Go, keeps cross-compiling cgo-free).
