import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { shouldEmitLiveProgress, stripHostNoise } from "../plugins/grok-router/scripts/lib/render.mjs";
import { COMPANION, makeTempDir, readArgv, testEnv } from "./helpers.mjs";

test("host only hears ready plus blocking startup errors", () => {
  assert.equal(shouldEmitLiveProgress("Ready to work."), true);
  assert.equal(shouldEmitLiveProgress("You are not logged in. Run grok login."), true);
  assert.equal(shouldEmitLiveProgress("2026-09-21T20:17:42Z ERROR authentication required"), true);
  assert.equal(shouldEmitLiveProgress("MCP server 'fusion' handshake failed: connection closed"), false);
  assert.equal(shouldEmitLiveProgress("plugin name collision resolved by scope precedence"), false);
  assert.equal(shouldEmitLiveProgress("grep timed out timeout_secs=20"), false);
  assert.equal(shouldEmitLiveProgress("Grok pid 70692"), false);
  assert.equal(
    stripHostNoise("MCP server init failed\nYou are not logged in\nplugin name collision"),
    "You are not logged in"
  );
});

function runCompanion(args, tempDir, extras = {}) {
  const env = testEnv(tempDir, extras);
  const result = spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: extras.cwd || tempDir,
    env,
    encoding: "utf8"
  });
  return result;
}

test("models reports the live fake catalog", () => {
  const tempDir = makeTempDir();
  const result = runCompanion(["models", "--json"], tempDir);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.defaultModel, "grok-4.6");
  assert.ok(payload.models.some((model) => model.id === "grok-4.5"));
});

test("surface lists live commands including clone", () => {
  const tempDir = makeTempDir();
  const result = runCompanion(["surface", "--json"], tempDir);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const clone = payload.coverage.commands.find((command) => command.name === "clone");
  assert.equal(clone.coverage, "cli-only");
  const model = payload.coverage.flags.find((flag) => flag.option === "model");
  assert.equal(model.coverage, "safe-forward");
  const always = payload.coverage.flags.find((flag) => flag.option === "always-approve");
  assert.equal(always.coverage, "policy-owned");
});

