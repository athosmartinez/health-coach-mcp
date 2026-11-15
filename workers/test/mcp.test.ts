import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GOOGLE_HEALTH_SCOPES } from "../src/google";
import { SERVER_NAME, TRANSPORT, VERSION } from "../src/version";
import {
  GOOGLE_ACCESS_TOKEN,
  GOOGLE_REFRESH_TOKEN,
  type JsonRpc,
  MCP_HEADERS,
  MCP_URL,
  OWNER_EMAIL,
  parseRpc,
  rpc,
  signInAsOwner,
} from "./helpers";
import { ALL_TOOL_NAMES } from "./memory-helpers";

const MODERN_PROTOCOL = "2026-07-28";

let accessToken = "";

beforeEach(async () => {
  accessToken = (await signInAsOwner()).access_token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const post = (body: unknown) => rpc(accessToken, body);

describe("MCP /mcp", () => {
  it("lists the tools and returns server_info", async () => {
    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "health-coach-mcp-test", version: "0" },
      },
    });
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toMatchObject({
      serverInfo: { name: SERVER_NAME, version: VERSION },
    });

    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.error).toBeUndefined();
    const tools = (listed.result as { tools?: { name: string }[] }).tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOL_NAMES);

    const called = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "server_info", arguments: {} },
    });
    expect(called.error).toBeUndefined();
    const result = called.result as {
      isError?: boolean;
      structuredContent?: { name: string; version: string; transport: string };
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      name: SERVER_NAME,
      version: VERSION,
      transport: TRANSPORT,
    });
  });

  it("confirms the Google link with google_account_status, without tokens", async () => {
    const called = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "google_account_status", arguments: {} },
    });
    expect(called.error).toBeUndefined();
    const result = called.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      linked: true,
      email: OWNER_EMAIL,
      linked_at: expect.any(String),
      scopes_missing: [],
      token: "ok",
      hint: null,
    });
    expect(result.structuredContent?.scopes_granted).toEqual(expect.arrayContaining([...GOOGLE_HEALTH_SCOPES]));
    const text = JSON.stringify(called);
    expect(text).not.toContain(GOOGLE_REFRESH_TOKEN);
    expect(text).not.toContain(GOOGLE_ACCESS_TOKEN);
  });

  // A 2026-07-28 request carries its protocol version and client in params._meta
  // and skips initialize. The SDK serves it on a different path than the
  // claim-less 2025 requests above.
  it("serves server_info on the 2026-07-28 per-request protocol", async () => {
    const response = await exports.default.fetch(MCP_URL, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        authorization: `Bearer ${accessToken}`,
        "mcp-protocol-version": MODERN_PROTOCOL,
        "mcp-method": "tools/call",
        "mcp-name": "server_info",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "server_info",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "health-coach-mcp-test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const called = parseRpc(response.headers.get("content-type"), text);
    expect(called.error).toBeUndefined();
    expect((called.result as { structuredContent?: unknown }).structuredContent).toEqual({
      name: SERVER_NAME,
      version: VERSION,
      transport: TRANSPORT,
    });
  });

  it.each([
    { name: "wrong path", url: "http://localhost/other", method: "POST", body: "{}", status: 404 },
    { name: "GET without a token", url: MCP_URL, method: "GET", status: 401, anonymous: true },
    { name: "GET", url: MCP_URL, method: "GET", status: 405, code: -32000 },
    { name: "DELETE", url: MCP_URL, method: "DELETE", status: 405, code: -32000 },
    { name: "invalid JSON", url: MCP_URL, method: "POST", body: "{nope", status: 400, code: -32700 },
    {
      name: "foreign Origin",
      url: MCP_URL,
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      origin: "https://evil.example",
      status: 403,
      code: -32000,
    },
  ])("rejects $name with HTTP $status", async ({ url, method, body, origin, status, code, anonymous }) => {
    const headers: Record<string, string> = { ...MCP_HEADERS };
    if (!anonymous) headers.authorization = `Bearer ${accessToken}`;
    if (origin) headers.origin = origin;
    const response = await exports.default.fetch(url, { method, headers, body });
    const text = await response.text();
    expect(response.status, text).toBe(status);
    if (code !== undefined) {
      expect((JSON.parse(text) as JsonRpc).error?.code, text).toBe(code);
    }
  });
});
