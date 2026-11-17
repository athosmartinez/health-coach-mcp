# health-coach-mcp (Cloudflare Workers)

Remote MCP server for the health coach. It serves Streamable HTTP at `/mcp`, protected by OAuth 2.1, so Claude, ChatGPT and other MCP clients can add it as a custom connector. It is single-user: only one Google account (`ALLOWED_GOOGLE_EMAIL`) can sign in. A public home page at `/` and a privacy policy at `/privacy` are served without sign-in, for the Google OAuth consent screen. The project overview is the root `README.md`.

## Tools, prompts and the resource

- `server_info`: the server name, version and transport.
- `google_account_status`: the linked account, its granted and missing Google Health scopes, and whether its access still works; never a token.
- The 11 coach memory tools (`docs/CAPABILITY.md` §4.2):
  `profile_get`, `profile_update`, `targets_set`, `health_item_upsert`, `health_items_list`, `labs_record`, `labs_query`, `preference_set`, `preferences_get`, `note_add`, `notes_search`.
- The 5 coach tools (`docs/CAPABILITY.md` §4.1). They read the Google Health API:
  - `morning_briefing`: last night's sleep, HRV and resting heart rate against the 28 days before, a readiness level, and yesterday's load.
  - `workout_review`: the sessions of a day (or one session by `exercise_id`), the week's sessions against the target, and the night after. A session this server logged includes `entry_id`, the id `exercise_log_delete` accepts.
  - `nutrition_day`: the food log of a day, per nutrient and per meal, against the targets in force and the calories burned. An item this server logged includes `entry_id`, the id `nutrition_log_delete` accepts.
  - `weekly_report`: an ISO week against the week before and the 28 days before it, the adherence to the targets, and the week's decision notes.
  - `metric_series`: one metric per day or per week, at most 366 days and 180 points.