test("analyze launches grok -p with a read-only tool allowlist", () => {
  const tempDir = makeTempDir();
  fs.writeFileSync(path.join(tempDir, "README.md"), "hello\n");
  const result = runCompanion(["analyze", "map this repo"], tempDir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const recorded = readArgv(tempDir);
  assert.ok(recorded.argv.includes("-p"));
  assert.ok(recorded.argv.includes("--tools"));
  assert.ok(recorded.argv.includes("read_file,grep,list_dir"));
  assert.ok(!recorded.argv.includes("--always-approve"));
  assert.match(result.stdout, /fake grok response/);
  assert.match(result.stderr, /# Grok Analyze Started/);
  assert.match(result.stderr, /Job ID:\s+\S+/);
});

test("exec launches grok -p with --always-approve", () => {
  const tempDir = makeTempDir();
  const result = runCompanion(["exec", "add a comment"], tempDir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const recorded = readArgv(tempDir);
  assert.ok(recorded.argv.includes("--always-approve"));
  assert.ok(!recorded.argv.includes("--tools"));
});

test("cli forwards unmodeled help", () => {
  const tempDir = makeTempDir();
  const result = runCompanion(["cli", "clone", "--help"], tempDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Help for clone/);
});

function initGitRepo(tempDir) {
  spawnSync("git", ["init"], { cwd: tempDir, encoding: "utf8" });
  fs.writeFileSync(path.join(tempDir, "README.md"), "hello\n");
  spawnSync("git", ["add", "README.md"], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tempDir, encoding: "utf8" });
  fs.writeFileSync(path.join(tempDir, "README.md"), "hello world\n");
}

test("foreground review emits job id on stderr before grok finishes", async () => {
  const tempDir = makeTempDir();
  initGitRepo(tempDir);
  const child = spawn(process.execPath, [COMPANION, "review"], {
    cwd: tempDir,
    env: { ...testEnv(tempDir), GROK_FAKE_SLEEP_MS: "1200" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  let sawJobId = false;
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (/Job ID:\s+\S+/.test(stderr)) {
      sawJobId = true;
    }
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const closed = new Promise((resolve) => {
    child.on("close", (status) => {
      exited = true;
      resolve(status);
    });
  });
  const deadline = Date.now() + 2000;
  while (!sawJobId && !exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(exited, false, `job id should appear before grok exits; stderr=${stderr}`);
  assert.match(stderr, /# Grok Review Started/);
  assert.match(stderr, /Job ID:\s+\S+/);
  assert.match(stderr, /grok-router status /);
  const status = await closed;
  assert.equal(status, 0, stderr + stdout);
  assert.equal(stdout.includes("# Grok Review Started"), false);
  assert.match(stdout, /fake lane|fake grok response|findings/i);
});

test("review --lean writes a prompt file and does not forward --lean", () => {
  const tempDir = makeTempDir();
  spawnSync("git", ["init"], { cwd: tempDir, encoding: "utf8" });
  fs.writeFileSync(path.join(tempDir, "README.md"), "hello\n");
  spawnSync("git", ["add", "README.md"], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tempDir, encoding: "utf8" });
  fs.writeFileSync(path.join(tempDir, "README.md"), "hello world\n");
  const result = runCompanion(["review", "--lean"], tempDir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const recorded = readArgv(tempDir);
  assert.ok(recorded.argv.includes("--prompt-file"));
  assert.ok(recorded.argv.includes("--json-schema"));
  assert.ok(recorded.argv.includes("--disallowed-tools"));
  assert.ok(recorded.argv.includes("--disable-web-search"));
  assert.ok(recorded.argv.includes("--no-subagents"));
  assert.ok(recorded.argv.includes("--no-plan"));
  assert.ok(recorded.argv.includes("--system-prompt-override"));
  assert.ok(!recorded.argv.includes("--lean"));
  assert.ok(!recorded.argv.includes("--always-approve"));
});

test("setup is ready when fake grok is logged in", () => {
  const tempDir = makeTempDir();
  const result = runCompanion(["setup", "--json"], tempDir);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  const dest = path.join(tempDir, "grok-home", "workflows");
  assert.ok(fs.existsSync(path.join(dest, "grok-router-review.rhai")));
  assert.ok(fs.existsSync(path.join(dest, "grok-router-adversarial-review.rhai")));
});

for (const laneArgs of [["--lanes", "ticket6,ticket8"], ["--lanes=ticket6,ticket8"]]) {
  test(`exec ${laneArgs.join(" ")} dispatches both named lanes and preserves the prompt`, () => {
    const tempDir = makeTempDir();
    const result = runCompanion(["exec", ...laneArgs, "--best", "--json", "Complete the assigned acceptance work."], tempDir);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const panel = JSON.parse(result.stdout);
    assert.equal(panel.jobClass, "grok-panel");
    assert.equal(panel.status, "completed");
    assert.deepEqual(panel.lanes.map((lane) => lane.label), ["ticket6", "ticket8"]);
    assert.equal(new Set(panel.lanes.map((lane) => lane.id)).size, 2);
    for (const lane of panel.lanes) {
      const leafResult = runCompanion(["result", "--json", lane.id], tempDir);
      assert.equal(leafResult.status, 0, leafResult.stderr);
      const leaf = JSON.parse(leafResult.stdout);
      assert.equal(leaf.status, "completed");
      assert.equal(leaf.request.userRequest, "Complete the assigned acceptance work.");
      assert.ok(leaf.request.prompt.includes(`Lane: ${lane.label}.`));
      assert.equal(leaf.request.noSubagents, true);
      assert.equal(leaf.request.controls.model, "grok-4.6");
    }
  });
}

for (const resumeFlag of ["--resume", "-r"]) {
  test(`exec ${resumeFlag} forwards a named session exactly once`, () => {
    const tempDir = makeTempDir();
    const session = "11111111-1111-4111-8111-111111111111";
    const result = runCompanion(["exec", resumeFlag, session, "Continue the requested fix."], tempDir);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { argv } = readArgv(tempDir);
    assert.equal(argv.filter((arg) => arg === "--resume").length, 1);
    assert.equal(argv[argv.indexOf("--resume") + 1], session);
  });
}
