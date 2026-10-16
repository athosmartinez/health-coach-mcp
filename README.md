# health-coach-mcp

A personal MCP server that turns Google Health (Fitbit Air) data into ready-to-use metrics for
an AI health, training and nutrition coach. Works with any MCP client: Claude Code, Claude
Desktop, claude.ai, other LLMs, cron agents and chat bridges.

> Status: in progress. The coach memory tools work; the Google Health data tools are being built
> (see `plans/health-coach-mcp-mvp.md`). Product context: `docs/PRODUCT-BRIEF.md`.

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

```bash
claude mcp add health-coach -- "$PWD/bin/health-coach-mcp"
```

### Claude Desktop

```json
{
  "mcpServers": {
    "health-coach": { "command": "/absolute/path/to/bin/health-coach-mcp" }
  }
}
```

## Development

```bash
make test   # go test -race ./...
make lint   # gofmt + go vet
```
