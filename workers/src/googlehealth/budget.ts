// What one MCP HTTP request may still spend on Google. The numbers come from
// the Workers Free plan and are named only here.

/** Workers Free: external subrequests of one invocation (the Worker and the Durable Object together). */
export const MAX_SUBREQUESTS = 50;

/**
 * Token endpoint requests one MCP HTTP request may cause, outside the Google
 * Health budget: one when the cached access token is about to expire, and one
 * after Google rejects a token (FORCED_RENEWALS).
 */
export const TOKEN_REQUESTS = 2;

/** Token renewals that rejected tokens may force in one MCP HTTP request. */
export const FORCED_RENEWALS = 1;

/**
 * Left unused. It covers the token requests beyond TOKEN_REQUESTS: a sign-in
 * that replaces the link while a renewal is in flight makes that renewal send
 * a second request. RequestTokens (tokens.ts) asks the store at most
 * TOKEN_REQUESTS times in one MCP HTTP request, so the worst case is
 * 2 × TOKEN_REQUESTS token requests: two more than planned, within this spare.
 */
export const SPARE_SUBREQUESTS = 3;

/**
 * Google Health API requests one MCP HTTP request may send. Every HTTP attempt
 * counts: a first try, a retry, a page and a request sent again after a token
 * renewal.
 */
export const HEALTH_REQUESTS = MAX_SUBREQUESTS - TOKEN_REQUESTS - SPARE_SUBREQUESTS;

/**
 * The request budget of one MCP HTTP request. The caller creates it once per
 * request and gives it to the Google Health client, so every tool call of that
 * request shares it. A request that would pass the budget is not sent.
 */
export class RequestBudget {
  private sent = 0;
  private renewals = 0;
  private sentBefore = 0;

  /**
   * The error of the token source in this MCP request. Once it fails, later
   * calls fail the same way without asking again: each new ask of a failing
   * token source is another token endpoint request.
   */
  tokenFailure: Error | undefined;

  /** A smaller limit is for tests; the limits never pass the plan's numbers. */
  constructor(
    readonly limit: number = HEALTH_REQUESTS,
    readonly renewalLimit: number = FORCED_RENEWALS,
  ) {
    if (!Number.isInteger(limit) || limit < 0 || limit > HEALTH_REQUESTS) {
      throw new Error(`a request budget holds 0 to ${HEALTH_REQUESTS} requests`);
    }
    if (!Number.isInteger(renewalLimit) || renewalLimit < 0 || renewalLimit > FORCED_RENEWALS) {
      throw new Error(`a request budget holds 0 to ${FORCED_RENEWALS} forced renewals`);
    }
  }

  /** Google Health API requests sent so far. */
  get used(): number {
    return this.sent;
  }

  /** Google Health API requests that can still be sent. */
  get remaining(): number {
    return this.limit - this.sent;
  }

  /**
   * Marks the start of a tool call. One MCP HTTP request can carry several
   * tool calls, which take turns: the units taken so far were taken by the
   * calls before this one.
   */
  beginCall(): void {
    this.sentBefore = this.sent;
  }

  /**
   * Whether earlier tool calls of the same MCP HTTP request took units before
   * the present call started. Such a call can run out of budget for a range
   * that fits a request of its own.
   */
  get sharedBefore(): boolean {
    return this.sentBefore > 0;
  }

  /** Takes the unit of one HTTP attempt. False when none is left: the request must not be sent. */
  take(): boolean {
    if (this.sent >= this.limit) return false;
    this.sent++;
    return true;
  }

  /** Whether a rejected token may still force a renewal in this MCP request. */
  get canRenew(): boolean {
    return this.renewals < this.renewalLimit;
  }

  /** Records a forced renewal. False when none is left. */
  takeRenewal(): boolean {
    if (!this.canRenew) return false;
    this.renewals++;
    return true;
  }
}
