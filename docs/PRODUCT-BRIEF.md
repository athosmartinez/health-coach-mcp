# Product Brief — Health Coach MCP

> Status: discovery · 2026-10-13 · source: product-lens interview

## 1. Who it's for
The owner. One user, one Google Health account, one Fitbit Air (in use for 1 week).
Starting a gym + diet routine.

## 2. The pain
- The band generates a lot of data (HR, HRV, sleep, SpO2, steps), and I log diet and workouts
  in the Google Health app, but **nobody connects the dots**: what to do today, whether the diet is working,
  whether I'm recovering.
- The Google Health app coach is locked to the app and a single LLM; it doesn't know my history,
  lab tests or preferences, and doesn't reach me where I am (terminal, WhatsApp).

## 3. Why now
- Fitbit Air + new **Google Health API v4** (OAuth, webhooks, 40 data types, nutrition included).
- Legacy Fitbit Web API shuts down on 2026-10-30 — the right moment to build directly on v4.
- MCP has become the standard: one server serves Claude Code, Desktop, claude.ai, other LLMs and agents.

## 4. 10-star version
A coach that knows me better than a nutritionist + personal trainer + doctor combined:
reads everything (wearable, diet, workouts, lab tests), proactively spots trends ("your HRV
dropped 3 days in a row after evening workouts"), adjusts diet and training week by week,
sees lab results evolve over years, and reaches out by message at the right moment.

## 5. MVP
**A harness-agnostic MCP server** (any LLM/client) that delivers **data + ready-made metrics**,
plus a **memory of its own** for profile and history. The LLM interprets; the MCP computes.

### Moments the MVP has to support
| Moment | What the coach needs from the MCP |
|---|---|
| Morning briefing | Last night's sleep, HRV and resting HR vs. 28d baseline, recovery/readiness signal |
| Diet review | Kcal/macros for the day vs. target, protein per kg, estimated deficit (intake − TDEE) |
| Workout review | Session, HR zones, AZM, weekly frequency and volume vs. plan |
| Weekly report | 7d vs. previous 7d vs. 28d trends: weight, body fat, resting HR, HRV, sleep, steps, adherence |

### Data sources
- **Google Health API (read-only):** sleep, HR, HRV, SpO2, steps, AZM, exercise, nutrition log,
  hydration, weight/body fat.
- **The coach's own memory (read + write):** basic profile and goals, health history
  (conditions, medication, supplements, injuries), lab tests over time, preferences and routine,
  coach notes and decisions made.
- **Lab test input:** lab PDF (extraction), via chat, or an editable YAML/JSON file.

### Deployment
- Phase 1: **local on the Mac**.
- Phase 2: **cloud**, for WhatsApp/Telegram and proactive (cron) routines.
- So: containerizable from day one, configurable storage, stdio **and** Streamable HTTP transport.

## 6. Anti-goals
- **Multi-user / product for others.** Single-user; no tenants, signup or billing.
- **Not writing to Google Health** in the MVP (the coach writes only to its own memory).

Not excluded, but **outside the MVP by default** (decide later): own UI/dashboard, other
wearables, proactive WhatsApp channel (comes with phase 2).

## 7. Success metrics (30 days)
- **Daily use:** coach consulted ≥ 5 of 7 days without forcing it.
- **Adherence:** % of days hitting protein and calories; planned vs. completed workouts.
- **Metrics:** weight and body fat on the right trend; HRV and sleep stable or improving.
- **Decisions:** concrete adjustments made because of an insight (log them in the memory).

## 8. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Google Health API access for a new project not confirmed ("not onboarding new projects") | Blocks everything | **Validate `ghealth setup` + 1 real read BEFORE writing code** |
| OAuth app in Testing → refresh token expires every ~7 days | Silent breakage | Move to "In production" unverified (single-user) or alert on expired token |
| Restricted scopes; going over 100 users requires CASA | None (single-user) | Anti-goal: multi-user |
| Fitbit Air may not produce every type (e.g. ECG, skin temp is Pixel Watch-only) | Gaps in metrics | Map real availability in the first week of data |
| Few days of history (1 week) | 28d baseline unreliable at first | Metrics report `confidence`/`n_days` |
| LLM giving medical-sounding advice | Health | Guardrail in the tools/prompts: flag + refer to a doctor; never prescribe medication |
| Sensitive data (lab tests, medication) in the cloud in phase 2 | Privacy | Encryption at rest, auth on the HTTP endpoint, secrets outside the repo |
| 1s HR = huge payload for the LLM | Tokens/cost | Tools return aggregates; raw only on demand and paginated |

## 9. Recommendation
**GO**, with a gate: before any code, confirm that `ghealth` authenticates and reads real data
from the Fitbit Air (sleep, HRV, nutrition log). If it reads, the next lane is
`product-capability` (capability contract: tools, schemas, storage) → plan → implementation.

## 10. Decisions
- **Stack: Go** (2026-10-13).
  - MCP: official SDK `github.com/modelcontextprotocol/go-sdk` (stdio for phase 1, Streamable HTTP for phase 2).
  - Google Health API: reuse the client/OAuth from `ghealth` (`Google-Health-API/google-health-cli`, Apache 2.0).
  - Storage: SQLite via `modernc.org/sqlite` (pure Go, no cgo); Postgres optional in phase 2.
  - Lab PDFs: extraction done by the agent/LLM; the MCP only validates and stores the structured values.
  - Why: single binary, small container, simple concurrency for parallel fetches.

## 11. Open questions
- Phase 2 cloud: which provider (VPS/Docker, Cloud Run, Supabase)?
- Readiness: build our own score from HRV and resting HR, or use whatever the API provides?
- Diet targets: you set them (or a nutritionist does), or the coach proposes them from the profile?
