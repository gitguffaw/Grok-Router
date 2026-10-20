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

test("exec --model grok-4.7-build-fast --effort xhigh --background emits model and effort once and completes", () => {
  const tempDir = makeTempDir();
  const modelsText = "You are logged in with grok.com.\n\nDefault model: grok-4.7-build-fast\n\nAvailable models:\n  * grok-4.7-build-fast (default)\n  - grok-4.6\n";
  const started = runCompanion(
    ["exec", "--model", "grok-4.7-build-fast", "--effort", "xhigh", "--background", "--json", "Reply only pong. Do not use tools or modify files."],
    tempDir,
    { GROK_FAKE_MODELS_TEXT: modelsText }
  );
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const startedJob = JSON.parse(started.stdout);
  const waited = runCompanion(
    ["status", "--wait", "--json", startedJob.id],
    tempDir,
    { GROK_FAKE_MODELS_TEXT: modelsText }
  );
  assert.equal(waited.status, 0, waited.stderr + waited.stdout);
  const job = JSON.parse(waited.stdout);
  assert.equal(job.status, "completed", JSON.stringify(job.result));
  const { argv } = readArgv(tempDir);
  assert.equal(argv.filter((arg) => arg === "-m" || arg === "--model").length, 1);
  assert.equal(argv[argv.indexOf("-m") + 1], "grok-4.7-build-fast");
  assert.equal(argv.filter((arg) => arg === "--reasoning-effort" || arg === "--effort").length, 1);
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "xhigh");
});

test("analyze/rescue --resume <SID> emit --resume once and cli --resume <SID> forwards --resume unchanged", () => {
  const tempDir = makeTempDir();
  const initialSession = "22222222-2222-4222-8222-222222222222";
  const turn1 = runCompanion(
    ["analyze", "--json", "Reply in one line with your model name."],
    tempDir,
    { GROK_FAKE_SESSION: initialSession }
  );
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1Job = JSON.parse(turn1.stdout);
  const resultOut = runCompanion(["result", turn1Job.id], tempDir);
  assert.equal(resultOut.status, 0, resultOut.stderr);
  assert.match(resultOut.stdout, new RegExp(`Resume in Grok: grok --resume ${initialSession}`));

  for (const [mode, prompt] of [
    ["analyze", "Quote the question I asked in the previous turn."],
    ["rescue", "Quote the question I asked in the previous turn. Diagnosis only."]
  ]) {
    const resumed = runCompanion([mode, "--resume", initialSession, "--json", prompt], tempDir);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    const job = JSON.parse(resumed.stdout);
    assert.equal(job.status, "completed");
    assert.equal(job.grokSessionId, initialSession);
    const { argv } = readArgv(tempDir);
    assert.equal(argv.filter((arg) => arg === "--resume" || arg === "-r").length, 1);
    assert.equal(argv[argv.indexOf("--resume") + 1], initialSession);
  }

  const cliResumed = runCompanion(
    [
      "cli",
      "--resume",
      initialSession,
      "-p",
      "Quote the question I asked in the previous turn.",
      "--tools",
      "read_file,grep,list_dir",
      "--output-format",
      "json"
    ],
    tempDir
  );
  assert.equal(cliResumed.status, 0, cliResumed.stderr + cliResumed.stdout);
  const { argv: cliArgv } = readArgv(tempDir);
  assert.equal(cliArgv.filter((arg) => arg === "--resume").length, 1);
  assert.equal(cliArgv[cliArgv.indexOf("--resume") + 1], initialSession);
  const cliPayload = JSON.parse(cliResumed.stdout.trim());
  assert.equal(cliPayload.sessionId, initialSession);
});

