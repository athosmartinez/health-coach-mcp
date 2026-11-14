// The only way to add a tool (Go: internal/tools/register.go, plus the
// tool-call log and the error contract of internal/server/middleware.go).
//
// Every tool goes through `register`, because it guarantees the error contract:
//   - any error reaches the client as the JSON {code,message,hint} in the text
//     content, with isError and no structuredContent;
//   - arguments that fail the input schema are invalid_input, not a plain-text
//     SDK error;
//   - an unexpected error becomes internal_error: its text (which may carry
//     health values) is never sent or logged, only its type names are;
//   - one log line per call, with the tool name, duration and outcome only.

import {
  type CallToolResult,
  type McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  fromJsonSchema,
} from "@modelcontextprotocol/server";

import { INTERNAL_ERROR, type WireError, errorTypes, toWire, wireText } from "../coach/errors";
import { truncate } from "../coach/text";
import { type JsonSchema, invalidDate } from "./schema";

/**
 * What a tool body produces. A result rather than a throw, so it can cross
 * Durable Object RPC: a thrown error loses its type and fields there.
 */
export type ToolOutcome = { ok: true; output: Record<string, unknown> } | { ok: false; error: WireError };

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

/** A tool definition with its validators, built once per isolate. */
export interface Tool extends ToolDefinition {
  /** Why the arguments are rejected, or undefined when they pass. */
  checkInput(args: unknown): string | undefined;
  /** Why a result does not match the output schema, or undefined when it does. */
  checkOutput(output: unknown): string | undefined;
}

type ObjectSchema = StandardSchemaWithJSON<Record<string, unknown>>;

function validator(schema: JsonSchema): (value: unknown) => string | undefined {
  const standard = fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0])["~standard"];
  return (value) => {
    // undefined is not a JSON value: checked as null, it fails the schema's type.
    const result = standard.validate(value === undefined ? null : value);
    // The SDK's JSON Schema validator is synchronous.
    if (result instanceof Promise) throw new Error("the schema validator is asynchronous");
    return result.issues?.length ? result.issues.map((issue) => issue.message).join("; ") : undefined;
  };
}

/**
 * Compiles a tool definition. Call it at module scope: createServer runs on
 * every request, and the validators must not be rebuilt each time.
 */
export function defineTool(definition: ToolDefinition): Tool {
  const matchesInput = validator(definition.inputSchema);
  const matchesOutput = validator(definition.outputSchema);
  return {
    ...definition,
    checkInput: (args) => matchesInput(args) ?? invalidDate(definition.inputSchema, args),
    checkOutput: matchesOutput,
  };
}

/**
 * The schema as the SDK lists it. Its validation passes everything: `register`
 * checks the arguments itself, so a rejection keeps the error contract, and
 * results are checked where the tool body runs.
 */
function listed(schema: JsonSchema): ObjectSchema {
  const json = schema as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "health-coach-mcp",
      jsonSchema: { input: () => json, output: () => json },
      validate: (value) => ({ value: value as Record<string, unknown> }),
    },
  };
}

/**
 * Bounds validator text copied into an error message: it can quote names the
 * client sent.
 */
export const MAX_ECHOED_ERROR = 500;

/** The error for arguments that do not match the tool's input schema. */
export function schemaError(detail: string): WireError {
  return {
    code: "invalid_input",
    message: truncate(`the arguments do not match the tool's input schema: ${detail}`, MAX_ECHOED_ERROR),
    hint: "check the tool's input schema and retry",
  };
}

/** The error result: the JSON in the text content, never structuredContent (it would fail the output schema). */
export function errorResult(error: WireError): CallToolResult {
  return { content: [{ type: "text", text: wireText(error) }], isError: true };
}

export type ToolHandler = (args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>;

/** Adds a tool to the server. The handler gets arguments that passed the input schema. */
export function register(server: McpServer, tool: Tool, handler: ToolHandler): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: listed(tool.inputSchema),
      outputSchema: listed(tool.outputSchema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    },
    (args) => invoke(tool, handler, args),
  );
}

/**
 * One tool call, as `register` serves it: checks the arguments, runs the
 * handler, writes the log line and builds the result.
 */
export async function invoke(tool: Tool, handler: ToolHandler, args: unknown): Promise<CallToolResult> {
  const started = Date.now();
  const outcome = await run(tool, handler, args);
  // Never the arguments, the result or an error message: all of them may carry health data.
  console.log("tool_call", {
    tool: tool.name,
    duration_ms: Date.now() - started,
    is_error: !outcome.ok,
    ...(outcome.ok ? {} : { code: outcome.error.code }),
  });
  if (!outcome.ok) return errorResult(outcome.error);
  return { content: [{ type: "text", text: JSON.stringify(outcome.output) }], structuredContent: outcome.output };
}

async function run(tool: Tool, handler: ToolHandler, args: unknown): Promise<ToolOutcome> {
  try {
    const problem = tool.checkInput(args);
    if (problem !== undefined) return { ok: false, error: schemaError(problem) };
    return await handler(args as Record<string, unknown>);
  } catch (error) {
    return failure(tool, error);
  }
}

/** Raised when a tool body returns something its output schema does not allow. */
export class OutputSchemaError extends Error {
  constructor() {
    super("the tool result does not match its output schema");
    this.name = "OutputSchemaError";
  }
}

/**
 * Runs a tool body where the data lives and turns whatever happens into a
 * ToolOutcome. The result is checked against the output schema.
 */
export function capture(tool: Tool, body: () => Record<string, unknown>): ToolOutcome {
  try {
    const output = body();
    if (tool.checkOutput(output) !== undefined) throw new OutputSchemaError();
    return { ok: true, output };
  } catch (error) {
    return failure(tool, error);
  }
}

function failure(tool: Tool, error: unknown): ToolOutcome {
  const wire = toWire(error);
  if (wire.code === INTERNAL_ERROR.code) {
    // The error text may quote data: only its type names are logged.
    console.error("tool_internal_error", { tool: tool.name, error_types: errorTypes(error) });
  }
  return { ok: false, error: wire };
}
