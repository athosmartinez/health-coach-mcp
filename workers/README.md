# health-coach-mcp (Cloudflare Workers)

Remote MCP server for the health coach. The Go server at the repo root stays the contract. This Worker serves Streamable HTTP at `/mcp`, protected by OAuth 2.1, so Claude and ChatGPT can add it as a custom connector. It is single-user: only one Google account (`ALLOWED_GOOGLE_EMAIL`) can sign in. A public home page at `/` and a privacy policy at `/privacy` are served without sign-in, for the Google OAuth consent screen.

## Tools

- `server_info`: the server name, version and transport.
- `google_account_status`: the linked account, its granted and missing Google Health scopes, and whether its access still works; never a token.
- The 11 coach memory tools of the Go server (`docs/CAPABILITY.md` §4.2), with the same names, descriptions, annotations, schemas, validation rules, limits and error codes:
  `profile_get`, `profile_update`, `targets_set`, `health_item_upsert`, `health_items_list`, `labs_record`, `labs_query`, `preference_set`, `preferences_get`, `note_add`, `notes_search`.

The coach-moment tools (`morning_briefing`, `nutrition_day`, `workout_review`, `weekly_report`, `metric_series`) and the MCP prompts are not served yet.

### How a tool call runs

1. The Worker isolate does only OAuth and the allowlist check (`src/index.ts`). It has 10 ms of CPU per request on the Free plan. An unauthenticated request gets `401` and a grant of an account that is no longer allowed gets `403`; neither reaches the object.
2. The Worker forwards the request to the `CoachStore` Durable Object (`stub.fetch`) without the `Authorization` header, and returns the object's response without reading its body.
3. The object serves the whole MCP request (`CoachStore.fetch`): JSON-RPC parsing, the Host and Origin checks, the input-schema check, the tool body next to its SQLite data, the log line and the serialization of the result. A tool calls the store directly: there is no Durable Object RPC call per tool. The object's `fetch` answers only `/mcp`, and only the Worker's stub can call it.
4. Every tool goes through `register` (`src/tools/register.ts`). A tool error reaches the client as JSON `{code,message,hint}` in the text content, with `isError` and no `structuredContent`. Arguments that fail the input schema are `invalid_input`. An unexpected error is `internal_error`: its text is never sent or logged.
5. One log line per call: `tool_call` with the tool name, `duration_ms`, `is_error` and `code`. Never arguments, results, error messages or stored values. An internal error also logs `tool_internal_error` with the tool name and the error's type names.

The source layout mirrors the Go packages: `src/coach/` (local dates, tool errors, the envelope), `src/store/` (profile, targets, health items, preferences, labs, notes), `src/tools/` (`register`, the schema builders, the memory tools). The schema migrations and the Durable Object class are in `src/store.ts`.

## Settings

| Variable | Kind | Meaning |
|---|---|---|
| `HCM_TZ` | var in `wrangler.jsonc` | The IANA zone that defines a "day": today, the target in force, a note's creation day. Default `America/Sao_Paulo`. `Local`, a UTC offset or an unknown name is rejected. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_GOOGLE_EMAIL` | secrets | See [Setup](#setup). |

## How sign-in works

1. The MCP client calls `/mcp` and gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
2. It reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, then registers: dynamic client registration at `/register` (Claude) or a Client ID Metadata Document (ChatGPT).
3. `/authorize` shows a consent page. On Allow, the browser goes to Google (`access_type=offline`, `prompt=consent`, PKCE, `openid email` plus the Google Health scopes).
4. Google returns to `/callback`. The Worker checks the ID token (issuer, audience, expiry, nonce, verified email) and the allowlist.
   - Another account gets a `403` page. Its Google token is revoked and nothing is stored.
   - The allowed account's Google refresh token is stored in the `CoachStore` Durable Object (SQLite table `google_account`). The MCP grant gets only `{ sub, email }`.
5. The client exchanges its code at `/token` for an MCP access token and refresh token.

`@cloudflare/workers-oauth-provider` keeps clients, grants and hashed MCP tokens in the `OAUTH_KV` namespace. The Google refresh token is never in KV, logs or tool output. `CoachStore.googleAccessToken()` returns a Google access token, renewed with the stored refresh token when it has less than a minute left. A Google `invalid_grant` removes the link (`auth_expired`); a timeout, 408, 429 or 5xx is `upstream_unavailable`.

## Setup

The Google Health API scopes and `nutrition.writeonly` must be enabled on the Google Cloud project.

1. In Google Cloud console, create an OAuth client of type **Web application**.
   - Authorized redirect URIs: `https://<worker host>/callback` and, for local runs, `http://localhost:8788/callback`.
   - While the consent screen is in **Testing** status, add your account as a test user. Google expires refresh tokens of Testing apps after 7 days.
2. Create the KV namespace and put its `id` in `wrangler.jsonc` under `kv_namespaces` (`OAUTH_KV`):
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. Set the secrets. `ALLOWED_GOOGLE_EMAIL` is a secret too, so the address stays out of git:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put ALLOWED_GOOGLE_EMAIL
   ```
4. `npm run deploy`. Then add `https://<worker host>/mcp` as a custom connector in Claude or ChatGPT, with no client ID or secret.