test("analyze --prompt-file reads the prompt from the file and runs the job", () => {
  const tempDir = makeTempDir();
  const promptFile = path.join(tempDir, "pf.txt");
  fs.writeFileSync(promptFile, "Reply with exactly the word PONG.\n", "utf8");
  const result = runCompanion(["analyze", "--prompt-file", promptFile, "--json"], tempDir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const job = JSON.parse(result.stdout);
  assert.equal(job.status, "completed");
  assert.equal(job.request.userRequest, "Reply with exactly the word PONG.");
  assert.match(job.request.prompt, /Reply with exactly the word PONG\./);
  assert.match(job.rendered, /Reply with exactly the word PONG\./);
  const { argv } = readArgv(tempDir);
  assert.equal(argv.filter((arg) => arg === "--prompt-file").length, 1);
  assert.ok(!argv.includes("-p"));
});

test("cli runs (including cli -r <SID> resumes) and managed --resume runs are tracked as router jobs with resumeOf", () => {
  const tempDir = makeTempDir();
  const sid = "33333333-3333-4333-8333-333333333333";

  const turn1 = runCompanion(
    ["analyze", "Reply in one line with your model name."],
    tempDir,
    { GROK_FAKE_SESSION: sid }
  );
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1IdMatch = turn1.stderr.match(/Job ID:\s+(\S+)/);
  assert.ok(turn1IdMatch, `expected Job ID on stderr, got: ${turn1.stderr}`);
  const turn1Id = turn1IdMatch[1];

  const turn1Result = runCompanion(["result", turn1Id], tempDir);
  assert.equal(turn1Result.status, 0, turn1Result.stderr);
  assert.match(turn1Result.stdout, new RegExp(`Resume in Grok: grok --resume ${sid}`));

  const cliTurn = runCompanion(
    [
      "cli",
      "-r",
      sid,
      "-p",
      "Quote the question I asked in the previous turn.",
      "--tools",
      "read_file,grep,list_dir",
      "--output-format",
      "json"
    ],
    tempDir
  );
  assert.equal(cliTurn.status, 0, cliTurn.stderr + cliTurn.stdout);
  const cliIdMatch = cliTurn.stderr.match(/Job ID:\s+(\S+)/);
  assert.ok(cliIdMatch, `expected tracked Job ID on cli stderr, got: ${cliTurn.stderr}`);
  const cliJobId = cliIdMatch[1];

  const statusAll = runCompanion(["status", "--all"], tempDir);
  assert.equal(statusAll.status, 0, statusAll.stderr);
  assert.match(statusAll.stdout, new RegExp(turn1Id));
  assert.match(statusAll.stdout, new RegExp(cliJobId));

  const cliStored = runCompanion(["result", "--json", cliJobId], tempDir);
  assert.equal(cliStored.status, 0, cliStored.stderr);
  const cliJob = JSON.parse(cliStored.stdout);
  assert.equal(cliJob.id, cliJobId);
  assert.equal(cliJob.status, "completed");
  assert.equal(cliJob.grokSessionId, sid);
  assert.equal(cliJob.resumeOf, turn1Id);
  assert.equal(cliJob.request.userRequest, "Quote the question I asked in the previous turn.");
  assert.ok(cliJob.rendered.includes("Quote the question I asked in the previous turn."));
  assert.ok(cliJob.logFile && fs.existsSync(cliJob.logFile));

  const analyzeResumed = runCompanion(
    ["analyze", "--resume", sid, "--json", "Quote the question I asked in the previous turn."],
    tempDir
  );
  assert.equal(analyzeResumed.status, 0, analyzeResumed.stderr + analyzeResumed.stdout);
  const analyzeJob = JSON.parse(analyzeResumed.stdout);
  assert.equal(analyzeJob.status, "completed");
  assert.equal(analyzeJob.grokSessionId, sid);
  assert.equal(analyzeJob.resumeOf, turn1Id);
  assert.equal(analyzeJob.request.tools, "read_file,grep,list_dir");
});

test("exec --lanes with --prompt-file reads the prompt file for each lane", () => {
  const tempDir = makeTempDir();
  const pf = path.join(tempDir, "lane-prompt.txt");
  fs.writeFileSync(pf, "Implement the lane acceptance criteria.\n", "utf8");
  const result = runCompanion(
    ["exec", "--lanes", "alpha,beta", "--prompt-file", pf, "--best", "--json"],
    tempDir
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const panel = JSON.parse(result.stdout);
  assert.equal(panel.jobClass, "grok-panel");
  assert.equal(panel.status, "completed");
  assert.deepEqual(panel.lanes.map((lane) => lane.label), ["alpha", "beta"]);
  for (const lane of panel.lanes) {
    const leafResult = runCompanion(["result", "--json", lane.id], tempDir);
    assert.equal(leafResult.status, 0, leafResult.stderr);
    const leaf = JSON.parse(leafResult.stdout);
    assert.equal(leaf.status, "completed");
    assert.equal(leaf.request.userRequest, "Implement the lane acceptance criteria.");
    assert.ok(leaf.request.prompt.includes("Implement the lane acceptance criteria."));
    assert.ok(leaf.request.prompt.includes(`Lane: ${lane.label}.`));
    assert.ok(leaf.request.promptFile && fs.existsSync(leaf.request.promptFile));
  }
});

test("--prompt-file stores file contents in cli and reports a clear error when missing", () => {
  const tempDir = makeTempDir();
  const missing = path.join(tempDir, "missing-prompt.txt");
  const missingManaged = runCompanion(["analyze", "--prompt-file", missing], tempDir);
  assert.notEqual(missingManaged.status, 0);
  assert.match(missingManaged.stderr, /Prompt file not found:/);
  assert.equal(/ENOENT/.test(missingManaged.stderr), false);

  const pf = path.join(tempDir, "cli-pf.txt");
  fs.writeFileSync(pf, "Summarize the CLI prompt file.\n", "utf8");
  const cliOk = runCompanion(["cli", "--prompt-file", pf, "--output-format", "json"], tempDir);
  assert.equal(cliOk.status, 0, cliOk.stderr + cliOk.stdout);
  const cliIdMatch = cliOk.stderr.match(/Job ID:\s+(\S+)/);
  assert.ok(cliIdMatch);
  const cliJob = JSON.parse(runCompanion(["result", "--json", cliIdMatch[1]], tempDir).stdout);
  assert.equal(cliJob.request.prompt, "Summarize the CLI prompt file.");
  assert.equal(cliJob.request.userRequest, "Summarize the CLI prompt file.");
  assert.equal(cliJob.request.promptFile, path.resolve(tempDir, pf));

  const missingCli = runCompanion(["cli", "--prompt-file", missing, "--output-format", "json"], tempDir);
  assert.notEqual(missingCli.status, 0);
  const missingCliId = missingCli.stderr.match(/Job ID:\s+(\S+)/);
  if (missingCliId) {
    const failedCliJob = JSON.parse(runCompanion(["result", "--json", missingCliId[1]], tempDir).stdout);
    assert.notEqual(failedCliJob.request.prompt, missing);
    assert.match(failedCliJob.request.prompt, /^\[prompt-file:/);
    assert.equal(failedCliJob.request.promptFile, path.resolve(tempDir, missing));
  } else {
    assert.match(missingCli.stderr, /Prompt file not found:/);
    assert.equal(/ENOENT/.test(missingCli.stderr), false);
  }
});

