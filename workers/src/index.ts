import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { AUTHORIZE_PATH, authHandler } from "./auth";
import { isAllowedEmail } from "./google";
import { createServer } from "./mcp";
import { CoachStore } from "./store";

export { CoachStore };

export const MCP_PATH = "/mcp";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

const mcpHandler = createMcpHandler(createServer, { route: MCP_PATH });

/**
 * Called by the provider only with a valid access token for this resource.
 * The allowlist is checked again on every request, so changing
 * ALLOWED_GOOGLE_EMAIL cuts off grants issued to the previous account.
 */
const mcpApiHandler = {
  async fetch(request, env, ctx) {
    const props = ctx.props as { email?: unknown } | undefined;
    if (!isAllowedEmail(env.ALLOWED_GOOGLE_EMAIL, props?.email)) {
      return Response.json(
        { error: "access_denied", error_description: "this account may not use this server" },
        { status: 403 },
      );
    }
    // ctx carries the verified token; getMcpAuthContext() reads it from there.
    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

function buildProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: mcpApiHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Claude registers itself with DCR; ChatGPT prefers a Client ID Metadata
    // Document. Both are enabled. CIMD also needs global_fetch_strictly_public.
    clientRegistrationEndpoint: REGISTER_PATH,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      // The canonical resource and every token's audience. Built from the
      // request origin: Cloudflare routes only this Worker's hostnames here.
      resource: `${origin}${MCP_PATH}`,
      resource_name: "Health coach MCP",
    },
    // Refreshing an MCP token re-checks the allowlist. The Google refresh
    // token is not in props (it stays in CoachStore), so nothing to renew here.
    tokenExchangeCallback: ({ grantType, props, env }) => {
      if (grantType !== "refresh_token") return;
      const email = (props as { email?: unknown } | undefined)?.email;
      if (!isAllowedEmail(env.ALLOWED_GOOGLE_EMAIL, email)) {
        throw new OAuthError("invalid_grant", { description: "this account may not use this server" });
      }
    },
    // Log the failed check only. The request and detail may carry client input.
    onError: ({ status, internal }) => {
      console.warn("oauth error", { status, category: internal.category, reason: internal.reason });
    },
  });
}

/** One provider per origin (workers.dev, a custom domain, localhost in dev). */
const providers = new Map<string, OAuthProvider<Env>>();
const MAX_PROVIDERS = 8;

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    if (providers.size >= MAX_PROVIDERS) providers.clear();
    provider = buildProvider(origin);
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
