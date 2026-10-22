import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readGrokHelp } from "../plugins/grok-router/scripts/lib/grok.mjs";
import { parseGrokHelp } from "../plugins/grok-router/scripts/lib/help.mjs";
import { classifyControls, coverageForSurface } from "../plugins/grok-router/scripts/lib/live-controls.mjs";
import { FIXTURES, helpText, makeTempDir, testEnv } from "./helpers.mjs";

test("parseGrokHelp reads live clap help", () => {
  const parsed = parseGrokHelp(fs.readFileSync(path.join(FIXTURES, "grok-help.txt"), "utf8"));
  const longs = parsed.flags.map((flag) => flag.long);
  assert.ok(longs.includes("--model"));
  assert.ok(longs.includes("--always-approve"));
  assert.ok(longs.includes("--reasoning-effort"));
  assert.ok(longs.includes("--tools"));
  const model = parsed.flags.find((flag) => flag.long === "--model");
  assert.equal(model.short, "-m");
  assert.equal(model.requiresValue, true);
  const effort = parsed.flags.find((flag) => flag.long === "--reasoning-effort");
  assert.ok(effort.aliases.includes("--effort"));
  const permission = parsed.flags.find((flag) => flag.long === "--permission-mode");
  assert.ok(permission.possibleValues.includes("bypassPermissions"));
  const names = parsed.commands.map((command) => command.name);
  assert.ok(names.includes("models"));
  assert.ok(names.includes("clone"));
  assert.ok(names.includes("usage"));
  assert.ok(names.includes("cursor-worker"));
});

test("new flags and commands appear without a Router release", () => {
  const text = helpText({
    flags: `
      --brand-new-flag <VALUE>
          A flag added by a future Grok CLI
`,
    commands: `  brand-new-cmd  A command added by a future Grok CLI\n`
  });
  const classified = classifyControls(text);
  const coverage = coverageForSurface(text);
  assert.ok(classified.safeForward.some((control) => control.option === "brand-new-flag"));
  assert.ok(!classified.policy.some((control) => control.option === "brand-new-flag"));
  assert.equal(coverage.commands.find((command) => command.name === "brand-new-cmd")?.coverage, "cli-only");
  assert.equal(coverage.flags.find((flag) => flag.option === "always-approve")?.coverage, "policy-owned");
  assert.equal(coverage.flags.find((flag) => flag.option === "model")?.coverage, "safe-forward");
});

