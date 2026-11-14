import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { SERVER_NAME, TRANSPORT, VERSION } from "../src/version";

const MCP_URL = "http://localhost/mcp";
const MODERN_PROTOCOL = "2026-07-28";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "localhost",
  "mcp-protocol-version": "2025-03-26",
};

interface JsonRpc {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function post(body: unknown): Promise<JsonRpc> {
  const response = await exports.default.fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBeLessThan(400);
  return parseRpc(response.headers.get("content-type"), text);
}

function parseRpc(contentType: string | null, text: string): JsonRpc {
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

describe("MCP /mcp", () => {
  it("lists server_info and returns name, version, and transport", async () => {
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
    expect(tools.map((tool) => tool.name)).toEqual(["server_info"]);

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

  // A 2026-07-28 request carries its protocol version and client in params._meta
  // and skips initialize. The SDK serves it on a different path than the
  // claim-less 2025 requests above.
  it("serves server_info on the 2026-07-28 per-request protocol", async () => {
    const response = await exports.default.fetch(MCP_URL, {
      method: "POST",
      headers: {
        ...headers,
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

  // No auth in this phase: a valid call without credentials succeeds (tests
  // above). The OAuth phase must change that on purpose, to 401.
  it.each([
    { name: "wrong path", url: "http://localhost/other", method: "POST", body: "{}", status: 404 },
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
  ])("rejects $name with HTTP $status", async ({ url, method, body, origin, status, code }) => {
    const response = await exports.default.fetch(url, {
      method,
      headers: origin ? { ...headers, origin } : headers,
      body,
    });
    const text = await response.text();
    expect(response.status, text).toBe(status);
    if (code !== undefined) {
      expect((JSON.parse(text) as JsonRpc).error?.code, text).toBe(code);
    }
  });
});
