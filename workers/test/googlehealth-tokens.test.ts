// The access token of one MCP HTTP request: one answer for every tool call,
// and at most TOKEN_REQUESTS asks of the store.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GOOGLE_HEALTH_SCOPES } from "../src/google";
import { RequestBudget, TOKEN_REQUESTS } from "../src/googlehealth/budget";
import { GoogleHealthClient, type TokenResult, type TokenSource } from "../src/googlehealth/client";
import { RequestTokens } from "../src/googlehealth/tokens";
import type { CoachStore } from "../src/store";
import { GOOGLE_REFRESH_TOKEN, OWNER_EMAIL, OWNER_SUB, mockGoogle } from "./helpers";
import { SAO_PAULO, freshStore } from "./memory-helpers";

/**
 * Hands out at-0, at-1, ... and renews after `invalidate` of the current
 * token, like the CoachStore object.
 */
class FakeStore implements TokenSource {
  n = 0;
  stale = false;
  asked = 0;
  invalidated: string[] = [];
  failure: TokenResult | undefined;

  async accessToken(): Promise<TokenResult> {
    this.asked++;
    if (this.failure) return this.failure;
    if (this.stale) {
      this.n++;
      this.stale = false;
    }
    return { ok: true, accessToken: `at-${this.n}` };
  }

  invalidate(rejected: string): boolean {
    this.invalidated.push(rejected);
    if (rejected !== `at-${this.n}`) return false;
    this.stale = true;
    return true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the token of one MCP request", () => {
  it("asks the store once for every ask of the request", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    // Tool calls of a batch ask together; later calls ask again.
    const together = await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]);
    expect(together).toEqual(Array.from({ length: 3 }, () => ({ ok: true, accessToken: "at-0" })));
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-0" });
    expect(store.asked).toBe(1);
    expect(tokens.asked).toBe(1);
  });

  it.each<TokenResult>([
    { ok: false, code: "not_linked" },
    { ok: false, code: "auth_expired" },
    { ok: false, code: "upstream_unavailable" },
    { ok: false, code: "internal_error" },
  ])("shares the failure $code without asking again", async (failure) => {
    const store = new FakeStore();
    store.failure = failure;
    const tokens = new RequestTokens(store);
    expect(await tokens.accessToken()).toEqual(failure);
    expect(await tokens.accessToken()).toEqual(failure);
    expect(store.asked).toBe(1);
  });

  it("asks once more after Google rejects the token it holds", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-0" });
    // The store's verdict is passed on: the client counts its forced renewal on it.
    expect(await tokens.invalidate("at-0")).toBe(true);
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-1" });
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-1" });
    expect(store.asked).toBe(2);
  });

  it("asks again for a held token that another request already replaced", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    await tokens.accessToken();
    // Another MCP request renewed the token in the store.
    store.n = 1;
    expect(await tokens.invalidate("at-0")).toBe(false);
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-1" });
    expect(store.asked).toBe(2);
  });

  it("keeps its token when the rejected one is not the token it holds", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    await tokens.accessToken();
    expect(await tokens.invalidate("at-older")).toBe(false);
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-0" });
    expect(store.asked).toBe(1);
    expect(store.invalidated).toEqual(["at-older"]);
  });

  it("has no token any more when the last one it may ask for is rejected", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    expect(TOKEN_REQUESTS).toBe(2);
    await tokens.accessToken();
    await tokens.invalidate("at-0");
    await tokens.accessToken();
    // The second token is rejected too: the store is not asked a third time.
    expect(await tokens.invalidate("at-1")).toBe(true);
    expect(await tokens.accessToken()).toEqual({ ok: false, code: "auth_expired" });
    expect(await tokens.accessToken()).toEqual({ ok: false, code: "auth_expired" });
    expect(store.asked).toBe(TOKEN_REQUESTS);
    expect(tokens.asked).toBe(TOKEN_REQUESTS);
  });

  it("reports a rejection before any ask to the store, and holds nothing", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store);
    expect(await tokens.invalidate("at-0")).toBe(true);
    expect(await tokens.accessToken()).toEqual({ ok: true, accessToken: "at-1" });
    expect(store.asked).toBe(1);
  });

  it.each([0, 3, 1.5, -1, Number.NaN])("refuses a limit of %s asks", (limit) => {
    expect(() => new RequestTokens(new FakeStore(), limit)).toThrow("a request asks for a token 1 to 2 times");
  });

  it("takes a smaller limit for a test", async () => {
    const store = new FakeStore();
    const tokens = new RequestTokens(store, 1);
    await tokens.accessToken();
    await tokens.invalidate("at-0");
    expect(await tokens.accessToken()).toEqual({ ok: false, code: "auth_expired" });
    expect(store.asked).toBe(1);
  });
});

describe("the token of one MCP request, over the CoachStore object", () => {
  const API = "https://health.googleapis.com";

  /** A paged list through the client of one MCP request, inside the object. */
  function listIn(stub: DurableObjectStub<CoachStore>, shared: boolean) {
    return runInDurableObject(stub, async (instance) => {
      const store: TokenSource = {
        accessToken: () => instance.googleAccessToken(),
        invalidate: (rejected) => instance.invalidateGoogleAccessToken(rejected),
      };
      const client = new GoogleHealthClient({
        tokens: shared ? new RequestTokens(store) : store,
        zone: SAO_PAULO,
        budget: new RequestBudget(),
        wait: async () => undefined,
        jitter: (ms) => ms,
      });
      return client.list("steps", "2026-10-01", "2026-10-07", (record) => (record as { name: string }).name);
    });
  }

  it("sends one token request when every new token is already near its expiry", async () => {
    // A token endpoint that hands out tokens good for 30 seconds: the store
    // renews such a token on every ask.
    let issued = 0;
    const pages = 6;
    let page = 0;
    const calls = mockGoogle(
      () => Response.json({ access_token: `short-${++issued}`, expires_in: 30, token_type: "Bearer" }),
      (request) => {
        if (!request.url.startsWith(`${API}/v4/`)) return undefined;
        page++;
        return Response.json({ dataPoints: [{ name: `p${page}` }], ...(page % pages === 0 ? {} : { nextPageToken: `t${page}` }) });
      },
    );
    const link = {
      sub: OWNER_SUB,
      email: OWNER_EMAIL,
      refreshToken: GOOGLE_REFRESH_TOKEN,
      accessToken: "at-old",
      accessTokenExpiresAt: 0,
      scopes: ["openid", "email", ...GOOGLE_HEALTH_SCOPES].join(" "),
    };
    const stub = freshStore();
    await stub.linkGoogleAccount(link);
    expect(await listIn(stub, true)).toHaveLength(pages);
    expect(calls.token).toHaveLength(1);
    // Without the shared answer, each of the 6 pages renews the token.
    const bare = freshStore();
    await bare.linkGoogleAccount(link);
    expect(await listIn(bare, false)).toHaveLength(pages);
    expect(calls.token).toHaveLength(1 + pages);
  });
});
