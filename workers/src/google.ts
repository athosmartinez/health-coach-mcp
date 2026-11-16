/**
 * Google as the upstream identity provider: the authorize URL, the token
 * endpoint (code exchange and refresh), revocation, and the ID token checks.
 *
 * Errors carry only Google's `error` code and the HTTP status, never the
 * response body: a token endpoint body can quote a token or a client secret.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

/**
 * The data types the coach writes, each with its write scope, what that scope
 * permits (the words of a hint) and the two tools that need it. A closed
 * table: a write of a data type that is not here does not exist.
 *
 * The scopes are the ones Google lists for each data type
 * (https://developers.google.com/health/data-types).
 */
export const WRITE_SCOPES = {
  "nutrition-log": {
    scope: `${SCOPE_PREFIX}nutrition.writeonly`,
    permits: "add nutrition data",
    addTool: "nutrition_log_add",
    deleteTool: "nutrition_log_delete",
  },
  exercise: {
    scope: `${SCOPE_PREFIX}activity_and_fitness.writeonly`,
    permits: "add exercise data",
    addTool: "exercise_log_add",
    deleteTool: "exercise_log_delete",
  },
} as const;

/** A data type the coach writes. */
export type WriteDataType = keyof typeof WRITE_SCOPES;

export const WRITE_DATA_TYPES = Object.keys(WRITE_SCOPES) as WriteDataType[];

/** A scope as a hint names it: without the URL in front (`googlehealth.nutrition.writeonly`). */
export function scopeName(scope: string): string {
  return scope.slice(scope.lastIndexOf("/") + 1);
}

/**
 * The Google Health scopes the coach needs: four read-only scopes, plus
 * nutrition.writeonly for the food log tools and
 * activity_and_fitness.writeonly for the exercise log tools.
 */
export const GOOGLE_HEALTH_SCOPES = [
  `${SCOPE_PREFIX}activity_and_fitness.readonly`,
  `${SCOPE_PREFIX}health_metrics_and_measurements.readonly`,
  `${SCOPE_PREFIX}sleep.readonly`,
  `${SCOPE_PREFIX}nutrition.readonly`,
  WRITE_SCOPES["nutrition-log"].scope,
  WRITE_SCOPES.exercise.scope,
] as const;

/** `openid email` identify the account for the allowlist check. */
export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email", ...GOOGLE_HEALTH_SCOPES] as const;

const ID_TOKEN_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/**
 * What the person does when the Google link is missing, expired or revoked.
 */
export const RECONNECT_HINT = "Disconnect and reconnect this connector in the MCP client to sign in with Google again.";

/**
 * What the person checks when Google refuses the server's own token request
 * (a wrong client ID or secret).
 */
export const OAUTH_CLIENT_HINT = "Check the server's Google OAuth client settings.";

/** Stable codes for auth failures. */
export type GoogleErrorCode = "auth_expired" | "upstream_unavailable" | "internal_error";

export interface GoogleError {
  ok: false;
  code: GoogleErrorCode;
  /** Google's error code and the HTTP status only. */
  message: string;
}

export interface GoogleTokens {
  ok: true;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Absent when Google keeps the current refresh token. */
  refreshToken?: string;
  /** Space-separated, as granted. Absent when Google does not repeat it. */
  scope?: string;
  idToken?: string;
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce: string;
}

/** The Google consent URL: offline access and a fresh consent, so a refresh token comes back. */
export function googleAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GOOGLE_SIGN_IN_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    nonce: options.nonce,
  }).toString();
  return url.toString();
}

const TOKEN_TIMEOUT_MS = 10_000;

export function exchangeCode(
  client: GoogleClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  now: number = Date.now(),
): Promise<GoogleTokens | GoogleError> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    now,
    // A sign-in that got no usable token cannot go on: a fault of this server's flow.
    "internal_error",
  );
}

/**
 * Renews the access token. HTTP 200 without a usable token is a fault of the
 * token service, not of the link or the OAuth client: the same request can
 * work later, so it is upstream_unavailable (the Go server: "could not be
 * reached"). A redirect is the same: it is not followed. An answer that
 * Google refuses stays internal_error.
 */
export function refreshAccessToken(
  client: GoogleClient,
  refreshToken: string,
  now: number = Date.now(),
): Promise<GoogleTokens | GoogleError> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    now,
    "upstream_unavailable",
  );
}

