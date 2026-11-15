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
  - `nutrition_day`: the food log of a day, per nutrient and per meal, against the targets in force and the calories burned. An item this server logged includes `entry_id`, the id `nutrition_log_delete` accepts.
  - `weekly_report`: an ISO week against the week before and the 28 days before it, the adherence to the targets, and the week's decision notes.
  - `metric_series`: one metric per day or per week, at most 366 days and 180 points.
- The 2 tools that write the food log. The Go server does not have them: it only reads Google Health. [Food log writes](#food-log-writes) has their rules.
  - `nutrition_log_add`: logs one meal or food item in Google Health, with the calories and macros that the MCP client estimated (for example from a photo), and returns the id of the new entry.
  - `nutrition_log_delete`: deletes one entry, and only an entry that this server created. The id is the one `nutrition_log_add` returned, which `nutrition_day` also lists on the item.
- The 4 MCP prompts of the Go server: `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report`. Each tells the model to call `profile_get` and its tool, with the guardrails inline. The optional day is parsed as a calendar date before it reaches the text.
- The resource `coach://guardrails`: the coach guardrails of the Go server, byte for byte.

The 17 tools of the Go server have the same names, descriptions, annotations, schemas, validation rules, limits, rounding, flags, reason codes and error codes here. The prompts and the resource have the same texts. [Differences from the Go server](#differences-from-the-go-server) lists what a client or an operator can still observe.

### How a tool call runs

1. The Worker isolate does only OAuth and the allowlist check (`src/index.ts`). It has 10 ms of CPU per request on the Free plan. An unauthenticated request gets `401` and a grant of an account that is no longer allowed gets `403`; neither reaches the object.
2. The Worker forwards the request to the `CoachStore` Durable Object (`stub.fetch`) without the `Authorization` header, and returns the object's response without reading its body.
3. The object serves the whole MCP request (`CoachStore.fetch`): JSON-RPC parsing, the Host and Origin checks, the input-schema check, the tool body next to its SQLite data, every request to Google, the log line and the serialization of the result. A tool calls the store directly: there is no Durable Object RPC call per tool. The object's `fetch` answers only `/mcp`, and only the Worker's stub can call it.
4. Every tool goes through `register` (`src/tools/register.ts`). A tool error reaches the client as JSON `{code,message,hint}` in the text content, with `isError` and no `structuredContent`. Arguments that fail the input schema are `invalid_input`. An unexpected error is `internal_error`: its text is never sent or logged.
5. One log line per call: `tool_call` with the tool name, `duration_ms`, `is_error` and `code`. Never arguments, results, error messages or stored values. An internal error also logs `tool_internal_error` with the tool name and the error's type names. The Google Health client logs a retry, a rejected token and a rejected request with the data type, the HTTP status and Google's status enum, and a write answer that it cannot use with the reason: never a request body, a response body or a token.

The source layout mirrors the Go packages: `src/coach/` (local dates, tool errors, the envelope), `src/store/` (profile, targets, health items, preferences, labs, notes, the `daily_metrics` cache, the food entries this server created), `src/googlehealth/` (the API client with its reads and its two food log writes, the request budget, the access token of one request), `src/healthdata/` (records to daily values through the cache), `src/metrics/` (pure math), `src/tools/` (`register`, the schema builders, the memory tools, the coach tools, the two food log tools) and `src/prompts/`. The schema migrations and the Durable Object class are in `src/store.ts`.

## Google Health reads

The Workers Free plan allows 50 external subrequests per invocation. The design takes the strict reading: 50 for the whole MCP HTTP request, the Worker and the object together. The numbers are named in `src/googlehealth/budget.ts`.

### The request budget

- One MCP HTTP request may send at most **45** Google Health API requests. Every HTTP attempt counts: a first try, a retry, a page, a rollup chunk, and a request sent again after a token renewal.
- The token endpoint is outside that number. One request asks the store for an access token at most twice: at first, and once more after Google rejects the token. The normal worst case is 45 + 2 = 47 external fetches. A new sign-in that replaces the link during a renewal makes that renewal send a second request, so the bound is 45 + 4 = **49**.
- The object creates one budget and one token answer per MCP HTTP request (in the server factory that `createMcpHandler` calls for each request). A JSON-RPC batch is one HTTP request: all its tool calls share them, and `google_account_status` shares the token answer.
- The coach tools of one MCP HTTP request take turns. The Google requests of a request run one after the other, and a later call finds in the cache what an earlier call fetched.
- The turns are per MCP HTTP request. The object does not order two MCP HTTP requests: while one waits for Google, the object serves the other. Two requests at the same time each have their own budget and token answer (up to 49 external fetches each), can fetch the same window twice, and add their memory (see [Memory](#memory)). In the tests, two pairs of overlapping requests give the answers and the cache rows of the same requests in sequence. One queue for the whole object is not used: a request that stops while it holds the turn would block every later request.
- A request that would pass the budget is not sent. The tool answers one of two errors:
  - the call needs more pages or chunks than the budget has left: `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range` (the Go client's own error for a range that is too large). When earlier tool calls of the same MCP HTTP request took units before this call started, the hint is `use a shorter date range, or send this call in a request of its own`: the same call can fit a budget of its own;
  - retries of a failing request used the budget up, or Google rejected the token of a request and no unit is left to send it again after the renewal: `upstream_unavailable`, as when the 4 attempts of a request run out. The rule: a page that was never tried is `invalid_input`; a request that was tried and cannot be sent again is `upstream_unavailable`.
- A failing request is tried 4 times, with waits of about 1, 2 and 4 seconds (jittered; a `Retry-After` of up to 8 seconds is honored).

### Batching

The Go server fetches each run of consecutive missing days with its own requests. Here a source fetches the missing days in as few requests as it can (`src/healthdata/plan.ts`):

- **Windows.** A long range is fetched in windows, oldest first: 63 nights for sleep and HRV (the most nights whose HRV samples fit one page), 90 days for the steps and zone-minutes rollups, 14 days for the total-calories rollup (the API's caps), 31 days for a list of the band's step records. The settled days of a finished window (up to today − 3) are written to the cache before the next window starts. So a call that ends with the budget error leaves its finished windows in the cache, and the same call again needs fewer requests.
- **Merged runs.** The missing days of a window are fetched as one covering range. Days of that range that are already cached keep their cached value. A cache with holes never needs more requests than a cold cache.
- **Narrow reads.** A tool reads only what its values need. `metric_series resting_hr` does not list sleep; `metric_series steps` reads only the steps rollup; `morning_briefing` does not read total calories; `weekly_report` and the food metrics read them only for the logged days without a kcal target, and only for the days the band was worn. One exception: when the narrow read of `nutrition_day` or `morning_briefing` has no value for its day and dropped an unreadable row, the tool reads the total it left out for that one day (the steps rollup, or the total-calories rollup: one more request). The Go server reads all three totals, and a day with any of them is a day without band data, not a missing day.
- **The "band worn" check** lists the band's step records only for the days without a zone-minutes row.
- **Never cached:** sessions, heart-rate samples, the food log, today and the 2 days before it (a day is cached when it is at most today − 3), and a day without band data (as in the Go server). A steps or total-calories row is cached only for a day whose zone-minutes value is known, so `metric_series steps` alone costs the same on every call until a zone-minutes read covers its days.

### Memory

An isolate has 128 MB. The client never keeps the raw pages of a call (`src/googlehealth/client.ts`, `page.ts`):

- one response is at most **16 MiB**, and the responses of one call (all its pages and rollup chunks) at most **32 MiB** (the Go limits are 32 and 64 MiB); over a limit is the budget error above, not retried;
- a page is read record by record, never as one parsed tree, and each record is reduced to the fields its caller needs before the next one is read;
- a record longer than **1 MiB** (1,048,576 characters) is refused before it is parsed: the tool answers `upstream_unavailable`, `Google Health returned an unreadable <type> response`. A parsed record of 1 MiB holds at most about 350,000 values. The largest real records are a night with its stage list and a session: 1 MiB is four times a night of 8 hours with a sleep stage every 30 seconds (960 stages of about 250 characters);
- a top-level field of a page other than the list and the page token is checked as JSON and never parsed: the client reads its name only. So a response that is small in bytes and holds millions of small values does not become millions of objects;
- the estimated peak of one MCP HTTP request is 64 MiB: what a call kept (at most 32 MiB) plus one response in flight as bytes and as text. The calls of one request run one after the other, so their peaks do not add. Two MCP HTTP requests at the same time are not ordered: their peaks add, and two of the largest calls together can pass the 128 MB.

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
| `nutrition_log_add` | one entry | 1 | 0 | 1 | ok | 1 | 1 |
| `nutrition_log_add` | one entry; the access token is renewed first, and Google rejects the new one once | 2 | 2 | 4 | ok | 1 | 1 |
| `nutrition_log_add` | one entry; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |
| `nutrition_log_delete` | an entry this server created | 1 | 0 | 1 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created that Google no longer has (HTTP 404, `NOT_FOUND`) | 1 | 0 | 1 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created; the access token is renewed first, and Google rejects the new one once | 2 | 2 | 4 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |
| `nutrition_log_add`, 100 calls | one POST with 100 entries; the access token is renewed first | 45, 45, 45, 45 | 1, 0, 0, 0 | 46, 45, 45, 45 | ok ×45, budget error ×55 | none | — |

The highest count is **49 external fetches** in one MCP HTTP request: 45 Google Health requests and 4 token requests, in the row with the sign-in race. Without that race the highest count is 47. No row passes 50.

What the table shows:

1. **Every tool answers its worst-case input, in at most 2 requests.** Request 1 of the largest cases ends with the budget error after 45 requests; request 2 continues from the cached windows.
2. **Three inputs use exactly the 45 requests and succeed:** `total_calories` over 366 days (27 total-calories rollups, 5 zone-minutes rollups, 13 lists of the band's steps), and `hrv` and `sleep_asleep_min` over 366 days in the dense account (39 sleep pages, 6 HRV pages). One more page ends request 1 with the budget error, and request 2 succeeds.
3. **The worst case of `workout_review` is a `date`: 39 to 40 requests on a day with 33 sessions, a margin of 5 to 6.** Its session lists and heart-rate lists are never cached: 4 session pages and 31 heart-rate lists on every call (a max heart rate is read for the newest 31 sessions of the day). Each 25 more sessions in the day or in its week add one request. A day that needs more than 45 answers the budget error on every call. With `exercise_id` the heart rate is listed for that session only: 7 session pages (3 of them for the lookup of the day in the last 28 days) and 1 heart-rate list, 12 requests here.
4. **A day without band data is checked again on every call.** Over a year the repeated "band worn" check costs `5 + 13 × pages` requests, where `pages` is the pages of one 31-day list of the band's steps: 18 with one page, 31 with two (the table has 29 to 31). With three pages it is 44, and with four it is 57: over the budget on every call. Three and four pages are not measured.
5. **A JSON-RPC batch shares one budget.** A call that does not fit answers the budget error, and no request is sent for it. Its hint names a request of its own when the calls before it took units (the four calls of the last row). The same POST sent again succeeds only when the parts of its calls that are never cached fit one budget together. The POST with the worst-case input of each tool never does: send such calls in requests of their own.
6. **Retries count.** With 503 on every request the call ends after 4 attempts. With three 503 answers before each answer the call ends at 45 requests with `upstream_unavailable`, after 33 waits (about a minute).
7. **A write is one Google Health request, and at most 5.** `nutrition_log_add` and `nutrition_log_delete` send one request. Their worst case is 5 Google Health requests and 2 token requests (7 external fetches): the token is renewed first, Google rejects the new one (1 request), and Google then answers 429 to the 4 attempts. For an add, a 5xx answer or a network error ends the call at 1 request: see [A create is never sent twice](#a-create-is-never-sent-twice). A delete that Google answers with its own HTTP 404 (`NOT_FOUND`) is one request too: the entry is gone, and the call succeeds without a retry. In the write rows that succeed, the request sent once more is one more entry for an add (1 request), and `no_data` with no request for a delete (the entry is gone).
8. **One POST with 100 `nutrition_log_add` calls creates 45 entries.** The calls take turns in the order of the POST. Each of the first 45 creates its entry and answers its `entry_id`. Each of the other 55 answers `invalid_input`, `this MCP request already sent all the Google Health requests one request may send: the entry was not sent`, with the hint `send this call in a request of its own`, and nothing is sent for it. So no entry is sent without being reported: the test compares the entries the fake API holds with the ids the calls answered. The row never succeeds, because it sends the same 100 calls again, and each POST creates 45 more entries. A client sends again only the calls that answered this error: the test then needs 3 POSTs for the 100 entries (45, 45 and 10), and each entry exists once.

## Food log writes

Two tools write to Google Health. `nutrition_log_add` creates one entry of the food log, and `nutrition_log_delete` deletes one entry that this server created. The Go server has no write tool (`docs/CAPABILITY.md` R2: the Go server makes no write calls), so these two are the Worker's own. They follow the contract of every tool: `defineTool` and `register`, the stable error codes, one `tool_call` log line.

**The request shapes come from Google's documentation. No call to the real API has tested them.** [What the documentation does not settle](#what-the-documentation-does-not-settle) lists each open point and what the server does about it.

### The two tools

`nutrition_log_add` logs one meal or food item, with the calories and macros that the MCP client estimated (for example from a photo).

| Input | Rule |
|---|---|
| `name` | required text; the spaces around it are cut; 1 to 64 characters (code points); visible characters only: no control character, no format character (a zero-width space or joiner, a text direction mark, a soft hyphen), no line or paragraph separator, no replacement character (U+FFFD) and no half of a surrogate pair |
| `meal_type` | required: `BREAKFAST`, `LUNCH`, `DINNER` or `SNACK` |
| `kcal` | required number, 0 to 10,000 |
| `protein_g`, `carbs_g`, `fat_g` | optional numbers, 0 to 2,000 each; a macro that is left out is not sent: it is unknown, not 0 |
| `date` | optional local day, `YYYY-MM-DD`; today when left out; never after today; at most 30 days before today |
| `time` | optional local time, `HH:MM` on a 24-hour clock, in the coach's zone (`HCM_TZ`); now when left out; required with a `date` before today; never after now |

- **The input is strict.** An unknown property, a wrong type or a value out of bounds is `invalid_input`, and nothing is sent. An optional input may be `null`; `date` and `time` may also be `""`. An error names the field and its bound, never the value.
- **A schema error repeats nothing that the client sent.** The arguments of a write are its payload, and the text of the schema validator names an unknown property by its key and can quote a value: `{"name":"X","meal_type":"LUNCH","kcal":1,"<a food name>":true}` would put the food name in the error. So the two write tools word their schema errors themselves (`defineTool(definition, { echo: false })`, `plainProblem` in `src/tools/schema.ts`). The message names a property that the schema declares and the rule that failed (`kcal must be a number`, `meal_type must be one of BREAKFAST, LUNCH, DINNER, SNACK`), and an unknown property has one fixed text: `the arguments hold a property that the tool does not have`. The code, the hint (`check the tool's input schema and retry`) and the 500-byte cap are those of every schema error. The other tools keep the validator's text, as the Go server has it.
- **The bounds** are the ones past which the food reads reject a value of an item (`MAX_ITEM_KCAL` and `MAX_ITEM_GRAMS` in `src/healthdata/nutrition.ts`). A single food item cannot pass them. A value that the tool accepts is a value that `nutrition_day` keeps, and a name that the tool accepts is the name that `nutrition_day` shows: see the next point. They are far inside the range Google documents for kcal and for grams, `[0, 100000]`.
- **The name.** Every food name goes through one filter when it is read (`clean` in `src/healthdata/decode.ts`): the filter drops control characters, format characters, line and paragraph separators, U+FFFD and a surrogate without its pair, and it cuts the name at 64 characters. The tool accepts only a name that this filter keeps unchanged. Otherwise a name of zero-width characters would be logged and then shown as an empty name, a text direction override would reach Google as it is, and a name of 120 characters would be shown as its first 64. So an emoji sequence that is joined with a zero-width joiner is refused. The error names the rule and never the name.
- **A DST change.** A time that the clocks skip is read as the first instant after the gap. A time that happens twice is read as the first of its two instants. This is the rule of the start of a day in `src/coach/date.ts` (`instantOf` next to `bounds`). The output shows the time that was logged.
- **The output:** `entry_id` (the data point name that Google returned), `date`, `time`, `meal_type`, the numbers that were sent (`null` for a macro that was not), and a `notice` that says the values are the client's estimate. It does not repeat the food name. `nutrition_day` lists the same `entry_id` on the item, so a later chat can delete the entry without the id from this call.
- **Annotations:** not read-only, not destructive, not idempotent, `openWorldHint: true` (it writes to an external service).

`nutrition_log_delete` takes `entry_id`: at most 256 characters, the name of a nutrition-log data point (`users/<user>/dataTypes/nutrition-log/dataPoints/<id>`). That name is the one `nutrition_log_add` returned, which is also the `entry_id` `nutrition_day` lists on the item. It returns `{entry_id, deleted: true}`. Annotations: not read-only, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`.

Both descriptions say what the tool writes and where, and that it gives no dietary or medical advice. They carry the medical guardrail of the other tools: never diagnose, never suggest starting, stopping or dosing a medication or a supplement.

### The request shapes

The client (`src/googlehealth/client.ts`) lets exactly two writes pass, both for the data type `nutrition-log` and both compared as whole texts (`writeTarget`). Every other method, path, user or data type is refused before a token is asked for. `test/googlehealth-write.test.ts` pins the list.

**Create** ([create reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create), [nutrition guide](https://developers.google.com/health/data-types/nutrition), [DataPoint reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints), [scopes](https://developers.google.com/health/scopes)):

```
POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints
scope: https://www.googleapis.com/auth/googlehealth.nutrition.writeonly (granted at sign-in)

{"nutritionLog":{
  "interval":{"startTime":"2026-10-16T11:15:00Z","startUtcOffset":"-10800s","endTime":"2026-10-16T11:15:01Z","endUtcOffset":"-10800s"},
  "foodDisplayName":"…","mealType":"LUNCH",
  "energy":{"kcal":431.5},
  "totalCarbohydrate":{"grams":51.25},
  "totalFat":{"grams":17.5},
  "nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":23.75}}]}}
```

- Carbohydrate and fat go in the item's own total fields and protein in the nutrient list: the places the food reads take them from. A macro that was left out has no key.
- The answer is an `Operation`. The guide shows it finished: `{"done": true, "response": {"@type": "…DataPoint", "name": "users/<user id>/dataTypes/nutrition-log/dataPoints/<id>", "dataSource": {"platform": "GOOGLE_WEB_API", …}, "nutritionLog": {…}}}`. The `entry_id` is that `name`.

**Delete** ([batchDelete reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/batchDelete), [nutrition guide](https://developers.google.com/health/data-types/nutrition)). The API has no other delete for a data point:

```
POST https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete

{"names":["users/me/dataTypes/nutrition-log/dataPoints/<id>"]}
```

- The answer is an `Operation`. The server never uses the wildcard data type (`dataTypes/-`) and never sends more than one name.
- A write answer is read through a cap of 64 KiB and parsed whole.

### A create is never sent twice

A create is not idempotent. Google ignores an ID that the client provides, and its [data management page](https://developers.google.com/health/data-management) says that a `POST` sent again after a timeout creates a duplicate. So:

- **A create is sent again only after an answer that proves Google did not take it:** HTTP 429, a quota 403 (`RESOURCE_EXHAUSTED`), and the one token renewal after a 401 or the stale-token 403. When the 4 attempts end, the tool answers `upstream_unavailable` with the hint `the entry was not created; try again in a few minutes`.
- **When the outcome is unknown, the call ends at that one request.** A network error, a timeout (30 seconds), HTTP 408, any 5xx, an answer over the size cap, and an answer that breaks while it is read are all unknown. The tool answers `upstream_unavailable` with the hint `the entry may exist: check the day with nutrition_day before a new try (an entry this server has no id for shows there as food from another source; when the day already had food from another source, check the food log in the Fitbit app instead)`.
- **What that check can show.** An entry that was created without its id reaching the server has no row, so it is not the server's own: `nutrition_day` leaves it out and raises `other_source_food_excluded`. That is one flag, not a count. On a day without other food from another source, the flag answers the question: it is there when the entry exists. On a day that already had food from another source, the flag was there before the add, and `nutrition_day` cannot decide. Then only the food log itself can: the Fitbit app shows every entry of the day.
- **An `Operation` that gives no name is unknown too.** That is an `Operation` that is not finished (the API has no method to ask for it again), one that carries an `error`, and one whose `response.name` is not a nutrition-log data point name. The tool answers the same `upstream_unavailable` with the same hint, and the log has `google health write answer not usable` with the reason. An id is never made up.
- **A delete names its entry, so it is idempotent.** It keeps the retry rules of a read: 4 attempts for 429, 408, 5xx and network errors.

### Only the entries of this server are deleted

Google's documentation does not prove that `batchDelete` refuses the name of a data point that another app wrote (see below). So the server does not rely on Google for it.

- Migration 5 adds the table `nutrition_entries` to the object's SQLite store: the Google account that was linked when the entry was created (its `sub`), the data point name that the create answered, the local day of the entry, and the creation time. The account and the name are the primary key. It holds no food name and no nutrient value.
- **An entry belongs to one Google account.** A delete goes out with the token of the account that is linked now. So the store knows only the entries of the linked account: an entry that was created for another account is `no_data`, and nothing is sent for it. Without this rule, a delete of an old `entry_id` after another account is linked would reach Google with the wrong account's token, and a "not found" answer would read as a delete. The rows of the other account stay in the table: they are its entries again when it is linked again. **With no account linked** (Google refused a token renewal, and the link was removed), no row matches either, but `no_data` would be false: the entry can be the entry of the account that must sign in again. So a delete then answers `auth_expired`, `not signed in to Google Health`, with the reconnect hint. It answers that for every well-formed id, so the answer does not say which entries exist. Nothing is sent, not even a token request, and the row stays: the same delete works after the same account signs in again. An entry is recorded only when the account that was linked before the create is still the linked one after it.
- **An add:** check the input, send the create, store the returned name, answer. When the store write fails after Google took the entry, the tool answers `internal_error` with a text of its own: `the entry was created in Google Health, but this server could not record it, so it cannot delete the entry`, hint `do not log the same food again`. The log has `tool_internal_error` with the tool name and the error's type names.
- **A delete:** an `entry_id` that is not a nutrition-log data point name is `invalid_input`. After that check, a delete without a linked Google account is `auth_expired`. With an account linked, a name that is not in the table, exactly as stored, is `no_data`. In the three cases nothing is sent to Google: not for an id of another data type, another user path or a name with more path parts, and not for the band's own food. After a delete that happened, the row is removed. An HTTP 404 that is Google's own JSON error with the status `NOT_FOUND` means the entry is already gone: the row is removed and the answer is the same `{entry_id, deleted: true}`. Any other 404 (the HTML page of a front end, a JSON body without that status) does not prove that the entry is gone: the tool answers `Google Health refused the delete`. After that and after any other error the row stays, so the delete can be asked again.

### The food reads count the entries of this server

The food reads keep only the items of the Fitbit platform, as the Go server does. An item of another platform is left out: it raises `other_source_food_excluded`, and it makes the kcal delta of `nutrition_day` null. An entry written through the API has the platform `GOOGLE_WEB_API` (the answer of the guide's example). So without one more rule the coach would not count the meals it logged itself.

- **The rule.** The nutrition source (`src/healthdata/nutrition.ts`) also keeps an item whose data point ID is in the table of the entries this server created. Every other item of another platform stays "other source", as before.
- **By ID, not by name.** The ID is the last path part of the name. A create answers `users/<user id>/…`, and a list can name the user in another form.
- **By day.** The table is asked for the entries of the days of the read, with one day of margin on each side. It is one store read through an index, and no request to Google.
- **By account.** Only the entries of the Google account that is linked now count. After another account is linked, an entry of the account before is not its own: it reads as food of another source, as every item of another platform does.
- **The id on the item.** `nutrition_day` sets `entry_id` on each listed item. It is the name the create answered, the name the table and `nutrition_log_delete` match exactly, when the item's data point id is one this server created for the linked account. A list may name the user as `me` or by an id; the two are the same entry when the data point id matches, and the tool returns the stored name either way. An item from the band or another app, and an entry of another linked account, has `entry_id` null. The names are read with the food log, before its Google request, so a relink during the request cannot pair the item with the new account's name. The lookup is one indexed read of the range plus the `has` check per listed item, no Google request.
- **Every food read has the rule:** `nutrition_day`, `weekly_report` and the food metrics of `metric_series`. The source label of such an item is `GOOGLE_WEB_API`.
- **This is a deliberate difference from the Go server**, which writes nothing to Google Health and so has no such rule. It is a commit of its own: `feat(workers): count the entries this server logged in the food reads`. Two later commits change only this rule and its tests: `test(workers): damage a stored entry name without naming the columns` and `fix(workers): count only the linked account's entries in the food reads`. To keep the Go rule, revert the three, the newest first. The two tools still add and delete, and an entry of this server then reads as food of another source.

### The request budget of a write

- A write takes one unit of the 45 for each HTTP attempt, like a read. The two tools take turns with the coach tools on the one budget and the one token answer of the MCP HTTP request.
- A write that finds no unit left is not sent. It answers `invalid_input`, `this MCP request already sent all the Google Health requests one request may send: the entry was not sent` (or `the delete was not sent`), with the hint `send this call in a request of its own`. It is not the "date range" text of a read.
- The highest count of external fetches of one MCP HTTP request stays 49. See points 7 and 8 of [Measured subrequests](#measured-subrequests).

### The errors of a write

| Case | Code | Message |
|---|---|---|
| An input out of its rule | `invalid_input` | names the field and the bound |
| No Google account linked, or a 401 after the one renewal | `auth_expired` | `not signed in to Google Health`, or `Google Health rejected the sign-in`; the reconnect hint |
| HTTP 403 that is not a quota answer | `scope_missing` | `Google Health denied the write of nutrition-log data`; the hint names the reconnect step and `googlehealth.nutrition.writeonly` |
| Another 4xx, and a 404 of a delete that is not Google's `NOT_FOUND` | `invalid_input` | `Google Health refused the entry` or `Google Health refused the delete`, then Google's ErrorInfo `reason` and `error.message` when the body has them. The message is cut to about 200 characters, and a token, an email address or a user identifier in it is left out. Hint: `the entry was not created; check the date, the time and the values`, or `the entry was not deleted`. The log line `google health request rejected` has the HTTP status, Google's status enum, and, for a write, the same reason and message. A read logs only the status and the enum |
| 429 or a quota 403 on every attempt | `upstream_unavailable` | `Google Health API is unavailable`; hint: the entry was not created (or, for a delete, to call it again) |
| An add whose outcome is unknown | `upstream_unavailable` | hint: the entry may exist |
| A delete of an entry that is not this server's own | `no_data` | `this server created no entry with that id` |
| The store write fails after Google took the entry | `internal_error` | the text above |

No error message holds a food name or a number of the entry. A write that Google refuses may repeat Google's short `error.message` and the `reason` of an ErrorInfo, and nothing else of the answer: not the request body, a token, an email address or a user identifier. A read never repeats the body. No log line holds the payload: the lines of a call are `tool_call`, the client's own lines (a data type, an HTTP status, a retry count, a reason, and for a refused write the short message) and, for an internal error, the type chain.

### What the documentation does not settle

Where the pages disagree or say nothing, the server takes the reading that cannot write a wrong entry or delete a wrong one. A real call must still confirm each point.

1. **The UTC offsets.** The reference marks `startUtcOffset` and `endUtcOffset` as required (`SessionTimeInterval`). The example request of the guide leaves them out, and its answer then shows `"0s"`. The server sends both, as the seconds of the coach's zone at the instant of the entry (`"-10800s"` in São Paulo). Without them Google would read the local time of the entry as UTC: an evening meal would land on the next civil day. The only format example of the reference is positive (`"3.5s"`); a negative value is not shown.
2. **The length of the interval.** An interval whose start equals its end is empty, and Google rejects the write (`INVALID_ARGUMENT`). The nutrition guide's meal lasts 30 minutes and its water example lasts 1 second. The server sends that shorter window: `endTime` is `startTime` plus one second, and `endUtcOffset` is the same value as `startUtcOffset`. The entry still belongs to the local day of its start. The food reads take the day from `startTime`, so an entry at 23:59:59 stays on that day when its end is 00:00:00.
3. **`serving`.** The example of the guide sends `serving.amount` alone. The reference marks `foodMeasurementUnit` as required inside `serving`, and `serving` itself as optional. The server sends no `serving`.
4. **`foodDisplayName`** has no Required or Optional mark in the reference. The guide says to set it for a food without a food ID. The server always sends it.
5. **`mealType`.** The field text of the reference names four values, and its enum holds ten. The tool takes the four that `nutrition_day` orders its meals by.
6. **The `Operation`.** Both writes answer an `Operation`, and the examples of the guide show it finished. No page lists a method to ask for an `Operation` again. So the server cannot wait for one that is not finished: see [A create is never sent twice](#a-create-is-never-sent-twice). For a delete, an `Operation` that is not finished or carries an error is `upstream_unavailable`, the row stays, and the delete can be asked again.
7. **The answer of `batchDelete` for nutrition-log** is not shown: the guide shows it for hydration-log only. The server takes a finished `Operation` without an error as a delete that happened, and does not read the list of points in it.
8. **A delete of an entry that is already gone.** No page says what `batchDelete` answers for it. The server takes as "already gone" only an HTTP 404 whose body is Google's JSON error with the status `NOT_FOUND`. A 404 without that body is what a front end answers for a path or a body that is wrong, and the `batchDelete` shape itself is not proven: taken as "gone", it would make the server forget an entry that Google still holds. For such a 404 and for any other 4xx, the tool answers `Google Health refused the delete` and the row stays. If Google answers a missing entry in another way (for example a finished `Operation` that lists nothing), the server reads it as a delete that happened.
9. **Whose data points `batchDelete` deletes.** The data management page says that only the creator of a record can modify it, and the scopes page describes the write scope as adding nutrition data and editing or deleting the data it adds. No page says that `batchDelete` refuses the name of another app's data point. The table of [Only the entries of this server are deleted](#only-the-entries-of-this-server-are-deleted) is the answer.
10. **The two forms of a name.** A request names the user as `me`, and an answer names the user by an ID. The delete request writes the name under `users/me`, the form of the guide's example; the reference says that every name must share the parent of the path. The table keeps the name as the create answered it. No page says which form a list uses for an entry written through the API, so `nutrition_day` does not assume one: it matches the data point id and returns the stored name, which is the `entry_id` `nutrition_log_delete` accepts.
11. **The characters of an ID that Google makes** are not documented (a client-provided ID is 4 to 63 lowercase letters, digits and hyphens). The server accepts `[A-Za-z0-9_.-]{1,128}`, the pattern the reads already use for a data point name. A create whose answer has another form is an entry that may exist, without a usable id.
12. **An entry cannot be changed.** The guide says that a log of a food without a food ID cannot be updated: delete it and create a new one. So there is no edit tool.
13. **The fields of a food without a food ID.** The nutrition guide, under "Anonymous food", says to provide `nutrients`, `energy`, `energyFromFat`, `totalCarbohydrate` and `totalFat`. The reference marks all five as optional, and the guide's own example leaves `energyFromFat` out. The server follows the reference: it always sends `energy`, it sends `totalCarbohydrate`, `totalFat` and the protein entry of `nutrients` only for the macros that the client gave, and it never sends `energyFromFat`. So an add with kcal alone sends `energy` alone. If Google enforces the guide's list, such an add answers `Google Health refused the entry` and nothing is written; an add with all three macros would then still lack `energyFromFat`.

Also not proven, because no real call was made: that Google accepts each field as sent; how a list reports an entry that was written through the API (its platform, the form of its name); and that the `nutrition.writeonly` scope alone allows the delete.

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

### When another Google account is linked

The object holds one link. A sign-in replaces it. When the operator changes `ALLOWED_GOOGLE_EMAIL` and another account signs in, the object must not serve the data of the account before it:

- **The cache of daily values is emptied.** A row of `daily_metrics` does not say whose day it holds. So `linkGoogleAccount` empties the table, in the same transaction as the new link, when the `sub` of the account that signs in is not the stored one. It also empties it when no link is stored: a revoked link is removed, and then nothing says whose days the cache holds. A new sign-in of the same account keeps the cache. The cache is disposable: the next read fetches the days again.
- **The food entries of the account before are no longer this server's own.** Each row of `nutrition_entries` holds the account its entry was created for, and `nutrition_log_delete` knows only the entries of the linked account (see [Only the entries of this server are deleted](#only-the-entries-of-this-server-are-deleted)). The rows stay, for when their account is linked again.
- **The coach memory stays.** The profile, targets, health items, labs, preferences and notes are the person's own and are not tied to the Google account.

## Setup

Deploy your own single-user instance from the `workers` directory. Sign in to Cloudflare first (`npx wrangler login`), in the account where this Worker should live. You need your own Google Cloud project and OAuth client (type **Web application**), your own KV namespace, and the one Google account that may sign in. This repository does not include a Cloudflare account id, a project id, a real KV namespace id, or an account address.

The Google Health API scopes and `nutrition.writeonly` must be enabled on your Google Cloud project.

1. In Google Cloud console, create an OAuth client of type **Web application**.
   - Authorized redirect URIs: `https://<worker host>/callback` and, for local runs, `http://localhost:8788/callback`.
   - While the consent screen is in **Testing** status, add your account as a test user. Google expires refresh tokens of Testing apps after 7 days.
2. Create your own KV namespace and set its `id` in `wrangler.jsonc` under `kv_namespaces` (`OAUTH_KV`). The committed `id` (`00000000000000000000000000000000`) is a placeholder so tests and `wrangler types` have a value; replace it with the id this command prints:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. Set the three secrets. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are that OAuth client. `ALLOWED_GOOGLE_EMAIL` is the one Google account allowed to sign in, and it is a secret so the address stays out of git:
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

- `test/health-e2e.test.ts`: the OAuth sign-in through the Worker, then `tools/list` (20 tools), the prompts, `coach://guardrails`, one call of each coach tool, and one error of each kind (`no_data`, `invalid_input`, `auth_expired`, `scope_missing`, `upstream_unavailable`).
- `test/foodlog-e2e.test.ts`: the same sign-in, then `nutrition_log_add`, `nutrition_day` of that day, `nutrition_log_delete`, a second delete of the same id (`no_data`), and one error of each kind that a write can give.
- `test/tools-foodlog.test.ts` (the input and time rules of the two write tools, and each tool through `/mcp` of the object) and `test/googlehealth-write.test.ts` (the allowlist of the client, the request bodies, the retry rules and the `Operation` cases).
- `test/subrequests.test.ts`: the table of [Measured subrequests](#measured-subrequests).
- `test/coach-e2e.test.ts` and `test/memory-e2e.test.ts`: the detailed cases of the coach tools and of the memory tools over `/mcp`.

### Parity with the Go server

`test/parity.test.ts` compares the 17 tools that the Go server lists with `test/fixtures/go-tools-list.json`, the `tools/list` result of the Go server. The Worker lists 3 tools more. The test pins them in a list of tools the Go server does not have (`google_account_status`, `nutrition_log_add`, `nutrition_log_delete`), so a tool that is in neither list fails the test. `test/prompts.test.ts` compares the prompts and the resource with `test/fixtures/go-prompts.json`, the Go server's answers to `prompts/list`, each `prompts/get`, `resources/list` and `resources/read`. Generate the fixtures again after a tool definition, a prompt or the guardrails change in Go:

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

- **The budget error.** A call that needs more than the 45 Google Health requests of its MCP HTTP request answers `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range`. The Go server gives this error only at 200 pages or 64 MiB. Here it also comes at 16 MiB per response and 32 MiB per call, and the 32 MiB cover all the chunks of one rollup. In a request with several tool calls, a call that runs out of budget after earlier calls took units has the hint `use a shorter date range, or send this call in a request of its own`.
- **Retries that use the budget up** are `upstream_unavailable`. So is a request that Google rejects for its token when the budget has no unit left to send it again.
- **Every network error is retried.** The Go server fails fast on a DNS not-found and on a certificate error; `fetch` in workerd does not tell the kinds apart.
- **`Retry-After` as a date is read only in the IMF-fixdate form.** The Go server also reads the two obsolete forms.

The token rules:

- **One forced renewal per MCP HTTP request.** The Go server allows one per page. After it, a second `401` in the same request is `auth_expired`.
- **The store is asked for a token at most twice per request.** A token that passes its expiry during a long request is not renewed by the clock: Google rejects it, and the forced renewal renews it. A failure of the token endpoint is asked once per request, whatever the request calls.
- **`google_account_status` shares the token answer of its request**, so in a batch it reports the state at the first ask.
- **The coach tool calls of one HTTP request run one after the other** and share the budget. The Go server runs calls at the same time. Two HTTP requests at the same time are not ordered here either: each has its own budget.

Effects of a narrow read:

- **A narrow read serves a settled day from its own cached rows.** The Go server serves a cached activity day only when its steps, zone-minutes and total-calories rows are all there, so it reads the day again when one of the three totals is missing. Example: a settled day with a zone-minutes row and no steps row is served from the cache by `metric_series azm`; the Go server reads that day again on every call. So a total of such a day that changes at Google after the day settled shows in the Go server, and not here. The Go rule is not kept: a tool that reads one total writes one total, so it would never find a cached day, and `metric_series total_calories` over 366 days would cost 45 requests on every call.
- **`unreadable_records` counts only the data that was read.** For example `metric_series resting_hr` does not see an unreadable sleep record, `morning_briefing` does not see an unreadable total-calories row of yesterday or a body-fat reading, and `metric_series total_calories` does not see a total-calories row of a day without the band. The Go server reads every value. When such a row is the only activity data of the day, `nutrition_day` (an unreadable steps row) and `morning_briefing` (an unreadable total-calories row) answer `band_not_worn` without `unreadable_records`; the Go server answers `unreadable_records` without `band_not_worn`.
- **A worn day without a zone-minutes row reads as 0 minutes also when an unreadable steps or total-calories row is in the same run** and the tool did not read that rollup. The Go server gives no value for that day.
- **`sources` of `metric_series resting_hr`** holds the labels of the resting heart rate records only. The Go server adds the labels of the sleep records.
- **`metric_series total_calories` gives `band_not_worn` for every day without band data**, also a day without any activity data. The flag `band_not_worn` is then set, and a week point counts the day in `days_left_out`. The Go server gives such a day `null` without a reason. The value of every point is the same.

Output forms:

- **Session times are written in the coach's zone** (`2026-10-14T19:00:00-03:00`), as night and food times are. The Go server writes a session time as the record carried it (`…Z` for the API's UTC instants). The instant is the same.
- **`nutrition_day` items include `entry_id`.** The Go server's items do not. It is the stored name of an entry this server created for the linked account, or null.
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

Writes to Google Health (the Go server has none):

- **Two tools write the food log.** `nutrition_log_add` and `nutrition_log_delete` exist only here; the Go server is read-only on Google Health. They are the only tools with `openWorldHint: true`. See [Food log writes](#food-log-writes).
- **The Google Health client is not read-only.** Next to the reads of the Go client, it sends the create of one nutrition-log data point and the delete of nutrition-log data points by name, and no other write.
- **The store has a table that the Go store does not have:** `nutrition_entries` (migration 5), the entries this server created.
- **The food reads keep the entries this server created**, although their platform is `GOOGLE_WEB_API` and not Fitbit. The Go server leaves out every item of another platform. An item of another platform that this server did not create is left out here too. See [The food reads count the entries of this server](#the-food-reads-count-the-entries-of-this-server), which also says how to take the rule out.

Logs:

- **Log lines are `console.*(message, {fields})`** with the Go messages and field names. `wait_ms` is a number (Go logs a duration as `wait`). A network error logs only the type names of its cause. `from` and `to` of an "unreadable …" line are the range of the Worker's own request, which can be wider than the Go server's run.

## Workers Free plan

- **Worker CPU: 10 ms per request.** The Worker isolate does OAuth and the allowlist check, then forwards the request. Its work does not grow with the size of the arguments or of the result, and it makes no request to Google.
- **Subrequests: 50 per invocation.** See [The request budget](#the-request-budget) and [Measured subrequests](#measured-subrequests): the highest measured count of one MCP HTTP request is 49.
- **Google Health rate limit: 300 requests per minute per user.** One MCP HTTP request sends at most 45, one after the other; requests at the same time send at most 45 each. Over the limit Google answers 429, which is retried.
- **Rows written: 100,000 per day** for SQLite in Durable Objects. A note also writes rows to its full-text index. The `daily_metrics` cache writes up to 15 values per day when the day settles. Each value counts 3 rows written: its row, its primary key entry and its entry in the index `(metric, date)`. A cold year is about 16,500 rows written, once. An entry that `nutrition_log_add` creates counts 3 rows written too (its row, its primary key entry and its entry in the index of the day), and the check of a delete reads 1 row.
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
- The tool calls of one MCP HTTP request share the 45 requests. A call that finds units taken by the calls before it can answer the budget error for a range that fits a request of its own. Its hint says so: `use a shorter date range, or send this call in a request of its own`.
- Two MCP HTTP requests at the same time are not ordered. Each has its own budget, so together they can send more than 45 Google Health requests, fetch the same window twice, and need twice the memory of one request. The estimate of 64 MiB is for one request; nothing stops two of the largest calls at the same time.
- `workout_review` by `date` of a day whose session lists and heart-rate lists need more than 45 requests cannot succeed: nothing of them is cached. `exercise_id` reviews one session of such a day with one heart-rate list.
- The two food log tools rest on Google's documentation only: no real call has tested their request shapes. See [What the documentation does not settle](#what-the-documentation-does-not-settle).
- `nutrition_log_delete` takes the `entry_id` that `nutrition_log_add` returned. `nutrition_day` lists that id on the item, so a later chat can delete the entry. An item this server did not create has `entry_id` null. The id is the stored name, matched to the list by data point id, because a list may name the user in another form than the create did.
- An add whose outcome is unknown, or whose row could not be stored, can leave an entry in Google Health that this server does not own. The server cannot delete it, and the food reads count it as food of another source.
- The food reads know an entry of this server by its data point ID and by its day (one day of margin). An entry that another app moves by two days or more reads as food of another source.
- Two MCP HTTP requests at the same time are not ordered, so the same food sent in two requests is logged twice. Inside one request the adds take turns, and each call adds its own entry: the server does not look for an equal entry.
- An entry cannot be changed: delete it and add it again. An entry can be dated at most 30 days back, and has one of four meal types.
- The account of an entry is the account that the store holds when the entry is recorded, checked against the one it held before the create. One MCP HTTP request keeps one Google token for all its tool calls. So when another account signs in between two tool calls of one request, a later add of that request can still go out with the token of the account before, and its row is then bound to the new account. The window is one request in flight during a change of `ALLOWED_GOOGLE_EMAIL`.
- A year in which every 31-day window has days without band data, in an account whose 31-day list of the band's steps has four pages or more, makes `metric_series` for `azm`, `total_calories`, `kcal_in` and `protein_g` over that year answer the budget error on every call. Use a shorter range.
