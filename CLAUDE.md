# health-coach-mcp

Single-user remote MCP server. A TypeScript Cloudflare Worker exposes Google Health data (Fitbit / Pixel Watch) plus a coach memory (profile, history, labs) to any MCP client, and can log meals and completed workouts back to Google Health. Product context: `docs/PRODUCT-BRIEF.md`. Contract: `docs/CAPABILITY.md`. The detailed technical doc is `workers/README.md`.

The server is deployed on Cloudflare Workers (Free plan) and in use.

## Commands

From `workers/`:

- Install: `npm ci`
- Typecheck: `npm run typecheck` (`wrangler types` and `tsc`)
- Test: `npm test` (`vitest run`, in workerd)
- Local: `npm run dev` (port 8788; MCP at `http://localhost:8788/mcp`)
- Deploy: `npm run deploy`

## Layout

Everything that runs is under `workers/`.

- `src/index.ts` — Worker entry. `workers-oauth-provider` on the request origin; the allowlist check; forwards `/mcp` to the Durable Object without the MCP access token.
- `src/auth.ts` — consent page, redirect to Google, `/callback` (ID token, allowlist, refresh token into `CoachStore`).
- `src/mcp.ts` — `createServer`: `server_info`, `google_account_status`, then memory, coach, food-log and exercise-log tools, the guardrails resource and the prompts.
- `src/store.ts` — `CoachStore` Durable Object, SQLite migrations, `createMcpHandler` (one budget and one Google token answer per MCP HTTP request).
- `src/config.ts` — `HCM_TZ` (IANA zone, default `America/Sao_Paulo`; `Local` and unknown names rejected).
- `src/coach/` — `LocalDate` (validated on decode; DST-safe bounds; sleep belongs to the day it ends), the envelope, tool error codes.
- `src/store/` — profile, versioned targets, health items, labs, preferences, notes (FTS5), the `daily_metrics` cache, and the food and exercise entries this server created.
- `src/google.ts` — Google OAuth URLs, the scopes, the allowlist.
- `src/googlehealth/` — API v4 client. Reads, plus exactly four writes (`writeTarget` in `client.ts`): create and delete of `nutrition-log`, create and delete of `exercise`. Request budget in `budget.ts`.
- `src/healthdata/` — records to daily values through the cache.
- `src/metrics/` — pure math (baselines, deltas, readiness, quality flags). No I/O.
- `src/tools/` — `register` is the only way to add a tool. `memory.ts` (11 tools), `moments.ts` (the five coach tools), `foodlog.ts`, `exerciselog.ts`.
- `src/prompts/` — prompts `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report`, and the `coach://guardrails` text.
- `test/fixtures/go-tools-list.json` and `test/fixtures/go-prompts.json` — frozen snapshot of the former Go server, and the source of truth for the parity tests. Do not regenerate them.

`plans/` is the original plan and is left as history.

## Rules

- **The MCP computes, the LLM interprets.** Tools return aggregates (7d/28d averages, deltas, adherence) with `n_days` and coverage, not raw 1-second series.
- **Google Health access.** The server reads Google Health and writes only two data types: nutrition-log entries (`nutrition_log_add`, `nutrition_log_delete`) and exercise sessions (`exercise_log_add`, `exercise_log_delete`). A delete removes only an entry this server created. `nutrition_day` exposes `entry_id` on an item this server logged for the linked account, and `workout_review` on a session it logged; the field is null on any other item or session. A logged session stays a record of its own next to the band's (`overlaps_band_session`, never merged).
- **Single user.** Only `ALLOWED_GOOGLE_EMAIL` may finish sign-in or call `/mcp`. The check runs again on every MCP request and on MCP token refresh.
- **No health data or secrets in git, logs or tool errors.** OAuth client JSON, tokens, databases and exports stay out (see `.gitignore`). Tests use synthetic fixtures only. A tool log line is the name, duration and outcome. Internal errors log the tool name and the error's type names, never the message.
- **Tokens.** The Google refresh token lives only in `CoachStore` SQLite. It is not in KV, logs, errors or tool output. KV (`OAUTH_KV`) holds OAuth clients, grants and hashed MCP tokens.
- **Register tools with `register` (`src/tools/register.ts`).** A `ToolError` reaches the client as JSON `{code,message,hint}` text (never `structuredContent`). Any other error becomes `internal_error`. `ToolError` messages must not contain health values.
- **Schema changes are new entries in the migrations list in `src/store.ts`**, never edits to an applied one. Notes search quotes every word as an FTS5 phrase; user text is never FTS syntax.
- **No boolean JSON schemas in tool properties.** `{}` serializes as `true`, which zod-based clients reject; "any JSON" is `s.anyJSON()`. A test walks every tool schema.
- **Dates in tool inputs are local dates** (`src/coach/date.ts`). Parsing a bad date is an error, never a throw from the date helpers that the tools call.
- **Enums** in tool inputs come from `inputSchema`; a description on a field is description only.
- **Medical guardrail.** Tool descriptions and outputs must not diagnose or suggest starting, stopping or dosing any medication or supplement; flag out-of-range values (a value without a range is `no_reference`, never "normal") and point to a doctor. The lab's own mark wins over the computed range. The texts live in `src/tools/memory.ts` (`MEDICAL_HINT`, `CRITICAL_HINT`, `UNIT_HINT`, `NO_ADVICE`, `DATA_NOTICE`) and travel in the outputs. Every output that returns stored free text carries `notice: DATA_NOTICE`.
- **Annotations.** A tool that can replace or erase stored data is `destructiveHint: true`. Memory and coach tools are `openWorldHint: false`. The four Google Health write tools are `openWorldHint: true`.
- Code reused from `ghealth` (Google-Health-API/google-health-cli, Apache-2.0) keeps its license header and is listed in `NOTICE`.
- Coach tools share one Google request budget per MCP HTTP request (`src/googlehealth/budget.ts`). Do not send a request that would pass it.

## Stack

Cloudflare Workers · TypeScript · `@modelcontextprotocol/server` · `agents` (`createMcpHandler`) · `@cloudflare/workers-oauth-provider` · Durable Object SQLite · KV · `zod`.
