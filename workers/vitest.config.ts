import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The files run in parallel, and the store limit tests fill tables with
    // tens of thousands of rows. Under that load the first request of a file
    // (it loads the Worker) can pass the default 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Synthetic values only. Tests mock every Google call; nothing leaves workerd.
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          ALLOWED_GOOGLE_EMAIL: "owner@example.com",
        },
      },
    }),
  ],
});
