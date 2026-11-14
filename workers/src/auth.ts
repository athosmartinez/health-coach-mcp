/**
 * The authorization server's own pages: the consent page at /authorize, the
 * redirect to Google, and Google's return to /callback.
 *
 * Only ALLOWED_GOOGLE_EMAIL may finish. Any other account gets a 403 page:
 * its Google token is revoked, nothing goes to the store, and no MCP grant is
 * created. The pages never name the allowed account: anyone who registers a
 * client can reach them.
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";

import {
  exchangeCode,
  type GoogleClient,
  googleAuthorizeUrl,
  isAllowedEmail,
  pkceChallenge,
  randomToken,
  readIdToken,
  revokeToken,
} from "./google";
import { coachStore } from "./store";

export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";

/** What the MCP grant carries to the /mcp handler (encrypted in KV). No Google token. */
export interface AuthProps {
  sub: string;
  email: string;
  [key: string]: unknown;
}

/** Kept server-side by beginUpstream(), returned at the callback. */
interface UpstreamData {
  verifier: string;
  nonce: string;
}

export const authHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== AUTHORIZE_PATH && url.pathname !== CALLBACK_PATH) {
      return new Response("Not Found", { status: 404 });
    }
    const client = googleClient(env);
    if (!client || !env.ALLOWED_GOOGLE_EMAIL?.trim()) {
      return page(503, "Not configured", "This server's sign-in is not configured yet.");
    }
    try {
      if (url.pathname === AUTHORIZE_PATH) {
        if (request.method === "GET") return await showConsent(request, env);
        if (request.method === "POST") return await submitConsent(request, env, client);
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
      }
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
      }
      return await callback(request, env, client);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        // A redirect is safe only once the library validated the client and redirect URI.
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return page(400, "Sign-in failed", `${error.description} Start again from your MCP client.`);
      }
      if (error instanceof CimdFetchError) {
        return page(400, "Sign-in failed", "This app could not be verified.");
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

function googleClient(env: Env): GoogleClient | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  // First: a failed lookup leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: Env, client: GoogleClient): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // The MCP grant carries no OAuth scopes: /mcp checks the account, not scopes.
  const approved = await oauth.approveConsent(request, handle, { scope: [] });
  const verifier = randomToken(32);
  const nonce = randomToken(16);
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier, nonce } satisfies UpstreamData,
    headers: approved.headers,
  });
  headers.set(
    "location",
    googleAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: callbackUrl(request),
      state,
      codeChallenge: await pkceChallenge(verifier),
      nonce,
    }),
  );
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env, client: GoogleClient): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const resumed = await oauth.finishUpstream<UpstreamData>(request);
  const headers = resumed.headers;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    // The user declined at Google, or Google failed: tell the MCP client.
    headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const tokens = await exchangeCode(client, code, resumed.data.verifier, callbackUrl(request));
  if (!tokens.ok) {
    return page(502, "Sign-in failed", "Google did not complete the sign-in. Try again.", headers);
  }
  const revokeIssued = () => revokeToken(tokens.refreshToken ?? tokens.accessToken);

  const identity = readIdToken(tokens.idToken, client.clientId, resumed.data.nonce);
  if (!identity) {
    await revokeIssued();
    return page(502, "Sign-in failed", "Google's answer could not be verified. Try again.", headers);
  }
  if (!identity.emailVerified || !isAllowedEmail(env.ALLOWED_GOOGLE_EMAIL, identity.email)) {
    await revokeIssued();
    return page(
      403,
      "Account not allowed",
      "This is a private server. Only its owner's Google account can connect to it. Nothing was saved.",
      headers,
    );
  }
  if (!tokens.refreshToken) {
    await revokeIssued();
    return page(
      502,
      "Sign-in failed",
      "Google did not grant offline access. Remove this app at myaccount.google.com/connections, then connect again.",
      headers,
    );
  }

  await coachStore(env).linkGoogleAccount({
    sub: identity.sub,
    email: identity.email,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scope ?? "",
  });
  const props: AuthProps = { sub: identity.sub, email: identity.email };
  const { redirectTo } = await oauth.completeAuthorization({
    request: resumed.request,
    // Google's sub is digits only; the provider forbids ":" in a user id.
    userId: identity.sub,
    metadata: {},
    scope: resumed.request.scope,
    props,
  });
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Same origin as the request: register https://<host>/callback in the Google client. */
function callbackUrl(request: Request): string {
  return new URL(CALLBACK_PATH, request.url).toString();
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}" +
  "button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}";

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${name}</title><style>${STYLE}</style></head><body>
<h1>Allow ${name} to use your health coach?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>Next, Google asks you to sign in and to share your Google Health data with this server.</p>
<form method="post" action="${AUTHORIZE_PATH}">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Continue with Google</button>
<button name="decision" value="deny">Deny</button>
</form></body></html>`;
}

function page(status: number, title: string, message: string, headers?: Headers): Response {
  const out = new Headers(headers);
  out.delete("location");
  out.set("content-type", "text/html; charset=utf-8");
  out.set("cache-control", "no-store");
  out.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body>
<h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
  return new Response(body, { status, headers: out });
}
