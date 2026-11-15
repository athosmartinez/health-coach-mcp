// Captures `tools/list` of the Go server over stdio into
// test/fixtures/go-tools-list.json, the contract the Worker's tool schemas are
// compared with (test/parity.test.ts).
//
// Usage, from workers/:
//   (cd .. && make build) && node scripts/go-tools-list.mjs [--check] [path/to/health-coach-mcp]
//
// With --check it writes nothing: it lists the tools again, compares them with
// the committed fixture, and exits 1 with the names of the tools that differ
// (`npm run check:go-fixture`).
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
const fixture = join(here, "..", "test", "fixtures", "go-tools-list.json");

const sandbox = await mkdtemp(join(tmpdir(), "hcm-tools-list-"));
const dataDir = await mkdtemp(join(sandbox, "data-"));
const configDir = await mkdtemp(join(sandbox, "config-"));

try {
  const tools = await listTools();
  if (check) {
    await compareWithFixture(tools);
  } else {
    await writeFile(fixture, `${JSON.stringify({ tools }, null, 2)}\n`);
    console.log(`wrote ${tools.length} tools to ${fixture}`);
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

/** JSON with the keys of every object sorted: two equal definitions give the same text. */
function canonical(value) {
  return JSON.stringify(value, (_key, node) =>
    node !== null && typeof node === "object" && !Array.isArray(node)
      ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => (a < b ? -1 : 1)))
      : node,
  );
}

/**
 * Check mode: fails when the committed fixture is not what the Go binary lists
 * now, and names the tools that differ. It writes nothing.
 */
async function compareWithFixture(tools) {
  const committed = new Map(JSON.parse(await readFile(fixture, "utf8")).tools.map((tool) => [tool.name, tool]));
  const listed = new Map(tools.map((tool) => [tool.name, tool]));
  const stale = [];
  for (const [name, tool] of listed) {
    if (!committed.has(name)) stale.push(`${name} (not in the fixture)`);
    else if (canonical(committed.get(name)) !== canonical(tool)) stale.push(`${name} (changed)`);
  }
  for (const name of committed.keys()) if (!listed.has(name)) stale.push(`${name} (no longer listed by the Go server)`);

  if (stale.length === 0) {
    console.log(`the fixture matches the Go server: ${listed.size} tools`);
    return;
  }
  console.error(`the fixture is stale for ${stale.length} tool(s):`);
  for (const line of stale.sort()) console.error(`  ${line}`);
  console.error("generate it again with: node scripts/go-tools-list.mjs");
  process.exitCode = 1;
}

function listTools() {
  return new Promise((resolveTools, reject) => {
    // A minimal environment: nothing of the caller's HCM_* settings is inherited.
    const child = spawn(binary, ["-transport=stdio"], {
      env: { PATH: process.env.PATH ?? "", HOME: sandbox, HCM_DATA_DIR: dataDir, HCM_CONFIG_DIR: configDir, HCM_TZ: "UTC" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for tools/list"));
    }, 20_000);
    const finish = (settle, value) => {
      clearTimeout(timer);
      child.kill();
      settle(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line === "") continue;
        const message = JSON.parse(line);
        if (message.error) return finish(reject, new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (message.id === 2) return finish(resolveTools, message.result.tools);
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => finish(reject, new Error(`the Go server exited early (code ${code})`)));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "go-tools-list", version: "0" } },
    });
  });
}
