// Secrets and helpers that `wrangler types` cannot see: secrets live only in
// .dev.vars or `wrangler secret put`, and OAUTH_PROVIDER is injected at
// runtime by workers-oauth-provider into the handlers it calls.
// A global script (no top-level import), so these merge into the generated Env.

interface AuthSecrets {
  /** Google OAuth client (type "Web application"). */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** The one Google account allowed to sign in. Unset or empty rejects everyone. */
  ALLOWED_GOOGLE_EMAIL: string;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

interface Env extends AuthSecrets {}

declare namespace Cloudflare {
  interface Env extends AuthSecrets {}
}
