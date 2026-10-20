import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../plugins/grok-router/scripts/lib/args.mjs";
import { buildGrokPrintArgs } from "../plugins/grok-router/scripts/lib/grok.mjs";
import { classifyControls } from "../plugins/grok-router/scripts/lib/live-controls.mjs";
import { parseGrokModels } from "../plugins/grok-router/scripts/lib/models.mjs";
import { buildRouterRequest } from "../plugins/grok-router/scripts/lib/router.mjs";
import { parseCommandInput, parseRoutedInput } from "../plugins/grok-router/scripts/grok-companion.mjs";
import { helpText, makeTempDir } from "./helpers.mjs";

const catalog = parseGrokModels(`Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`);
const nativeControls = classifyControls(helpText()).safeForward;

test("analyze is read-only and never auto-approves", () => {
  const request = buildRouterRequest({
    mode: "analyze",
    prompt: "map auth",
    options: { search: true, model: "4.6", effort: "xhigh", verbatim: true },
    catalog,
    nativeControls
  });
  assert.equal(request.write, false);
  assert.equal(request.tools, "read_file,grep,list_dir,web_search,web_fetch");
  assert.equal(request.controls.model, "grok-4.6");
  assert.equal(request.controls.effort, "xhigh");
  assert.ok(request.nativeArgs.includes("--verbatim"));
  assert.ok(!request.nativeArgs.includes("--always-approve"));
  assert.ok(!request.nativeArgs.includes("--tools"));
});

test("exec is write-capable", () => {
  const request = buildRouterRequest({
    mode: "exec",
    prompt: "fix the race",
    options: { best: true },
    catalog,
    nativeControls
  });
  assert.equal(request.write, true);
  assert.equal(request.tools, null);
  assert.equal(request.controls.model, "grok-4.6");
});

test("review rejects focus text", () => {
  assert.throws(
    () => buildRouterRequest({ mode: "review", prompt: "look at auth", catalog, nativeControls }),
    /adversarial-review/
  );
});

test("review without prompt uses the working tree", () => {
  const request = buildRouterRequest({
    mode: "review",
    prompt: "",
    options: {},
    catalog,
    nativeControls,
    diff: { text: "diff --git a/x b/x", command: "git diff" }
  });
  assert.equal(request.write, false);
  assert.match(request.prompt, /Findings only/);
  assert.match(request.prompt, /diff --git/);
});

test("safe-forward includes newly discovered flags", () => {
  const controls = classifyControls(helpText({
    flags: `
      --brand-new-flag <VALUE>
          future flag
`
  })).safeForward;
  const request = buildRouterRequest({
    mode: "analyze",
    prompt: "q",
    options: { "brand-new-flag": "yes" },
    catalog,
    nativeControls: controls
  });
  assert.deepEqual(
    request.nativeArgs.slice(request.nativeArgs.indexOf("--brand-new-flag"), request.nativeArgs.indexOf("--brand-new-flag") + 2),
    ["--brand-new-flag", "yes"]
  );
});

test("policy flags are not auto-forwarded from user options", () => {
  const request = buildRouterRequest({
    mode: "analyze",
    prompt: "q",
    options: { "always-approve": true, yolo: true, tools: "write", sandbox: "off" },
    catalog,
    nativeControls
  });
  assert.ok(!request.nativeArgs.includes("--always-approve"));
  assert.ok(!request.nativeArgs.includes("--yolo"));
  assert.ok(!request.nativeArgs.includes("--sandbox"));
  assert.equal(request.tools, "read_file,grep,list_dir");
});

test("managed model and effort selectors are emitted once in buildGrokPrintArgs while unrelated native flags forward", () => {
  for (const options of [
    { model: "4.6", effort: "xhigh", verbatim: true },
    { m: "4.6", "reasoning-effort": "high", verbatim: true }
  ]) {
    const request = buildRouterRequest({
      mode: "exec",
      prompt: "Reply only pong. Do not use tools or modify files.",
      options,
      catalog,
      nativeControls
    });
    const args = buildGrokPrintArgs(request);
    assert.equal(args.filter((arg) => arg === "-m" || arg === "--model").length, 1, `expected one model flag in ${JSON.stringify(args)}`);
    assert.equal(args[args.indexOf("-m") + 1], "grok-4.6");
    assert.ok(!args.includes("--model"));
    assert.equal(
      args.filter((arg) => arg === "--reasoning-effort" || arg === "--effort").length,
      1,
      `expected one effort flag in ${JSON.stringify(args)}`
    );
    assert.ok(args.includes("--verbatim"));
  }
});

