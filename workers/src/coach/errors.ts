// The stable error contract of every tool (Go: internal/coach/errors.go).

/** Stable, machine-readable error identifiers agents can branch on. */
export const CODES = [
  "auth_expired",
  "scope_missing",
  "upstream_unavailable",
  "no_data",
  "invalid_input",
  "internal_error",
] as const;

export type Code = (typeof CODES)[number];

/**
 * The error as the client reads it: the JSON text of a tool error result. A
 * plain object, so it can cross Durable Object RPC (a thrown error loses its
 * type and fields there).
 */
export interface WireError {
  code: Code;
  message: string;
  hint?: string;
}

/**
 * An error meant to reach the model. `message` and `hint` must never contain
 * health values: they may be shown outside the conversation.
 */
export class ToolError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly hint?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolError";
  }

  wire(): WireError {
    return this.hint ? { code: this.code, message: this.message, hint: this.hint } : { code: this.code, message: this.message };
  }
}

/** What the client sees for any error that is not a ToolError: its text may carry health data. */
export const INTERNAL_ERROR: WireError = { code: "internal_error", message: "unexpected internal error" };

const MAX_CHAIN = 8;

/** The causes of an error, depth first: every branch of an AggregateError, then `cause`. */
function* chain(error: unknown, budget = { left: MAX_CHAIN }): Generator<unknown> {
  if (error === undefined || error === null || budget.left === 0) return;
  budget.left--;
  yield error;
  if (error instanceof AggregateError) for (const inner of error.errors) yield* chain(inner, budget);
  if (error instanceof Error) yield* chain(error.cause, budget);
}

/** The ToolError in the error's cause chain, else the generic internal error. */
export function toWire(error: unknown): WireError {
  for (const link of chain(error)) if (link instanceof ToolError) return link.wire();
  return INTERNAL_ERROR;
}

/**
 * Names the types along an error's cause chain ("ToolError > SyntaxError"):
 * enough to tell a database fault from a bug without logging any message text.
 */
export function errorTypes(error: unknown): string {
  const names: string[] = [];
  for (const link of chain(error)) {
    names.push(link instanceof Error ? link.constructor.name || "Error" : typeof link);
  }
  return names.join(" > ");
}

/** The JSON a tool error carries as its only text content: code, message, then hint. */
export function wireText(error: WireError): string {
  return JSON.stringify(error.hint ? { code: error.code, message: error.message, hint: error.hint } : { code: error.code, message: error.message });
}
