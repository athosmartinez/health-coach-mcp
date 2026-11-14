/**
 * Plug-in point for later phases. Nothing in this module runs on a request.
 *
 * Planned shape (Cloudflare remote MCP guide, Agents "Authentication", and
 * cloudflare/ai demos/remote-mcp-google-oauth):
 *
 * 1. Google OAuth signs the user in on the authorization server's /authorize
 *    page (client id, client secret, optional hosted domain).
 * 2. MCP OAuth replaces this Worker's default export with OAuthProvider from
 *    @cloudflare/workers-oauth-provider. Its apiHandler.fetch calls the
 *    existing createMcpHandler, apiRoute stays /mcp, and unauthenticated
 *    calls then get a real 401. The provider also needs an OAUTH_KV binding
 *    and MCP_RESOURCE set to the public /mcp URL.
 *
 * Secrets, unset in this phase, are named in .dev.vars.example.
 * Do not add a bearer check here. A stand-in would be fake auth.
 */
export const oauthPhase = "todo" as const;
