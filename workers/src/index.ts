import { createMcpHandler } from "agents/mcp/server";

import { createServer } from "./mcp";
import { CoachStore } from "./store";

export { CoachStore };

const mcpHandler = createMcpHandler(createServer);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Workers Logs already records each invocation's method and URL; a
    // per-request console.log would double the log events on the Free quota.
    // TODO(oauth): replace this default export with OAuthProvider from
    // @cloudflare/workers-oauth-provider. apiHandler.fetch should call
    // mcpHandler. See src/oauth.ts. This phase does not authenticate.
    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
