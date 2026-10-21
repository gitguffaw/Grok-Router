import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { shouldEmitLiveProgress, stripHostNoise } from "../plugins/grok-router/scripts/lib/render.mjs";
import { handleCli, resolveKnownSessionId } from "../plugins/grok-router/scripts/lib/cli.mjs";
import { resolveJobFile, resolveStateDir, saveJob } from "../plugins/grok-router/scripts/lib/state.mjs";
import { buildCliGrammar } from "../plugins/grok-router/scripts/lib/cli.mjs";
import { parseGrokHelp } from "../plugins/grok-router/scripts/lib/help.mjs";
import { ROUTER_OWNED_OPTIONS } from "../plugins/grok-router/scripts/lib/live-controls.mjs";
import { COMPANION, FIXTURES, helpText, makeTempDir, readArgv, testEnv } from "./helpers.mjs";

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

test("cli runs (including cli -r <SID> resumes) and managed --resume runs are tracked as router jobs with turn-by-turn resumeOf", () => {
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
  assert.equal(analyzeJob.resumeOf, cliJobId);
  const { argv: analyzeArgv } = readArgv(tempDir);
  assert.equal(analyzeArgv.filter((arg) => arg === "--resume" || arg === "-r").length, 1);
  assert.equal(analyzeArgv[analyzeArgv.indexOf("--resume") + 1], sid);
  assert.ok(analyzeArgv.includes("--tools"));
  assert.equal(analyzeArgv[analyzeArgv.indexOf("--tools") + 1], "read_file,grep,list_dir");
  assert.ok(!analyzeArgv.includes("--always-approve"));

  const unknownSid = "99999999-9999-4999-8999-999999999999";
  const cliUnknownResume = runCompanion(
    ["cli", "-r", unknownSid, "-p", "Resume unknown session.", "--output-format", "json"],
    tempDir
  );
  assert.equal(cliUnknownResume.status, 0);
  const cliUnknownId = cliUnknownResume.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const cliUnknownJob = JSON.parse(runCompanion(["result", "--json", cliUnknownId], tempDir).stdout);
  assert.equal(cliUnknownJob.resumeOf, null);
  assert.equal(cliUnknownJob.grokSessionId, unknownSid);
});

test("cli -r <jobId> translates a router job ID into the Grok session ID in argv and records unknown when output has no session", () => {
  const tempDir = makeTempDir();
  const sid = "33333333-3333-4333-8333-333333333333";

  const turn1 = runCompanion(
    ["analyze", "--json", "Start session."],
    tempDir,
    { GROK_FAKE_SESSION: sid }
  );
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1Job = JSON.parse(turn1.stdout);

  const cliByJobIdPlain = runCompanion(
    ["cli", "-r", turn1Job.id, "-p", "Plain output turn."],
    tempDir
  );
  assert.equal(cliByJobIdPlain.status, 0, cliByJobIdPlain.stderr + cliByJobIdPlain.stdout);
  const { argv: cliJobIdArgv } = readArgv(tempDir);
  assert.equal(cliJobIdArgv[cliJobIdArgv.indexOf("-r") + 1], sid);
  const cliByJobIdMatch = cliByJobIdPlain.stderr.match(/Job ID:\s+(\S+)/);
  assert.ok(cliByJobIdMatch);
  const cliByJobIdStored = JSON.parse(runCompanion(["result", "--json", cliByJobIdMatch[1]], tempDir).stdout);
  assert.equal(cliByJobIdStored.resumeOf, turn1Job.id);
  assert.equal(cliByJobIdStored.grokSessionId, "unknown");
});

test("failed resume in cli or managed mode does not record a session it never got", () => {
  const tempDir = makeTempDir();
  const sid = "33333333-3333-4333-8333-333333333333";

  const failedCliResume = runCompanion(
    ["cli", "-r", sid, "-p", "Fail on purpose.", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_AUTH: "1" }
  );
  assert.notEqual(failedCliResume.status, 0);
  const failedCliId = failedCliResume.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(failedCliId);
  const failedCliJob = JSON.parse(runCompanion(["result", "--json", failedCliId], tempDir).stdout);
  assert.equal(failedCliJob.status, "failed");
  assert.equal(failedCliJob.grokSessionId, null);

  const failedManagedResume = runCompanion(
    ["analyze", "--resume", sid, "--json", "Fail managed on purpose."],
    tempDir,
    { GROK_FAKE_AUTH: "1" }
  );
  assert.notEqual(failedManagedResume.status, 0);
  const failedManagedJob = JSON.parse(failedManagedResume.stdout);
  assert.equal(failedManagedJob.status, "failed");
  assert.equal(failedManagedJob.grokSessionId, null);
});

test("cli --timeout-ms times out a slow run and records phase timed-out", () => {
  const tempDir = makeTempDir();
  const sid = "33333333-3333-4333-8333-333333333333";

  const timedOutCli = runCompanion(
    ["cli", "--timeout-ms", "80", "-r", sid, "-p", "Slow turn.", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_SLEEP_MS: "2000" }
  );
  assert.notEqual(timedOutCli.status, 0);
  const timedOutCliId = timedOutCli.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(timedOutCliId);
  const timedOutJob = JSON.parse(runCompanion(["result", "--json", timedOutCliId], tempDir).stdout);
  assert.equal(timedOutJob.status, "failed");
  assert.equal(timedOutJob.phase, "timed-out");
  assert.equal(timedOutJob.result.timedOut, true);
  assert.equal(timedOutJob.grokSessionId, null);
});

