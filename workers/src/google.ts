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
 * The Google Health scopes the coach needs. The four read-only ones match the
 * Go server (internal/googlehealth/auth.Scopes); nutrition.writeonly lets
 * later tools log food.
 */
export const GOOGLE_HEALTH_SCOPES = [
  `${SCOPE_PREFIX}activity_and_fitness.readonly`,
  `${SCOPE_PREFIX}health_metrics_and_measurements.readonly`,
  `${SCOPE_PREFIX}sleep.readonly`,
  `${SCOPE_PREFIX}nutrition.readonly`,
  `${SCOPE_PREFIX}nutrition.writeonly`,
] as const;

/** `openid email` identify the account for the allowlist check. */
export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email", ...GOOGLE_HEALTH_SCOPES] as const;

const ID_TOKEN_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/** Same codes as the Go server's coach.ToolError for auth failures. */
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
  );
}

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
  );
}

async function tokenRequest(form: Record<string, string>, now: number): Promise<GoogleTokens | GoogleError> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout. The error text could name the request; drop it.
    return { ok: false, code: "upstream_unavailable", message: "Google token endpoint unreachable" };
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON body (an HTML error page) is classified by status alone.
  }

  if (!response.ok) {
    const error = typeof body.error === "string" ? safeCode(body.error) : "unknown";
    const message = `Google token endpoint: ${error} (HTTP ${response.status})`;
    if (error === "invalid_grant") return { ok: false, code: "auth_expired", message };
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { ok: false, code: "upstream_unavailable", message };
    }
    return { ok: false, code: "internal_error", message };
  }

  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== "string" || accessToken === "" || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    return { ok: false, code: "internal_error", message: "Google token endpoint: malformed response" };
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