test("[RED] T-A1c / R-B / R-D: parseGrokHelp extracts compat aliases, =<V>, short-only, variadics, same-line aliases, and parseWarnings while keeping --allow canonical and policy-owned", () => {
  const fixtureText = fs.readFileSync(path.join(FIXTURES, "grok-help.txt"), "utf8");
  const parsed = parseGrokHelp(fixtureText);

  const allow = parsed.flags.find((flag) => flag.long === "--allow");
  assert.deepEqual(allow.aliases, ["--allowedTools", "--allowed-tools"], "[RED] plural compat aliases on --allow");
  const deny = parsed.flags.find((flag) => flag.long === "--deny");
  assert.deepEqual(deny.aliases, ["--disallowedTools"], "[RED] singular compat alias on --deny");
  const sysPrompt = parsed.flags.find((flag) => flag.long === "--system-prompt-override");
  assert.deepEqual(sysPrompt.aliases, ["--system-prompt"], "[RED] singular compat alias on --system-prompt-override");

  const du = parsed.commands.find((cmd) => cmd.name === "du");
  assert.deepEqual(du.aliases, ["disk-usage"], "[GUARD] command alias disk-usage preserved");
  const ver = parsed.commands.find((cmd) => cmd.name === "version");
  assert.deepEqual(ver.aliases, ["v"], "[GUARD] command alias v preserved");

  const classified = classifyControls(fixtureText);
  const allowControl = classified.policy.find((control) => control.option === "allow");
  assert.ok(allowControl, "[GUARD] --allow remains policy-owned");
  assert.equal(allowControl.flag, "--allow", "[GUARD] --allow header long flag remains canonical");
  assert.equal(allowControl.repeatable, true, "[GUARD] --allow remains repeatable");
  assert.ok(!classified.safeForward.some((control) => control.option === "allow" || control.option === "allowed-tools"), "[GUARD] --allow and --allowed-tools are not safe-forward");

  const synthetic = parseGrokHelp(helpText({
    flags: `
      --eq-req=<VAL>
          Equals required value
      --eq-opt[=<OPT>]
          Equals optional value
      --files <FILE>...
          Variadic files
  -x
          Short-only boolean flag
      --inline-flag <V>    Inline description [aliases: --in-alias] (compat alias: --in-compat)
      ---malformed-option
`
  }));
  const eqReq = synthetic.flags.find((flag) => flag.long === "--eq-req");
  assert.equal(eqReq?.requiresValue, true, "[RED] --eq-req=<VAL> requiresValue");
  assert.equal(eqReq?.valueHint, "VAL", "[RED] --eq-req=<VAL> valueHint");

  const eqOpt = synthetic.flags.find((flag) => flag.long === "--eq-opt");
  assert.equal(eqOpt?.optionalValue, true, "[RED] --eq-opt[=<OPT>] optionalValue");
  assert.equal(eqOpt?.valueHint, "OPT", "[RED] --eq-opt[=<OPT>] valueHint");

  const filesFlag = synthetic.flags.find((flag) => flag.long === "--files");
  assert.equal(filesFlag?.requiresValue, true);
  assert.equal(filesFlag?.valueHint, "FILE", "[RED] <FILE>... strips ellipsis from valueHint");
  assert.equal(filesFlag?.variadic, true, "[RED] <FILE>... sets variadic: true");

  const shortOnly = synthetic.flags.find((flag) => flag.short === "-x" && flag.long === null);
  assert.ok(shortOnly, "[RED] short-only -x flag is parsed");
  assert.deepEqual(shortOnly.names, ["-x"]);

  const inlineFlag = synthetic.flags.find((flag) => flag.long === "--inline-flag");
  assert.deepEqual(inlineFlag?.aliases, ["--in-alias", "--in-compat"], "[RED] same-line description aliases extracted");

  assert.equal(synthetic.parseWarnings.length, 1, "[RED] malformed option line emits parseWarning");
  assert.match(synthetic.parseWarnings[0], /unparsed option line:.*---malformed-option/);
});

test("[RED] R-A / A-C: readGrokHelp enforces a timeout and rejects stderr-only or empty help output", () => {
  const tempDir = makeTempDir();
  const slowGrok = path.join(tempDir, "slow-grok.mjs");
  fs.writeFileSync(
    slowGrok,
    "#!/usr/bin/env node\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\nprocess.stdout.write('Options:\\n  -h, --help\\n');\n",
    { mode: 0o755 }
  );
  const timedOutHelp = readGrokHelp(tempDir, testEnv(tempDir, { GROK_ROUTER_GROK: slowGrok }), { timeoutMs: 80 });
  assert.equal(timedOutHelp.ok, false, "[RED] readGrokHelp times out when grok --help hangs");
  assert.equal(timedOutHelp.text, "", "[RED] timed-out readGrokHelp returns empty text");
  assert.equal(timedOutHelp.result.timedOut, true, "[RED] result.timedOut is true on timeout");

  const stderrOnlyGrok = path.join(tempDir, "stderr-grok.mjs");
  fs.writeFileSync(
    stderrOnlyGrok,
    "#!/usr/bin/env node\nprocess.stderr.write('Options:\\n  --bogus <X>\\n');\nprocess.exit(0);\n",
    { mode: 0o755 }
  );
  const stderrHelp = readGrokHelp(tempDir, testEnv(tempDir, { GROK_ROUTER_GROK: stderrOnlyGrok }));
  assert.equal(stderrHelp.ok, false, "[RED] stderr-only exit 0 output is rejected by readGrokHelp");
  assert.equal(stderrHelp.text, "");
});
