import { describe, expect, it } from "vitest";

import { call, MCP_HEADERS } from "./helpers";

function expectHtmlHeaders(response: Response) {
  expect(response.headers.get("content-type")).toMatch(/text\/html;\s*charset=utf-8/i);
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("public pages", () => {
  it("serves the home page without auth", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expectHtmlHeaders(response);
    const body = await response.text();
    expect(body).toContain("health-coach-mcp");
    expect(body).toContain("personal remote MCP server");
    expect(body).toContain("Google Health");
    expect(body).toContain("Claude");
    expect(body).toContain("ChatGPT");
    expect(body).toContain('href="/privacy"');
    expect(body).not.toMatch(/<script/i);
  });

  it("serves the privacy policy without auth", async () => {
    const response = await call("/privacy");
    expect(response.status).toBe(200);
    expectHtmlHeaders(response);
    const body = await response.text();
    expect(body).toMatch(/allowlisted Google account/i);
    expect(body).toContain("openid");
    expect(body).toContain("email");
    expect(body).toContain("googlehealth.activity_and_fitness.readonly");
    expect(body).toContain("googlehealth.health_metrics_and_measurements.readonly");
    expect(body).toContain("googlehealth.sleep.readonly");
    expect(body).toContain("googlehealth.nutrition.readonly");
    expect(body).toContain("googlehealth.nutrition.writeonly");
    // Both uses of the write scope: the add, and the delete of the server's own entries.
    expect(body).toContain("to log food for the owner, and to delete food entries that this server logged.");
    expect(body).toContain("Durable Object");
    expect(body).toMatch(/never logged or shared/i);
    expect(body).toMatch(/not sold or shared with third parties/i);
    expect(body).toMatch(/Limited Use/);
    expect(body).toContain("Google API Services User Data Policy");
    expect(body).toContain("https://developers.google.com/terms/api-services-user-data-policy");
    expect(body).toContain("Third-party access");
    expect(body).toContain("open an issue on this repository");
    expect(body).not.toMatch(/mailto:/i);
    expect(body).not.toMatch(/<script/i);
  });

  it("still returns 401 from /mcp without a token", async () => {
    const response = await call("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
