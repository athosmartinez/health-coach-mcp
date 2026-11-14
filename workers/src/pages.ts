/**
 * Public pages for the Google OAuth consent screen: the home page and the
 * privacy policy. Served without OAuth and without secrets.
 */
export const HOME_PATH = "/";
export const PRIVACY_PATH = "/privacy";

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}" +
  "a{color:inherit}";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

/** Returns a public page when the path is / or /privacy; otherwise undefined. */
export function publicPage(request: Request): Response | undefined {
  const path = new URL(request.url).pathname;
  if (path !== HOME_PATH && path !== PRIVACY_PATH) return;
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const body = path === HOME_PATH ? homePage() : privacyPage();
  return new Response(body, { status: 200, headers: PAGE_HEADERS });
}

function homePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>health-coach-mcp</title><style>${STYLE}</style></head><body>
<h1>health-coach-mcp</h1>
<p>A personal remote MCP server that connects one Google account's Google Health data to MCP clients (Claude, ChatGPT).</p>
<p><a href="/privacy">Privacy policy</a></p>
</body></html>`;
}

function privacyPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy — health-coach-mcp</title><style>${STYLE}</style></head><body>
<h1>Privacy policy</h1>
<p>health-coach-mcp is a single-user personal service. Only one allowlisted Google account can sign in and use it.</p>
<h2>Google data we request</h2>
<p>When you sign in, the server requests these Google scopes:</p>
<ul>
<li><strong>openid</strong> and <strong>email</strong> — to identify the account and check it against the allowlist.</li>
<li><strong>googlehealth.activity_and_fitness.readonly</strong> — to read activity and fitness data.</li>
<li><strong>googlehealth.health_metrics_and_measurements.readonly</strong> — to read health metrics and measurements.</li>
<li><strong>googlehealth.sleep.readonly</strong> — to read sleep data.</li>
<li><strong>googlehealth.nutrition.readonly</strong> — to read nutrition data.</li>
<li><strong>googlehealth.nutrition.writeonly</strong> — to log food for the owner.</li>
</ul>
<h2>How data is stored and used</h2>
<p>The Google refresh token is stored only in a Cloudflare Durable Object. It is never logged or shared.</p>
<p>Google Health data is not sold or shared with third parties. It is used only to answer the owner's MCP requests from clients such as Claude and ChatGPT.</p>
<h2>Limited Use</h2>
<p>health-coach-mcp's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>How to revoke access</h2>
<p>You can revoke access at any time in your Google Account under Security &gt; Third-party access, or at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>.</p>
<h2>Contact</h2>
<p><a href="mailto:athosandrade04@gmail.com">athosandrade04@gmail.com</a></p>
<p><a href="/">Home</a></p>
</body></html>`;
}
