import { createMcpHandler } from "agents/mcp/server";

import { createServer } from "./mcp";
import { CoachStore } from "./store";

export { CoachStore };

const mcpHandler = createMcpHandler(createServer);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      console.log(JSON.stringify({ message: "mcp_request", method: request.method, path }));
    }
    // TODO(oauth): replace this default export with OAuthProvider from
    // @cloudflare/workers-oauth-provider. apiHandler.fetch should call
    // mcpHandler. See src/oauth.ts. This phase does not authenticate.
    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
