# health-coach-mcp

A personal MCP server that turns Google Health (Fitbit Air) data into ready-to-use metrics for
an AI health, training and nutrition coach. Works with any MCP client: Claude Code, Claude
Desktop, claude.ai, other LLMs, cron agents and chat bridges.

> Status: MVP complete, in a week of real use (see `plans/health-coach-mcp-mvp.md`).
> Product context: `docs/PRODUCT-BRIEF.md`; contract: `docs/CAPABILITY.md`.

## What it offers

- **Coach tools:** `morning_briefing`, `workout_review`, `nutrition_day`, `weekly_report` and `metric_series`.
  They read Google Health (read-only) and return values against the user's own baseline, with coverage and
  quality flags.
- **Coach memory:** profile, versioned targets, health items, labs, preferences and notes, in a local SQLite file.
- **Prompts:** `morning_briefing`, `nutrition_review`, `workout_review` and `weekly_report`, one per coaching
  moment. Each one calls `profile_get` and its tool, and carries the guardrails.
- **Resource:** `coach://guardrails`, the coach's medical limits, data rules and tone.

## Sign in to Google Health

1. In the Cloud console, create an OAuth client of type **Desktop app** and download its JSON.
2. Save it as `~/.config/health-coach-mcp/client_secret.json` (or `$HCM_CONFIG_DIR/client_secret.json`).
3. Sign in and check:

```bash
./bin/health-coach-mcp auth login    # opens the browser; saves credentials.json (0600)
./bin/health-coach-mcp auth status   # scopes and expiry; never prints a token
```

Only read-only scopes are requested. While the OAuth app is in Testing mode, Google ends the
sign-in about 7 days after it: tools then return `auth_expired`, and `auth login` fixes it. A
running server picks up the new sign-in without a restart.

## Run

```bash
make build
./bin/health-coach-mcp                         # stdio (local clients)
./bin/health-coach-mcp -transport=http         # Streamable HTTP on 127.0.0.1:8787
```

### Claude Code

Register the server for every project (`-s user`), then start a new Claude Code session:

```bash
claude mcp add -s user health-coach -- "$PWD/bin/health-coach-mcp"
```

In the new session:

1. Run `/mcp` and check that `health-coach` is connected.
2. Run a prompt, for example `/mcp__health-coach__morning_briefing`. Give a date (`YYYY-MM-DD`) as the
   argument to review another day.

A rebuilt binary is loaded when Claude Code starts the server again: start a new session, or reconnect
the server from `/mcp`.

### Claude Desktop

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart
Claude Desktop:

```json
{
  "mcpServers": {
    "health-coach": { "command": "/absolute/path/to/bin/health-coach-mcp" }
  }
}
```

## First use

Tell the coach your goals, training plan, daily kcal and protein targets and health history. It
records them with `profile_update`, `targets_set` and `health_item_upsert`, and every later answer
takes them into account. With a kcal target set, food series also load faster.

## Development

```bash
make test   # go test -race ./...
make lint   # gofmt + go vet
```

The Cloudflare Workers port lives in `workers/`.