- The 2 tools that write the food log. [Food log writes](#food-log-writes) has their rules.
  - `nutrition_log_add`: logs one meal or food item in Google Health, with the calories and macros that the MCP client estimated (for example from a photo), and returns the id of the new entry.
  - `nutrition_log_delete`: deletes one entry, and only an entry that this server created. The id is the one `nutrition_log_add` returned, which `nutrition_day` also lists on the item.
- The 2 tools that write the exercise log. [Exercise log writes](#exercise-log-writes) has their rules.
  - `exercise_log_add`: logs one completed workout session in Google Health, for a workout that the band did not record, and returns the id of the new session. An activity that is not in the tool's list is logged as `OTHER`, under the name that was given.
  - `exercise_log_delete`: deletes one session, and only a session that this server created. The id is the one `exercise_log_add` returned, which `workout_review` also lists on the session.
- The 4 MCP prompts: `morning_briefing`, `nutrition_review`, `workout_review`, `weekly_report`. Each tells the model to call `profile_get` and its tool, with the guardrails inline. The optional day is parsed as a calendar date before it reaches the text.
- The resource `coach://guardrails`: the coach guardrails, the text in `src/prompts/guardrails.ts`.

Seventeen of the tools are in the frozen `tools/list` snapshot in `test/fixtures/go-tools-list.json`, and twelve of them match it exactly (names, descriptions, annotations, schemas). The server lists 5 tools that snapshot does not have. Five tools in the snapshot differ on purpose: `server_info` adds `transport` to its output and has annotations, `nutrition_day` and `workout_review` add `entry_id` and sentences at the end of the description, `weekly_report` adds `cardio.vo2_max` and two sentences (one about `overlaps_band_session`, one about the daily VO2 max), and `metric_series` adds `vo2_max`. [Frozen contract](#frozen-contract) says how the tests pin that. [Behavior notes](#behavior-notes) lists what a client or an operator can observe that is easy to miss.

### How a tool call runs

1. The Worker isolate does only OAuth and the allowlist check (`src/index.ts`). It has 10 ms of CPU per request on the Free plan. An unauthenticated request gets `401` and a grant of an account that is no longer allowed gets `403`; neither reaches the object.
2. The Worker forwards the request to the `CoachStore` Durable Object (`stub.fetch`) without the `Authorization` header, and returns the object's response without reading its body.
3. The object serves the whole MCP request (`CoachStore.fetch`): JSON-RPC parsing, the Host and Origin checks, the input-schema check, the tool body next to its SQLite data, every request to Google, the log line and the serialization of the result. A tool calls the store directly: there is no Durable Object RPC call per tool. The object's `fetch` answers only `/mcp`, and only the Worker's stub can call it.
4. Every tool goes through `register` (`src/tools/register.ts`). A tool error reaches the client as JSON `{code,message,hint}` in the text content, with `isError` and no `structuredContent`. Arguments that fail the input schema are `invalid_input`. An unexpected error is `internal_error`: its text is never sent or logged.
5. One log line per call: `tool_call` with the tool name, `duration_ms`, `is_error` and `code`. Never arguments, results, error messages or stored values. An internal error also logs `tool_internal_error` with the tool name and the error's type names. The Google Health client logs a retry, a rejected token and a rejected request with the data type, the HTTP status and Google's status enum, and a write answer that it cannot use with the reason: never a request body, a response body or a token.

Source layout: `src/coach/` (local dates, tool errors, the envelope), `src/store/` (profile, targets, health items, preferences, labs, notes, the `daily_metrics` cache, the food entries and the workout sessions this server created), `src/googlehealth/` (the API client with its reads and its four writes, the shapes of the food log writes in `nutritionlog.ts` and of the exercise log writes in `exerciselog.ts`, the request budget, the access token of one request), `src/healthdata/` (records to daily values through the cache), `src/metrics/` (pure math), `src/tools/` (`register`, the schema builders, the memory tools, the coach tools, the two food log tools in `foodlog.ts`, the two exercise log tools in `exerciselog.ts`) and `src/prompts/`. The schema migrations and the Durable Object class are in `src/store.ts`.

## Google Health reads

The Workers Free plan allows 50 external subrequests per invocation. The design takes the strict reading: 50 for the whole MCP HTTP request, the Worker and the object together. The numbers are named in `src/googlehealth/budget.ts`.

### The request budget

- One MCP HTTP request may send at most **45** Google Health API requests. Every HTTP attempt counts: a first try, a retry, a page, a rollup chunk, and a request sent again after a token renewal.
- The token endpoint is outside that number. One request asks the store for an access token at most twice: at first, and once more after Google rejects the token. The normal worst case is 45 + 2 = 47 external fetches. A new sign-in that replaces the link during a renewal makes that renewal send a second request, so the bound is 45 + 4 = **49**.
- The object creates one budget and one token answer per MCP HTTP request (in the server factory that `createMcpHandler` calls for each request). A JSON-RPC batch is one HTTP request: all its tool calls share them, and `google_account_status` shares the token answer.
- The coach tools of one MCP HTTP request take turns. The Google requests of a request run one after the other, and a later call finds in the cache what an earlier call fetched.
- The turns are per MCP HTTP request. The object does not order two MCP HTTP requests: while one waits for Google, the object serves the other. Two requests at the same time each have their own budget and token answer (up to 49 external fetches each), can fetch the same window twice, and add their memory (see [Memory](#memory)). In the tests, two pairs of overlapping requests give the answers and the cache rows of the same requests in sequence. One queue for the whole object is not used: a request that stops while it holds the turn would block every later request.
- A request that would pass the budget is not sent. The tool answers one of two errors:
  - the call needs more pages or chunks than the budget has left: `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range`. When earlier tool calls of the same MCP HTTP request took units before this call started, the hint is `use a shorter date range, or send this call in a request of its own`: the same call can fit a budget of its own;
  - retries of a failing request used the budget up, or Google rejected the token of a request and no unit is left to send it again after the renewal: `upstream_unavailable`, as when the 4 attempts of a request run out. The rule: a page that was never tried is `invalid_input`; a request that was tried and cannot be sent again is `upstream_unavailable`.
- A failing request is tried 4 times, with waits of about 1, 2 and 4 seconds (jittered; a `Retry-After` of up to 8 seconds is honored).

### Batching

A source fetches the missing days in as few requests as it can (`src/healthdata/plan.ts`):

- **Windows.** A long range is fetched in windows, oldest first: 63 nights for sleep and HRV (the most nights whose HRV samples fit one page), 90 days for the steps and zone-minutes rollups, 14 days for the total-calories rollup (the API's caps), 31 days for a list of the band's step records. The settled days of a finished window (up to today − 3) are written to the cache before the next window starts. So a call that ends with the budget error leaves its finished windows in the cache, and the same call again needs fewer requests.
- **Merged runs.** The missing days of a window are fetched as one covering range. Days of that range that are already cached keep their cached value. A cache with holes never needs more requests than a cold cache.
- **Narrow reads.** A tool reads only what its values need. `metric_series resting_hr` does not list sleep; `metric_series steps` reads only the steps rollup; `morning_briefing` does not read total calories; `weekly_report` and the food metrics read them only for the logged days without a kcal target, and only for the days the band was worn. One exception: when the narrow read of `nutrition_day` or `morning_briefing` has no value for its day and dropped an unreadable row, the tool reads the total it left out for that one day (the steps rollup, or the total-calories rollup: one more request).
- **The "band worn" check** lists the band's step records only for the days without a zone-minutes row.
- **Never cached:** sessions, heart-rate samples, the food log, the daily VO2 max list, today and the 2 days before it (a day is cached when it is at most today − 3), and a day without band data. A steps or total-calories row is cached only for a day whose zone-minutes value is known, so `metric_series steps` alone costs the same on every call until a zone-minutes read covers its days.

### Memory

An isolate has 128 MB. The client never keeps the raw pages of a call (`src/googlehealth/client.ts`, `page.ts`):

- one response is at most **16 MiB**, and the responses of one call (all its pages and rollup chunks) at most **32 MiB**; over a limit is the budget error above, not retried;
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
| `weekly_report` | the current week, no kcal target | 13 | 0 | 13 | ok | 1 | 11 |
| `weekly_report` | the week before, no kcal target | 14 | 0 | 14 | ok | 1 | 4 |
| `metric_series` | `weight`, 366 days by week | 1 | 0 | 1 | ok | 1 | 1 |
| `metric_series` | `vo2_max`, 366 days by week | 1 | 0 | 1 | ok | 1 | 1 |
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
| `weekly_report` | dense account, the week before | 16 | 0 | 16 | ok | 1 | 4 |
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
| the five coach tools and `google_account_status` | one POST; today's briefing, a day with one session, a day of food, the current week, 7 days of steps; the access token is renewed first | 33 | 1 | 34 | ok | 1 | 29 |
| the five coach tools and `google_account_status` | one POST; the worst-case input of each tool; the access token is renewed first | 45, 45, 45, 45 | 1, 0, 0, 0 | 46, 45, 45, 45 | ok, budget error ×4, ok | none | — |
| `nutrition_log_add` | one entry | 1 | 0 | 1 | ok | 1 | 1 |
| `nutrition_log_add` | one entry; the access token is renewed first, and Google rejects the new one once | 2 | 2 | 4 | ok | 1 | 1 |
| `nutrition_log_add` | one entry; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |
| `nutrition_log_delete` | an entry this server created | 1 | 0 | 1 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created that Google no longer has (HTTP 404, `NOT_FOUND`) | 1 | 0 | 1 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created; the access token is renewed first, and Google rejects the new one once | 2 | 2 | 4 | ok | 1 | 0 |
| `nutrition_log_delete` | an entry this server created; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |
| `nutrition_log_add`, 100 calls | one POST with 100 entries; the access token is renewed first | 45, 45, 45, 45 | 1, 0, 0, 0 | 46, 45, 45, 45 | ok ×45, budget error ×55 | none | — |
| `exercise_log_add` | one session | 1 | 0 | 1 | ok | 1 | 1 |
| `exercise_log_add` | one session; the access token is renewed first, and Google rejects the new one once | 2 | 2 | 4 | ok | 1 | 1 |
| `exercise_log_add` | one session; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |
| `exercise_log_delete` | a session this server created | 1 | 0 | 1 | ok | 1 | 0 |
| `exercise_log_delete` | a session this server created; the token is renewed first, Google rejects the new one once, then answers 429 to every request | 5 | 2 | 7 | upstream_unavailable | none | — |

The highest count is **49 external fetches** in one MCP HTTP request: 45 Google Health requests and 4 token requests, in the row with the sign-in race. Without that race the highest count is 47. No row passes 50.

What the table shows:

1. **Every tool answers its worst-case input, in at most 2 requests.** Request 1 of the largest cases ends with the budget error after 45 requests; request 2 continues from the cached windows.
2. **Three inputs use exactly the 45 requests and succeed:** `total_calories` over 366 days (27 total-calories rollups, 5 zone-minutes rollups, 13 lists of the band's steps), and `hrv` and `sleep_asleep_min` over 366 days in the dense account (39 sleep pages, 6 HRV pages). One more page ends request 1 with the budget error, and request 2 succeeds.
3. **The worst case of `workout_review` is a `date`: 39 to 40 requests on a day with 33 sessions, a margin of 5 to 6.** Its session lists and heart-rate lists are never cached: 4 session pages and 31 heart-rate lists on every call (a max heart rate is read for the newest 31 sessions of the day). Each 25 more sessions in the day or in its week add one request. A day that needs more than 45 answers the budget error on every call. With `exercise_id` the heart rate is listed for that session only: 7 session pages (3 of them for the lookup of the day in the last 28 days) and 1 heart-rate list, 12 requests here.
4. **A day without band data is checked again on every call.** Over a year the repeated "band worn" check costs `5 + 13 × pages` requests, where `pages` is the pages of one 31-day list of the band's steps: 18 with one page, 31 with two (the table has 29 to 31). With three pages it is 44, and with four it is 57: over the budget on every call. Three and four pages are not measured.
5. **A JSON-RPC batch shares one budget.** A call that does not fit answers the budget error, and no request is sent for it. Its hint names a request of its own when the calls before it took units (the four calls of the last row). The same POST sent again succeeds only when the parts of its calls that are never cached fit one budget together. The POST with the worst-case input of each tool never does: send such calls in requests of their own.
6. **Retries count.** With 503 on every request the call ends after 4 attempts. With three 503 answers before each answer the call ends at 45 requests with `upstream_unavailable`, after 33 waits (about a minute).
7. **A write is one Google Health request, and at most 5.** `nutrition_log_add` and `nutrition_log_delete` send one request. Their worst case is 5 Google Health requests and 2 token requests (7 external fetches): the token is renewed first, Google rejects the new one (1 request), and Google then answers 429 to the 4 attempts. For an add, a 5xx answer or a network error ends the call at 1 request: see [A create is never sent twice](#a-create-is-never-sent-twice). A delete that Google answers with its own HTTP 404 (`NOT_FOUND`) is one request too: the entry is gone, and the call succeeds without a retry. In the write rows that succeed, the request sent once more is one more entry for an add (1 request), and `no_data` with no request for a delete (the entry is gone). `exercise_log_add` and `exercise_log_delete` go through the same client code and have the same counts: the last five rows.
8. **One POST with 100 `nutrition_log_add` calls creates 45 entries.** The calls take turns in the order of the POST. Each of the first 45 creates its entry and answers its `entry_id`. Each of the other 55 answers `invalid_input`, `this MCP request already sent all the Google Health requests one request may send: the entry was not sent`, with the hint `send this call in a request of its own`, and nothing is sent for it. So no entry is sent without being reported: the test compares the entries the fake API holds with the ids the calls answered. The row never succeeds, because it sends the same 100 calls again, and each POST creates 45 more entries. A client sends again only the calls that answered this error: the test then needs 3 POSTs for the 100 entries (45, 45 and 10), and each entry exists once.

## Food log writes

Two tools write the food log of Google Health. `nutrition_log_add` creates one entry of the food log, and `nutrition_log_delete` deletes one entry that this server created. Two more tools write the exercise log, with the same design: see [Exercise log writes](#exercise-log-writes). They follow the contract of every tool: `defineTool` and `register`, the stable error codes, one `tool_call` log line. `docs/CAPABILITY.md` R2 limits Google Health writes to these four tools.

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
- **A schema error repeats nothing that the client sent.** The arguments of a write are its payload, and the text of the schema validator names an unknown property by its key and can quote a value: `{"name":"X","meal_type":"LUNCH","kcal":1,"<a food name>":true}` would put the food name in the error. So the two write tools word their schema errors themselves (`defineTool(definition, { echo: false })`, `plainProblem` in `src/tools/schema.ts`). The message names a property that the schema declares and the rule that failed (`kcal must be a number`, `meal_type must be one of BREAKFAST, LUNCH, DINNER, SNACK`), and an unknown property has one fixed text: `the arguments hold a property that the tool does not have`. The code, the hint (`check the tool's input schema and retry`) and the 500-byte cap are those of every schema error. The other tools keep the validator's text.
- **The bounds** are the ones past which the food reads reject a value of an item (`MAX_ITEM_KCAL` and `MAX_ITEM_GRAMS` in `src/healthdata/nutrition.ts`). A single food item cannot pass them. A value that the tool accepts is a value that `nutrition_day` keeps, and a name that the tool accepts is the name that `nutrition_day` shows: see the next point. They are far inside the range Google documents for kcal and for grams, `[0, 100000]`.
- **The name.** Every food name goes through one filter when it is read (`clean` in `src/healthdata/decode.ts`): the filter drops control characters, format characters, line and paragraph separators, U+FFFD and a surrogate without its pair, and it cuts the name at 64 characters. The tool accepts only a name that this filter keeps unchanged. Otherwise a name of zero-width characters would be logged and then shown as an empty name, a text direction override would reach Google as it is, and a name of 120 characters would be shown as its first 64. So an emoji sequence that is joined with a zero-width joiner is refused. The error names the rule and never the name.
- **A DST change.** A time that the clocks skip is read as the first instant after the gap. A time that happens twice is read as the first of its two instants. This is the rule of the start of a day in `src/coach/date.ts` (`instantOf` next to `bounds`). The output shows the time that was logged.
- **The output:** `entry_id` (the data point name that Google returned), `date`, `time`, `meal_type`, the numbers that were sent (`null` for a macro that was not), and a `notice` that says the values are the client's estimate. It does not repeat the food name. `nutrition_day` lists the same `entry_id` on the item, so a later chat can delete the entry without the id from this call.
- **Annotations:** not read-only, not destructive, not idempotent, `openWorldHint: true` (it writes to an external service).

`nutrition_log_delete` takes `entry_id`: at most 256 characters, the name of a nutrition-log data point (`users/<user>/dataTypes/nutrition-log/dataPoints/<id>`). That name is the one `nutrition_log_add` returned, which is also the `entry_id` `nutrition_day` lists on the item. It returns `{entry_id, deleted: true}`. Annotations: not read-only, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`.

Both descriptions say what the tool writes and where, and that it gives no dietary or medical advice. They carry the medical guardrail of the other tools: never diagnose, never suggest starting, stopping or dosing a medication or a supplement.

### The request shapes

The client (`src/googlehealth/client.ts`) lets exactly four writes pass, each compared as a whole text (`writeTarget`): the create and the delete of the data type `nutrition-log`, below, and the create and the delete of the data type `exercise` ([Exercise log writes](#exercise-log-writes)). `writeTarget` answers the data type with the kind of the write, and every log line, error message and hint of a write names the data type of that write. Every other method, path, user or data type is refused before a token is asked for. `test/googlehealth-write.test.ts` and `test/googlehealth-exercise-write.test.ts` pin the list.

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

The food reads keep only the items of the Fitbit platform. An item of another platform is left out: it raises `other_source_food_excluded`, and it makes the kcal delta of `nutrition_day` null. An entry written through the API has the platform `GOOGLE_WEB_API` (the answer of the guide's example). So without one more rule the coach would not count the meals it logged itself.

- **The rule.** The nutrition source (`src/healthdata/nutrition.ts`) also keeps an item whose data point ID is in the table of the entries this server created. Every other item of another platform stays "other source", as before.
- **By ID, not by name.** The ID is the last path part of the name. A create answers `users/<user id>/…`, and a list can name the user in another form.
- **By day.** The table is asked for the entries of the days of the read, with one day of margin on each side. It is one store read through an index, and no request to Google.
- **By account.** Only the entries of the Google account that is linked now count. After another account is linked, an entry of the account before is not its own: it reads as food of another source, as every item of another platform does.
- **The id on the item.** `nutrition_day` sets `entry_id` on each listed item. It is the name the create answered, the name the table and `nutrition_log_delete` match exactly, when the item's data point id is one this server created for the linked account. A list may name the user as `me` or by an id; the two are the same entry when the data point id matches, and the tool returns the stored name either way. An item from the band or another app, and an entry of another linked account, has `entry_id` null. The names are read with the food log, before its Google request, so a relink during the request cannot pair the item with the new account's name. The lookup is one indexed read of the range plus the `has` check per listed item, no Google request.
- **Every food read has the rule:** `nutrition_day`, `weekly_report` and the food metrics of `metric_series`. The source label of such an item is `GOOGLE_WEB_API`.
- **The entries this server logged are kept on purpose.** The commits are `feat(workers): count the entries this server logged in the food reads`, then `test(workers): damage a stored entry name without naming the columns` and `fix(workers): count only the linked account's entries in the food reads`. Reverting those three, the newest first, leaves an entry of this server reading as food of another source. The two tools still add and delete.

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

## Exercise log writes

Two tools write the exercise log of Google Health. `exercise_log_add` creates one workout session, and `exercise_log_delete` deletes one session that this server created. They are for a workout that the band did not record. The design is the one of the food log tools: the same client code, an ownership table of the same form, the same request budget and the same error contract. This section says what a session has of its own, and names the part of [Food log writes](#food-log-writes) that holds the rest. `docs/CAPABILITY.md` R2 names these two tools next to the food log tools.

**The request shapes come from Google's documentation. No call to the real API has tested them.** [What the documentation does not settle for a session](#what-the-documentation-does-not-settle-for-a-session) lists each open point and what the server does about it.

### The two exercise tools

`exercise_log_add` logs one completed workout session.

| Input | Rule |
|---|---|
| `exercise_type` | required text. One of the 47 types of the list below, in any letter case, with spaces or hyphens between its words (`jiu-jitsu` is `JIU_JITSU`). Any other text is an activity that is not in the list: 1 to 64 visible characters, the rule of a food name |
| `date` | optional local day the session started, `YYYY-MM-DD`; today when left out; never after today; at most 30 days before today |
| `start_time` | optional local time, `HH:MM` on a 24-hour clock, in the coach's zone (`HCM_TZ`); required with `end_time`, and with a `date` before today |
| `end_time` | optional local time, `HH:MM`; give this or `duration_min` |
| `duration_min` | optional whole number, 1 to 1,440; give this or `end_time` |
| `kcal` | optional number, above 0 and at most 10,000; left out, the calories are unknown, not 0 |
| `notes` | optional text of one line, at most 500 visible characters; the spaces around it are cut |

- **The list of types:** `RUNNING`, `TREADMILL`, `TRAIL_RUN`, `WALKING`, `HIKING`, `BIKING`, `OUTDOOR_BIKE`, `MOUNTAIN_BIKE`, `STATIONARY_BIKE`, `SPINNING`, `SWIMMING`, `SWIMMING_POOL`, `SWIMMING_OPEN_WATER`, `ROWING`, `ROWING_MACHINE`, `ELLIPTICAL`, `STAIRCLIMBER`, `STRENGTH_TRAINING`, `WEIGHTLIFTING`, `FUNCTIONAL_STRENGTH_TRAINING`, `CALISTHENICS`, `CROSSFIT`, `HIIT`, `CIRCUIT_TRAINING`, `CORE_TRAINING`, `STRETCHING`, `YOGA`, `PILATES`, `JIU_JITSU`, `MARTIAL_ARTS`, `BOXING`, `KICKBOXING`, `MUAY_THAI`, `KARATE`, `TAEKWONDO`, `WRESTLING`, `SOCCER`, `BASKETBALL`, `VOLLEYBALL`, `TENNIS`, `PADEL`, `SURFING`, `DANCING`, `CLIMBING`, `JUMPING_ROPE`, `WORKOUT`, `OTHER`. Each one is a value of Google's `ExerciseType` enum. `test/fixtures/exercise-types.txt` holds the 181 values of the [DataPoint reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints), read on 2026-11-15, and a test checks that every type of the tool is one of them.
- **The schema has no `enum` for `exercise_type`.** An enum makes a client refuse an unknown activity before the server can log it. The description lists the values. The server cuts the spaces around the text, writes it in upper case and turns each run of spaces or hyphens into one `_`. A match is sent as that type. Any other text is sent as `OTHER`.
- **The name.** For a listed type the server sends a readable English name made from the type (`Jiu jitsu` for `JIU_JITSU`); the reference says that Google replaces it with a name of its own. For `OTHER` the server sends the user's text, as given. That text follows the rule of a food name (see [The two tools](#the-two-tools)): only a text that the read filter keeps unchanged is accepted, so `workout_review` shows the name that was logged. An error names the rule and never the text.
- **The start and the end.** Exactly one of `end_time` and `duration_min`.
  - With `start_time`, the session starts at that time of `date`. It ends `duration_min` later, or at `end_time`. An `end_time` after `start_time` on the clock is on the same local day. An `end_time` before `start_time` on the clock is on the next local day: a session across midnight. An `end_time` equal to `start_time` is a session without a length, and is refused.
  - Without `start_time`, only `duration_min` is allowed, and no `date` before today. The session ended now, at the whole minute, and started `duration_min` before. Its `date` is the local day of that start, which can be the day before.
- **Refused before anything is sent** (`invalid_input`, each with a hint): a session without a length, a session longer than 24 hours, a session that ends after now, `end_time` with `duration_min`, neither of the two, `end_time` without `start_time`, and a `date` before today without `start_time`.
- **A DST change.** A local time is read with the rule of the food log (`instantOf` in `src/coach/date.ts`): a time that the clocks skip is the first instant after the gap, and a time that happens twice is the first of its two instants. The start offset and the end offset are each the offset of its own instant, so they differ when the clocks change during the session. Two times that the clocks skip are the same instant: a session without a length. A session longer than 24 hours can come only from an `end_time` on a day of 25 hours.
- **The bounds.** The kcal bound is the one past which the exercise reads drop a session (`MAX_SESSION_KCAL` in `src/healthdata/exercise.ts`), and a session longer than a day is dropped by them too. A value that the tool accepts is a value that `workout_review` keeps.
- **The input is strict, and a schema error repeats nothing that the client sent.** The two tools word their schema errors themselves, as the two food log tools do (`defineTool(definition, { echo: false })`): the activity name, the notes or an entry id that was sent as a key is never repeated.
- **The output:** `entry_id` (the data point name that Google returned), `date` (the local day of the start), `start_time` and `end_time` (local `HH:MM`), `duration_min`, `exercise_type` (the type that was sent, so a mapping to `OTHER` is visible), `kcal` (`null` when it was not sent), and a `notice`. It does not repeat the activity name or the notes. The notice says that the calories are the client's estimate, that the session has no heart-rate data, that a type that is not in the list was logged as `OTHER` under the name given, and to keep `entry_id`.
- **Annotations:** not read-only, not destructive, not idempotent, `openWorldHint: true`.

`exercise_log_delete` takes `entry_id`: at most 256 characters, the name of an exercise data point (`users/<user>/dataTypes/exercise/dataPoints/<id>`). It returns `{entry_id, deleted: true}`. Annotations: not read-only, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`. It has no `date` input. To delete the session of a day without its id, read the day with `workout_review`: it lists `entry_id` on each session this server created, and null on every other session.

Both descriptions say what the tool writes and where, and carry the medical guardrail: no training or medical advice, never diagnose, never suggest starting, stopping or dosing a medication or a supplement. Nothing of a call is logged beyond the `tool_call` line: no type, no name, no value, no notes, no entry id.

### The request shapes of a session

**Create** ([create reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create), [workouts guide, "Write a workout session"](https://developers.google.com/health/data-types/workouts), [DataPoint reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints), [data types](https://developers.google.com/health/data-types)):

```
POST https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints
scope: https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly (granted at sign-in)

{"dataSource":{"recordingMethod":"MANUAL","platform":"GOOGLE_WEB_API"},
 "exercise":{
  "interval":{"startTime":"2026-10-16T10:10:00Z","startUtcOffset":"-10800s","endTime":"2026-10-16T11:25:00Z","endUtcOffset":"-10800s"},
  "exerciseType":"OTHER","displayName":"…",
  "activeDuration":"4500s",
  "metricsSummary":{"caloriesKcal":431.5},
  "notes":"…"}}
```

- The times are whole seconds in UTC. Each offset is `"<seconds>s"`, the offset of the coach's zone at that instant.
- `activeDuration` is always sent, as the whole length of the session: no pause is known, and the exercise reads drop a session without it.
- `metricsSummary` is always sent: `{}` without calories. `notes` is sent only when given. The server sends no data point name: the id is the one Google makes.
- The answer is an `Operation`. The guide shows it finished: `{"done": true, "response": {"@type": "…DataPoint", "name": "users/<user id>/dataTypes/exercise/dataPoints/<id>", "dataSource": {…, "platform": "GOOGLE_WEB_API"}, "exercise": {…}}}`. The `entry_id` is that `name`. An answer is accepted only when `response.name` is a data point name of the data type of the request: the name of a `nutrition-log` point is not the id of a session, and the name of an `exercise` point is not the id of a food entry.

**Delete** ([batchDelete reference](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/batchDelete)):

```
POST https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints:batchDelete

{"names":["users/me/dataTypes/exercise/dataPoints/<id>"]}
```

`src/googlehealth/exerciselog.ts` holds the two shapes. `test/googlehealth-exercise-write.test.ts` compares the create body with the request of the guide's example: the same keys, the same key order and the same value formats for the inputs of the example.

### What a session shares with a food entry

- **A create is never sent twice.** The rules of [A create is never sent twice](#a-create-is-never-sent-twice) hold. The hint of an unknown outcome names the read of the sessions: `the entry may exist: check the day with workout_review before a new try (a session this server has no id for is not listed there, and the result has the flag other_source_sessions_excluded; when the week already had a session from another source, check the exercise log in the Fitbit app instead)`. `workout_review` raises that flag for the day and for its week, and it is one flag, not a count.
- **Only the sessions of this server are deleted.** Migration 6 adds the table `exercise_entries`, with the columns and the day index of `nutrition_entries`: the Google account, the data point name, the local day the session started and the creation time. It holds no activity name, no notes and no value. The rules of [Only the entries of this server are deleted](#only-the-entries-of-this-server-are-deleted) hold, in this table: an entry belongs to one Google account; an id that is not an exercise data point name is `invalid_input`; no linked account is `auth_expired`; a name that the table does not hold is `no_data`; nothing is sent in the three cases. The two tables are apart: an id of the food log is `invalid_input` for `exercise_log_delete`, and an id of a session is `invalid_input` for `nutrition_log_delete`.
- **The request budget.** A write takes one unit of the 45 for each HTTP attempt. See [The request budget of a write](#the-request-budget-of-a-write) and the last five rows of [Measured subrequests](#measured-subrequests).
- **The errors.** The table of [The errors of a write](#the-errors-of-a-write) holds, with the data type and the scope of the write: an HTTP 403 is `scope_missing`, `Google Health denied the write of exercise data`, and the hint names the reconnect step and `googlehealth.activity_and_fitness.writeonly`. A delete that stays unavailable names `exercise_log_delete` in its hint. The log lines of the client have `data_type: "exercise"`. A session write has one error more, which a food log write does not have: see [A session write is bound to one Google account](#a-session-write-is-bound-to-one-google-account).
- **A refused write.** A 400 of Google reaches the tool error and the log as Google's ErrorInfo `reason` and short `error.message`, and nothing else of the body. Google's message can repeat a value of the request, and a session carries free text. So before the message is cut, the client takes out of it every text of the request that the caller wrote, compared without regard to letter case: for a create, the name of an activity that is not in the list, the notes and the calories as the body writes them (`431.5`); for a delete, the data point id. A text shorter than 3 characters is not taken out: it identifies nothing, and its removal would empty the message. The limit: the times and the type of the session are not taken out, and neither is a text that Google repeats in another form (cut short, or a number written another way). The `reason` is a constant and stays as it is. The food log writes keep their message as it was. The fake API of the tests checks an exercise create against the rules of the reference and answers HTTP 400 `INVALID_ARGUMENT` with an ErrorInfo otherwise. The rules: the four fields of the interval; each time an RFC 3339 timestamp (a date, a time, and `Z` or an offset, with at most nine fraction digits); each UTC offset a duration (`"<seconds>s"`, at most nine fraction digits, negative allowed); an end after the start; a documented `exerciseType`; a `displayName`; a `metricsSummary`; and, when the body has them, a `caloriesKcal` that is a number, an `activeDuration` that is a duration and not negative, `notes` that are a string, a `recordingMethod` of the documented enum, and no field that `Exercise` does not have. A test also sends each documented form, so the fake does not refuse what the reference allows. A fake that takes a body the real API refuses hides the defect: a food entry whose interval had no length passed such a fake.
- **An account that signed in before the scope was requested** has no exercise write scope. The two tools then answer `scope_missing`. `google_account_status` lists the scope in `scopes_missing`, and its `hint` says: `exercise_log_add and exercise_log_delete need googlehealth.activity_and_fitness.writeonly, which a new sign-in grants.` Disconnect and reconnect the connector to grant it.

### A session write is bound to one Google account

A tool reads the linked account from the store, and the client takes the access token on its own. The two can belong to different Google accounts when another account signs in during the request. Example: one MCP HTTP request holds `workout_review` and then `exercise_log_add`. Account B signs in while the read waits for Google. The request keeps the token of account A, and the add reads account B from the store. Without one more rule the session of A would be recorded as B's.

- **The token answer names its account.** `CoachStore.googleAccessToken()` answers the `sub` of the Google account the token belongs to: the row the token was read from, or the row whose refresh token renewed it. So the answer stays true when a sign-in replaces the link while a renewal is in flight.
- **The write names the account the tool checked.** `exercise_log_add` passes the account it read before the create, the one `record` then checks. `exercise_log_delete` reads the account once, uses it for the "not linked" check, and passes it to the delete.
- **The client compares the two before each HTTP attempt,** also after a token renewal. When the token is of another account, or its answer names no account, nothing is sent and no unit of the budget is taken.
- **The error** is `invalid_input`, `the linked Google account changed during this MCP request: the entry was not sent` (or `the delete was not sent`), with the hint `send this call in a request of its own`. When an attempt went out before the token changed (Google rejected the token of the first account, and the renewal answered the token of the second), the text ends with `was not sent again`. The code is the one of a write that the budget has no unit for: nothing is wrong at Google or with the sign-in, and the same call works in a request of its own, which reads the account and the token together. The log has `google health write not sent: the linked account changed` with the data type and the operation. Neither the error nor the log holds an account id, an email address or a token.
- **A read and the two food log writes are not compared.** They name no account to the client. See [Known limits](#known-limits) for the window that the food log tools keep.
- **One window stays for an add.** When the account changes while Google creates the session, the create went out with the right token, and `record` then refuses the row: the tool answers `internal_error`, `the entry was created in Google Health, but this server could not record it`. The session exists in the first account and this server does not own it.

`test/account-switch.test.ts` holds the three cases (an add and a delete after a read of the same request, and a delete whose token renewal races a sign-in). `test/googlehealth-exercise-write.test.ts` holds the rule of the client, and `test/store.test.ts` the account of each token answer.

### The exercise reads count the sessions of this server

The exercise reads keep only the sessions of the Fitbit platform. A session of another platform is left out and raises `other_source_sessions_excluded`. A session written through the API has the platform `GOOGLE_WEB_API` (the answer of the guide's example). So without one more rule the coach would not count the workouts it logged itself.

- **The rule.** The exercise source (`src/healthdata/exercise.ts`) also keeps a session whose data point ID is in the table of the sessions this server created. Every other session of another platform stays "other source", as before.
- **By ID, by day and by account,** as for the food reads: the ID is the last path part of the name; the table is asked for the days of the read with one day of margin; only the entries of the Google account that is linked now count. The names are read before the list request, so a relink during the request cannot swap names.
- **A logged session is `manual` and has no heart rate.** It carries the flags `manual_entry` and `no_hr_data`, and no heart-rate request is sent for it. Its source label is `GOOGLE_WEB_API`.
- **Nothing is merged or summed** between a session this server created and a session of the band (`docs/CAPABILITY.md` I2). They stay two records, each with its own values and source, and each counts as a session of the week.
- **The flag `overlaps_band_session`.** When a logged session covers time that a session of the band also covers, the logged session carries this flag: the same workout may be counted twice, and the client must see that. A session of the band that starts on the day before or after the range counts for the check. The band's session carries no new flag.
- **The flag on the result.** A result that shows week totals carries the flag in its own `quality_flags` when a session of the week carries it. `workout_review` has it when a session that `week_context` counted overlaps, also on a day other than the reviewed one. `weekly_report` has it when a session behind `adherence.sessions` overlaps. `morning_briefing` has it when a listed session of yesterday overlaps. The count and the minutes stay per record: the flag is the only sign that one workout may be in them twice.
- **The id on the session.** `workout_review` sets `entry_id` on each listed session: the name the create answered, when this server created the session for the linked account, and null on every other session. `exercise_id` is unchanged: it is the name of the list, and it still selects one session.
- **Every exercise read has the rule:** `workout_review`, `weekly_report` (the sessions of the week) and `morning_briefing` (yesterday's load, by type and never by name).
- **The sessions this server logged are kept on purpose.** The commit is `feat(workers): read the workout sessions this server logged`. Reverting it leaves a session of this server reading as a session of another source. The two tools still add and delete.

### What the documentation does not settle for a session

Where the pages disagree or say nothing, the server takes the reading that follows the guide's example. A real call must still confirm each point.

1. **`platform` in the request.** The reference marks `DataSource.platform` as output only. The request of the guide's only example sends `"platform": "GOOGLE_WEB_API"`. The server sends it, as the example does.
2. **`recordingMethod: MANUAL`.** The reference documents the value ("The data was manually entered by the user"). The example sends `ACTIVELY_MEASURED`. No page shows a create with `MANUAL`.
3. **`displayName`.** The reference marks it as required, and says that Google ignores the client's value and writes a name of its own for every type but `OTHER`. The request of the example leaves it out. The server always sends it.
4. **`metricsSummary: {}`.** The reference marks `metricsSummary` as required and every field in it as optional. No page shows an empty one.
5. **`activeDuration`.** The reference marks it as optional. The guide says that the server calculates it from the interval and the pause events. The server sends it as the whole interval, without events.
6. **The UTC offsets.** The reference marks both as required. The example sends `"0s"`. A negative value is not shown.
7. **`notes`.** The reference documents it as "standard free-form notes captured at manual logging". No page shows a create with notes, or a length limit.
8. **How a list shows a written session.** No page shows the list entry of a session that was written through the API: its platform, its recording method, the form of its name, or whether Google adds values to it. The server matches the session by data point id, takes any session it created as `manual`, and reads no heart rate from a session of another platform than the band's.
9. **The `Operation`.** As for the food log: no page lists a method to ask for an `Operation` again. An `Operation` that is not finished, that carries an error, or whose name is not an exercise data point name is an entry that may exist.
10. **`batchDelete` for `exercise`.** The data types page lists the operation for the type. No page shows its answer for a session, what it answers for a session that is already gone, or that it refuses the name of a session another app wrote. The server keeps the rules of the food log delete: only Google's own `NOT_FOUND` is "already gone", and only a session in the table is ever deleted.
11. **`update`.** The data types page lists an `update` operation for `exercise`. The server does not use it: there is no edit tool. Delete the session and add it again.

Also not proven, because no real call was made: that Google accepts each field as sent (`platform` in the request, `metricsSummary: {}`, `displayName` for a type other than `OTHER`, the recording method `MANUAL`); the form of the listed name and the platform of a written session; and that the `activity_and_fitness.writeonly` scope alone allows the delete.

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
- **The workout sessions of the account before are no longer this server's own either.** Each row of `exercise_entries` holds the account its session was created for. `exercise_log_delete` and the exercise reads know only the sessions of the linked account: a session of the account before reads as a session of another source, with `entry_id` null. The rows stay too. A session write that is in flight during the change is not sent with the token of the other account: see [A session write is bound to one Google account](#a-session-write-is-bound-to-one-google-account).
- **The coach memory stays.** The profile, targets, health items, labs, preferences and notes are the person's own and are not tied to the Google account.

## Setup

Deploy your own single-user instance from the `workers` directory. Sign in to Cloudflare first (`npx wrangler login`), in the account where this Worker should live. You need your own Google Cloud project and OAuth client (type **Web application**), your own KV namespace, and the one Google account that may sign in. This repository does not include a Cloudflare account id, a project id, a real KV namespace id, or an account address.

The Google Health API scopes, with the two write scopes `nutrition.writeonly` and `activity_and_fitness.writeonly`, must be enabled on your Google Cloud project. An account that signed in before a scope was added to the sign-in does not have it: `google_account_status` names the missing scope and the tools that need it, and a reconnect of the connector grants it.

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

- `test/health-e2e.test.ts`: the OAuth sign-in through the Worker, then `tools/list` (22 tools), the prompts, `coach://guardrails`, one call of each coach tool, and one error of each kind (`no_data`, `invalid_input`, `auth_expired`, `scope_missing`, `upstream_unavailable`).
- `test/foodlog-e2e.test.ts`: the same sign-in, then `nutrition_log_add`, `nutrition_day` of that day, `nutrition_log_delete`, a second delete of the same id (`no_data`), and one error of each kind that a write can give.
- `test/tools-foodlog.test.ts` (the input and time rules of the two write tools, and each tool through `/mcp` of the object) and `test/googlehealth-write.test.ts` (the allowlist of the client, the request bodies, the retry rules and the `Operation` cases).
- `test/exerciselog-e2e.test.ts`: the same sign-in, then `tools/list` (22 tools, the two of the exercise log after the two of the food log), `exercise_log_add`, `workout_review` of that day, `exercise_log_delete` with the id that `workout_review` listed, and a second delete of the same id (`no_data`).
- `test/tools-exerciselog.test.ts` (the input and time rules of the two exercise log tools, the list of types against the documented enum, each tool through `/mcp` of the object, and the reads that show a logged session), `test/googlehealth-exercise-write.test.ts` (the four writes of the allowlist, the create body against the documented example, the scopes, and the errors that name the data type) and `test/store-exercise-entries.test.ts` (the table of the logged sessions).
- The fake Google Health API of the tests (`test/healthdata-helpers.ts`) checks an exercise create against the rules of the reference, and answers HTTP 400 `INVALID_ARGUMENT` with an ErrorInfo for a body that breaks one.
- `test/subrequests.test.ts`: the table of [Measured subrequests](#measured-subrequests).
- `test/coach-e2e.test.ts` and `test/memory-e2e.test.ts`: the detailed cases of the coach tools and of the memory tools over `/mcp`.

### Frozen contract

`test/fixtures/go-tools-list.json` and `test/fixtures/go-prompts.json` are a frozen snapshot of the former Go server. They are the source of truth for the parity tests. Nothing in the repository regenerates them.

`test/parity.test.ts` compares 16 tools (the 11 memory tools and the 5 coach tools) with `go-tools-list.json` field by field. For `server_info`, the 17th tool of the snapshot, it checks only that the server lists it: `server_info` differs on purpose (`transport` in its output, and annotations). The server lists 5 tools that snapshot does not have (`exercise_log_add`, `exercise_log_delete`, `google_account_status`, `nutrition_log_add`, `nutrition_log_delete`), and the test pins that list, so a tool that is in neither fails. Four of the 16 tools differ on purpose, and the test pins each difference: `nutrition_day` and `workout_review` have `entry_id` on each listed item or session, and sentences at the end of the description that say so (for `workout_review`, also what `overlaps_band_session` marks, on a session and on the result); `weekly_report` adds `cardio.vo2_max` and two sentences at the end of its description (one about `overlaps_band_session` on the result, one about the daily VO2 max); `metric_series` adds `vo2_max` to the metric enum and one sentence at the end of its description. Nothing else of those tools differs. `test/prompts.test.ts` compares the prompts and the resource with `go-prompts.json` (`prompts/list`, each `prompts/get`, `resources/list` and `resources/read`).

A change to a tool definition, a prompt or the guardrails that should stay inside that contract has to update the fixture in the same change. The tests read only the committed fixtures.

## Behavior notes

What a client or an operator can observe.

Coach memory and the server:

- **`preference_set` does not keep a value byte for byte.** The value arrives parsed, so it is stored as `JSON.stringify` writes it: `1.0` becomes `1`, insignificant white space and escapes go away, and integer-like object keys move first. The 2,048-byte limit counts `<`, `>`, `&`, U+2028 and U+2029 as 6 bytes each (`goJsonLength` in `src/coach/text.ts`), although they are stored unescaped. An integer beyond 2^53 loses precision.
- **Timestamps have millisecond precision.** They are stored with a fixed-width format (9 fractional digits) and returned as RFC 3339 with the trailing zeros trimmed.
- **A schema error is `invalid_input`** with the hint `check the tool's input schema and retry`, and the message is capped at 500 bytes. The message text comes from the SDK's validator. A date that matches the pattern but is not a real day (`2026-02-30`) is reported by its path, without the value. An `exercise_id` longer than 256 characters is this `invalid_input` too.
- **Tool results are checked against the output schema by `register`**, not by the MCP SDK. A result that does not match, or that holds NaN or Infinity, is `internal_error`.
- **A bad `HCM_TZ` does not stop the process.** A Worker has no start: every tool that needs the zone answers `internal_error` and the log has `config_error` with the variable name. Zone names are checked by the runtime's `Intl`, which ignores case.
- **A call to an unknown tool is a protocol error and writes no `tool_call` line.**
- **`arguments` that is not an object is a protocol error.** For `"arguments": []`, a string, a number or `null`, the MCP SDK answers JSON-RPC error `-32602` before `register` runs, with no `tool_call` line. The error text does not repeat the value.
- **A schema newer than the code is not refused.** The migration runner applies only what is missing.
- **`server_info` returns `name`, `version` and `transport`**, and has annotations.
- Names in error messages are quoted with `JSON.stringify`. Lowercasing and uppercasing follow code point by code point (`src/coach/text.ts`, `src/metrics/quality.ts`); the Unicode tables are the runtime's.

Error texts and hints of the Google Health side:

- **Hints name the reconnect step.** `auth_expired` has the hint `Disconnect and reconnect this connector in the MCP client to sign in with Google again.`; `scope_missing` adds `Allow every permission, and check that the Google Health API is enabled in the Cloud project.`
- **A token renewal that Google refuses** is `auth_expired`, `Google rejected the token renewal`, with the hint `Check the server's Google OAuth client settings.` and the reconnect step.
- **A token endpoint that is down has one message**, `Google's token service is unavailable`, also for an HTTP 200 answer without a usable token.
- **A date error of a prompt has the JSON-RPC code `-32602`** and the message `date must be a calendar date (YYYY-MM-DD)`. A prompt argument that is not text is refused by the MCP SDK with its own text.
- **The echo of an unknown prompt name is cut at 500 bytes**, and its escapes follow `JSON.stringify`.
- **List and read results have no `ttlMs` and `cacheScope` keys.** The frozen prompt fixture still has them; the parity test strips those two keys before it compares.

The request budget:

- **The budget error.** A call that needs more than the 45 Google Health requests of its MCP HTTP request answers `invalid_input`, `the date range holds more <type> data than one call reads`, hint `use a shorter date range`. The same error comes at 16 MiB per response and 32 MiB per call, and the 32 MiB cover all the chunks of one rollup. In a request with several tool calls, a call that runs out of budget after earlier calls took units has the hint `use a shorter date range, or send this call in a request of its own`.
- **Retries that use the budget up** are `upstream_unavailable`. So is a request that Google rejects for its token when the budget has no unit left to send it again.
- **Every network error is retried.** `fetch` in workerd does not separate a DNS failure from a certificate error.
- **`Retry-After` as a date is read only in the IMF-fixdate form.**

The token rules:

- **One forced renewal per MCP HTTP request.** After it, a second `401` in the same request is `auth_expired`.
- **The store is asked for a token at most twice per request.** A token that passes its expiry during a long request is not renewed by the clock: Google rejects it, and the forced renewal renews it. A failure of the token endpoint is asked once per request, whatever the request calls.
- **`google_account_status` shares the token answer of its request**, so in a batch it reports the state at the first ask.
- **The coach tool calls of one HTTP request run one after the other** and share the budget. Two HTTP requests at the same time are not ordered: each has its own budget.

Effects of a narrow read:

- **A narrow read serves a settled day from its own cached rows.** A tool that reads one total writes one total. Example: a settled day with a zone-minutes row and no steps row is served from the cache by `metric_series azm`. A total of such a day that changes at Google after the day settled stays at the cached value until something else rewrites that row. Reading every activity total on every call would mean `metric_series total_calories` over 366 days costs 45 requests every time.
- **`unreadable_records` counts only the data that was read.** For example `metric_series resting_hr` does not see an unreadable sleep record, `morning_briefing` does not see an unreadable total-calories row of yesterday or a body-fat reading, and `metric_series total_calories` does not see a total-calories row of a day without the band. When such a row is the only activity data of the day, `nutrition_day` (an unreadable steps row) and `morning_briefing` (an unreadable total-calories row) answer `band_not_worn` without `unreadable_records`.
- **A worn day without a zone-minutes row reads as 0 minutes also when an unreadable steps or total-calories row is in the same run** and the tool did not read that rollup.
- **`sources` of `metric_series resting_hr`** holds the labels of the resting heart rate records only.
- **`metric_series total_calories` gives `band_not_worn` for every day without band data**, also a day without any activity data. The flag `band_not_worn` is then set, and a week point counts the day in `days_left_out`.

Output forms:

- **Session times are written in the coach's zone** (`2026-10-14T19:00:00-03:00`), as night and food times are.
- **`nutrition_day` items include `entry_id`.** It is the stored name of an entry this server created for the linked account, or null.
- **`workout_review` sessions include `entry_id`.** It is the stored name of a session this server created for the linked account, or null. The description says what a logged session looks like, and what `overlaps_band_session` marks on a session and on the result.
- **A session can carry the flag `overlaps_band_session`, and so can a result with week totals.** `workout_review`, `weekly_report` and `morning_briefing` raise it in `quality_flags`. The description of `weekly_report` says what the flag marks. See [The exercise reads count the sessions of this server](#the-exercise-reads-count-the-sessions-of-this-server).
- **A rounded `-0` is written as `0`.**
- **Key order.** `active_min_by_type` keeps the order of the sessions, and `days_left_out` the order in which the reasons first appear. A JSON object has no order.
- **Sessions with the same start keep the API's order.**

Decoding of Google Health records:

- **Key names match exactly.**
- **A repeated key keeps the last value**, and a page that holds its list key twice is refused.
- **A whole number written as `440.0` or `4.4e2` is accepted.**
- **Time fractions finer than a millisecond are cut, never rounded up:** an instant stays in its second and on its local day. An output shows milliseconds. Inside one millisecond, two instants keep their order down to about a microsecond.
- **A record that is not JSON makes its whole page unreadable** (`upstream_unavailable`). It cannot reach a parser as one skipped record.
- **A record longer than 1 MiB makes its whole page unreadable** (`upstream_unavailable`).
- **A page field that the client does not read may nest at most 512 levels.** It is checked as JSON without being parsed, and a deeper one makes the page unreadable.

Writes to Google Health:

- **Two tools write the food log, and two write the exercise log.** `nutrition_log_add`, `nutrition_log_delete`, `exercise_log_add` and `exercise_log_delete` are the only tools with `openWorldHint: true`. See [Food log writes](#food-log-writes) and [Exercise log writes](#exercise-log-writes).
- **The Google Health client sends four writes and no other:** for the data type `nutrition-log` and for the data type `exercise`, the create of one data point and the delete of data points by name.
- **The sign-in asks for two write scopes:** `googlehealth.nutrition.writeonly` and `googlehealth.activity_and_fitness.writeonly`, next to the four read scopes.
- **The store has `nutrition_entries`** (migration 5) **and `exercise_entries`** (migration 6), the entries this server created.
- **The exercise reads keep the sessions this server created**, although their platform is `GOOGLE_WEB_API` and not Fitbit. A session of another platform that this server did not create is left out. See [The exercise reads count the sessions of this server](#the-exercise-reads-count-the-sessions-of-this-server).
- **The food reads keep the entries this server created**, although their platform is `GOOGLE_WEB_API` and not Fitbit. An item of another platform that this server did not create is left out. See [The food reads count the entries of this server](#the-food-reads-count-the-entries-of-this-server).

Logs:

- **Log lines are `console.*(message, {fields})`.** `wait_ms` is a number. A network error logs only the type names of its cause. `from` and `to` of an "unreadable …" line are the range of this server's own request.

## Workers Free plan

- **Worker CPU: 10 ms per request.** The Worker isolate does OAuth and the allowlist check, then forwards the request. Its work does not grow with the size of the arguments or of the result, and it makes no request to Google.
- **Subrequests: 50 per invocation.** See [The request budget](#the-request-budget) and [Measured subrequests](#measured-subrequests): the highest measured count of one MCP HTTP request is 49.
- **Google Health rate limit: 300 requests per minute per user.** One MCP HTTP request sends at most 45, one after the other; requests at the same time send at most 45 each. Over the limit Google answers 429, which is retried.
- **Rows written: 100,000 per day** for SQLite in Durable Objects. A note also writes rows to its full-text index. The `daily_metrics` cache writes up to 15 values per day when the day settles. Each value counts 3 rows written: its row, its primary key entry and its entry in the index `(metric, date)`. A cold year is about 16,500 rows written, once. An entry that `nutrition_log_add` or `exercise_log_add` creates counts 3 rows written too (its row, its primary key entry and its entry in the index of the day), and the check of a delete reads 1 row. An exercise read lists the logged sessions of its days first: one indexed read, which reads the rows of those days only.
- **Rows read: 5 million per day** for SQLite in Durable Objects. Each write to the coach memory counts its table first (`SELECT COUNT(*)`), to enforce the caps. A count scans the table: `note_add` can read up to 50,000 rows, `labs_record` up to 20,000, a new item in `health_item_upsert` up to 500 and a new key in `preference_set` up to 200. If a scanned row counts as a row read (the pricing page does not say how a count is billed), about 100 `note_add` calls in a day use the whole quota once the notes table is full. A new store is far from that. The coach tools read the `daily_metrics` cache one metric at a time, through the index `(metric, date)`: one metric over N cached days reads N + 1 rows, not the rows of all 15 metrics of those days. The largest read is the recovery of 366 days, 10 metrics: 3,670 rows. The row counts of the cache are the ones the local runtime reports (`rowsRead`, `rowsWritten`); a deploy has not confirmed them.
- **A statement binds at most 100 parameters and is at most 100 KB long** (SQLite in Durable Objects). The store binds at most 13 parameters, and writes a lab batch one row per statement.
- **Bundle:** `wrangler deploy --dry-run` reports 1,210 KiB, 268 KiB with gzip.

### Not verified on the Free plan

This code is deployed on Cloudflare Workers (Free plan) and in daily use. The points below have not been measured on that deploy yet; they come from the docs or from local tests:

- **Object CPU.** The Durable Objects limits table says 30 seconds of CPU per request. The same page says that objects have the Workers per-invocation CPU limits. If the object has only 10 ms, a cold call over a year cannot work: `metric_series hrv` over 366 days parses about 36,000 HRV samples.
- **Whether an object invocation has its own subrequest budget.** The design assumes that it has not: 50 for the whole request.
- **Memory.** The 16 MiB and 32 MiB limits rest on an estimate of 0.7 to 1.0 kB per heart-rate sample, and the 1 MiB record limit on an estimate of about 250 characters per sleep stage. No real record was measured. The local workerd does not enforce 128 MB.
- **Record volumes.** The table above uses synthetic volumes. A real 31-day list of the band's steps can have more than one page.
- **The daily rollup page size.** The docs give a maximum page size of 90 (14 for total calories). The request sends `pageSize: 10000`.
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
- The two exercise log tools rest on Google's documentation only, as the food log tools do: no real call has tested their request shapes. See [What the documentation does not settle for a session](#what-the-documentation-does-not-settle-for-a-session).
- A logged session has no heart rate, no zone minutes and no distance, and its calories are the client's estimate. It can be dated at most 30 days back and lasts at most 24 hours. It cannot be changed: delete it and add it again.
- The server does not look for a session of the band at the same time before it logs one. A logged session that overlaps a session of the band is still created; the reads mark it with `overlaps_band_session`, and both count as sessions of the week. The week's count and minutes are not corrected: a result that shows them carries the flag, and the client must say that the same workout may be there twice.
- The limits of a food entry above hold for a session too: an add whose outcome is unknown, or whose row could not be stored, can leave a session that this server does not own and cannot delete, and that reads as a session of another source; a session that another app moves by two days or more reads as a session of another source; and the same workout sent in two MCP HTTP requests at the same time is logged twice.
- A session write is bound to the Google account that the tool checked, and is refused when the token of the request belongs to another account (see [A session write is bound to one Google account](#a-session-write-is-bound-to-one-google-account)). So after another account signs in during an MCP HTTP request, every later `exercise_log_add` and `exercise_log_delete` of that request answers `invalid_input` and must be sent again in a request of its own. One window stays: an account that signs in while Google creates a session leaves a session in the first account that this server does not own.
- An account that signed in before the exercise write scope was requested must reconnect the connector once. Until then the two exercise log tools answer `scope_missing`.
- The two food log tools are not bound to the account of their token. The account of a food entry is the account that the store holds when the entry is recorded, checked against the one it held before the create. One MCP HTTP request keeps one Google token for all its tool calls. So when another account signs in between two tool calls of one request, a later `nutrition_log_add` of that request can still go out with the token of the account before, and its row is then bound to the new account. A later `nutrition_log_delete` of that request can go out with the token of the account before for an entry of the new account, and a delete whose token renewal races a sign-in can go out with the token of the new account for an entry of the account before. The window is one request in flight during a change of `ALLOWED_GOOGLE_EMAIL`. The two exercise log tools do not have it.
- A year in which every 31-day window has days without band data, in an account whose 31-day list of the band's steps has four pages or more, makes `metric_series` for `azm`, `total_calories`, `kcal_in` and `protein_g` over that year answer the budget error on every call. Use a shorter range.
