#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hasLeadingHelpFlag, parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { createContextPack } from "./lib/context-pack.mjs";
import {
  extractGrokText,
  extractSessionId,
  getGrokAuthStatus,
  getGrokAvailability,
  grokHome,
  grokInvocation,
  managedTimeoutMs,
  readGrokHelp,
  readGrokInspect,
  readGrokModels,
  readGrokVersion,
  runGrokPrintJob,
  summarizeInspect
} from "./lib/grok.mjs";
import { classifyControls, coverageForSurface, liveControlParseConfig, ROUTER_OWNED_OPTIONS } from "./lib/live-controls.mjs";
import { parseGrokHelp } from "./lib/help.mjs";
import {
  appendLogLine,
  cancelJob,
  createJobLogFile,
  listJobs,
  readFullJob,
  refreshStaleJobs,
  runTrackedJob,
  sortJobsNewestFirst,
  waitForJob
} from "./lib/jobs.mjs";
import { renderModelCatalog } from "./lib/models.mjs";
import { binaryAvailable, runCommand, runProcess, spawnDetached } from "./lib/process.mjs";
import {
  emitJobStarted,
  emitLiveProgress,
  renderCommandPayload,
  renderJobStatus,
  renderSetupReport,
  renderStartedJob,
  renderStatusReport,
  renderStoredJobResult,
  renderSurface
} from "./lib/render.mjs";
import { mergeLaneFindings, parseLanes, renderSynthesis } from "./lib/panel.mjs";
import { buildRouterRequest } from "./lib/router.mjs";
import { generateJobId, getConfig, readJobFile, resolveJobsDir, saveJob, setConfig } from "./lib/state.mjs";
import { readGitDiff, readGitStatus, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8")).version;

const PUBLIC_COMMANDS = [
  "setup",
  "models",
  "surface",
  "help",
  "version",
  "analyze",
  "exec",
  "review",
  "adversarial-review",
  "rescue",
  "status",
  "result",
  "cancel",
  "cli"
];

const ROUTER_PARSE_SEED = {
  valueOptions: ["cwd", "model", "effort", "timeout-ms", "base", "scope", "tool", "resume", "lanes", "lane"],
  booleanOptions: [
    "json",
    "background",
    "wait",
    "best",
    "lean",
    "full",
    "search",
    "docs",
    "parallel",
    "panel",
    "all",
    "write",
    "fresh",
    "resume-last",
    "allow-mutating",
    "allow-dangerous",
    "enable-review-gate",
    "disable-review-gate"
  ],
  arrayOptions: ["tool"],
  aliasMap: { m: "model", C: "cwd", h: "help" },
  stopAtPositional: true
};

function pluginVersion() {
  return PLUGIN_VERSION;
}

function normalizeArgv(argv) {
  if (argv[0] === "--raw-arg-string") {
    if (argv.length !== 2) {
      throw new Error("--raw-arg-string requires exactly one following token: the raw argument string");
    }
    return splitRawArgumentString(argv[1]);
  }
  if (argv.length === 1 && argv[0] && argv[0].includes(" ") && !argv[0].startsWith("-")) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...ROUTER_PARSE_SEED,
    ...config,
    valueOptions: unique([...(ROUTER_PARSE_SEED.valueOptions), ...(config.valueOptions ?? [])]),
    booleanOptions: unique([...(ROUTER_PARSE_SEED.booleanOptions), ...(config.booleanOptions ?? [])]),
    arrayOptions: unique([...(ROUTER_PARSE_SEED.arrayOptions ?? []), ...(config.arrayOptions ?? [])]),
    aliasMap: { ...ROUTER_PARSE_SEED.aliasMap, ...(config.aliasMap ?? {}) },
    stopAtPositional: config.stopAtPositional ?? ROUTER_PARSE_SEED.stopAtPositional
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function output(value, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : value);
}

function commandPayload(result) {
  return {
    command: result.command,
    args: result.args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
    error: result.error ? result.error.message : null
  };
}

function discoverRoutedSurface(cwd = process.cwd(), env = process.env) {
  const help = readGrokHelp(cwd, env);
  const helpText = help.ok ? help.text : "";
  const classified = classifyControls(helpText);
  return { help, helpText, classified, nativeControls: classified.safeForward };
}

function parseRoutedInput(argv, nativeControls) {
  const liveConfig = liveControlParseConfig([
    ...nativeControls,
    ...[...ROUTER_OWNED_OPTIONS].map((option) => ({
      option,
      optionAliases: [],
      kind: ["cwd", "model", "effort", "timeout-ms", "base", "scope", "tool", "resume", "lanes"].includes(option) ? "value" : "boolean",
      repeatable: option === "tool"
    }))
  ]);
  return parseCommandInput(argv, {
    valueOptions: unique([...liveConfig.valueOptions, ...ROUTER_PARSE_SEED.valueOptions, "prompt-file"]),
    booleanOptions: unique([...liveConfig.booleanOptions, ...ROUTER_PARSE_SEED.booleanOptions]),
    optionalValueOptions: liveConfig.optionalValueOptions,
    arrayOptions: unique([...(liveConfig.repeatableOptions ?? []), "tool"]),
    aliasMap: { ...liveConfig.aliasMap, ...ROUTER_PARSE_SEED.aliasMap },
    promptFileOption: "prompt-file"
  });
}

function routerHelpPayload() {
  return {
    router: { name: "grok-router", version: pluginVersion() },
    usage: [
      "grok-companion.mjs [--help|-h]",
      "grok-companion.mjs <command> [args]"
    ],
    commands: PUBLIC_COMMANDS.map((name) => ({ name, summary: commandSummary(name) })),
    notes: [
      "The installed grok binary is the source of truth. Run models / surface / help before assuming flags or model ids.",
      "--model and --effort are opaque live values. --best selects the live default from grok models.",
      "analyze/review are read-only (--tools read_file,grep,list_dir). exec uses --always-approve.",
      "--lean is a router-owned context diet (not a grok flag). Opt-in. House AGENTS.md may still inject via prompt_context. --full restores 0.1.0 behavior. --search with --lean keeps web tools.",
      "Fan-out: --lanes a,b,c or review --panel launches N grok -p --no-subagents leaves. The companion merges json-schema findings. Full leaf text: result <id> --lane k. Do not spawn_subagent in the lead. Claude and Codex only. Do not install this plugin into Grok.",
      "Foreground is the default. Job ID and progress print on stderr as soon as the job is queued. stdout is the finished result. --background detaches a tracked worker. --wait is only valid on status.",
      "New Grok flags appear on surface as safe-forward or cli-only. Use cli for unmodeled subcommands."
    ]
  };
}

function commandSummary(name) {
  return {
    setup: "Check grok, auth, and optional review gate",
    models: "Live grok models catalog",
    surface: "Installed CLI version, help, and router coverage",
    help: "Router help, or grok <path> --help",
    version: "Router and grok versions",
    analyze: "Read-only analysis",
    exec: "Write-capable implementation",
    review: "Findings-only review of a git diff",
    "adversarial-review": "Steerable challenge review",
    rescue: "Tracked investigate/fix with session resume",
    status: "List or inspect jobs",
    result: "Stored job output",
    cancel: "Stop an active job",
    cli: "Raw grok argv passthrough"
  }[name] ?? name;
}

function renderRouterHelp(payload) {
  const lines = [
    "# Grok Router",
    "",
    `Version: ${payload.router.version}`,
    "",
    "Usage:",
    ...payload.usage.map((line) => `  ${line}`),
    "",
    "Commands:",
    ...payload.commands.map((command) => `  ${command.name.padEnd(22)} ${command.summary}`),
    "",
    "Notes:",
    ...payload.notes.map((note) => `  - ${note}`)
  ];
  return `${lines.join("\n")}\n`;
}

function installWorkflows(env = process.env) {
  const src = path.join(ROOT, "workflows");
  const dest = path.join(grokHome(env), "workflows");
  const copied = [];
  if (!fs.existsSync(src)) {
    return { dest, copied };
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(src).filter((file) => file.endsWith(".rhai"))) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
    copied.push(name);
  }
  return { dest, copied };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  if (options["enable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: true });
  }
  if (options["disable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: false });
  }
  const node = binaryAvailable("node", ["--version"], { cwd });
  const grok = getGrokAvailability(cwd);
  const auth = grok.available ? getGrokAuthStatus(cwd) : { loggedIn: false, detail: "grok unavailable" };
  const inspect = grok.available ? readGrokInspect(cwd) : { ok: false, parsed: null, detail: "grok unavailable" };
  const load = inspect.ok ? summarizeInspect(inspect.parsed) : null;
  const config = getConfig(cwd);
  const nextSteps = [];
  if (!grok.available) {
    nextSteps.push("Install Grok CLI from https://x.ai/cli and put `grok` on PATH.");
  }
  if (grok.available && !auth.loggedIn) {
    nextSteps.push("Run `grok login`. If the browser is blocked, use `grok login --device-auth` or set XAI_API_KEY.");
  }
  const workflows = installWorkflows();
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: grok-router setup --enable-review-gate");
  }
  if (workflows.copied.length) {
    nextSteps.push(`Grok TUI: /workflow grok-router-review (copied ${workflows.copied.join(", ")} to ${workflows.dest}).`);
  }
  const report = {
    ready: node.available && grok.available && auth.loggedIn,
    node,
    grok,
    auth,
    inspect: {
      ok: inspect.ok,
      detail: inspect.ok ? inspect.parsed?.grokVersion : (inspect.raw || inspect.result?.stderr || "failed")
    },
    load,
    workflows,
    reviewGate: { enabled: Boolean(config.stopReviewGate) },
    nextSteps
  };
  output(options.json ? report : renderSetupReport(report), Boolean(options.json));
}

async function handleModels(argv) {
  const { options } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  const version = readGrokVersion(cwd);
  const models = readGrokModels(cwd);
  const inspect = readGrokInspect(cwd);
  const payload = {
    router: { name: "grok-router", version: pluginVersion() },
    grokVersion: version.raw,
    ...models.catalog,
    lean: {
      flag: "--lean",
      default: false,
      residual: "House AGENTS.md may still inject via prompt_context. --lean is opt-in. --full restores 0.1.0."
    },
    load: inspect.ok ? summarizeInspect(inspect.parsed) : null,
    raw: options.all ? models.raw : undefined
  };
  output(options.json ? payload : renderModelCatalog(models.catalog, { version: version.raw, lean: payload.lean, load: payload.load }), Boolean(options.json));
}

async function handleSurface(argv) {
  const { options } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  const version = readGrokVersion(cwd);
  const help = readGrokHelp(cwd);
  const coverage = coverageForSurface(help.text);
  const payload = {
    router: {
      name: "grok-router",
      version: pluginVersion(),
      managedWorkTools: ["analyze", "exec", "review", "adversarial-review", "rescue"],
      discoveryTools: ["setup", "models", "surface", "help", "version"],
      jobTools: ["status", "result", "cancel"],
      fullSurfaceTools: ["cli"],
      note: "Managed modes enforce read/write boundaries. --lean is a router-owned context diet (not a grok flag). Discovery reads the installed grok binary. cli exposes unmodeled commands and flags the same day they appear in grok --help."
    },
    version: version.raw,
    coverage,
    help: commandPayload(help.result)
  };
  output(options.json ? payload : renderSurface(payload), Boolean(options.json));
}

async function handleVersion(argv) {
  const { options } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  const grok = readGrokVersion(cwd);
  const payload = { router: { name: "grok-router", version: pluginVersion() }, grok: grok.raw };
  output(options.json ? payload : `Grok Router: ${payload.router.version}\nGrok CLI: ${grok.raw}\n`, Boolean(options.json));
}

async function handleHelp(argv) {
  const parsed = parseCommandInput(argv, { stopAtPositional: true });
  if (!parsed.positionals.length || parsed.options.help) {
    const payload = routerHelpPayload();
    output(parsed.options.json ? payload : renderRouterHelp(payload), Boolean(parsed.options.json));
    return;
  }
  const cwd = resolveCwd(parsed.options);
  const args = [...parsed.positionals, "--help"];
  const invocation = grokInvocation(args);
  const result = runCommand(invocation.command, invocation.args, { cwd });
  const payload = commandPayload(result);
  output(parsed.options.json ? payload : renderCommandPayload(`grok ${args.join(" ")}`, payload), Boolean(parsed.options.json));
}

function classifyCliArgs(args, helpText) {
  const parsed = parseGrokHelp(helpText);
  const commandNames = new Set(parsed.commands.flatMap((command) => [command.name, ...command.aliases]));
  const [first] = args;
  const helpOnly = args.includes("--help") || args.includes("-h") || first === "help";
  const mutatingCommands = new Set(["login", "logout", "plugin", "mcp", "setup", "update", "memory", "worktree", "clone"]);
  const mutating = !helpOnly && mutatingCommands.has(first);
  const unclassified = !helpOnly && first && !commandNames.has(first) && !String(first).startsWith("-");
  return { helpOnly, mutating, unclassified, first };
}

const CLI_PARSE_CONFIG = {
  valueOptions: ["cwd", "timeout-ms", "base", "scope", "tool", "lanes", "lane"],
  booleanOptions: [
    "allow-mutating",
    "allow-dangerous",
    "json",
    "background",
    "wait",
    "best",
    "lean",
    "full",
    "search",
    "docs",
    "parallel",
    "panel",
    "all",
    "write",
    "fresh",
    "resume-last",
    "enable-review-gate",
    "disable-review-gate"
  ],
  arrayOptions: ["tool"],
  aliasMap: { C: "cwd" },
  stopAtPositional: false
};

const CLI_ALLOWED_ROUTER_OPTIONS = new Set(["cwd", "timeout-ms", "allow-mutating", "allow-dangerous"]);

function parseCliInput(argv) {
  const parsed = parseArgs(normalizeArgv(argv), CLI_PARSE_CONFIG);
  for (const key of Object.keys(parsed.options)) {
    if (!CLI_ALLOWED_ROUTER_OPTIONS.has(key)) {
      throw new Error(`--${key} is a router option and is not supported on cli. Pass native grok flags (or use analyze, exec, review, adversarial-review, or rescue).`);
    }
  }
  return parsed;
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findPriorJobForResume(workspaceRoot, target, env = process.env) {
  if (!target || target === true) {
    return null;
  }
  const ref = String(target).trim();
  if (!ref) {
    return null;
  }
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot, env));
  return (
    jobs.find((job) => job.id === ref) ??
    jobs.find((job) => job.grokSessionId === ref) ??
    null
  );
}