/**
 * `unusable` is the code for an answer that is neither a token nor a refusal
 * of Google: HTTP 200 with a body that holds no usable token, or a redirect
 * (which is not followed).
 */
async function tokenRequest(
  form: Record<string, string>,
  now: number,
  unusable: GoogleErrorCode,
): Promise<GoogleTokens | GoogleError> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      // The token endpoint never redirects. A 307 or 308 that is followed
      // sends the form again, with the client secret and the refresh token,
      // to the redirect target; and each hop is one more subrequest, which
      // the budget of an MCP request does not count.
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout. The error text could name the request; drop it.
    return { ok: false, code: "upstream_unavailable", message: "Google token endpoint unreachable" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    // The connection dropped or timed out while the body was read.
    return { ok: false, code: "upstream_unavailable", message: `Google token endpoint: body not received (HTTP ${response.status})` };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON body (an HTML error page) is classified by status alone.
  }

  if (!response.ok) {
    const error = typeof body.error === "string" ? safeCode(body.error) : "unknown";
    const message = `Google token endpoint: ${error} (HTTP ${response.status})`;
    // A redirect is not an answer of the token service, whatever its body
    // says: it is never a refusal of the grant.
    if (response.status >= 300 && response.status < 400) return { ok: false, code: unusable, message };
    if (error === "invalid_grant") return { ok: false, code: "auth_expired", message };
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { ok: false, code: "upstream_unavailable", message };
    }
    return { ok: false, code: "internal_error", message };
  }

  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== "string" || accessToken === "" || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    return { ok: false, code: unusable, message: "Google token endpoint: malformed response" };
  }
  return {
    ok: true,
    accessToken,
    expiresAt: now + expiresIn * 1000,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
  };
}

/** OAuth error codes are short ASCII words; anything else is not echoed. */
function safeCode(code: string): string {
  return /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
}

/** Best effort: revoking a refresh token also revokes its access tokens. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      // As for the token request: a followed redirect would send the token on.
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    // The rejected account's grant then expires on Google's side.
  }
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Reads the ID token from the token endpoint response. OIDC Core 3.1.3.7 lets
 * a client skip the signature check for an ID token it received directly
 * from the token endpoint over TLS; the claims below are still checked.
 * Returns null when any check fails.
 */
export function readIdToken(
  idToken: string | undefined,
  clientId: string,
  nonce: string,
  now: number = Date.now(),
): GoogleIdentity | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(parts[1] ?? ""));
    if (!parsed || typeof parsed !== "object") return null;
    claims = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof claims.iss !== "string" || !ID_TOKEN_ISSUERS.has(claims.iss)) return null;
  const audience = claims.aud;
  if (Array.isArray(audience) ? !audience.includes(clientId) : audience !== clientId) return null;
  if (Array.isArray(audience) && audience.length > 1 && claims.azp !== clientId) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (claims.nonce !== nonce) return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  if (typeof claims.email !== "string" || claims.email === "") return null;
  return { sub: claims.sub, email: claims.email, emailVerified: claims.email_verified === true };
}

/** Exact match, ignoring case and surrounding space. Unset or empty allows nobody. */
export function isAllowedEmail(allowed: string | undefined, email: unknown): boolean {
  const expected = allowed?.trim().toLowerCase();
  if (!expected || typeof email !== "string") return false;
  return email.trim().toLowerCase() === expected;
}

/** Granted scopes, split; Google returns them space-separated. */
export function splitScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(" ").filter((value) => value !== "");
}

export function missingHealthScopes(granted: readonly string[]): string[] {
  return GOOGLE_HEALTH_SCOPES.filter((scope) => !granted.includes(scope));
}

/**
 * What a missing write scope takes away, one sentence for each scope in
 * `missing`: the two tools that need it and the scope's name. "" when no
 * write scope is missing. An account that signed in before a write scope was
 * requested lacks that scope until the next sign-in.
 */
export function missingWriteScopes(missing: readonly string[]): string {
  return WRITE_DATA_TYPES.map((type) => WRITE_SCOPES[type])
    .filter((write) => missing.includes(write.scope))
    .map((write) => `${write.addTool} and ${write.deleteTool} need ${scopeName(write.scope)}, which a new sign-in grants.`)
    .join(" ");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
