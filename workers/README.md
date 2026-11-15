# health-coach-mcp (Cloudflare Workers)

Remote MCP server for the health coach. The Go server at the repo root stays the contract. This Worker serves Streamable HTTP at `/mcp`, protected by OAuth 2.1, so Claude and ChatGPT can add it as a custom connector. It is single-user: only one Google account (`ALLOWED_GOOGLE_EMAIL`) can sign in. A public home page at `/` and a privacy policy at `/privacy` are served without sign-in, for the Google OAuth consent screen.

## Tools, prompts and the resource

- `server_info`: the server name, version and transport.
- `google_account_status`: the linked account, its granted and missing Google Health scopes, and whether its access still works; never a token.
- The 11 coach memory tools of the Go server (`docs/CAPABILITY.md` §4.2):
  `profile_get`, `profile_update`, `targets_set`, `health_item_upsert`, `health_items_list`, `labs_record`, `labs_query`, `preference_set`, `preferences_get`, `note_add`, `notes_search`.
- The 5 coach tools of the Go server (`docs/CAPABILITY.md` §4.1). They read the Google Health API and never write to it:
  - `morning_briefing`: last night's sleep, HRV and resting heart rate against the 28 days before, a readiness level, and yesterday's load.
  - `workout_review`: the sessions of a day (or one session by `exercise_id`), the week's sessions against the target, and the night after.
  - `nutrition_day`: the food log of a day, per nutrient and per meal, against the targets in force and the calories burned.
  - `weekly_report`: an ISO week against the week before and the 28 days before it, the adherence to the targets, and the week's decision notes.
  - `metric_series`: one metric per day or per week, at most 366 days and 180 points.
- The 4 MCP prompts of the Go server: `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report`. Each tells the model to call `profile_get` and its tool, with the guardrails inline. The optional day is parsed as a calendar date before it reaches the text.
- The resource `coach://guardrails`: the coach guardrails of the Go server, byte for byte.

