// Captures what the Go server answers over stdio for its prompts and for the
// coach://guardrails resource into test/fixtures/go-prompts.json, the contract
// the Worker's prompts and resource are compared with (test/prompts.test.ts).
//
// Usage, from workers/:
//   (cd .. && make build) && node scripts/go-prompts.mjs [--check] [path/to/health-coach-mcp]
//
// With --check it writes nothing: it asks the Go server again, compares the
// answers with the committed fixture, and exits 1 with the requests whose
// answer differs (`npm run check:go-fixture`).
//
// The fixture is a list of exchanges: a request (method and params) and the
// result or the error the Go server gave. The prompts hold no date of their
// own, so the answers do not change from one day to the next.
//
// The Go server's default data and config folders hold the real health database
// and Google credentials. This script never uses them: HCM_DATA_DIR and
// HCM_CONFIG_DIR always point at new empty folders, removed at the end.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const options = process.argv.slice(2);
const check = options.includes("--check");
const binary = resolve(options.find((option) => !option.startsWith("--")) ?? join(here, "..", "..", "bin", "health-coach-mcp"));
const fixture = join(here, "..", "test", "fixtures", "go-prompts.json");

/** Each prompt and the name of its optional day argument. */
const PROMPTS = [
  ["morning_briefing", "date"],
  ["nutrition_review", "date"],
  ["workout_review", "date"],
  ["weekly_report", "week_end"],
];

/** A day for the prompts that are asked with one. Any real calendar day gives the same text around it. */
const DAY = "2026-10-10";

const GUARDRAILS_URI = "coach://guardrails";

/** The requests, in the order the fixture lists them. */
const REQUESTS = [
  { method: "prompts/list" },
  ...PROMPTS.flatMap(([name, arg]) => [
    { method: "prompts/get", params: { name } },
    { method: "prompts/get", params: { name, arguments: { [arg]: DAY } } },
    // An empty value is an omitted one.
    { method: "prompts/get", params: { name, arguments: { [arg]: "" } } },
    // Text that is not a calendar date is refused, and the error does not repeat it.
    { method: "prompts/get", params: { name, arguments: { [arg]: "2026-02-30" } } },
  ]),
  // Only the prompt's own argument is read.
  { method: "prompts/get", params: { name: "weekly_report", arguments: { date: DAY } } },
  { method: "prompts/get", params: { name: "no_such_prompt" } },
  { method: "resources/list" },
  { method: "resources/templates/list" },
  { method: "resources/read", params: { uri: GUARDRAILS_URI } },
  { method: "resources/read", params: { uri: "coach://no-such-resource" } },
];

const sandbox = await mkdtemp(join(tmpdir(), "hcm-prompts-"));
const dataDir = await mkdtemp(join(sandbox, "data-"));
const configDir = await mkdtemp(join(sandbox, "config-"));

try {
  const captured = await capture();
  if (check) {
    await compareWithFixture(captured);
  } else {
    await writeFile(fixture, `${JSON.stringify(captured, null, 2)}\n`);
    console.log(`wrote ${captured.exchanges.length} exchanges to ${fixture}`);
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

/** JSON with the keys of every object sorted: two equal answers give the same text. */
function canonical(value) {
  return JSON.stringify(value, (_key, node) =>
    node !== null && typeof node === "object" && !Array.isArray(node)
      ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => (a < b ? -1 : 1)))
      : node,
  );
}

/** Names a request in a report line. */
function label(request) {
  return `${request.method} ${JSON.stringify(request.params ?? {})}`;
}

/**
 * Check mode: fails when the committed fixture is not what the Go binary
 * answers now, and names the requests that differ. It writes nothing.
 */
async function compareWithFixture(captured) {
  const committed = JSON.parse(await readFile(fixture, "utf8"));
  const stale = [];
  if (canonical(committed.capabilities) !== canonical(captured.capabilities)) stale.push("the prompts and resources capabilities (changed)");
  const before = new Map(committed.exchanges.map((exchange) => [label(exchange.request), exchange]));
  const now = new Map(captured.exchanges.map((exchange) => [label(exchange.request), exchange]));
  for (const [key, exchange] of now) {
    if (!before.has(key)) stale.push(`${key} (not in the fixture)`);
    else if (canonical(before.get(key)) !== canonical(exchange)) stale.push(`${key} (changed)`);
  }
  for (const key of before.keys()) if (!now.has(key)) stale.push(`${key} (no longer asked by this script)`);

  if (stale.length === 0) {
    console.log(`the fixture matches the Go server: ${now.size} prompt and resource exchanges`);
    return;
  }
  console.error(`the fixture is stale for ${stale.length} answer(s):`);
  for (const line of stale.sort()) console.error(`  ${line}`);
  console.error("generate it again with: node scripts/go-prompts.mjs");
  process.exitCode = 1;
}

function capture() {
  return new Promise((resolveCapture, reject) => {
    // A minimal environment: nothing of the caller's HCM_* settings is inherited.
    const child = spawn(binary, ["-transport=stdio"], {
      env: { PATH: process.env.PATH ?? "", HOME: sandbox, HCM_DATA_DIR: dataDir, HCM_CONFIG_DIR: configDir, HCM_TZ: "UTC" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for the Go server"));
    }, 20_000);
    const finish = (settle, value) => {
      clearTimeout(timer);
      child.kill();
      settle(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    // Request ids: 1 is initialize, then one per entry of REQUESTS.
    const FIRST_ID = 2;
    const answers = new Map();
    let capabilities;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line === "") continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (message.error) return finish(reject, new Error(`initialize failed: ${JSON.stringify(message.error)}`));
          const { prompts, resources } = message.result.capabilities ?? {};
          capabilities = { prompts, resources };
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          for (const [i, request] of REQUESTS.entries()) send({ jsonrpc: "2.0", id: FIRST_ID + i, ...request });
          continue;
        }
        if (typeof message.id !== "number") continue;
        answers.set(message.id, message.error ? { error: message.error } : { result: message.result });
        if (answers.size === REQUESTS.length) {
          const exchanges = REQUESTS.map((request, i) => ({ request, ...answers.get(FIRST_ID + i) }));
          return finish(resolveCapture, { capabilities, exchanges });
        }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => finish(reject, new Error(`the Go server exited early (code ${code})`)));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "go-prompts", version: "0" } },
    });
  });
}