function resolveKnownSessionId(workspaceRoot, job, env = process.env) {
  if (!job) {
    return null;
  }
  if (job.grokSessionId && job.grokSessionId !== "unknown") {
    return job.grokSessionId;
  }
  if (job.request?.controls?.resume && job.request.controls.resume !== "unknown") {
    return job.request.controls.resume;
  }
  const seen = new Set([job.id]);
  let cursor = job;
  while (cursor?.resumeOf && !seen.has(cursor.resumeOf)) {
    seen.add(cursor.resumeOf);
    cursor = readJobFile(workspaceRoot, cursor.resumeOf, env);
    if (cursor?.grokSessionId && cursor.grokSessionId !== "unknown") {
      return cursor.grokSessionId;
    }
    if (cursor?.request?.controls?.resume && cursor.request.controls.resume !== "unknown") {
      return cursor.request.controls.resume;
    }
  }
  return null;
}

const CLI_READ_ONLY_TOOLS = new Set(["read_file", "grep", "list_dir", "web_search", "web_fetch"]);

function cliToolsCanWrite(tools) {
  if (!tools) {
    return false;
  }
  const entries = String(tools)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return entries.some((entry) => !CLI_READ_ONLY_TOOLS.has(entry));
}

function extractCliMetadata(args, cwd, helpText = "") {
  const parsedHelp = parseGrokHelp(helpText);
  const commandNames = new Set(parsedHelp.commands.flatMap((command) => [command.name, ...command.aliases]));
  const valueFlags = new Set(["--agent", "--agents", "--allow", "--allowedTools", "--cwd", "-C", "--debug-file", "--deny", "--disallowed-tools", "--disallowedTools", "--json-schema", "--leader-socket", "-m", "--model", "--max-turns", "--output-format", "-p", "--single", "--permission-mode", "--prompt-file", "--prompt-json", "--reasoning-effort", "--effort", "--rules", "-s", "--session-id", "--sandbox", "--system-prompt-override", "--system-prompt", "--tools", "--worktree-ref", "--ref"]);
  const optionalValueFlags = new Set(["-r", "--resume", "-w", "--worktree"]);
  for (const flag of parsedHelp.flags) {
    for (const name of flag.names) {
      if (flag.requiresValue) {
        valueFlags.add(name);
      } else if (flag.optionalValue) {
        optionalValueFlags.add(name);
      }
    }
  }

  let resume = null;
  let resumeFlagIndex = -1;
  let resumeInlinePrefix = null;
  let hasResumeFlag = false;
  let hasContinueFlag = false;
  let prompt = null;
  let promptFile = null;
  let model = null;
  let effort = null;
  let tools = null;
  const positionalTokens = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    const next = args[i + 1];
    if (token === "--") {
      positionalTokens.push(...args.slice(i + 1).map((item) => String(item)));
      break;
    }
    if ((token === "--resume" || token === "-r")) {
      hasResumeFlag = true;
      if (next !== undefined && !String(next).startsWith("-")) {
        resume = String(next);
        resumeFlagIndex = i + 1;
        i += 1;
      } else {
        resume = true;
      }
    } else if (token.startsWith("--resume=")) {
      hasResumeFlag = true;
      resume = token.slice("--resume=".length);
      resumeFlagIndex = i;
      resumeInlinePrefix = "--resume=";
    } else if (token === "--continue" || token === "-c") {
      hasContinueFlag = true;
    } else if ((token === "-p" || token === "--single") && next !== undefined) {
      prompt = String(next);
      i += 1;
    } else if (token.startsWith("--single=")) {
      prompt = token.slice("--single=".length);
    } else if (token === "--prompt-file" && next !== undefined) {
      promptFile = String(next);
      i += 1;
    } else if (token.startsWith("--prompt-file=")) {
      promptFile = token.slice("--prompt-file=".length);
    } else if ((token === "-m" || token === "--model") && next !== undefined) {
      model = String(next);
      i += 1;
    } else if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
    } else if ((token === "--effort" || token === "--reasoning-effort") && next !== undefined) {
      effort = String(next);
      i += 1;
    } else if (token.startsWith("--effort=")) {
      effort = token.slice("--effort=".length);
    } else if (token.startsWith("--reasoning-effort=")) {
      effort = token.slice("--reasoning-effort=".length);
    } else if (token === "--tools" && next !== undefined) {
      tools = String(next);
      i += 1;
    } else if (token.startsWith("--tools=")) {
      tools = token.slice("--tools=".length);
    } else if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      if (eq === -1) {
        if (valueFlags.has(token) && next !== undefined) {
          i += 1;
        } else if (optionalValueFlags.has(token) && next !== undefined && !String(next).startsWith("-")) {
          i += 1;
        }
      }
    } else {
      positionalTokens.push(token);
    }
  }

  let resolvedPromptFile = null;
  if (promptFile) {
    resolvedPromptFile = path.resolve(cwd, promptFile);
    if (!fs.existsSync(resolvedPromptFile)) {
      throw new Error(`Prompt file not found: ${resolvedPromptFile}`);
    }
    const fromFile = fs.readFileSync(resolvedPromptFile, "utf8").trim() || `[prompt-file: ${resolvedPromptFile}]`;
    prompt = prompt ? `${fromFile}\n\n${prompt}` : fromFile;
  }

  if (prompt === null && positionalTokens.length && !commandNames.has(positionalTokens[0])) {
    prompt = positionalTokens.join(" ");
  }

  const hasPromptOrResume = Boolean(prompt !== null || resolvedPromptFile || hasResumeFlag || hasContinueFlag);

  return {
    resume,
    resumeFlagIndex,
    resumeInlinePrefix,
    hasResumeFlag,
    hasPromptOrResume,
    prompt,
    promptFile: resolvedPromptFile,
    model,
    effort,
    tools,
    continue: hasContinueFlag
  };
}