Everything fits the Workers Free plan: one SQLite-backed Durable Object and one KV namespace.

## Run locally

Requires Node 22.12 or newer (Wrangler's current engine).

```bash
cd workers
npm ci
cp .dev.vars.example .dev.vars   # then fill in the three values
npm run dev
```

Wrangler listens on `http://localhost:8788`, with a local KV and Durable Object. The MCP endpoint is `http://localhost:8788/mcp`. `npx @modelcontextprotocol/inspector@latest` can connect to it and runs the OAuth flow in the browser.

## Test and typecheck

```bash
npm test
npm run typecheck
```

The tests run in workerd through `@cloudflare/vitest-plugin`. They mock every Google call (`fetch` in the isolate) and use synthetic values from `vitest.config.ts`. Nothing calls Google or Cloudflare.

### Parity with the Go server

`test/parity.test.ts` compares the 11 memory tools that the Worker lists with `test/fixtures/go-tools-list.json`, the `tools/list` result of the Go server. Generate the fixture again after a tool definition changes in Go:

```bash
(cd .. && make build) && node scripts/go-tools-list.mjs
```

The script runs the Go binary with new, empty data and config folders. It never reads the real health database or the Google credentials.

## Differences from the Go server

- **`preference_set` does not keep a value byte for byte.** The value arrives parsed, so it is stored as `JSON.stringify` writes it: `1.0` becomes `1`, insignificant white space and escapes go away, and integer-like object keys move first. The 2,048-byte limit is measured as in Go, on the text as Go's JSON encoder writes it: `<`, `>`, `&`, U+2028 and U+2029 count 6 bytes each, although they are stored unescaped. As in Go, an integer beyond 2^53 loses precision.
- **Timestamps have millisecond precision.** They are stored with the Go store's fixed-width format (9 fractional digits) and returned as RFC 3339 with the trailing zeros trimmed, as Go writes a time.
- **The text of a schema error differs.** Both servers answer `invalid_input` with the hint `check the tool's input schema and retry`, and both cap the message at 500 bytes. The message text comes from each SDK's validator. A date that matches the pattern but is not a real day (`2026-02-30`) is reported by its path, without the value.
- **Tool results are checked against the output schema by `register`**, not by the MCP SDK. A result that does not match is `internal_error`.
- **A bad `HCM_TZ` does not stop the server.** The Go server refuses to start. A Worker has no start: every memory tool answers `internal_error` and the log has `config_error` with the variable name. Zone names are checked by the runtime's `Intl`, which ignores case.
- **A call to an unknown tool is a protocol error and writes no `tool_call` line.** The Go server logs it as `protocol_error`.
- **`arguments` that is not an object is a protocol error.** For `"arguments": []`, a string, a number or `null`, the MCP SDK answers JSON-RPC error `-32602` before `register` runs, with no `tool_call` line. The Go server answers `invalid_input` in a tool result. The error text does not repeat the value.
- **A schema newer than the code is not refused.** The Go store refuses a database migrated by a newer binary; the migration runner here applies only what is missing.
- **No `daily_metrics` table yet.** It comes with the code that fills the metrics cache.
- **`server_info` also returns `transport`** and has annotations; it existed before the memory tools.
- The quoting of names in error messages (`JSON.stringify`) follows JavaScript, which differs from Go's `%q` only for control characters and a few non-ASCII characters. Lowercasing follows Go's `strings.ToLower` (code point by code point, `src/coach/text.ts`); the Unicode tables are the runtime's, not Go's.

## Workers Free plan

- **Worker CPU: 10 ms per request.** The Worker isolate does OAuth and the allowlist check, then forwards the request. Its work does not grow with the size of the arguments or of the result.
- **Object CPU: not verified in the docs.** The Durable Objects limits table says 30 seconds of CPU per request. The same page says that objects have the Workers per-invocation CPU limits. No deploy has measured it yet.
- **How to measure after a deploy.** Fill the store to its caps with synthetic rows, then read the CPU time of the Durable Object invocation in the Workers observability logs for these four calls:
  - `health_items_list {}` with 500 items of 4 KiB details (about 2.1 MB of result text);
  - `notes_search {"limit": 200}` with 8 KiB notes (about 1.7 MB);
  - `labs_query {}` with 2,000 rows (about 0.34 MB);
  - `labs_record` with 200 results (the largest input to check).
- **Rows written: 100,000 per day** for SQLite in Durable Objects. A note also writes rows to its full-text index. A single user stays far below it.
- **A statement binds at most 100 parameters and is at most 100 KB long** (SQLite in Durable Objects). The store binds at most 13 parameters, and writes a lab batch one row per statement.

## Known limits

- The OAuth resource is `<request origin>/mcp`. A second hostname (`workers.dev` and a custom domain) is a separate resource with its own grants.
- `/register` and the consent page are open to anyone, as MCP clients need them. Each attempt writes to KV, so heavy abuse could use up the Free plan's daily KV writes.
