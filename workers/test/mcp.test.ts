import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { SERVER_NAME, TRANSPORT, VERSION } from "../src/version";

const MCP_URL = "http://localhost/mcp";

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
});
