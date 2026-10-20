import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { COMPANION, makeTempDir, testEnv } from "./helpers.mjs";

function run(args, tempDir, extras = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: tempDir,
    env: testEnv(tempDir, extras),
    encoding: "utf8"
  });
}

function jobLogs(tempDir) {
  const stateRoot = path.join(tempDir, "data", "state");
  if (!fs.existsSync(stateRoot)) {
    return "";
  }
  return fs.readdirSync(stateRoot).flatMap((slug) => {
    const jobs = path.join(stateRoot, slug, "jobs");
    if (!fs.existsSync(jobs)) {
      return [];
    }
    return fs.readdirSync(jobs)
      .filter((name) => name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(jobs, name), "utf8"));
  }).join("\n");
}

test("exec end to end: host sees ready and the answer, not MCP startup noise", () => {
  const tempDir = makeTempDir();
  const result = run(["exec", "add a comment"], tempDir, { GROK_FAKE_NOISE: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /# Grok Exec Started/);
  assert.match(result.stderr, /Job ID:\s+exec-/);
  assert.match(result.stderr, /Ready to work\./);
  assert.match(result.stdout, /fake grok response/);
  assert.equal(/MCP server/.test(result.stderr), false);
  assert.equal(/plugin name collision/.test(result.stderr), false);
  assert.equal(/skill name does not match/.test(result.stderr), false);
  assert.equal(/grep timed out/.test(result.stderr), false);
  assert.equal(/Grok pid/.test(result.stderr), false);
  const log = jobLogs(tempDir);
  assert.match(log, /MCP server 'fusion' handshake failed/);
  // Raw log chunks each get a timestamp. The fixture deliberately splits this
  // message across writes, and pipe chunk boundaries vary across runtimes.
  const logText = log.replace(/^\[[^\]\n]+\] /gm, "").replace(/\s+/g, " ");
  assert.match(logText, /plugin name collision resolved by scope precedence/);
});

test("exec end to end: authentication failure is the startup error the host sees", () => {
  const tempDir = makeTempDir();
  const result = run(["exec", "add a comment"], tempDir, { GROK_FAKE_AUTH: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ready to work\./);
  assert.match(`${result.stdout}\n${result.stderr}`, /You are not logged in/);
  assert.equal(/MCP server/.test(result.stdout), false);
  assert.equal(/handshake failed/.test(result.stdout), false);
});