The 17 tools of the Go server have the same names, descriptions, annotations, schemas, validation rules, limits, rounding, flags, reason codes and error codes here. The prompts and the resource have the same texts. [Differences from the Go server](#differences-from-the-go-server) lists what a client or an operator can still observe.

### How a tool call runs

1. The Worker isolate does only OAuth and the allowlist check (`src/index.ts`). It has 10 ms of CPU per request on the Free plan. An unauthenticated request gets `401` and a grant of an account that is no longer allowed gets `403`; neither reaches the object.
2. The Worker forwards the request to the `CoachStore` Durable Object (`stub.fetch`) without the `Authorization` header, and returns the object's response without reading its body.
3. The object serves the whole MCP request (`CoachStore.fetch`): JSON-RPC parsing, the Host and Origin checks, the input-schema check, the tool body next to its SQLite data, every request to Google, the log line and the serialization of the result. A tool calls the store directly: there is no Durable Object RPC call per tool. The object's `fetch` answers only `/mcp`, and only the Worker's stub can call it.
4. Every tool goes through `register` (`src/tools/register.ts`). A tool error reaches the client as JSON `{code,message,hint}` in the text content, with `isError` and no `structuredContent`. Arguments that fail the input schema are `invalid_input`. An unexpected error is `internal_error`: its text is never sent or logged.
5. One log line per call: `tool_call` with the tool name, `duration_ms`, `is_error` and `code`. Never arguments, results, error messages or stored values. An internal error also logs `tool_internal_error` with the tool name and the error's type names. The Google Health client logs a retry, a rejected token and a rejected request with the data type, the HTTP status and Google's status enum: never a response body or a token.

The source layout mirrors the Go packages: `src/coach/` (local dates, tool errors, the envelope), `src/store/` (profile, targets, health items, preferences, labs, notes, the `daily_metrics` cache), `src/googlehealth/` (the read-only API client, the request budget, the access token of one request), `src/healthdata/` (records to daily values through the cache), `src/metrics/` (pure math), `src/tools/` (`register`, the schema builders, the memory tools, the coach tools) and `src/prompts/`. The schema migrations and the Durable Object class are in `src/store.ts`.

## Google Health reads

The Workers Free plan allows 50 external subrequests per invocation. The design takes the strict reading: 50 for the whole MCP HTTP request, the Worker and the object together. The numbers are named in `src/googlehealth/budget.ts`.

### The request budget

- One MCP HTTP request may send at most **45** Google Health API requests. Every HTTP attempt counts: a first try, a retry, a page, a rollup chunk, and a request sent again after a token renewal.
- The token endpoint is outside that number. One request asks the store for an access token at most twice: at first, and once more after Google rejects the token. The normal worst case is 45 + 2 = 47 external fetches. A new sign-in that replaces the link during a renewal makes that renewal send a second request, so the bound is 45 + 4 = **49**.
- The object creates one budget and one token answer per MCP HTTP request (in the server factory that `createMcpHandler` calls for each request). A JSON-RPC batch is one HTTP request: all its tool calls share them, and `google_account_status` shares the token answer.
- The coach tools of one request take turns. The Google requests of a request run one after the other, and a later call finds in the cache what an earlier call fetched.
- A request that would pass the budget is not sent. The tool answers one of two errors:
  - the call needs more pages or chunks than the budget has left: `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range` (the Go client's own error for a range that is too large);
  - retries of a failing request used the budget up, or Google rejected the token of a request and no unit is left to send it again after the renewal: `upstream_unavailable`, as when the 4 attempts of a request run out. The rule: a page that was never tried is `invalid_input`; a request that was tried and cannot be sent again is `upstream_unavailable`.
- A failing request is tried 4 times, with waits of about 1, 2 and 4 seconds (jittered; a `Retry-After` of up to 8 seconds is honored).

### Batching

The Go server fetches each run of consecutive missing days with its own requests. Here a source fetches the missing days in as few requests as it can (`src/healthdata/plan.ts`):

- **Windows.** A long range is fetched in windows, oldest first: 63 nights for sleep and HRV (the most nights whose HRV samples fit one page), 90 days for the steps and zone-minutes rollups, 14 days for the total-calories rollup (the API's caps), 31 days for a list of the band's step records. The settled days of a finished window (up to today − 3) are written to the cache before the next window starts. So a call that ends with the budget error leaves its finished windows in the cache, and the same call again needs fewer requests.
- **Merged runs.** The missing days of a window are fetched as one covering range. Days of that range that are already cached keep their cached value. A cache with holes never needs more requests than a cold cache.
- **Narrow reads.** A tool reads only what its values need. `metric_series resting_hr` does not list sleep; `metric_series steps` reads only the steps rollup; `morning_briefing` does not read total calories; `weekly_report` and the food metrics read them only for the logged days without a kcal target, and only for the days the band was worn. One exception: when the narrow read of `nutrition_day` or `morning_briefing` has no value for its day and dropped an unreadable row, the tool reads the total it left out for that one day (the steps rollup, or the total-calories rollup: one more request). The Go server reads all three totals, and a day with any of them is a day without band data, not a missing day.
- **The "band worn" check** lists the band's step records only for the days without a zone-minutes row.
- **Never cached:** sessions, heart-rate samples, the food log, today and the 3 days before it, and a day without band data (as in the Go server). A steps or total-calories row is cached only for a day whose zone-minutes value is known, so `metric_series steps` alone costs the same on every call until a zone-minutes read covers its days.

### Memory

An isolate has 128 MB. The client never keeps the raw pages of a call (`src/googlehealth/client.ts`, `page.ts`):

- one response is at most **16 MiB**, and the responses of one call (all its pages and rollup chunks) at most **32 MiB** (the Go limits are 32 and 64 MiB); over a limit is the budget error above, not retried;
- a page is read record by record, never as one parsed tree, and each record is reduced to the fields its caller needs before the next one is read;
- a record longer than **1 MiB** (1,048,576 characters) is refused before it is parsed: the tool answers `upstream_unavailable`, `Google Health returned an unreadable <type> response`. A parsed record of 1 MiB holds at most about 350,000 values. The largest real records are a night with its stage list and a session: 1 MiB is four times a night of 8 hours with a sleep stage every 30 seconds (960 stages of about 250 characters);
- a top-level field of a page other than the list and the page token is checked as JSON and never parsed: the client reads its name only. So a response that is small in bytes and holds millions of small values does not become millions of objects;
- the estimated peak of a call is 64 MiB: what it kept (at most 32 MiB) plus one response in flight as bytes and as text.

These numbers rest on an estimate of the record sizes. No production isolate has measured them.

### Measured subrequests

`test/subrequests.test.ts` counts every external `fetch` of one MCP HTTP request, with the real client and source inside the object and Google behind a mocked `fetch`. A test compares the table below with the pinned counts, and the run prints the measured table. The cache is cold at request 1 of each row.

```bash
npm test -- test/subrequests.test.ts --reporter=default
```

Vitest's minimal reporter hides the output of a file that passes; `--reporter=default` shows the table.

The synthetic account, 366 days (2025-10-16 to 2026-10-16). The volumes are estimates of a band worn day and night:

- one main sleep of 8 hours per night and a nap on every third day (488 sleep records); 97 HRV samples per night; one resting heart rate per day;
- a steps and a total-calories rollup row on every day; a zone-minutes row on four days of five;
- 320 step records of the band per worn day, one per minute with steps (117,120 a year; a 31-day list is 9,920 records, one page);
- a weigh-in with body fat every day; 5 food items per day;
- one session of an hour on five days of seven, with a heart-rate sample every 2 seconds; one day with 33 sessions of 20 minutes;
- **dense account:** a phone copy of every sleep record (854 sleep records) and 130 HRV samples per night;
- **off-wrist days and two-page steps lists:** one day without band data in every week, and every list of the band's steps comes back in two pages.

Columns: the Google Health requests and the token requests of each MCP HTTP request until the call succeeds (`45, 3` is two requests); their sum; the outcome of request 1 (`budget error` is the `invalid_input` above); how many requests the call needs; the Google Health requests of one more request on the cache they filled.

| Tool | Input | Google Health requests | Token requests | Total | Outcome of request 1 | Requests until success | A later request |
|---|---|---|---|---|---|---|---|
| `morning_briefing` | the day after a day without a zone-minutes row | 9 | 0 | 9 | ok | 1 | 5 |
| `workout_review` | `date` of a day with 33 sessions | 39 | 0 | 39 | ok | 1 | 35 |
| `workout_review` | `exercise_id` of the newest session of that day | 12 | 0 | 12 | ok | 1 | 8 |
| `nutrition_day` | a settled day without a zone-minutes row | 5 | 0 | 5 | ok | 1 | 1 |
| `weekly_report` | the current week, no kcal target | 12 | 0 | 12 | ok | 1 | 10 |
| `weekly_report` | the week before, no kcal target | 13 | 0 | 13 | ok | 1 | 3 |
| `metric_series` | `weight`, 366 days by week | 1 | 0 | 1 | ok | 1 | 1 |
| `metric_series` | `resting_hr`, 366 days by week | 1 | 0 | 1 | ok | 1 | 1 |
| `metric_series` | `hrv`, 366 days by week | 29 | 0 | 29 | ok | 1 | 2 |
| `metric_series` | `sleep_asleep_min`, 366 days by week | 29 | 0 | 29 | ok | 1 | 2 |
| `metric_series` | `steps`, 366 days by week | 5 | 0 | 5 | ok | 1 | 5 |
| `metric_series` | `azm`, 366 days by week | 18 | 0 | 18 | ok | 1 | 1 |
| `metric_series` | `total_calories`, 366 days by week | 45 | 0 | 45 | ok | 1 | 2 |
| `metric_series` | `kcal_in`, 366 days by week, no kcal target | 45, 3 | 0, 0 | 45, 3 | budget error | 2 | 3 |
| `metric_series` | `protein_g`, 366 days by week, no kcal target | 45, 3 | 0, 0 | 45, 3 | budget error | 2 | 3 |
| `metric_series` | `kcal_in`, 366 days by week, a kcal target on every day | 1 | 0 | 1 | ok | 1 | 1 |
| `morning_briefing` | dense account, the same day | 10 | 0 | 10 | ok | 1 | 5 |
| `workout_review` | dense account, the same `date` | 40 | 0 | 40 | ok | 1 | 35 |
| `weekly_report` | dense account, the week before | 15 | 0 | 15 | ok | 1 | 3 |
| `metric_series` | dense account, `hrv`, 366 days by week | 45 | 0 | 45 | ok | 1 | 2 |
| `metric_series` | dense account, `sleep_asleep_min`, 366 days by week | 45 | 0 | 45 | ok | 1 | 2 |
| `metric_series` | off-wrist days and two-page steps lists, `azm`, 366 days | 31 | 0 | 31 | ok | 1 | 29 |
| `metric_series` | off-wrist days and two-page steps lists, `total_calories`, 366 days | 45, 42 | 0, 0 | 45, 42 | budget error | 2 | 30 |
| `metric_series` | off-wrist days and two-page steps lists, `kcal_in`, 366 days, no kcal target | 45, 44 | 0, 0 | 45, 44 | budget error | 2 | 31 |
| `metric_series` | `total_calories`, 366 days; the access token is renewed first | 45 | 1 | 46 | ok | 1 | 2 |
| `metric_series` | `total_calories`, 366 days; Google rejects the token once | 45, 2 | 1, 0 | 46, 2 | budget error | 2 | 2 |
| `metric_series` | `total_calories`, 366 days; the token is renewed first, and Google rejects the new one once | 45, 2 | 2, 0 | 47, 2 | budget error | 2 | 2 |
| `metric_series` | the case above, and a new sign-in replaces the link during each renewal | 45, 2 | 4, 0 | 49, 2 | budget error | 2 | 2 |
| `morning_briefing` | Google Health answers 503 to every request | 4 | 0 | 4 | upstream_unavailable | none | — |
| `metric_series` | `total_calories`, 366 days; Google Health answers 503 three times before each answer | 45 | 0 | 45 | upstream_unavailable | none | — |
| the five coach tools and `google_account_status` | one POST; today's briefing, a day with one session, a day of food, the current week, 7 days of steps; the access token is renewed first | 32 | 1 | 33 | ok | 1 | 28 |
| the five coach tools and `google_account_status` | one POST; the worst-case input of each tool; the access token is renewed first | 45, 45, 45, 45 | 1, 0, 0, 0 | 46, 45, 45, 45 | ok, budget error ×4, ok | none | — |

The highest count is **49 external fetches** in one MCP HTTP request: 45 Google Health requests and 4 token requests, in the row with the sign-in race. Without that race the highest count is 47. No row passes 50.

What the table shows:

1. **Every tool answers its worst-case input, in at most 2 requests.** Request 1 of the largest cases ends with the budget error after 45 requests; request 2 continues from the cached windows.
2. **Three inputs use exactly the 45 requests and succeed:** `total_calories` over 366 days (27 total-calories rollups, 5 zone-minutes rollups, 13 lists of the band's steps), and `hrv` and `sleep_asleep_min` over 366 days in the dense account (39 sleep pages, 6 HRV pages). One more page ends request 1 with the budget error, and request 2 succeeds.
3. **The worst case of `workout_review` is a `date`: 39 to 40 requests on a day with 33 sessions, a margin of 5 to 6.** Its session lists and heart-rate lists are never cached: 4 session pages and 31 heart-rate lists on every call (a max heart rate is read for the newest 31 sessions of the day). Each 25 more sessions in the day or in its week add one request. A day that needs more than 45 answers the budget error on every call. With `exercise_id` the heart rate is listed for that session only: 7 session pages (3 of them for the lookup of the day in the last 28 days) and 1 heart-rate list, 12 requests here.
4. **A day without band data is checked again on every call.** Over a year the repeated "band worn" check costs `5 + 13 × pages` requests, where `pages` is the pages of one 31-day list of the band's steps: 18 with one page, 31 with two (the table has 29 to 31). With three pages it is 44, and with four it is 57: over the budget on every call. Three and four pages are not measured.
5. **A JSON-RPC batch shares one budget.** A call that does not fit answers the budget error, and no request is sent for it. The same POST sent again succeeds only when the parts of its calls that are never cached fit one budget together. The POST with the worst-case input of each tool never does: send such calls in requests of their own.
6. **Retries count.** With 503 on every request the call ends after 4 attempts. With three 503 answers before each answer the call ends at 45 requests with `upstream_unavailable`, after 33 waits (about a minute).

## Settings

| Variable | Kind | Meaning |
|---|---|---|
| `HCM_TZ` | var in `wrangler.jsonc` | The IANA zone that defines a "day": today, the target in force, a note's creation day, the day a night ends. Default `America/Sao_Paulo`. `Local`, a UTC offset or an unknown name is rejected. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_GOOGLE_EMAIL` | secrets | See [Setup](#setup). |

## How sign-in works

1. The MCP client calls `/mcp` and gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
2. It reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, then registers: dynamic client registration at `/register` (Claude) or a Client ID Metadata Document (ChatGPT).
3. `/authorize` shows a consent page. On Allow, the browser goes to Google (`access_type=offline`, `prompt=consent`, PKCE, `openid email` plus the Google Health scopes).
4. Google returns to `/callback`. The Worker checks the ID token (issuer, audience, expiry, nonce, verified email) and the allowlist.
   - Another account gets a `403` page. Its Google token is revoked and nothing is stored.
   - The allowed account's Google refresh token is stored in the `CoachStore` Durable Object (SQLite table `google_account`). The MCP grant gets only `{ sub, email }`.
5. The client exchanges its code at `/token` for an MCP access token and refresh token.

`@cloudflare/workers-oauth-provider` keeps clients, grants and hashed MCP tokens in the `OAUTH_KV` namespace. The Google refresh token is never in KV, logs or tool output. `CoachStore.googleAccessToken()` returns a Google access token, renewed with the stored refresh token when it has less than a minute left. A Google `invalid_grant` removes the link (`auth_expired`); a timeout, 408, 429, 5xx, a redirect or a malformed answer is `upstream_unavailable`. A request to Google's token or revoke endpoint never follows a redirect: a followed 307 or 308 would send the client secret and the refresh token to the redirect target, and would add subrequests that the budget does not count. A coach tool without a linked account answers `auth_expired` with the hint to disconnect and reconnect the connector.

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

- `test/health-e2e.test.ts`: the OAuth sign-in through the Worker, then `tools/list` (18 tools), the prompts, `coach://guardrails`, one call of each coach tool, and one error of each kind (`no_data`, `invalid_input`, `auth_expired`, `scope_missing`, `upstream_unavailable`).
- `test/subrequests.test.ts`: the table of [Measured subrequests](#measured-subrequests).
- `test/coach-e2e.test.ts` and `test/memory-e2e.test.ts`: the detailed cases of the coach tools and of the memory tools over `/mcp`.

### Parity with the Go server

`test/parity.test.ts` compares the 17 tools that the Go server lists with `test/fixtures/go-tools-list.json`, the `tools/list` result of the Go server. `test/prompts.test.ts` compares the prompts and the resource with `test/fixtures/go-prompts.json`, the Go server's answers to `prompts/list`, each `prompts/get`, `resources/list` and `resources/read`. Generate the fixtures again after a tool definition, a prompt or the guardrails change in Go:

```bash
(cd .. && make build) && node scripts/go-tools-list.mjs && node scripts/go-prompts.mjs
```

The scripts run the Go binary with new, empty data and config folders. They never read the real health database or the Google credentials.

The parity tests read only the committed fixtures, so they cannot see a definition that changed in Go. This check does: it asks the Go binary again, compares the answers with the fixtures, writes nothing, and exits 1 with the names of what differs.

```bash
(cd .. && make build) && npm run check:go-fixture
```

## Differences from the Go server

What a client or an operator can observe. Differences that are only internal (types, the place of a helper) are not listed.

Coach memory and the server:

- **`preference_set` does not keep a value byte for byte.** The value arrives parsed, so it is stored as `JSON.stringify` writes it: `1.0` becomes `1`, insignificant white space and escapes go away, and integer-like object keys move first. The 2,048-byte limit is measured as in Go, on the text as Go's JSON encoder writes it: `<`, `>`, `&`, U+2028 and U+2029 count 6 bytes each, although they are stored unescaped. As in Go, an integer beyond 2^53 loses precision.
- **Timestamps have millisecond precision.** They are stored with the Go store's fixed-width format (9 fractional digits) and returned as RFC 3339 with the trailing zeros trimmed, as Go writes a time.
- **The text of a schema error differs.** Both servers answer `invalid_input` with the hint `check the tool's input schema and retry`, and both cap the message at 500 bytes. The message text comes from each SDK's validator. A date that matches the pattern but is not a real day (`2026-02-30`) is reported by its path, without the value. An `exercise_id` longer than 256 characters is this `invalid_input` too; the Go SDK answers its own error text.
- **Tool results are checked against the output schema by `register`**, not by the MCP SDK. A result that does not match, or that holds NaN or Infinity, is `internal_error`.
- **A bad `HCM_TZ` does not stop the server.** The Go server refuses to start. A Worker has no start: every tool that needs the zone answers `internal_error` and the log has `config_error` with the variable name. Zone names are checked by the runtime's `Intl`, which ignores case.
- **A call to an unknown tool is a protocol error and writes no `tool_call` line.** The Go server logs it as `protocol_error`.
- **`arguments` that is not an object is a protocol error.** For `"arguments": []`, a string, a number or `null`, the MCP SDK answers JSON-RPC error `-32602` before `register` runs, with no `tool_call` line. The Go server answers `invalid_input` in a tool result. The error text does not repeat the value.
- **A schema newer than the code is not refused.** The Go store refuses a database migrated by a newer binary; the migration runner here applies only what is missing.
- **`server_info` also returns `transport`** and has annotations; it existed before the memory tools.
- The quoting of names in error messages (`JSON.stringify`) follows JavaScript, which differs from Go's `%q` only for control characters and a few non-ASCII characters. Lowercasing and uppercasing follow Go's `strings.ToLower` and `ToUpper` code point by code point (`src/coach/text.ts`, `src/metrics/quality.ts`); the Unicode tables are the runtime's, not Go's.

Error texts and hints of the Google Health side:

- **Hints name the reconnect step.** `auth_expired` has the hint `Disconnect and reconnect this connector in the MCP client to sign in with Google again.`; `scope_missing` adds `Allow every permission, and check that the Google Health API is enabled in the Cloud project.` The Go server names its CLI command `health-coach-mcp auth login`.
- **A token renewal that Google refuses** is `auth_expired`, `Google rejected the token renewal`, with the hint `Check the server's Google OAuth client settings.` and the reconnect step. The Go server adds Google's error code and the HTTP status to the message, and names `client_secret.json`.
- **A token endpoint that is down has one message**, `Google's token service is unavailable`, also for an HTTP 200 answer without a usable token. The Go server has three texts.
- **A date error of a prompt has the JSON-RPC code `-32602`.** The Go server answers code `0` with the same message, `date must be a calendar date (YYYY-MM-DD)`. A prompt argument that is not text is refused by the MCP SDK with its own text.
- **The echo of an unknown prompt name is cut at 500 bytes**, and its escapes follow `JSON.stringify`, not Go's `%q`.
- **List and read results have no `ttlMs` and `cacheScope` keys.** The Go SDK adds `ttlMs: 0` and `cacheScope: "public"`.

The request budget (the Go server has none):

- **The budget error.** A call that needs more than the 45 Google Health requests of its MCP HTTP request answers `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range`. The Go server gives this error only at 200 pages or 64 MiB. Here it also comes at 16 MiB per response and 32 MiB per call, and the 32 MiB cover all the chunks of one rollup.
- **Retries that use the budget up** are `upstream_unavailable`. So is a request that Google rejects for its token when the budget has no unit left to send it again.
- **Every network error is retried.** The Go server fails fast on a DNS not-found and on a certificate error; `fetch` in workerd does not tell the kinds apart.
- **`Retry-After` as a date is read only in the IMF-fixdate form.** The Go server also reads the two obsolete forms.

The token rules:

- **One forced renewal per MCP HTTP request.** The Go server allows one per page. After it, a second `401` in the same request is `auth_expired`.
- **The store is asked for a token at most twice per request.** A token that passes its expiry during a long request is not renewed by the clock: Google rejects it, and the forced renewal renews it. A failure of the token endpoint is asked once per request, whatever the request calls.
- **`google_account_status` shares the token answer of its request**, so in a batch it reports the state at the first ask.
- **The coach tool calls of one HTTP request run one after the other** and share the budget. The Go server runs calls at the same time.

Effects of a narrow read:

- **`unreadable_records` counts only the data that was read.** For example `metric_series resting_hr` does not see an unreadable sleep record, `morning_briefing` does not see an unreadable total-calories row of yesterday or a body-fat reading, and `metric_series total_calories` does not see a total-calories row of a day without the band. The Go server reads every value. When such a row is the only activity data of the day, `nutrition_day` (an unreadable steps row) and `morning_briefing` (an unreadable total-calories row) answer `band_not_worn` without `unreadable_records`; the Go server answers `unreadable_records` without `band_not_worn`.
- **A worn day without a zone-minutes row reads as 0 minutes also when an unreadable steps or total-calories row is in the same run** and the tool did not read that rollup. The Go server gives no value for that day.
- **`sources` of `metric_series resting_hr`** holds the labels of the resting heart rate records only. The Go server adds the labels of the sleep records.
- **`metric_series total_calories` gives `band_not_worn` for every day without band data**, also a day without any activity data. The flag `band_not_worn` is then set, and a week point counts the day in `days_left_out`. The Go server gives such a day `null` without a reason. The value of every point is the same.

Output forms:

- **Session times are written in the coach's zone** (`2026-10-14T19:00:00-03:00`), as night and food times are. The Go server writes a session time as the record carried it (`…Z` for the API's UTC instants). The instant is the same.
- **A rounded `-0` is written as `0`.** Go's JSON encoder writes `-0`.
- **Key order.** `active_min_by_type` keeps the order of the sessions, and `days_left_out` the order in which the reasons first appear. The Go server writes map keys sorted. A JSON object has no order.
- **Sessions with the same start keep the API's order.** Go's sort is not stable.

Decoding of Google Health records:

- **Key names match exactly.** Go's decoder also matches without regard to case.
- **A repeated key keeps the last value**, and a page that holds its list key twice is refused. Go decodes both values, and keeps the last list.
- **A whole number written as `440.0` or `4.4e2` is accepted** where Go refuses it.
- **Time fractions finer than a millisecond are cut, never rounded up:** an instant stays in its second and on its local day, as in the Go server. An output shows milliseconds. Inside one millisecond, two instants keep their order down to about a microsecond; the Go server keeps nanoseconds.
- **A record that is not JSON makes its whole page unreadable** (`upstream_unavailable`). It cannot reach a parser as one skipped record.
- **A record longer than 1 MiB makes its whole page unreadable** (`upstream_unavailable`). The Go server has only its byte limits per response and per call.
- **A page field that the client does not read may nest at most 512 levels.** It is checked as JSON without being parsed, and a deeper one makes the page unreadable. Go's decoder allows deeper nesting.

Logs:

- **Log lines are `console.*(message, {fields})`** with the Go messages and field names. `wait_ms` is a number (Go logs a duration as `wait`). A network error logs only the type names of its cause. `from` and `to` of an "unreadable …" line are the range of the Worker's own request, which can be wider than the Go server's run.

## Workers Free plan

- **Worker CPU: 10 ms per request.** The Worker isolate does OAuth and the allowlist check, then forwards the request. Its work does not grow with the size of the arguments or of the result, and it makes no request to Google.
- **Subrequests: 50 per invocation.** See [The request budget](#the-request-budget) and [Measured subrequests](#measured-subrequests): the highest measured count of one MCP HTTP request is 49.
- **Google Health rate limit: 300 requests per minute per user.** One MCP HTTP request sends at most 45, one after the other. Over the limit Google answers 429, which is retried.
- **Rows written: 100,000 per day** for SQLite in Durable Objects. A note also writes rows to its full-text index. The `daily_metrics` cache writes up to 15 values per day when the day settles. Each value counts 3 rows written: its row, its primary key entry and its entry in the index `(metric, date)`. A cold year is about 16,500 rows written, once.
- **Rows read: 5 million per day** for SQLite in Durable Objects. Each write to the coach memory counts its table first (`SELECT COUNT(*)`), as the Go store does, to enforce the caps. A count scans the table: `note_add` can read up to 50,000 rows, `labs_record` up to 20,000, a new item in `health_item_upsert` up to 500 and a new key in `preference_set` up to 200. If a scanned row counts as a row read (the pricing page does not say how a count is billed), about 100 `note_add` calls in a day use the whole quota once the notes table is full. A new store is far from that. The coach tools read the `daily_metrics` cache one metric at a time, through the index `(metric, date)`: one metric over N cached days reads N + 1 rows, not the rows of all 15 metrics of those days. The largest read is the recovery of 366 days, 10 metrics: 3,670 rows. The row counts of the cache are the ones the local runtime reports (`rowsRead`, `rowsWritten`); a deploy has not confirmed them.
- **A statement binds at most 100 parameters and is at most 100 KB long** (SQLite in Durable Objects). The store binds at most 13 parameters, and writes a lab batch one row per statement.
- **Bundle:** `wrangler deploy --dry-run` reports 1,210 KiB, 268 KiB with gzip.

### Not verified on the Free plan

No deploy has run this code. These points come from the docs or from local tests:

- **Object CPU.** The Durable Objects limits table says 30 seconds of CPU per request. The same page says that objects have the Workers per-invocation CPU limits. If the object has only 10 ms, a cold call over a year cannot work: `metric_series hrv` over 366 days parses about 36,000 HRV samples.
- **Whether an object invocation has its own subrequest budget.** The design assumes that it has not: 50 for the whole request.
- **Memory.** The 16 MiB and 32 MiB limits rest on an estimate of 0.7 to 1.0 kB per heart-rate sample, and the 1 MiB record limit on an estimate of about 250 characters per sleep stage. No real record was measured. The local workerd does not enforce 128 MB.
- **Record volumes.** The table above uses synthetic volumes. A real 31-day list of the band's steps can have more than one page.
- **The daily rollup page size.** The docs give a maximum page size of 90 (14 for total calories). The request keeps the Go shape and sends `pageSize: 10000`, which works for the Go server against the real API.
- **The time form of real exercise records.** The fixtures write UTC instants.

How to measure after a deploy:

1. **CPU time.** Call each coach tool once on a cold cache, with `metric_series` for `hrv` and for `total_calories` over 366 days by week. Read the CPU time of the Durable Object invocation of each call in the Workers observability logs (`observability` is on in `wrangler.jsonc`). Compare it with 10 ms and with 30 seconds.
2. **Subrequests.** Send one MCP request at a time on an idle Worker and read its subrequest count: in the Worker's metrics for that interval, or in the trace of the request (set `observability.traces.head_sampling_rate` to 1 for the test and count the outbound `fetch` spans). Compare it with the table. If Cloudflare refuses a subrequest, `fetch` fails: the log has `google health request did not complete`, and after 4 attempts the tool answers `upstream_unavailable`.
3. **The memory tools.** Fill the store to its caps with synthetic rows, then read the CPU time of these four calls:
   - `health_items_list {}` with 500 items of 4 KiB details (about 2.1 MB of result text);
   - `notes_search {"limit": 200}` with 8 KiB notes (about 1.7 MB);
   - `labs_query {}` with 2,000 rows (about 0.34 MB);
   - `labs_record` with 200 results (the largest input to check).

## Known limits

- The OAuth resource is `<request origin>/mcp`. A second hostname (`workers.dev` and a custom domain) is a separate resource with its own grants.
- `/register` and the consent page are open to anyone, as MCP clients need them. Each attempt writes to KV, so heavy abuse could use up the Free plan's daily KV writes.
- A call that needs more than 45 Google Health requests answers the budget error and must be sent again (see [Measured subrequests](#measured-subrequests), points 1 to 5). The largest measured input needs 2 requests.
- `workout_review` by `date` of a day whose session lists and heart-rate lists need more than 45 requests cannot succeed: nothing of them is cached. `exercise_id` reviews one session of such a day with one heart-rate list.
- A year in which every 31-day window has days without band data, in an account whose 31-day list of the band's steps has four pages or more, makes `metric_series` for `azm`, `total_calories`, `kcal_in` and `protein_g` over that year answer the budget error on every call. Use a shorter range.