async function handleCli(argv) {
  const { options, positionals } = parseCliInput(argv);
  const cwd = resolveCwd(options);
  const env = process.env;
  const args = [...positionals];
  if (!args.length) {
    throw new Error("Provide Grok CLI arguments, for example: grok-router cli --help");
  }
  if (args[0] === "grok") {
    throw new Error("Do not include the grok binary name; provide only Grok CLI args.");
  }
  const help = readGrokHelp(cwd, env);
  const classification = classifyCliArgs(args, help.text);
  if (classification.mutating && !options["allow-mutating"]) {
    throw new Error("Raw Grok command may mutate configuration or install state. Re-run with --allow-mutating only when the user explicitly requested this action.");
  }
  if (classification.unclassified && !options["allow-mutating"]) {
    throw new Error("Raw Grok command is not classified yet. Re-run with --allow-mutating when the user explicitly requested it, or pass a known grok subcommand.");
  }
  const timeoutMs = options["timeout-ms"] !== undefined && options["timeout-ms"] !== null && options["timeout-ms"] !== ""
    ? managedTimeoutMs(options["timeout-ms"])
    : 0;
  const meta = extractCliMetadata(args, cwd, help.text);
  if (classification.helpOnly || !meta.hasPromptOrResume) {
    const invocation = grokInvocation(args, env);
    const result = await runProcess(invocation.command, invocation.args, { cwd, env, timeoutMs });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.status ?? 1;
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const priorJob = findPriorJobForResume(workspaceRoot, meta.resume, env);
  const resumedByJobId = Boolean(priorJob && meta.resume === priorJob.id);
  const priorSessionId = resumedByJobId ? resolveKnownSessionId(workspaceRoot, priorJob, env) : null;
  if (resumedByJobId && !priorSessionId) {
    throw new Error(`Job ${priorJob.id} has no known Grok session.`);
  }
  const resumeSessionId = resumedByJobId
    ? priorSessionId
    : (meta.resume && meta.resume !== true ? meta.resume : null);
  if (resumedByJobId && priorSessionId && meta.resumeFlagIndex !== -1) {
    args[meta.resumeFlagIndex] = meta.resumeInlinePrefix
      ? `${meta.resumeInlinePrefix}${priorSessionId}`
      : priorSessionId;
  }
  const resumeOf = priorJob?.id ?? null;
  const userRequest = (meta.prompt ?? args.join(" ")).trim();
  const write = args.includes("--always-approve") || args.includes("--yolo") || cliToolsCanWrite(meta.tools) || Boolean(classification.mutating);
  const jobId = generateJobId("cli");
  const logFile = createJobLogFile(workspaceRoot, jobId, "Grok CLI", env);
  const request = {
    mode: "cli",
    workflow: "CLI",
    write,
    tools: meta.tools,
    prompt: userRequest,
    promptFile: meta.promptFile,
    userRequest,
    controls: {
      model: meta.model,
      effort: meta.effort,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      resume: resumeSessionId,
      continue: meta.continue
    },
    nativeArgs: args
  };
  const job = saveJob(workspaceRoot, {
    id: jobId,
    jobClass: "grok",
    kindLabel: "CLI",
    mode: "cli",
    title: userRequest.slice(0, 96),
    summary: userRequest.slice(0, 96),
    workspaceRoot,
    status: "queued",
    phase: "queued",
    write,
    request,
    resumeOf,
    grokSessionId: null,
    logFile,
    createdAt: new Date().toISOString()
  }, env);
  emitJobStarted({ ...job, status: "running" });

  const invocation = grokInvocation(args, env);
  let rawResult = null;
  await runTrackedJob(job, async (hooks) => {
    appendLogLine(logFile, `Invoking Grok cli: ${args.join(" ")}`);
    const result = await runProcess(invocation.command, invocation.args, {
      cwd,
      env,
      timeoutMs,
      onSpawn: (processRecord) => hooks.updateProcess(processRecord),
      onStdout: (chunk) => appendLogLine(logFile, chunk),
      onStderr: (chunk) => appendLogLine(logFile, chunk)
    });
    rawResult = result;
    const parsed = parseJsonOrNull(result.stdout?.trim?.() ? result.stdout.trim() : result.stdout);
    const exitStatus = result.error ? 1 : (result.status ?? 1);
    const jobStatus = result.timedOut ? "failed" : exitStatus === 0 ? "completed" : "failed";
    const parsedSessionId = extractSessionId(parsed, result.stdout);
    const sessionId = jobStatus === "completed" ? (parsedSessionId ?? "unknown") : null;
    const text = extractGrokText(parsed, result.stdout);
    return {
      exitStatus,
      jobStatus,
      phase: result.timedOut ? "timed-out" : jobStatus === "completed" ? "done" : "failed",
      grokSessionId: sessionId,
      payload: {
        mode: "cli",
        workflow: "CLI",
        command: invocation.command,
        args,
        timedOut: Boolean(result.timedOut),
        signal: result.signal,
        rawOutput: text,
        parsedOutput: parsed,
        structuredOutput: parsed?.structuredOutput ?? null,
        stderr: result.stderr,
        sessionId
      },
      rendered: (text || result.stderr || (result.error ? result.error.message : `Grok exited ${exitStatus} with no result.`)).trimEnd()
    };
  }, { env, trackChildProcess: true });

  if (rawResult?.stdout) {
    process.stdout.write(rawResult.stdout);
  }
  if (rawResult?.stderr) {
    process.stderr.write(rawResult.stderr);
  }
  process.exitCode = rawResult?.status ?? 1;
}

async function runStoredJob(workspaceRoot, jobId, options = {}) {
  const env = options.env ?? process.env;
  const stored = readJobFile(workspaceRoot, jobId, env);
  if (!stored) {
    throw new Error(`Missing stored job ${jobId}`);
  }
  const live = options.live === true;
  return runTrackedJob(stored, async (hooks) => {
    appendLogLine(stored.logFile, `Invoking Grok ${stored.mode}.`);
    if (live) {
      emitLiveProgress("Ready to work.");
    }
    return runGrokPrintJob(workspaceRoot, stored.request, {
      env,
      detached: options.backgroundWorker ? false : undefined,
      timeoutMs: stored.request.controls?.timeoutMs,
      readGitStatus: () => readGitStatus(workspaceRoot),
      onProgress: (event) => {
        if (event.logBody != null) {
          appendLogLine(stored.logFile, event.logBody);
        }
        if (live && event.message) {
          emitLiveProgress(event.message);
        }
      },
      onSpawn: options.backgroundWorker
        ? undefined
        : (processRecord) => {
          hooks.updateProcess(processRecord);
        }
    });
  }, { env, processGroup: Boolean(options.backgroundWorker), trackChildProcess: !options.backgroundWorker });
}

async function handleInternalRun(argv) {
  const jobId = argv[0];
  const workspaceRoot = process.env.GROK_ROUTER_WORKSPACE || process.cwd();
  const job = await runStoredJob(workspaceRoot, jobId, { backgroundWorker: true });
  if (job?.status && !["completed", "completed-with-warnings"].includes(job.status)) {
    process.exitCode = 1;
  }
}

async function handleRouted(mode, argv) {
  const cwdGuess = process.cwd();
  const { nativeControls } = discoverRoutedSurface(cwdGuess);
  const parsed = parseRoutedInput(argv, nativeControls);
  return runRouted(mode, parsed, { nativeControls });
}

function lastRescueSession(cwd, env) {
  const jobs = sortJobsNewestFirst(listJobs(cwd, env)).filter((job) => job.mode === "rescue" && job.grokSessionId && job.grokSessionId !== "unknown");
  return jobs[0]?.grokSessionId ?? null;
}

async function runRouted(mode, { options, positionals }, { nativeControls } = {}) {
  const cwd = resolveCwd(options);
  const env = process.env;
  if (env.GROK_ROUTER_NESTING === "1") {
    throw new Error("Nested grok-router fan-out is refused. Leaves must not call grok-router.");
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = positionals.join(" ");
  const lanes = parseLanes(mode, options);
  if (lanes) {
    return runPanel(mode, { options, prompt, lanes, nativeControls, cwd, env, workspaceRoot });
  }
  if (mode === "rescue" && (options["resume-last"] || options.resume === true) && !options.fresh) {
    const sessionId = lastRescueSession(workspaceRoot, env);
    if (sessionId) {
      options.resume = sessionId;
    }
  }
  const priorJob = options.resume && options.resume !== true
    ? findPriorJobForResume(workspaceRoot, options.resume, env)
    : null;
  const resumedByJobId = Boolean(priorJob && options.resume === priorJob.id);
  const priorSessionId = resumedByJobId ? resolveKnownSessionId(workspaceRoot, priorJob, env) : null;
  if (resumedByJobId && !priorSessionId) {
    throw new Error(`Job ${priorJob.id} has no known Grok session.`);
  }
  if (resumedByJobId && priorSessionId) {
    options.resume = priorSessionId;
  }
  const models = readGrokModels(cwd, env);
  const version = readGrokVersion(cwd, env);
  const gitBefore = readGitStatus(workspaceRoot);
  let diff = null;
  if (mode === "review" || mode === "adversarial-review") {
    diff = readGitDiff(workspaceRoot, { base: options.base || null, staged: options.scope === "staged" });
  }
  const request = buildRouterRequest({
    mode,
    prompt,
    options,
    gitBefore,
    catalog: models.catalog,
    nativeControls: nativeControls ?? [],
    diff
  });
  const resumeOf = priorJob?.id ?? null;
  const jobId = generateJobId(mode);
  if (mode === "review" || mode === "adversarial-review" || Boolean(options["prompt-file"])) {
    const promptFile = path.join(resolveJobsDir(workspaceRoot, env), `${jobId}.prompt.txt`);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
    request.promptFile = promptFile;
  }
  const contextPack = createContextPack(workspaceRoot, request, { grokVersion: version.raw });
  const logFile = createJobLogFile(workspaceRoot, jobId, `Grok ${request.workflow}`, env);
  const job = saveJob(workspaceRoot, {
    id: jobId,
    jobClass: "grok",
    kindLabel: request.workflow,
    mode,
    title: request.userRequest.slice(0, 96),
    summary: request.userRequest.slice(0, 96),
    workspaceRoot,
    status: "queued",
    phase: options.background ? "background" : "queued",
    write: request.write,
    request,
    resumeOf,
    grokSessionId: null,
    contextPack,
    logFile,
    createdAt: new Date().toISOString()
  }, env);

  if (options.background) {
    const worker = spawnDetached(process.execPath, [SCRIPT, "internal-run", job.id], {
      cwd: workspaceRoot,
      env: { ...env, GROK_ROUTER_WORKSPACE: workspaceRoot }
    });
    saveJob(workspaceRoot, {
      ...job,
      status: "running",
      phase: "background",
      companionPid: worker.pid,
      companionProcessStartTime: worker.processStartTime,
      processGroup: worker.processGroup
    }, env);
    output(options.json ? { ...job, status: "running", phase: "background" } : renderStartedJob({ ...job, status: "running" }), Boolean(options.json));
    return;
  }

  emitJobStarted({ ...job, status: "running" });
  const finished = await runStoredJob(workspaceRoot, job.id, { env, live: !options.json });
  if (finished.status && !["completed", "completed-with-warnings"].includes(finished.status)) {
    process.exitCode = 1;
  }
  if (options.json) {
    output(finished, true);
    return;
  }
  process.stdout.write(finished.rendered?.endsWith("\n") ? finished.rendered : `${finished.rendered ?? ""}\n`);
}

async function launchLeafJob(mode, { options, prompt, lane, nativeControls, env, workspaceRoot, models, version, gitBefore, diff }) {
  const request = buildRouterRequest({
    mode,
    prompt,
    options: { ...options, lane, panel: true, background: false },
    gitBefore,
    catalog: models.catalog,
    nativeControls: nativeControls ?? [],
    diff
  });
  const jobId = generateJobId(`${mode}-lane`);
  if (mode === "review" || mode === "adversarial-review" || Boolean(options["prompt-file"])) {
    const promptFile = path.join(resolveJobsDir(workspaceRoot, env), `${jobId}.prompt.txt`);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
    request.promptFile = promptFile;
  }
  const contextPack = createContextPack(workspaceRoot, request, { grokVersion: version.raw });
  const logFile = createJobLogFile(workspaceRoot, jobId, `Grok ${request.workflow} / ${lane}`, env);
  saveJob(workspaceRoot, {
    id: jobId,
    jobClass: "grok-lane",
    kindLabel: `${request.workflow} (${lane})`,
    mode,
    lane,
    title: lane,
    summary: lane,
    workspaceRoot,
    status: "queued",
    phase: "queued",
    write: request.write,
    request,
    contextPack,
    logFile,
    createdAt: new Date().toISOString()
  }, env);
  emitLiveProgress(`Lane ${lane}: ${jobId}`);
  const finished = await runStoredJob(workspaceRoot, jobId, { env, live: !options.json });
  return {
    id: finished.id ?? jobId,
    label: lane,
    status: finished.status,
    structuredOutput: finished.result?.structuredOutput ?? finished.result?.parsedOutput?.structuredOutput ?? null,
    parsedOutput: finished.result?.parsedOutput ?? null,
    rendered: finished.rendered
  };
}

async function runPanel(mode, { options, prompt, lanes, nativeControls, cwd, env, workspaceRoot }) {
  const models = readGrokModels(cwd, env);
  const version = readGrokVersion(cwd, env);
  const gitBefore = readGitStatus(workspaceRoot);
  let diff = null;
  if (mode === "review" || mode === "adversarial-review") {
    diff = readGitDiff(workspaceRoot, { base: options.base || null, staged: options.scope === "staged" });
  }
  const parentId = generateJobId(`${mode}-panel`);
  const logFile = createJobLogFile(workspaceRoot, parentId, `Grok ${mode} panel`, env);
  saveJob(workspaceRoot, {
    id: parentId,
    jobClass: "grok-panel",
    kindLabel: `${mode} panel`,
    mode,
    title: lanes.join(", ").slice(0, 96),
    summary: lanes.join(", ").slice(0, 96),
    workspaceRoot,
    status: "running",
    phase: "panel",
    lanes,
    write: false,
    logFile,
    createdAt: new Date().toISOString()
  }, env);
  emitJobStarted({
    id: parentId,
    kindLabel: `${mode} panel`,
    status: "running"
  });
  const leafResults = [];
  for (const lane of lanes) {
    appendLogLine(logFile, `Lane ${lane}`);
    leafResults.push(await launchLeafJob(mode, {
      options,
      prompt,
      lane,
      nativeControls,
      env,
      workspaceRoot,
      models,
      version,
      gitBefore,
      diff
    }));
  }
  const synthesis = mergeLaneFindings(leafResults);
  const rendered = renderSynthesis(synthesis);
  const parent = saveJob(workspaceRoot, {
    id: parentId,
    jobClass: "grok-panel",
    kindLabel: `${mode} panel`,
    mode,
    title: lanes.join(", ").slice(0, 96),
    summary: synthesis.summary,
    workspaceRoot,
    status: leafResults.every((lane) => ["completed", "completed-with-warnings"].includes(lane.status))
      ? "completed"
      : "completed-with-warnings",
    phase: "done",
    lanes: synthesis.lanes,
    synthesis,
    rendered,
    logFile,
    completedAt: new Date().toISOString()
  }, env);
  if (options.json) {
    output(parent, true);
    return;
  }
  process.stdout.write(rendered);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  refreshStaleJobs(cwd);
  const reference = positionals[0] || "";
  if (options.wait) {
    if (!reference) {
      throw new Error("status --wait requires a job id.");
    }
    const job = await waitForJob(cwd, reference, { timeoutMs: options["timeout-ms"] });
    output(options.json ? job : renderJobStatus(job), Boolean(options.json));
    return;
  }
  if (reference) {
    const job = readFullJob(cwd, reference);
    output(options.json ? job : renderJobStatus(job), Boolean(options.json));
    return;
  }
  const jobs = sortJobsNewestFirst(listJobs(cwd));
  const visible = options.all ? jobs : jobs.slice(0, 20);
  output(
    options.json ? { jobs: visible, truncated: !options.all && jobs.length > visible.length, total: jobs.length } : renderStatusReport(visible),
    Boolean(options.json)
  );
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  refreshStaleJobs(cwd);
  const job = readFullJob(cwd, positionals[0] || "");
  if (options.lane !== undefined && options.lane !== true && options.lane !== false) {
    const lanes = job.lanes ?? job.synthesis?.lanes ?? [];
    const index = Number(options.lane);
    const match = Number.isFinite(index)
      ? lanes[index]
      : lanes.find((entry) => entry.label === options.lane || entry.id === options.lane);
    if (!match?.id) {
      throw new Error(`No lane "${options.lane}" on job ${job.id}.`);
    }
    const leaf = readFullJob(cwd, match.id);
    output(options.json ? leaf : renderStoredJobResult(leaf), Boolean(options.json));
    return;
  }
  output(options.json ? job : renderStoredJobResult(job), Boolean(options.json));
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  const job = await cancelJob(cwd, positionals[0] || "");
  output(options.json ? job : renderStoredJobResult(job), Boolean(options.json));
}

async function handleAwaitResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { stopAtPositional: true });
  const cwd = resolveCwd(options);
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("await-result requires a job id.");
  }
  const job = await waitForJob(cwd, jobId, { timeoutMs: options["timeout-ms"] });
  const lines = [
    `Grok Router job ${job.id} ${job.status}.`,
    `Retrieve output with: grok-router result ${job.id}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

const HANDLERS = {
  setup: handleSetup,
  models: handleModels,
  surface: handleSurface,
  help: handleHelp,
  version: handleVersion,
  analyze: (argv) => handleRouted("analyze", argv),
  exec: (argv) => handleRouted("exec", argv),
  review: (argv) => handleRouted("review", argv),
  "adversarial-review": (argv) => handleRouted("adversarial-review", argv),
  rescue: (argv) => handleRouted("rescue", argv),
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
  cli: handleCli,
  "await-result": handleAwaitResult,
  "internal-run": handleInternalRun
};

async function main(argv) {
  const tokens = [...argv];
  if (!tokens.length || tokens[0] === "--help" || tokens[0] === "-h") {
    process.stdout.write(renderRouterHelp(routerHelpPayload()));
    return;
  }
  if (tokens[0] === "--version" || tokens[0] === "-v") {
    await handleVersion([]);
    return;
  }
  const command = tokens.shift();
  if (hasLeadingHelpFlag(tokens) && command !== "cli") {
    if (["analyze", "exec", "review", "adversarial-review", "rescue"].includes(command)) {
      process.stdout.write(renderRouterHelp(routerHelpPayload()));
      return;
    }
  }
  const handler = HANDLERS[command];
  if (!handler) {
    throw new Error(`Unknown grok-router command "${command}". Try grok-companion.mjs --help.`);
  }
  await handler(tokens);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  buildRouterRequest,
  classifyCliArgs,
  discoverRoutedSurface,
  handleRouted,
  main,
  parseCommandInput,
  parseRoutedInput,
  pluginVersion,
  PUBLIC_COMMANDS
};
