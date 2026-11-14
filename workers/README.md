# health-coach-mcp (Cloudflare Workers)

Remote MCP server for the health coach. The Go server at the repo root stays the contract. This Worker serves Streamable HTTP at `/mcp`, protected by OAuth 2.1, so Claude and ChatGPT can add it as a custom connector. It is single-user: only one Google account (`ALLOWED_GOOGLE_EMAIL`) can sign in.

Tools: `server_info`, and `google_account_status` (the linked account, its granted and missing Google Health scopes, and whether its access still works; never a token).

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

## Known limits

- The OAuth resource is `<request origin>/mcp`. A second hostname (`workers.dev` and a custom domain) is a separate resource with its own grants.
- `/register` and the consent page are open to anyone, as MCP clients need them. Each attempt writes to KV, so heavy abuse could use up the Free plan's daily KV writes.
