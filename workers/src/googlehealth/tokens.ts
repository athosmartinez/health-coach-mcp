// The access token of one MCP HTTP request.

import { TOKEN_REQUESTS } from "./budget";
import type { TokenResult, TokenSource } from "./client";

/**
 * Shares one token answer between every tool call of an MCP HTTP request. One
 * HTTP request can carry several tool calls (a JSON-RPC batch of up to 100
 * messages), and every ask of the store can be a token endpoint request. So
 * the store is asked at most TOKEN_REQUESTS times: once at first, and once
 * more after Google rejects that token. A failure is an answer too: a token
 * endpoint that is down is asked once, whatever the request calls.
 *
 * An ask sends one token request, or two when a sign-in replaces the link
 * while the renewal is in flight. So one MCP HTTP request sends at most
 * 2 × TOKEN_REQUESTS token requests, which the spare subrequests cover.
 *
 * The answer is not checked against the linked account again either: when
 * another Google account signs in during the request, the later calls still
 * get the token of the account before. The answer names the account of its
 * token (`sub`), and a write that is bound to an account compares the two
 * (GoogleHealthClient.request).
 *
 * The answer is not checked against the clock again: a token is good for at
 * least a minute when the store hands it out, and one that expires during a
 * longer request is rejected by Google and renewed like any rejected token.
 */
export class RequestTokens implements TokenSource {
  private asks = 0;
  private answer: Promise<TokenResult> | undefined;

  constructor(
    private readonly store: TokenSource,
    /** A smaller limit is for tests. */
    readonly limit: number = TOKEN_REQUESTS,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > TOKEN_REQUESTS) {
      throw new Error(`a request asks for a token 1 to ${TOKEN_REQUESTS} times`);
    }
  }

  /** Asks of the store so far. */
  get asked(): number {
    return this.asks;
  }

  accessToken(): Promise<TokenResult> {
    if (!this.answer) {
      this.asks++;
      this.answer = this.store.accessToken();
    }
    return this.answer;
  }

  /**
   * Reports a token Google rejected. When it is the token this request holds,
   * the next ask goes to the store again; with no ask left, the request has no
   * token any more.
   */
  async invalidate(rejected: string): Promise<boolean> {
    const marked = await this.store.invalidate(rejected);
    const held = await this.answer;
    if (held?.ok && held.accessToken === rejected) {
      const gone: TokenResult = { ok: false, code: "auth_expired" };
      this.answer = this.asks < this.limit ? undefined : Promise.resolve(gone);
    }
    return marked;
  }
}
