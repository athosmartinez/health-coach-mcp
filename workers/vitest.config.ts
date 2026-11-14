import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