test("buildRouterRequest reads --prompt-file when inline prompt is omitted and does not duplicate --prompt-file in nativeArgs", () => {
  const tempDir = makeTempDir();
  const pf = path.join(tempDir, "pf.txt");
  fs.writeFileSync(pf, "Reply with exactly the word PONG.\n", "utf8");
  const request = buildRouterRequest({
    mode: "analyze",
    prompt: "",
    options: { "prompt-file": pf },
    catalog,
    nativeControls
  });
  assert.equal(request.userRequest, "Reply with exactly the word PONG.");
  assert.match(request.prompt, /Reply with exactly the word PONG\./);
  assert.ok(!request.nativeArgs.includes("--prompt-file"));
});

test("parseArgs only treats --prompt-file as satisfying hasLaterPositional when promptFileOption is configured and before --", () => {
  const defaultParsed = parseArgs(["--resume", "hello", "--prompt-file", "pf.txt"], {
    optionalValueOptions: ["resume"],
    valueOptions: ["prompt-file"]
  });
  assert.equal(defaultParsed.options.resume, true);
  assert.deepEqual(defaultParsed.positionals, ["hello"]);

  const promptFileAfterDoubleDash = parseArgs(
    ["--resume", "session-id", "--", "--prompt-file", "pf.txt"],
    {
      optionalValueOptions: ["resume"],
      valueOptions: ["prompt-file"],
      promptFileOption: "prompt-file",
      stopAtPositional: true
    }
  );
  assert.equal(promptFileAfterDoubleDash.options.resume, "session-id");
  assert.equal(promptFileAfterDoubleDash.options["prompt-file"], undefined);
  assert.deepEqual(promptFileAfterDoubleDash.positionals, ["--prompt-file", "pf.txt"]);

  const promptFileInPositionalTailAfterDoubleDash = parseArgs(
    ["--", "--prompt-file", "pf.txt"],
    {
      optionalValueOptions: ["resume"],
      valueOptions: ["prompt-file"],
      promptFileOption: "prompt-file",
      stopAtPositional: false
    }
  );
  assert.equal(promptFileInPositionalTailAfterDoubleDash.options["prompt-file"], undefined);
  assert.deepEqual(promptFileInPositionalTailAfterDoubleDash.positionals, ["--prompt-file", "pf.txt"]);

  const promptFileAsValueOfAnotherOption = parseArgs(
    ["--resume", "Prompt literal", "--rules", "--prompt-file"],
    {
      optionalValueOptions: ["resume"],
      valueOptions: ["prompt-file", "rules"],
      promptFileOption: "prompt-file",
      stopAtPositional: true
    }
  );
  assert.equal(promptFileAsValueOfAnotherOption.options.resume, true);
  assert.deepEqual(
    promptFileAsValueOfAnotherOption.positionals,
    ["Prompt literal", "--rules", "--prompt-file"]
  );

  const bareResumeWithPromptText = parseRoutedInput(
    ["--resume", "Explain the auth flow"],
    nativeControls
  );
  assert.equal(bareResumeWithPromptText.options.resume, true);
  assert.deepEqual(bareResumeWithPromptText.positionals, ["Explain the auth flow"]);

  const namedResumeWithPromptFile = parseRoutedInput(
    ["--resume", "11111111-1111-4111-8111-111111111111", "--prompt-file", "pf.txt"],
    nativeControls
  );
  assert.equal(namedResumeWithPromptFile.options.resume, "11111111-1111-4111-8111-111111111111");
  assert.equal(namedResumeWithPromptFile.options["prompt-file"], "pf.txt");
  assert.deepEqual(namedResumeWithPromptFile.positionals, []);

  const nonRoutedCommand = parseCommandInput(
    ["--opt", "arg", "--prompt-file", "pf.txt"],
    { optionalValueOptions: ["opt"] }
  );
  assert.equal(nonRoutedCommand.options.opt, true);
  assert.equal(nonRoutedCommand.positionals[0], "arg");
});
