import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { shouldEmitLiveProgress, stripHostNoise } from "../plugins/grok-router/scripts/lib/render.mjs";
import * as companionModule from "../plugins/grok-router/scripts/grok-companion.mjs";
import { resolveJobFile, saveJob } from "../plugins/grok-router/scripts/lib/state.mjs";
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

  // Turn 2 via cli -r <SID>
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

  // Turn 3 via managed analyze --resume <SID>: links turn-by-turn to cliJobId (Turn 2) and passes read-only --tools in grok argv
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

  // Unknown raw session ID has resumeOf: null (never a raw session ID)
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
  const env = testEnv(tempDir);
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  const origSetTimeout = globalThis.setTimeout;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const scheduledDelays = [];
  globalThis.setTimeout = function wrappedSetTimeout(fn, delay, ...rest) {
    if (Number(delay) >= 1000) {
      scheduledDelays.push(Number(delay));
    }
    return origSetTimeout.call(this, fn, delay, ...rest);
  };
  process.stdout.write = () => true;
  let capturedRunProcessTimeoutMs;
  try {
    await companionModule.main(["cli", "--cwd", tempDir, "-p", "Check default timeout", "--output-format", "json"]);
    assert.deepEqual(scheduledDelays, [], `expected no timeout timer in runProcess, got ${JSON.stringify(scheduledDelays)}`);

    assert.equal(typeof companionModule.handleCli, "function");
    await companionModule.handleCli(["--cwd", tempDir, "-p", "Check runProcess options", "--output-format", "json"], {
      runProcessImpl: async (_cmd, _args, opts) => {
        capturedRunProcessTimeoutMs = opts.timeoutMs;
        return { status: 0, stdout: '{"text":"ok","sessionId":"11111111-1111-4111-8111-111111111111"}\n', stderr: "", timedOut: false };
      }
    });
    assert.equal(capturedRunProcessTimeoutMs, 0);
  } finally {
    process.stdout.write = origStdoutWrite;
    globalThis.setTimeout = origSetTimeout;
    for (const key of Object.keys(env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = prevEnv[key];
      }
    }
  }
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

  // Walks 3-job chain (job3 -> job2 -> job1) and finds rootSid
  assert.equal(typeof companionModule.resolveKnownSessionId, "function");
  assert.equal(companionModule.resolveKnownSessionId(tempDir, job3, env), rootSid);

  // Corrupt middle job file (job2) -> returns null without throwing
  const job2File = resolveJobFile(tempDir, job2.id, env);
  fs.writeFileSync(job2File, "{corrupted json", "utf8");
  assert.equal(companionModule.resolveKnownSessionId(tempDir, job3, env), null);

  // Remove middle job file (job2) -> returns null without throwing
  fs.unlinkSync(job2File);
  assert.equal(companionModule.resolveKnownSessionId(tempDir, job3, env), null);
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

test("cli rejects router-only flags only in option position, never as flag values or after --", () => {
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

  // R3a: -p "--yolo" with read-only --tools must be write:false (not write:true)
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

  // R3b: when --tools is omitted and no --always-approve/--yolo is passed, grok's default tools can edit, so write is "unknown"
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

  // Real --yolo option sets write:true
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
  const otherCwdJob = JSON.parse(runCompanion(["result", "--json", otherCwdId, "--cwd", otherCwd], tempDir).stdout);
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
