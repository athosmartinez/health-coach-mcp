# health-coach-mcp

A personal MCP server that turns Google Health (Fitbit Air) data into ready-to-use metrics for
an AI health, training and nutrition coach. Works with any MCP client: Claude Code, Claude
Desktop, claude.ai, other LLMs, cron agents and chat bridges.

> Status: early scaffold. Only the `server_info` tool exists. See `docs/PRODUCT-BRIEF.md`.

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
