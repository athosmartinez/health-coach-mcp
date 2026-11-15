import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GOOGLE_HEALTH_SCOPES } from "../src/google";
import { providerOptions } from "../src/index";
import { coachStore } from "../src/store";
import {
  call,
  cimdClient,
  CLIENT_REDIRECT,
  codeExchangeReply,
  dumpKv,
  exchangeMcpCode,
  GOOGLE_ACCESS_TOKEN,
  GOOGLE_REFRESH_TOKEN,
  googleCallback,
  googleRedirect,
  MCP_HEADERS,
  MCP_URL,
  mockGoogle,
  ORIGIN,
  OWNER_EMAIL,
  OWNER_SUB,
  registerClient,
  rpc,
  signInAsOwner,
  startSignIn,
} from "./helpers";
import { ALL_TOOL_NAMES } from "./memory-helpers";

async function accountRows(): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(coachStore(env), async (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM google_account").toArray(),
  );
}

beforeEach(async () => {
  await runInDurableObject(coachStore(env), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM google_account");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth metadata", () => {
  it("publishes authorization server metadata with PKCE, DCR and CIMD", async () => {
    const response = await call("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
  });

  it("publishes protected resource metadata for /mcp", async () => {
    const response = await call("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: [ORIGIN],
    });
  });
});

describe("/mcp authorization", () => {
  it("answers 401 with a resource_metadata challenge without a token", async () => {
    const response = await call("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("answers 401 to an unknown bearer token", async () => {
    const response = await call("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer not-a-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("Google sign-in", () => {
  it("sends the user to Google with offline access, consent, PKCE and the coach scopes", async () => {
    mockGoogle(() => new Response(null, { status: 500 }));
    const redirect = googleRedirect(await startSignIn(await registerClient()));
    const params = redirect.url.searchParams;
    expect(params.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();
    expect(params.get("state")).toBeTruthy();
    expect(params.has("login_hint")).toBe(false);
    expect(params.get("scope")?.split(" ").sort()).toEqual(["openid", "email", ...GOOGLE_HEALTH_SCOPES].sort());
  });

  it("links the allowed account, issues MCP tokens and keeps the Google token out of KV", async () => {
    const tokens = await signInAsOwner();
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeTruthy();

    // Google got the PKCE verifier and the same redirect URI.
    const exchange = tokens.calls.token[0];
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code")).toBe("google-code");
    expect(exchange?.get("code_verifier")).toBeTruthy();
    expect(exchange?.get("redirect_uri")).toBe(`${ORIGIN}/callback`);

    const [row] = await accountRows();
    expect(row).toMatchObject({ email: OWNER_EMAIL, refresh_token: GOOGLE_REFRESH_TOKEN });

    const kv = await dumpKv();
    expect(kv.keys.some((key) => key.startsWith("grant:"))).toBe(true);
    for (const text of [...kv.keys, ...kv.values]) {
      expect(text).not.toContain(GOOGLE_REFRESH_TOKEN);
      expect(text).not.toContain(GOOGLE_ACCESS_TOKEN);
    }
    // Grant props are encrypted in KV, so a plain search cannot see them: decrypt them.
    const summary = await getOAuthApi(providerOptions(ORIGIN), env).unwrapToken<Record<string, unknown>>(tokens.access_token);
    expect(summary?.grant.props).toEqual({ sub: OWNER_SUB, email: OWNER_EMAIL });

    // The MCP access token opens /mcp.
    const listed = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((listed.result as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
    expect(names.sort()).toEqual(ALL_TOOL_NAMES);

    // The MCP refresh token works and rotates.
    const refreshed = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        client_id: tokens.clientId,
      }).toString(),
    });
    const refreshedBody = await refreshed.text();
    expect(refreshed.status, refreshedBody).toBe(200);
    expect(JSON.parse(refreshedBody)).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String) });
  });

  it("rejects any other Google account: 403, token revoked, nothing stored", async () => {
    let nonce = "";
    const calls = mockGoogle(codeExchangeReply({ email: "stranger@example.com", sub: "2" }, () => nonce));
    const client = await registerClient();
    const redirect = googleRedirect(await startSignIn(client));
    nonce = redirect.url.searchParams.get("nonce") ?? "";
    const before = await dumpKv();

    const response = await googleCallback(redirect);
    const html = await response.text();
    expect(response.status).toBe(403);
    expect(html).toContain("Account not allowed");
    expect(html).not.toContain(OWNER_EMAIL);
    expect(response.headers.get("location")).toBeNull();

    expect(calls.revoke.map((form) => form.get("token"))).toEqual([GOOGLE_REFRESH_TOKEN]);
    expect(await accountRows()).toEqual([]);
    const after = await dumpKv();
    const added = after.keys.filter((key) => !before.keys.includes(key));
    expect(added.filter((key) => key.startsWith("grant:") || key.startsWith("token:"))).toEqual([]);
    for (const text of after.values) expect(text).not.toContain(GOOGLE_REFRESH_TOKEN);
  });

  it("rejects the allowed address when Google has not verified it", async () => {
    let nonce = "";
    const calls = mockGoogle(codeExchangeReply({ email: OWNER_EMAIL, email_verified: false }, () => nonce));
    const redirect = googleRedirect(await startSignIn(await registerClient()));
    nonce = redirect.url.searchParams.get("nonce") ?? "";
    const response = await googleCallback(redirect);
    expect(response.status).toBe(403);
    expect(calls.revoke).toHaveLength(1);
    expect(await accountRows()).toEqual([]);
  });

  it("rejects an ID token whose nonce does not match", async () => {
    const calls = mockGoogle(codeExchangeReply({ email: OWNER_EMAIL }, () => "another-nonce"));
    const redirect = googleRedirect(await startSignIn(await registerClient()));
    const response = await googleCallback(redirect);
    expect(response.status).toBe(502);
    expect(calls.revoke).toHaveLength(1);
    expect(await accountRows()).toEqual([]);
  });

  it("does not link without a Google refresh token", async () => {
    let nonce = "";
    mockGoogle(codeExchangeReply({ email: OWNER_EMAIL }, () => nonce, { refresh_token: undefined }));
    const redirect = googleRedirect(await startSignIn(await registerClient()));
    nonce = redirect.url.searchParams.get("nonce") ?? "";
    const response = await googleCallback(redirect);
    expect(response.status).toBe(502);
    expect(await accountRows()).toEqual([]);
  });

  it("sends access_denied to the client when the user declines at Google", async () => {
    const calls = mockGoogle(() => new Response(null, { status: 500 }));
    const redirect = googleRedirect(await startSignIn(await registerClient()));
    const response = await googleCallback(redirect, { error: "access_denied" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(calls.token).toEqual([]);
  });

  it("sends access_denied to the client when the user denies on the consent page", async () => {
    mockGoogle(() => new Response(null, { status: 500 }));
    const response = await startSignIn(await registerClient(), "deny");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("refuses a replayed callback state", async () => {
    let nonce = "";
    mockGoogle(codeExchangeReply({ email: OWNER_EMAIL }, () => nonce));
    const client = await registerClient();
    const redirect = googleRedirect(await startSignIn(client));
    nonce = redirect.url.searchParams.get("nonce") ?? "";
    const jarBefore = redirect.jar.header();
    expect((await googleCallback(redirect)).status).toBe(302);
    const replay = await call(
      `/callback?${new URLSearchParams({ state: redirect.url.searchParams.get("state") ?? "", code: "google-code" })}`,
      { headers: { cookie: jarBefore } },
    );
    expect(replay.status).toBe(400);
  });

  it("exchanges the MCP code only once", async () => {
    let nonce = "";
    mockGoogle(codeExchangeReply({ email: OWNER_EMAIL }, () => nonce));
    const client = await registerClient();
    const redirect = googleRedirect(await startSignIn(client));
    nonce = redirect.url.searchParams.get("nonce") ?? "";
    const back = await googleCallback(redirect);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    await exchangeMcpCode(client, code);
    const again = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: client.clientId,
        code_verifier: client.verifier,
      }).toString(),
    });
    expect(again.status).toBe(400);
  });

  it("signs in a Client ID Metadata Document client", async () => {
    const clientId = "https://client.example/oauth/client-metadata.json";
    const document = {
      client_id: clientId,
      client_name: "CIMD test client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    const serveDocument = (request: Request) =>
      request.url === clientId
        ? Response.json(document, { headers: { "cache-control": "no-store" } })
        : undefined;
    const tokens = await signInAsOwner({ client: await cimdClient(clientId), other: serveDocument });
    expect(tokens.refresh_token).toBeTruthy();
    const listed = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.error).toBeUndefined();
  });

  it("refuses a CIMD client's redirect URI that its document does not list", async () => {
    const clientId = "https://client.example/oauth/other-metadata.json";
    mockGoogle(
      () => new Response(null, { status: 500 }),
      (request) =>
        request.url === clientId
          ? Response.json({
              client_id: clientId,
              client_name: "CIMD test client",
              redirect_uris: ["https://client.example/elsewhere"],
              token_endpoint_auth_method: "none",
            })
          : undefined,
    );
    const client = await cimdClient(clientId);
    const authorize = new URL("/authorize", ORIGIN);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: client.challenge,
      code_challenge_method: "S256",
      state: "client-state",
    }).toString();
    const response = await call(authorize.toString());
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("allowlist changes", () => {
  const original = env.ALLOWED_GOOGLE_EMAIL;

  afterEach(() => {
    env.ALLOWED_GOOGLE_EMAIL = original;
  });

  it("cuts off grants of the previous account at /mcp and at refresh", async () => {
    const tokens = await signInAsOwner();
    env.ALLOWED_GOOGLE_EMAIL = "someone-else@example.com";

    const denied = await call("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(denied.status).toBe(403);

    const refreshed = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        client_id: tokens.clientId,
      }).toString(),
    });
    expect(refreshed.status).toBe(400);
    expect(((await refreshed.json()) as { error?: string }).error).toBe("invalid_grant");
  });
});

describe("several hostnames", () => {
  it("signs in on each origin with that origin's resource", async () => {
    mockGoogle(() => new Response(null, { status: 500 }));
    // Any request through the default handler on another host first.
    expect((await exports.default.fetch("https://other.example/favicon.ico")).status).toBe(404);
    const otherConsent = await exports.default.fetch(
      `https://other.example/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: (await registerClient()).clientId,
        redirect_uri: CLIENT_REDIRECT,
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        resource: "https://other.example/mcp",
      })}`,
    );
    expect(otherConsent.status, await otherConsent.text()).toBe(200);
    vi.restoreAllMocks();

    // Then the usual sign-in on localhost still works.
    const tokens = await signInAsOwner();
    expect(tokens.access_token).toBeTruthy();
  });
});
