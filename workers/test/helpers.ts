import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";

import { GOOGLE_AUTHORIZE_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from "../src/google";

export const ORIGIN = "http://localhost";
export const MCP_URL = `${ORIGIN}/mcp`;
export const CLIENT_REDIRECT = "https://client.example/callback";
export const OWNER_EMAIL = "owner@example.com";
export const OWNER_SUB = "100000000000000000001";
/** Distinct, greppable fake secrets: tests assert they never leak. */
export const GOOGLE_REFRESH_TOKEN = "fake-google-refresh-token-7f3a";
export const GOOGLE_ACCESS_TOKEN = "fake-google-access-token-9c1d";

export function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned ID token, as the code reads it from the token endpoint over TLS. */
export function idToken(claims: Record<string, unknown>): string {
  return [base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })), base64Url(JSON.stringify(claims)), "sig"].join(".");
}

export interface GoogleCalls {
  token: URLSearchParams[];
  revoke: URLSearchParams[];
}

export type TokenReply = (form: URLSearchParams) => Response | Promise<Response>;

/**
 * Replaces fetch for the whole isolate (the Worker, the provider and the
 * Durable Object share it). Only Google's token and revoke endpoints answer;
 * any other URL fails the test, so nothing reaches the network.
 */
export function mockGoogle(tokenReply: TokenReply): GoogleCalls {
  const calls: GoogleCalls = { token: [], revoke: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    if (request.url === GOOGLE_TOKEN_URL && request.method === "POST") {
      calls.token.push(form);
      return tokenReply(form);
    }
    if (request.url === GOOGLE_REVOKE_URL && request.method === "POST") {
      calls.revoke.push(form);
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${request.method} ${request.url}`);
  });
  return calls;
}

export interface GoogleIdentityClaims {
  email: string;
  sub?: string;
  email_verified?: boolean;
}

/** Google's answer to the authorization code exchange; echoes the nonce it was sent. */
export function codeExchangeReply(identity: GoogleIdentityClaims, nonce: () => string, extra: Record<string, unknown> = {}): TokenReply {
  return () =>
    Response.json({
      access_token: GOOGLE_ACCESS_TOKEN,
      expires_in: 3599,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      token_type: "Bearer",
      scope: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
        "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
        "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
        "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
        "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly",
      ].join(" "),
      id_token: idToken({
        iss: "https://accounts.google.com",
        aud: env.GOOGLE_CLIENT_ID,
        sub: identity.sub ?? OWNER_SUB,
        email: identity.email,
        email_verified: identity.email_verified ?? true,
        nonce: nonce(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      ...extra,
    });
}

export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, ORIGIN), { redirect: "manual", ...init }));
}

/** Keeps the cookies a browser would send back (name=value only). */
export class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(header) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface McpClient {
  clientId: string;
  verifier: string;
  challenge: string;
}

export async function registerClient(): Promise<McpClient> {
  const response = await call("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  const { client_id: clientId } = JSON.parse(text) as { client_id: string };
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { clientId, verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface GoogleRedirect {
  url: URL;
  jar: CookieJar;
}

/** The MCP client's /authorize, the consent page, and Allow: ends at the Google redirect. */
export async function startSignIn(client: McpClient, decision: "approve" | "deny" = "approve"): Promise<Response & { jar: CookieJar }> {
  const jar = new CookieJar();
  const authorize = new URL("/authorize", ORIGIN);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: client.challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: MCP_URL,
  }).toString();
  const consent = await call(authorize.toString());
  const html = await consent.text();
  expect(consent.status, html).toBe(200);
  jar.store(consent);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle, html).toBeTruthy();

  const submitted = await call("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), origin: ORIGIN },
    body: new URLSearchParams({ handle: handle ?? "", decision }).toString(),
  });
  jar.store(submitted);
  return Object.assign(submitted, { jar });
}

export function googleRedirect(response: Response & { jar: CookieJar }): GoogleRedirect {
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get("location") ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
  return { url, jar: response.jar };
}

/** Google sends the browser back to /callback with a code. */
export async function googleCallback(redirect: GoogleRedirect, params: Record<string, string> = { code: "google-code" }): Promise<Response> {
  const callback = new URL("/callback", ORIGIN);
  callback.search = new URLSearchParams({ state: redirect.url.searchParams.get("state") ?? "", ...params }).toString();
  const response = await call(callback.toString(), { headers: { cookie: redirect.jar.header() } });
  redirect.jar.store(response);
  return response;
}

export interface McpTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeMcpCode(client: McpClient, code: string): Promise<McpTokens> {
  const response = await call("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: client.clientId,
      code_verifier: client.verifier,
      resource: MCP_URL,
    }).toString(),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as McpTokens;
}

/** The whole flow for the allowed account; returns the MCP tokens. */
export async function signInAsOwner(): Promise<McpTokens & { calls: GoogleCalls; clientId: string }> {
  let nonce = "";
  const calls = mockGoogle(codeExchangeReply({ email: OWNER_EMAIL }, () => nonce));
  const client = await registerClient();
  const redirect = googleRedirect(await startSignIn(client));
  nonce = redirect.url.searchParams.get("nonce") ?? "";
  const back = await googleCallback(redirect);
  expect(back.status, await back.clone().text()).toBe(302);
  const location = new URL(back.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
  expect(location.searchParams.get("state")).toBe("client-state");
  const tokens = await exchangeMcpCode(client, location.searchParams.get("code") ?? "");
  return { ...tokens, calls, clientId: client.clientId };
}

export interface JsonRpc {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function parseRpc(contentType: string | null, text: string): JsonRpc {
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .find((line) => line.length > 0 && line !== "[DONE]");
    expect(data, text).toBeTruthy();
    return JSON.parse(data ?? "") as JsonRpc;
  }
  return JSON.parse(text) as JsonRpc;
}

export const MCP_HEADERS = {
  host: "localhost",
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-03-26",
};

export async function rpc(accessToken: string, body: unknown): Promise<JsonRpc> {
  const response = await exports.default.fetch(MCP_URL, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBeLessThan(400);
  return parseRpc(response.headers.get("content-type"), text);
}

/** Every key and value in OAUTH_KV, for leak checks. */
export async function dumpKv(): Promise<{ keys: string[]; values: string[] }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list(cursor ? { cursor } : {});
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const values = await Promise.all(keys.map(async (key) => (await env.OAUTH_KV.get(key)) ?? ""));
  return { keys, values };
}