test("cancel stops an active cli job and persists cancelled state on disk", async () => {
  const tempDir = makeTempDir();
  const sid = "33333333-3333-4333-8333-333333333333";

  const cancelChild = spawn(
    process.execPath,
    [COMPANION, "cli", "-r", sid, "-p", "Cancel me.", "--output-format", "json"],
    {
      cwd: tempDir,
      env: { ...testEnv(tempDir), GROK_FAKE_SLEEP_MS: "5000" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let cancelStderr = "";
  let cancelJobId = null;
  cancelChild.stderr.setEncoding("utf8");
  cancelChild.stderr.on("data", (chunk) => {
    cancelStderr += chunk;
    const match = cancelStderr.match(/Job ID:\s+(\S+)/);
    if (match) {
      cancelJobId = match[1];
    }
  });
  const waitDeadline = Date.now() + 2000;
  while (!cancelJobId && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(cancelJobId, `expected cli Job ID before cancel; stderr=${cancelStderr}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelRes = runCompanion(["cancel", "--json", cancelJobId], tempDir);
  assert.equal(cancelRes.status, 0, cancelRes.stderr);
  const cancelledJob = JSON.parse(cancelRes.stdout);
  assert.equal(cancelledJob.status, "cancelled");
  assert.equal(cancelledJob.grokSessionId, null);
  await new Promise((resolve) => cancelChild.on("close", resolve));

  const storedAfterClose = JSON.parse(runCompanion(["result", "--json", cancelJobId], tempDir).stdout);
  assert.equal(storedAfterClose.status, "cancelled");
  assert.equal(storedAfterClose.phase, "cancelled");
  assert.equal(storedAfterClose.pid, null);
  assert.equal(storedAfterClose.grokSessionId, null);
});

test("exec --lanes with --prompt-file reads the prompt file for each lane exactly once", () => {
  const tempDir = makeTempDir();
  const pf = path.join(tempDir, "lane-prompt.txt");
  const promptText = "Implement the lane acceptance criteria.";
  fs.writeFileSync(pf, `${promptText}\n`, "utf8");
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
    assert.equal(leaf.request.userRequest, promptText);
    assert.equal(leaf.request.prompt.split(promptText).length - 1, 1);
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

test("cli only tracks prompt or session-resume runs and leaves help/discovery subcommands untracked", () => {
  const tempDir = makeTempDir();

  const helpRun = runCompanion(["cli", "--help"], tempDir);
  assert.equal(helpRun.status, 0, helpRun.stderr);
  assert.equal(/Job ID:/.test(helpRun.stderr), false);

  const modelsRun = runCompanion(["cli", "models"], tempDir);
  assert.equal(modelsRun.status, 0, modelsRun.stderr);
  assert.equal(/Job ID:/.test(modelsRun.stderr), false);

  const cloneHelpRun = runCompanion(["cli", "clone", "--help"], tempDir);
  assert.equal(cloneHelpRun.status, 0, cloneHelpRun.stderr);
  assert.equal(/Job ID:/.test(cloneHelpRun.stderr), false);

  const statusAfterDiscovery = runCompanion(["status", "--all", "--json"], tempDir);
  assert.equal(statusAfterDiscovery.status, 0, statusAfterDiscovery.stderr);
  assert.equal(JSON.parse(statusAfterDiscovery.stdout).jobs.length, 0);
});

test("cli passes no timeout (0) to runProcess when --timeout-ms is absent", async () => {
  const tempDir = makeTempDir();
  let capturedRunProcessTimeoutMs;
  await handleCli(["--cwd", tempDir, "-p", "Check runProcess options", "--output-format", "json"], {
    runProcessImpl: async (_cmd, _args, opts) => {
      capturedRunProcessTimeoutMs = opts.timeoutMs;
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    }
  });
  assert.equal(capturedRunProcessTimeoutMs, 0);
});

test("cli marks editing tools as write:true and read-only tools as write:false", () => {
  const tempDir = makeTempDir();

  const editRun = runCompanion(
    ["cli", "--raw-arg-string", '-p "Hello" --tools read_file,edit_file --output-format json'],
    tempDir
  );
  assert.equal(editRun.status, 0, editRun.stderr + editRun.stdout);
  const editJobId = editRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(editJobId);
  const editJob = JSON.parse(runCompanion(["result", "--json", editJobId], tempDir).stdout);
  assert.equal(editJob.write, true);
  assert.equal(editJob.request.write, true);

  const readOnlyRun = runCompanion(
    ["cli", "-p", "Check status", "--tools", "read_file,grep,list_dir", "--output-format", "json"],
    tempDir
  );
  assert.equal(readOnlyRun.status, 0, readOnlyRun.stderr + readOnlyRun.stdout);
  const readOnlyJobId = readOnlyRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(readOnlyJobId);
  const readOnlyJob = JSON.parse(runCompanion(["result", "--json", readOnlyJobId], tempDir).stdout);
  assert.equal(readOnlyJob.write, false);
  assert.equal(readOnlyJob.request.write, false);
});

test("cli extractCliMetadata strips trailing flags from prompts and does not treat -p --continue as continue:true", () => {
  const tempDir = makeTempDir();

  const positionalPromptWithTrailingFlags = runCompanion(
    ["cli", "-r", "11111111-1111-4111-8111-111111111111", "Hello", "--output-format", "json"],
    tempDir
  );
  assert.equal(positionalPromptWithTrailingFlags.status, 0, positionalPromptWithTrailingFlags.stderr + positionalPromptWithTrailingFlags.stdout);
  const posPromptId = positionalPromptWithTrailingFlags.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(posPromptId);
  const posPromptJob = JSON.parse(runCompanion(["result", "--json", posPromptId], tempDir).stdout);
  assert.equal(posPromptJob.request.prompt, "Hello");
  assert.equal(posPromptJob.request.userRequest, "Hello");
  assert.equal(posPromptJob.title, "Hello");

  const literalContinuePrompt = runCompanion(
    ["cli", "-p", "--continue", "--output-format", "json"],
    tempDir
  );
  assert.equal(literalContinuePrompt.status, 0, literalContinuePrompt.stderr + literalContinuePrompt.stdout);
  const literalContinueId = literalContinuePrompt.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(literalContinueId);
  const literalContinueJob = JSON.parse(runCompanion(["result", "--json", literalContinueId], tempDir).stdout);
  assert.equal(literalContinueJob.request.prompt, "--continue");
  assert.equal(literalContinueJob.request.controls.continue, false);
});

test("cli rejects router-only flags such as --json, --background, --lean, and --best", () => {
  const tempDir = makeTempDir();
  for (const routerFlag of ["--json", "--background", "--lean", "--best"]) {
    const badCli = runCompanion(["cli", routerFlag, "-p", "Hello"], tempDir);
    assert.notEqual(badCli.status, 0, `expected cli ${routerFlag} to fail`);
    assert.match(badCli.stderr, new RegExp(routerFlag));
  }
});

test("resolveKnownSessionId walks a resume chain of three or more jobs and handles a missing or unreadable job file in the middle", () => {
  const tempDir = makeTempDir();
  const env = testEnv(tempDir);
  const rootSid = "44444444-4444-4444-8444-444444444444";

  const job1 = saveJob(tempDir, {
    id: "analyze-hop1",
    jobClass: "grok",
    mode: "analyze",
    workspaceRoot: tempDir,
    status: "completed",
    grokSessionId: rootSid,
    resumeOf: null,
    request: { controls: { resume: null } }
  }, env);
  const job2 = saveJob(tempDir, {
    id: "cli-hop2",
    jobClass: "grok",
    mode: "cli",
    workspaceRoot: tempDir,
    status: "completed",
    grokSessionId: "unknown",
    resumeOf: job1.id,
    request: { controls: { resume: null } }
  }, env);
  const job3 = saveJob(tempDir, {
    id: "cli-hop3",
    jobClass: "grok",
    mode: "cli",
    workspaceRoot: tempDir,
    status: "completed",
    grokSessionId: "unknown",
    resumeOf: job2.id,
    request: { controls: { resume: null } }
  }, env);

  assert.equal(typeof resolveKnownSessionId, "function");
  assert.equal(resolveKnownSessionId(tempDir, job3, env), rootSid);

  const job2File = resolveJobFile(tempDir, job2.id, env);
  fs.writeFileSync(job2File, "{corrupted json", "utf8");
  assert.equal(resolveKnownSessionId(tempDir, job3, env), null);

  fs.unlinkSync(job2File);
  assert.equal(resolveKnownSessionId(tempDir, job3, env), null);
});

test("cli -r <SID> preserves an explicit raw session ID even when a prior job with that resume target returned a different session", () => {
  const tempDir = makeTempDir();
  const sessionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const turn2 = runCompanion(
    ["cli", "-r", sessionA, "-p", "Forked or reassigned turn", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: sessionB }
  );
  assert.equal(turn2.status, 0, turn2.stderr + turn2.stdout);

  const turn3 = runCompanion(
    ["cli", "-r", sessionA, "-p", "Explicitly resume original session A", "--output-format", "json"],
    tempDir
  );
  assert.equal(turn3.status, 0, turn3.stderr + turn3.stdout);
  const { argv } = readArgv(tempDir);
  assert.equal(argv[argv.indexOf("-r") + 1], sessionA);
});

test("cli -r <jobId> and managed --resume <jobId> fail clearly when the referenced job has no known Grok session", () => {
  const tempDir = makeTempDir();
  const plainTurn = runCompanion(["cli", "-p", "Plain output with no session ID."], tempDir);
  assert.equal(plainTurn.status, 0, plainTurn.stderr + plainTurn.stdout);
  const jobId = plainTurn.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(jobId);

  const cliResumeUnknown = runCompanion(["cli", "-r", jobId, "-p", "Try to resume."], tempDir);
  assert.notEqual(cliResumeUnknown.status, 0);
  assert.match(cliResumeUnknown.stderr, new RegExp(`job ${jobId} has no known Grok session`, "i"));

  const managedResumeUnknown = runCompanion(["analyze", "--resume", jobId, "Try to resume."], tempDir);
  assert.notEqual(managedResumeUnknown.status, 0);
  assert.match(managedResumeUnknown.stderr, new RegExp(`job ${jobId} has no known Grok session`, "i"));
});

test("cli rejects router-only flags as their own options, never as flag values or after --", () => {
  const tempDir = makeTempDir();

  const promptIsRouterFlag = runCompanion(["cli", "-p", "--best", "--output-format", "json"], tempDir);
  assert.equal(promptIsRouterFlag.status, 0, promptIsRouterFlag.stderr + promptIsRouterFlag.stdout);
  const { argv: argv1 } = readArgv(tempDir);
  assert.equal(argv1[argv1.indexOf("-p") + 1], "--best");

  const rulesIsRouterFlag = runCompanion(["cli", "--rules", "--json", "-p", "Hello", "--output-format", "json"], tempDir);
  assert.equal(rulesIsRouterFlag.status, 0, rulesIsRouterFlag.stderr + rulesIsRouterFlag.stdout);
  const { argv: argv2 } = readArgv(tempDir);
  assert.equal(argv2[argv2.indexOf("--rules") + 1], "--json");

  const afterDoubleDash = runCompanion(["cli", "-p", "Hello", "--output-format", "json", "--", "--lean"], tempDir);
  assert.equal(afterDoubleDash.status, 0, afterDoubleDash.stderr + afterDoubleDash.stdout);
});

test("cli write classification detects --yolo/--always-approve only as options and records write as unknown when --tools is omitted", () => {
  const tempDir = makeTempDir();

  const yoloPromptReadOnly = runCompanion(
    ["cli", "-p", "--yolo", "--tools", "read_file,grep,list_dir", "--output-format", "json"],
    tempDir
  );
  assert.equal(yoloPromptReadOnly.status, 0, yoloPromptReadOnly.stderr + yoloPromptReadOnly.stdout);
  const yoloPromptId = yoloPromptReadOnly.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(yoloPromptId);
  const yoloPromptJob = JSON.parse(runCompanion(["result", "--json", yoloPromptId], tempDir).stdout);
  assert.equal(yoloPromptJob.request.prompt, "--yolo");
  assert.equal(yoloPromptJob.write, false);
  assert.equal(yoloPromptJob.request.write, false);

  const noToolsRun = runCompanion(
    ["cli", "-p", "Hello without tools flag", "--output-format", "json"],
    tempDir
  );
  assert.equal(noToolsRun.status, 0, noToolsRun.stderr + noToolsRun.stdout);
  const noToolsId = noToolsRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(noToolsId);
  const noToolsJob = JSON.parse(runCompanion(["result", "--json", noToolsId], tempDir).stdout);
  assert.equal(noToolsJob.write, "unknown");
  assert.equal(noToolsJob.request.write, "unknown");

  const realYoloRun = runCompanion(
    ["cli", "--yolo", "-p", "Hello with yolo", "--output-format", "json"],
    tempDir
  );
  assert.equal(realYoloRun.status, 0, realYoloRun.stderr + realYoloRun.stdout);
  const realYoloId = realYoloRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(realYoloId);
  const realYoloJob = JSON.parse(runCompanion(["result", "--json", realYoloId], tempDir).stdout);
  assert.equal(realYoloJob.write, true);
  assert.equal(realYoloJob.request.write, true);
});

test("--continue and -c turns link into the resumeOf chain using the most recent prior tracked job in the same cwd or null if none", () => {
  const tempDir = makeTempDir();

  const turn1 = runCompanion(
    ["cli", "--continue", "-p", "First turn with continue", "--output-format", "json"],
    tempDir
  );
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1Id = turn1.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(turn1Id);
  const turn1Job = JSON.parse(runCompanion(["result", "--json", turn1Id], tempDir).stdout);
  assert.equal(turn1Job.resumeOf, null);

  const turn2 = runCompanion(
    ["analyze", "--continue", "--json", "Second turn via managed continue"],
    tempDir
  );
  assert.equal(turn2.status, 0, turn2.stderr + turn2.stdout);
  const turn2Job = JSON.parse(turn2.stdout);
  assert.equal(turn2Job.resumeOf, turn1Id);

  const turn3 = runCompanion(
    ["cli", "-c", "-p", "Third turn via cli -c", "--output-format", "json"],
    tempDir
  );
  assert.equal(turn3.status, 0, turn3.stderr + turn3.stdout);
  const turn3Id = turn3.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(turn3Id);
  const turn3Job = JSON.parse(runCompanion(["result", "--json", turn3Id], tempDir).stdout);
  assert.equal(turn3Job.resumeOf, turn2Job.id);

  const otherCwd = path.join(tempDir, "sub-cwd");
  fs.mkdirSync(otherCwd, { recursive: true });
  const otherCwdTurn = runCompanion(
    ["cli", "--cwd", otherCwd, "--continue", "-p", "Turn in different cwd", "--output-format", "json"],
    tempDir
  );
  assert.equal(otherCwdTurn.status, 0, otherCwdTurn.stderr + otherCwdTurn.stdout);
  const otherCwdId = otherCwdTurn.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(otherCwdId);
  const otherCwdJob = JSON.parse(runCompanion(["result", "--json", "--cwd", otherCwd, otherCwdId], tempDir).stdout);
  assert.equal(otherCwdJob.resumeOf, null);
});

test("status renders Grok session as 'not reported' instead of 'unknown' when a plain cli run finishes without a session ID", () => {
  const tempDir = makeTempDir();
  const plainTurn = runCompanion(["cli", "-p", "Plain output with no session ID."], tempDir);
  assert.equal(plainTurn.status, 0, plainTurn.stderr + plainTurn.stdout);
  const jobId = plainTurn.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(jobId);

  const statusOut = runCompanion(["status", jobId], tempDir);
  assert.equal(statusOut.status, 0, statusOut.stderr);
  assert.match(statusOut.stdout, /Grok session: not reported/);
  assert.equal(/Grok session: unknown/.test(statusOut.stdout), false);
});

test("[RED] T-A1a / R-C: cli -p '--help', cli -p 'hello' -- --help, and short clusters (-cp, -cphello, -cph, -rc, -cr=SID, -cC) are tracked and preserve original passthrough argv", () => {
  const tempDir = makeTempDir();

  const helpPromptRun = runCompanion(["cli", "-p", "--help", "--output-format", "json"], tempDir);
  assert.equal(helpPromptRun.status, 0, helpPromptRun.stderr + helpPromptRun.stdout);
  const helpPromptId = helpPromptRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(helpPromptId, "[RED] cli -p '--help' must be tracked as a job");
  const helpPromptJob = JSON.parse(runCompanion(["result", "--json", helpPromptId], tempDir).stdout);
  assert.equal(helpPromptJob.request.prompt, "--help", "[RED] stored prompt is --help");

  const postDoubleDashHelp = runCompanion(["cli", "-p", "hello", "--", "--help"], tempDir);
  assert.equal(postDoubleDashHelp.status, 0, postDoubleDashHelp.stderr + postDoubleDashHelp.stdout);
  const postDashId = postDoubleDashHelp.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(postDashId, "[RED] cli -p 'hello' -- --help must be tracked as a job");

  const clusterSeparate = runCompanion(["cli", "-cp", "hello", "--output-format", "json"], tempDir);
  assert.equal(clusterSeparate.status, 0, clusterSeparate.stderr + clusterSeparate.stdout);
  const clusterSeparateId = clusterSeparate.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(clusterSeparateId);
  const clusterSeparateJob = JSON.parse(runCompanion(["result", "--json", clusterSeparateId], tempDir).stdout);
  assert.equal(clusterSeparateJob.request.controls.continue, true, "[RED] -cp 'hello' sets continue === true");
  assert.equal(clusterSeparateJob.request.prompt, "hello", "[RED] -cp 'hello' extracts prompt 'hello'");
  assert.deepEqual(readArgv(tempDir).argv, ["-cp", "hello", "--output-format", "json"], "[GUARD] Rule (1): passthrough argv is not re-expanded");

  const clusterAttached = runCompanion(["cli", "-cphello", "--output-format", "json"], tempDir);
  assert.equal(clusterAttached.status, 0, clusterAttached.stderr + clusterAttached.stdout);
  const clusterAttachedId = clusterAttached.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(clusterAttachedId, "[RED] -cphello must be tracked as a job");
  const clusterAttachedJob = JSON.parse(runCompanion(["result", "--json", clusterAttachedId], tempDir).stdout);
  assert.equal(clusterAttachedJob.request.controls.continue, true, "[RED] -cphello sets continue === true");
  assert.equal(clusterAttachedJob.request.prompt, "hello", "[RED] -cphello extracts attached prompt 'hello'");
  assert.deepEqual(readArgv(tempDir).argv, ["-cphello", "--output-format", "json"], "[GUARD] Rule (1): -cphello forwarded verbatim");

  const clusterPromptH = runCompanion(["cli", "-cph", "--output-format", "json"], tempDir);
  assert.equal(clusterPromptH.status, 0, clusterPromptH.stderr + clusterPromptH.stdout);
  const clusterPromptHId = clusterPromptH.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(clusterPromptHId, "[RED] -cph is -c + -p 'h' (not -h help)");
  const clusterPromptHJob = JSON.parse(runCompanion(["result", "--json", clusterPromptHId], tempDir).stdout);
  assert.equal(clusterPromptHJob.request.controls.continue, true);
  assert.equal(clusterPromptHJob.request.prompt, "h");

  const clusterRc = runCompanion(["cli", "-rc", "-p", "resume title c", "--output-format", "json"], tempDir);
  assert.equal(clusterRc.status, 0, clusterRc.stderr + clusterRc.stdout);
  const clusterRcId = clusterRc.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(clusterRcId);
  const clusterRcJob = JSON.parse(runCompanion(["result", "--json", clusterRcId], tempDir).stdout);
  assert.equal(clusterRcJob.request.controls.resume, "c", "[RED] -rc is -r with attached value 'c'");
  assert.equal(clusterRcJob.request.controls.continue, false, "[RED] -rc does not set continue");

  const sid = "55555555-5555-4555-8555-555555555555";
  const clusterCrEq = runCompanion(["cli", `-cr=${sid}`, "-p", "resume sid", "--output-format", "json"], tempDir);
  assert.equal(clusterCrEq.status, 0, clusterCrEq.stderr + clusterCrEq.stdout);
  const clusterCrEqId = clusterCrEq.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(clusterCrEqId);
  const clusterCrEqJob = JSON.parse(runCompanion(["result", "--json", clusterCrEqId], tempDir).stdout);
  assert.equal(clusterCrEqJob.request.controls.continue, true, "[RED] -cr=SID sets continue === true");
  assert.equal(clusterCrEqJob.request.controls.resume, sid, "[RED] -cr=SID sets resume === SID");

  const clusterWithRouterC = runCompanion(["cli", "-cC", "-p", "opaque C in cluster", "--output-format", "json"], tempDir);
  assert.equal(clusterWithRouterC.status, 0, clusterWithRouterC.stderr + clusterWithRouterC.stdout);
  assert.ok(readArgv(tempDir).argv.includes("-cC"), "[GUARD] -C inside a cluster is opaque and forwarded untouched");
});

test("[RED] T-A1b / A-G / A-I / R-D: cli tokenizer uses live grok --help for new value/variadic flags and rejects router-owned options after a subcommand", () => {
  const tempDir = makeTempDir();
  const customFixtures = path.join(tempDir, "custom-fixtures");
  fs.mkdirSync(customFixtures, { recursive: true });
  for (const name of fs.readdirSync(path.join( path.dirname(COMPANION), "..", "..", "..", "tests", "fixtures"))) {
    const src = path.join(path.dirname(COMPANION), "..", "..", "..", "tests", "fixtures", name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(customFixtures, name));
    }
  }
  fs.writeFileSync(
    path.join(customFixtures, "grok-help.txt"),
    helpText({
      flags: `
      --custom-filter <EXPR>
          Filter expression
      --extra-files <FILE>...
          Variadic files
`
    }),
    "utf8"
  );

  const checkHelp = runCompanion(["cli", "--help"], tempDir, { GROK_FAKE_FIXTURES: customFixtures });
  assert.equal(checkHelp.status, 0, "[SETUP] cli --help succeeds with injected fixture");
  assert.match(checkHelp.stdout, /--custom-filter <EXPR>/, "[SETUP] injected --custom-filter is served by fake grok");

  const withLiveValueFlag = runCompanion(
    ["cli", "--custom-filter", "--best", "-p", "hello", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FIXTURES: customFixtures }
  );
  assert.equal(withLiveValueFlag.status, 0, `[RED] --custom-filter --best must not reject --best: ${withLiveValueFlag.stderr}`);
  assert.match(withLiveValueFlag.stderr, /Job ID:\s+\S+/, "[RED] job is tracked");

  const withVariadicFlag = runCompanion(
    ["cli", "--extra-files", "a.txt", "b.txt", "-p", "hello", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FIXTURES: customFixtures }
  );
  assert.equal(withVariadicFlag.status, 0, `[GUARD] variadic <FILE>... with explicit -p succeeds: ${withVariadicFlag.stderr}`);
  const varId = withVariadicFlag.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const varJob = JSON.parse(runCompanion(["result", "--json", varId], tempDir).stdout);
  assert.equal(varJob.request.prompt, "hello", "[GUARD] variadic values with explicit -p keep prompt 'hello'");

  const subcommandWithJson = runCompanion(["cli", "sessions", "--json"], tempDir);
  assert.notEqual(subcommandWithJson.status, 0, `[RED] router-owned --json after a subcommand is rejected: ${subcommandWithJson.stderr}`);
  assert.match(subcommandWithJson.stderr, /--json is a router option/);

  const mutatingSubcommandWithFlagAndHelp = runCompanion(["cli", "login", "--some-opt", "--help"], tempDir);
  assert.notEqual(mutatingSubcommandWithFlagAndHelp.status, 0, "[RED] Rule (2) fail-closed: unknown flag before --help on mutating subcommand still requires --allow-mutating");
  assert.match(mutatingSubcommandWithFlagAndHelp.stderr, /--allow-mutating/);
});

test("[RED] T-A2a / R-E / R-F: -c and bare -r skip failed jobs and grok-lane leaves, start bare -r at null pre-run, and reconcile resumeOf post-run from the reported session", () => {
  const tempDir = makeTempDir();
  const sid1 = "66666666-6666-4666-8666-666666666661";
  const sidLanes = "66666666-6666-4666-8666-666666666662";
  const sid2 = "66666666-6666-4666-8666-666666666663";
  const externalSid = "66666666-6666-4666-8666-666666666669";

  const turn1 = runCompanion(["analyze", "--json", "Root turn 1"], tempDir, { GROK_FAKE_SESSION: sid1 });
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1Job = JSON.parse(turn1.stdout);
  assert.equal(turn1Job.grokSessionId, sid1, "[SETUP] turn 1 session is sid1");

  const turn2Lanes = runCompanion(["analyze", "--lanes", "a,b", "--json", "Inspect lanes"], tempDir, { GROK_FAKE_SESSION: sidLanes });
  assert.equal(turn2Lanes.status, 0, turn2Lanes.stderr + turn2Lanes.stdout);

  const turn3 = runCompanion(["cli", "-c", "-p", "After lanes", "--output-format", "json"], tempDir, { GROK_FAKE_SESSION: sid1 });
  assert.equal(turn3.status, 0, turn3.stderr + turn3.stdout);
  const turn3Id = turn3.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const turn3Job = JSON.parse(runCompanion(["result", "--json", turn3Id], tempDir).stdout);
  assert.equal(turn3Job.resumeOf, turn1Job.id, "[RED] -c skips grok-lane leaf jobs and links to turn 1");

  const turn4Fail = runCompanion(["cli", "-p", "Fail turn", "--output-format", "json"], tempDir, { GROK_FAKE_AUTH: "1" });
  assert.notEqual(turn4Fail.status, 0, "[SETUP] turn 4 fails");

  const turn5 = runCompanion(["cli", "-c", "-p", "After failed turn", "--output-format", "json"], tempDir, { GROK_FAKE_SESSION: sid1 });
  assert.equal(turn5.status, 0, turn5.stderr + turn5.stdout);
  const turn5Id = turn5.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const turn5Job = JSON.parse(runCompanion(["result", "--json", turn5Id], tempDir).stdout);
  assert.equal(turn5Job.resumeOf, turn3Id, "[RED] -c skips failed job and links to turn 3");

  const barePlain = runCompanion(["cli", "-r", "-p", "Bare resume plain"], tempDir);
  assert.equal(barePlain.status, 0, barePlain.stderr + barePlain.stdout);
  const barePlainId = barePlain.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const barePlainJob = JSON.parse(runCompanion(["result", "--json", barePlainId], tempDir).stdout);
  assert.equal(barePlainJob.resumeOf, null, "[GUARD] R-E: bare -r starts null pre-run when no session is reported");

  const bareJson = runCompanion(["cli", "-r", "--output-format", "json"], tempDir, { GROK_FAKE_SESSION: sid1 });
  assert.equal(bareJson.status, 0, bareJson.stderr + bareJson.stdout);
  const bareJsonId = bareJson.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const bareJsonJob = JSON.parse(runCompanion(["result", "--json", bareJsonId], tempDir).stdout);
  assert.equal(bareJsonJob.resumeOf, turn5Id, "[RED] R-E: bare -r reconciles resumeOf post-run from reported session sid1");

  const turnSid2 = runCompanion(["cli", "-p", "New session sid2", "--output-format", "json"], tempDir, { GROK_FAKE_SESSION: sid2 });
  assert.equal(turnSid2.status, 0);
  const turnSid2Id = turnSid2.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  assert.ok(turnSid2Id);

  const turnReconcileToSid1 = runCompanion(
    ["cli", "-c", "-p", "Reconcile back to sid1", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: sid1 }
  );
  assert.equal(turnReconcileToSid1.status, 0);
  const reconcileSid1Id = turnReconcileToSid1.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const reconcileSid1Job = JSON.parse(runCompanion(["result", "--json", reconcileSid1Id], tempDir).stdout);
  assert.equal(reconcileSid1Job.resumeOf, bareJsonId, "[RED] post-run reconciliation overrides pre-run sid2 guess with bareJsonId (sid1)");

  const turnExternal = runCompanion(
    ["cli", "-c", "-p", "Continued untracked external session", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: externalSid }
  );
  assert.equal(turnExternal.status, 0);
  const externalJobId = turnExternal.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const externalJob = JSON.parse(runCompanion(["result", "--json", externalJobId], tempDir).stdout);
  assert.equal(externalJob.resumeOf, null, "[RED] R-G / A-B: resumeOf is cleared to null when grok reports an untracked external session");
});

test("[RED] T-A2b / A-A / R-F: managed --cwd sub --continue uses workspaceRoot executionCwd and links to the root job while isolated cli --cwd sub --continue stays null", () => {
  const tempDir = makeTempDir();
  initGitRepo(tempDir);
  const subDir = path.join(tempDir, "sub");
  fs.mkdirSync(subDir, { recursive: true });
  const env = testEnv(tempDir);

  assert.equal(resolveStateDir(tempDir, env), resolveStateDir(subDir, env), "[SETUP] root and subDir share the same state dir in a git repo");

  const sid = "77777777-7777-4777-8777-777777777777";
  const turn1 = runCompanion(["analyze", "--json", "Root turn"], tempDir, { GROK_FAKE_SESSION: sid });
  assert.equal(turn1.status, 0, turn1.stderr + turn1.stdout);
  const turn1Job = JSON.parse(turn1.stdout);

  const managedSub = runCompanion(
    ["analyze", "--cwd", subDir, "--continue", "--json", "Managed sub turn"],
    tempDir,
    { GROK_FAKE_SESSION: sid }
  );
  assert.equal(managedSub.status, 0, managedSub.stderr + managedSub.stdout);
  const managedSubJob = JSON.parse(managedSub.stdout);
  assert.equal(managedSubJob.resumeOf, turn1Job.id, "[RED] managed --cwd sub --continue executes in workspaceRoot and links to turn1Job");
  assert.equal(managedSubJob.executionCwd, turn1Job.workspaceRoot, "[RED] managed job records executionCwd === workspaceRoot");

  const cliSub = runCompanion(["cli", "--cwd", subDir, "--continue", "-p", "Isolated cli sub turn"], tempDir);
  assert.equal(cliSub.status, 0, cliSub.stderr + cliSub.stdout);
  const cliSubId = cliSub.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const cliSubJob = JSON.parse(runCompanion(["result", "--json", "--cwd", subDir, cliSubId], tempDir).stdout);
  assert.equal(cliSubJob.resumeOf, null, "[GUARD] isolated cli --cwd sub --continue does not link to root or managed-sub job");
});

test("[RED] T-C2 / A-E / R-E / R-H: J3 -r S links to plain-output J2, title-based -r reconciles post-run, --fork-session and contradictory sessions are guarded, and failed jobs preserve reported grokSessionId", () => {
  const tempDir = makeTempDir();
  const sid = "88888888-8888-4888-8888-888888888881";
  const forkedSid = "88888888-8888-4888-8888-888888888882";
  const otherSid = "88888888-8888-4888-8888-888888888883";
  const failedPartialSid = "88888888-8888-4888-8888-888888888884";

  const j1 = JSON.parse(runCompanion(["analyze", "--json", "Start S"], tempDir, { GROK_FAKE_SESSION: sid }).stdout);
  assert.equal(j1.grokSessionId, sid, "[SETUP] J1 reports sid");

  const j2Run = runCompanion(["cli", "-r", sid, "-p", "Plain turn 2"], tempDir);
  assert.equal(j2Run.status, 0);
  const j2Id = j2Run.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j2 = JSON.parse(runCompanion(["result", "--json", j2Id], tempDir).stdout);
  assert.equal(j2.grokSessionId, "unknown", "[SETUP] J2 has unknown grokSessionId");
  assert.equal(j2.resumeOf, j1.id, "[SETUP] J2 links to J1");

  const j3Run = runCompanion(["cli", "-r", sid, "-p", "Turn 3", "--output-format", "json"], tempDir, { GROK_FAKE_SESSION: sid });
  assert.equal(j3Run.status, 0);
  const j3Id = j3Run.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j3 = JSON.parse(runCompanion(["result", "--json", j3Id], tempDir).stdout);
  assert.equal(j3.resumeOf, j2Id, "[RED] C2: J3 links to plain-output J2 rather than skipping to J1");

  const j4PlainTitleRun = runCompanion(["cli", "-r", "my-session-title", "-p", "Plain title turn"], tempDir);
  assert.equal(j4PlainTitleRun.status, 0);
  const j4PlainTitleId = j4PlainTitleRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j4PlainTitle = JSON.parse(runCompanion(["result", "--json", j4PlainTitleId], tempDir).stdout);
  assert.equal(j4PlainTitle.resumeOf, null, "[GUARD] R-E: plain title-based -r stays null when no UUID is reported");

  const j4TitleJsonRun = runCompanion(
    ["cli", "-r", "my-session-title", "-p", "JSON title turn", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: sid }
  );
  assert.equal(j4TitleJsonRun.status, 0);
  const j4TitleJsonId = j4TitleJsonRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j4TitleJson = JSON.parse(runCompanion(["result", "--json", j4TitleJsonId], tempDir).stdout);
  assert.equal(j4TitleJson.resumeOf, j3Id, "[RED] R-E: title-based -r reconciles post-run to J3 via reported UUID sid");

  const j5ForkRun = runCompanion(
    ["cli", "-c", "--fork-session", "-p", "Forked turn", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: forkedSid }
  );
  assert.equal(j5ForkRun.status, 0);
  const j5ForkId = j5ForkRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j5Fork = JSON.parse(runCompanion(["result", "--json", j5ForkId], tempDir).stdout);
  assert.equal(j5Fork.resumeOf, j4TitleJsonId, "[GUARD] A-E: --fork-session keeps pre-run source link");

  const j6ReassignRun = runCompanion(
    ["cli", "-r", sid, "-p", "Reassigned turn", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FORCE_SESSION: otherSid }
  );
  assert.equal(j6ReassignRun.status, 0);
  const j7AfterReassignRun = runCompanion(
    ["cli", "-r", sid, "-p", "Back to sid", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_SESSION: sid }
  );
  assert.equal(j7AfterReassignRun.status, 0);
  const j7Id = j7AfterReassignRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const j7 = JSON.parse(runCompanion(["result", "--json", j7Id], tempDir).stdout);
  assert.equal(j7.resumeOf, j4TitleJsonId, "[GUARD] A-E: job that requested sid but reported otherSid is not matched for sid");

  const rescueFailed = runCompanion(
    ["rescue", "--json", "Start rescue that fails after emitting session"],
    tempDir,
    { GROK_FAKE_SESSION: failedPartialSid, GROK_FAKE_FAIL: "1" }
  );
  assert.notEqual(rescueFailed.status, 0);
  const rescueFailedJob = JSON.parse(rescueFailed.stdout);
  assert.equal(rescueFailedJob.status, "failed");
  assert.equal(rescueFailedJob.grokSessionId, failedPartialSid, "[GUARD] R-H: managed failed job preserves reported grokSessionId");

  const cliFailedWithSession = runCompanion(
    ["cli", "-p", "CLI turn that fails after emitting session", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_SESSION: failedPartialSid, GROK_FAKE_FAIL: "1" }
  );
  assert.notEqual(cliFailedWithSession.status, 0);
  const cliFailedId = cliFailedWithSession.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const cliFailedJob = JSON.parse(runCompanion(["result", "--json", cliFailedId], tempDir).stdout);
  assert.equal(cliFailedJob.status, "failed");
  assert.equal(cliFailedJob.grokSessionId, failedPartialSid, "[RED] R-H: cli failed job preserves reported grokSessionId when grok emitted one");
});

test("[RED] M1: router job IDs inside short clusters or inline -r= are refused (fail closed) while standalone -r/--resume/--resume= translate", () => {
  const tempDir = makeTempDir();
  const sid = "99999999-9999-4999-8999-999999999991";
  const turn1 = runCompanion(["analyze", "--json", "Start session for M1"], tempDir, { GROK_FAKE_SESSION: sid });
  assert.equal(turn1.status, 0, "[SETUP] turn 1 succeeds");
  const jobId = JSON.parse(turn1.stdout).id;

  for (const clusterArgs of [
    [`-r=${jobId}`],
    [`-cr=${jobId}`],
    ["-cr", jobId],
    [`-r${jobId}`]
  ]) {
    const bad = runCompanion(["cli", ...clusterArgs, "-p", "Should fail closed"], tempDir);
    assert.notEqual(bad.status, 0, `[RED] M1: ${clusterArgs.join(" ")} must be refused`);
    assert.match(bad.stderr, /standalone/i, `[RED] M1: ${clusterArgs.join(" ")} error explains standalone requirement`);
  }

  for (const standaloneArgs of [
    ["-r", jobId],
    ["--resume", jobId],
    [`--resume=${jobId}`]
  ]) {
    const ok = runCompanion(["cli", ...standaloneArgs, "-p", "Allowed standalone translation", "--output-format", "json"], tempDir);
    assert.equal(ok.status, 0, `[GUARD] standalone ${standaloneArgs.join(" ")} succeeds: ${ok.stderr}`);
  }
});

test("[RED] M2: result <id> --lane 0 and status <id> --json honor options placed after the job ID", () => {
  const tempDir = makeTempDir();
  const panelRun = runCompanion(["exec", "--lanes", "alpha,beta", "--best", "--json", "Complete lane work."], tempDir);
  assert.equal(panelRun.status, 0, "[SETUP] panel run succeeds");
  const panel = JSON.parse(panelRun.stdout);

  const laneTextOut = runCompanion(["result", panel.id, "--lane", "0"], tempDir);
  assert.equal(laneTextOut.status, 0, laneTextOut.stderr);
  assert.match(laneTextOut.stdout, new RegExp(`# Grok Job Result ${panel.lanes[0].id}`), "[RED] M2: result <id> --lane 0 returns the leaf job, not the parent panel");

  const laneJsonOut = runCompanion(["result", panel.id, "--lane", "0", "--json"], tempDir);
  assert.equal(laneJsonOut.status, 0, laneJsonOut.stderr);
  const leaf = JSON.parse(laneJsonOut.stdout);
  assert.equal(leaf.jobClass, "grok-lane", "[RED] M2: result <id> --lane 0 --json returns leaf JSON");
  assert.equal(leaf.lane, "alpha", "[RED] M2: result <id> --lane 0 returns lane alpha");

  const statusOut = runCompanion(["status", panel.id, "--json"], tempDir);
  assert.equal(statusOut.status, 0, statusOut.stderr);
  const statusPayload = JSON.parse(statusOut.stdout);
  assert.equal(statusPayload.id, panel.id, "[RED] M2: status <id> --json outputs JSON");
});

test("[RED] C1 / Rule 1: a single cli argv element containing spaces is never implicitly split, while --raw-arg-string still splits slash-command input", () => {
  const tempDir = makeTempDir();
  const singleElementSpace = runCompanion(["cli", "sessions --json"], tempDir);
  assert.notEqual(singleElementSpace.status, 0, "[RED] C1: single token 'sessions --json' is not split into subcommand 'sessions'");
  assert.match(singleElementSpace.stderr, /--allow-mutating/, "[RED] C1: single token 'sessions --json' is treated as one unclassified token");

  const allowedSingleToken = runCompanion(["cli", "--allow-mutating", "sessions --json"], tempDir);
  assert.equal(allowedSingleToken.status, 0, allowedSingleToken.stderr + allowedSingleToken.stdout);
  assert.deepEqual(readArgv(tempDir).argv, ["sessions --json"], "[RED] C1: single argv element containing space reaches grok as one element");

  const rawArgString = runCompanion(["cli", "--raw-arg-string", "doctor --debug"], tempDir);
  assert.equal(rawArgString.status, 0, rawArgString.stderr + rawArgString.stdout);
  assert.deepEqual(readArgv(tempDir).argv, ["doctor", "--debug"], "[GUARD] --raw-arg-string explicitly splits raw slash-command strings");
});

test("[RED] C2 / Rule 2: unknown flags on cli fail closed (never allow a later --help to look help-only, never record write:false, and always track the job while forwarding argv verbatim)", () => {
  const tempDir = makeTempDir();

  for (const args of [
    ["--future-value", "--help"],
    ["--future-flag"],
    ["-Z"],
    ["-hZ", "--help", "--tools", "read_file"]
  ]) {
    const res = runCompanion(["cli", ...args], tempDir);
    const jobId = res.stderr.match(/Job ID:\s+(\S+)/)?.[1];
    assert.ok(jobId, `[RED] C2: cli ${args.join(" ")} must fail closed and be tracked as a job (never untracked help-only)`);
    const job = JSON.parse(runCompanion(["result", "--json", jobId], tempDir).stdout);
    assert.equal(job.write, "unknown", `[RED] C2: cli ${args.join(" ")} records write: "unknown" (never false)`);
    assert.deepEqual(job.request.nativeArgs, args, `[GUARD] Rule 1: cli ${args.join(" ")} forwards argv verbatim`);
  }
});

test("[RED] Item 6 / C3: variadic flag values (including optional variadics) consume values up to the next flag without --best rejected as a router option", () => {
  const tempDir = makeTempDir();
  const customFixtures = path.join(tempDir, "custom-fixtures");
  fs.mkdirSync(customFixtures, { recursive: true });
  for (const name of fs.readdirSync(path.join(path.dirname(COMPANION), "..", "..", "..", "tests", "fixtures"))) {
    const src = path.join(path.dirname(COMPANION), "..", "..", "..", "tests", "fixtures", name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(customFixtures, name));
    }
  }
  fs.writeFileSync(
    path.join(customFixtures, "grok-help.txt"),
    helpText({
      flags: `
      --extra-files <FILE>...
          Required variadic files
      --opt-files [<FILE>...]
          Optional variadic files
`
    }),
    "utf8"
  );

  const optVarRun = runCompanion(
    ["cli", "--opt-files", "a.txt", "b.txt", "-c", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_FIXTURES: customFixtures }
  );
  assert.equal(optVarRun.status, 0, optVarRun.stderr + optVarRun.stdout);
  const optVarId = optVarRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const optVarJob = JSON.parse(runCompanion(["result", "--json", optVarId], tempDir).stdout);
  assert.equal(optVarJob.request.prompt, "--opt-files a.txt b.txt -c --output-format json", "[RED] C3: optional variadic [<FILE>...] consumes b.txt so b.txt is not extracted as a positional prompt");
});

test("[RED] Item 5 / C4: legacy job records without jobClass stay eligible for -c lookup and UUID/post-run reconciliation unless they are lane leaves by other fields", () => {
  const tempDir = makeTempDir();
  const env = testEnv(tempDir);
  const sid = "66666666-6666-4666-8666-666666666666";

  const legacyParent = saveJob(tempDir, {
    id: "analyze-legacy038parent",
    mode: "analyze",
    title: "Legacy 0.3.8 analyze job without jobClass",
    summary: "Legacy 0.3.8 analyze job without jobClass",
    cwd: tempDir,
    workspaceRoot: tempDir,
    status: "completed",
    phase: "done",
    grokSessionId: sid,
    createdAt: "2026-04-20T00:00:01.000Z",
    completedAt: "2026-04-20T00:00:02.000Z"
  }, env);

  saveJob(tempDir, {
    id: "panel-legacy038-lane-0",
    mode: "panel",
    lane: "alpha",
    title: "Legacy lane leaf without jobClass",
    summary: "Legacy lane leaf without jobClass",
    cwd: tempDir,
    workspaceRoot: tempDir,
    status: "completed",
    phase: "done",
    grokSessionId: sid,
    createdAt: "2026-04-20T00:00:03.000Z",
    completedAt: "2026-04-20T00:00:04.000Z"
  }, env);

  const contRun = runCompanion(
    ["cli", "-c", "-p", "Continue from legacy parent", "--output-format", "json"],
    tempDir,
    { GROK_FAKE_SESSION: sid }
  );
  assert.equal(contRun.status, 0, contRun.stderr + contRun.stdout);
  const contId = contRun.stderr.match(/Job ID:\s+(\S+)/)?.[1];
  const contJob = JSON.parse(runCompanion(["result", "--json", contId], tempDir).stdout);
  assert.equal(contJob.resumeOf, legacyParent.id, "[RED] C4: legacy parent job without jobClass is eligible for -c lookup while legacy lane leaf is skipped");
});

function spliceToken(base, index, token) {
  return [...base.slice(0, index), token, ...base.slice(index)];
}

function routerKeyOf(arg) {
  if (arg === "-C") {
    return "cwd";
  }
  if (!String(arg).startsWith("--")) {
    return null;
  }
  const body = String(arg).slice(2);
  const eq = body.indexOf("=");
  const key = eq === -1 ? body : body.slice(0, eq);
  return key || null;
}

test("[RED] R2 allow-list: unknown flags at every position around known subcommands and --help never run untracked, and router-owned options never reach grok", () => {
  const tempDir = makeTempDir();
  const helpFixture = fs.readFileSync(path.join(FIXTURES, "grok-help.txt"), "utf8");
  const grammar = buildCliGrammar(helpFixture);
  const parsed = parseGrokHelp(helpFixture);
  const commands = [];
  for (const command of parsed.commands) {
    if (command.name) {
      commands.push(command.name);
    }
    for (const alias of command.aliases ?? []) {
      if (alias) {
        commands.push(alias);
      }
    }
  }
  assert.ok(commands.includes("sessions") && commands.includes("models") && commands.includes("clone"), "[SETUP] fixture help lists known subcommands");

  const commandBases = [["--help"], ["-h"]];
  for (const command of commands) {
    commandBases.push([command]);
    commandBases.push([command, "--help"]);
    commandBases.push([command, "-h"]);
  }
  const unknownInjections = ["--future-value", "-Z", "--future-value=v"];
  const untracked = [];
  for (const base of commandBases) {
    for (let index = 0; index <= base.length; index += 1) {
      for (const injection of unknownInjections) {
        const args = spliceToken(base, index, injection);
        const argvPath = path.join(tempDir, "argv.json");
        if (fs.existsSync(argvPath)) {
          fs.unlinkSync(argvPath);
        }
        const res = runCompanion(["cli", ...args], tempDir);
        const tracked = /Job ID:\s+\S+/.test(res.stderr);
        const recorded = readArgv(tempDir)?.argv ?? [];
        const helpProbeOnly = recorded.length === 1 && recorded[0] === "--help";
        if (!helpProbeOnly && !tracked) {
          untracked.push(args.join(" "));
        }
      }
    }
  }

  const routerBases = [
    ["--help"],
    ["-h"],
    ["models"],
    ["models", "--help"],
    ["sessions"],
    ["sessions", "--help"],
    ["sessions", "-h"],
    ["login"],
    ["clone", "--help"],
    ["mcp", "add", "--help"],
    ["doctor"],
    ["-p", "hi"]
  ];
  const routerInjections = [];
  for (const key of ROUTER_OWNED_OPTIONS) {
    routerInjections.push(`--${key}`);
    routerInjections.push(`--${key}=v`);
  }
  const leaked = [];
  for (const base of routerBases) {
    for (let index = 0; index <= base.length; index += 1) {
      for (const injection of routerInjections) {
        const args = spliceToken(base, index, injection);
        const argvPath = path.join(tempDir, "argv.json");
        if (fs.existsSync(argvPath)) {
          fs.unlinkSync(argvPath);
        }
        const previous = index > 0 ? args[index - 1] : null;
        const injectionIsValue = Boolean(
          previous &&
          (grammar.valueFlags.has(previous) || (grammar.optionalValueFlags.has(previous) && !injection.startsWith("-")))
        );
        if (injectionIsValue) {
          continue;
        }
        runCompanion(["cli", ...args], tempDir);
        if (!fs.existsSync(argvPath)) {
          continue;
        }
        const recorded = readArgv(tempDir)?.argv ?? [];
        const injectionKey = routerKeyOf(injection);
        const hit = recorded.some((arg) => routerKeyOf(arg) === injectionKey);
        if (hit) {
          leaked.push(`${args.join(" ")} -> ${recorded.join(" ")}`);
        }
      }
    }
  }

  const sample = (items) => items.slice(0, 6).join(" || ");
  assert.equal(
    untracked.length,
    0,
    `[RED] R2 allow-list: ${untracked.length} shapes ran untracked, including: ${sample(untracked)}`
  );
  assert.equal(
    leaked.length,
    0,
    `[RED] R2 allow-list: ${leaked.length} router-owned options reached grok, including: ${sample(leaked)}`
  );
});

test("[RED] A1: an unknown flag before a known subcommand is tracked, including when --help follows", () => {
  const tempDir = makeTempDir();
  for (const args of [
    ["--future-value", "sessions", "--help"],
    ["--future-value", "sessions"],
    ["--future-value", "models"],
    ["-Z", "sessions"]
  ]) {
    const res = runCompanion(["cli", ...args], tempDir);
    const jobId = res.stderr.match(/Job ID:\s+(\S+)/)?.[1];
    assert.ok(jobId, `[RED] A1: cli ${args.join(" ")} must be tracked (never untracked passthrough)`);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.deepEqual(readArgv(tempDir).argv, args, `[GUARD] Rule 1: cli ${args.join(" ")} reaches grok verbatim`);
  }
});

test("[RED] A2: misplaced --raw-arg-string and --timeout are rejected and never reach grok", () => {
  const tempDir = makeTempDir();
  for (const args of [
    ["-p", "hi", "--raw-arg-string", "x"],
    ["--raw-arg-string=-p", "hi"],
    ["sessions", "--raw-arg-string", "x"],
    ["--timeout", "5", "-p", "hi"],
    ["--timeout=5", "models"],
    ["models", "--timeout"]
  ]) {
    const argvPath = path.join(tempDir, "argv.json");
    if (fs.existsSync(argvPath)) {
      fs.unlinkSync(argvPath);
    }
    const res = runCompanion(["cli", ...args], tempDir);
    assert.notEqual(res.status, 0, `[RED] A2: cli ${args.join(" ")} must be rejected`);
    const recorded = readArgv(tempDir)?.argv ?? [];
    const reachedGrok = recorded.some((arg) => arg === "--raw-arg-string" || arg.startsWith("--raw-arg-string=") || arg === "--timeout" || arg.startsWith("--timeout="));
    assert.equal(reachedGrok, false, `[RED] A2: cli ${args.join(" ")} must not reach grok (argv ${recorded.join(" ")})`);
    assert.match(res.stderr, /router option/, `[RED] A2: cli ${args.join(" ")} is rejected as a router option`);
  }
});

