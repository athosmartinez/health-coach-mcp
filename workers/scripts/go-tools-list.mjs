// Captures `tools/list` of the Go server over stdio into
// test/fixtures/go-tools-list.json, the contract the Worker's tool schemas are
// compared with (test/parity.test.ts).
//
// Usage, from workers/:
//   (cd .. && make build) && node scripts/go-tools-list.mjs [path/to/health-coach-mcp]
//
// The Go server's default data and config folders hold the real health database
// and Google credentials. This script never uses them: HCM_DATA_DIR and
// HCM_CONFIG_DIR always point at new empty folders, removed at the end.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(process.argv[2] ?? join(here, "..", "..", "bin", "health-coach-mcp"));
const fixture = join(here, "..", "test", "fixtures", "go-tools-list.json");

const sandbox = await mkdtemp(join(tmpdir(), "hcm-tools-list-"));
const dataDir = await mkdtemp(join(sandbox, "data-"));
const configDir = await mkdtemp(join(sandbox, "config-"));

try {
  const tools = await listTools();
  await writeFile(fixture, `${JSON.stringify({ tools }, null, 2)}\n`);
  console.log(`wrote ${tools.length} tools to ${fixture}`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
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
