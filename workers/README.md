# health-coach-mcp (Cloudflare Workers)

Phase 1 scaffold for the remote MCP server. The Go server at the repo root stays the contract. This Worker serves Streamable HTTP at `/mcp` with one tool, `server_info`, and a SQLite Durable Object (`CoachStore`) that holds a `schema_version` table only.

OAuth is not implemented. `/mcp` is open. See `src/oauth.ts`.

## Run locally

Requires Node 22.12 or newer (Wrangler's current engine).

```bash
cd workers
npm ci
npm run dev
```

Wrangler listens on `http://localhost:8788`. The MCP endpoint is `http://localhost:8788/mcp`. Point an MCP client (for example `npx @modelcontextprotocol/inspector@latest`) at that URL. A browser will not speak MCP on its own.

`npm run dev` does not need `.dev.vars`. The example file lists secret names for a later OAuth phase; copy it to `.dev.vars` only when those exist. Do not commit `.dev.vars`.

## Test and typecheck

```bash
npm test
npm run typecheck
```

`npm run deploy` is `wrangler deploy`. It is not part of this phase; do not run it until the OAuth phases exist and a Cloudflare account is configured. The config targets the Workers Free plan: the Durable Object uses `new_sqlite_classes` (SQLite is the only backend the free plan allows).

## Not in this phase

- Google OAuth on the authorization server
- MCP OAuth via `@cloudflare/workers-oauth-provider` (wraps `createMcpHandler`; adds `OAUTH_KV` and `MCP_RESOURCE`)
- Coach tools, memory tables, and Google Health reads
