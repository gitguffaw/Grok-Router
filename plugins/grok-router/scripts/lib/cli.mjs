import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { splitRawArgumentString } from "./args.mjs";
import {
  extractGrokText,
  extractSessionId,
  grokInvocation,
  managedTimeoutMs,
  READ_ONLY_TOOLS,
  READ_ONLY_WEB_TOOLS,
  readGrokHelp
} from "./grok.mjs";
import { parseGrokHelp } from "./help.mjs";
import { ROUTER_OWNED_OPTIONS } from "./live-controls.mjs";
import { appendLogLine, createJobLogFile, listJobs, runTrackedJob, sortJobsNewestFirst } from "./jobs.mjs";
import { runProcess } from "./process.mjs";
import { emitJobStarted } from "./render.mjs";
import { generateJobId, readJobFile, saveJob } from "./state.mjs";
import { resolveCwd, resolveWorkspaceRoot } from "./workspace.mjs";

const CLI_REJECTED_ROUTER_OPTIONS = new Set([
  "base", "scope", "tool", "lanes", "lane", "json", "background", "wait", "best",
  "lean", "full", "search", "docs", "parallel", "panel", "all", "write", "fresh",
  "resume-last", "enable-review-gate", "disable-review-gate", "raw-arg-string", "timeout"
]);

const MUTATING_COMMANDS = new Set([
  "login", "logout", "plugin", "mcp", "setup", "update", "memory", "worktree", "clone"
]);

const READ_ONLY_CLI_SUBCOMMANDS = new Set([
  "agent", "completions", "cursor-worker", "dashboard", "doctor", "du", "disk-usage",
  "export", "help", "inspect", "leader", "models", "sessions", "trace", "usage",
  "version", "v", "wrap"
]);

const FALLBACK_CLI_GRAMMAR = {
  valueFlags: [
    "--agent", "--agents", "--allow", "--allowedTools", "--allowed-tools", "--cwd",
    "--debug-file", "--deny", "--disallowed-tools", "--disallowedTools", "--json-schema",
    "--leader-socket", "-m", "--model", "--max-turns", "--output-format", "-p", "--single",
    "--permission-mode", "--prompt-file", "--prompt-json", "--reasoning-effort", "--effort",
    "--rules", "-s", "--session-id", "--sandbox", "--system-prompt-override", "--system-prompt",
    "--tools", "--worktree-ref", "--ref"
  ],
  optionalValueFlags: ["-r", "--resume", "-w", "--worktree"],
  booleanFlags: [
    "--always-approve", "-c", "--continue", "--debug", "--disable-web-search", "--fork-session",
    "--fullscreen", "-h", "--help", "--include-partial-messages", "--minimal", "--no-alt-screen",
    "--no-plan", "--no-subagents", "--oauth", "--restore-code", "-v", "--version", "--verbatim", "--yolo"
  ],
  canonicalPairs: [
    ["--allowedTools", "--allow"], ["--allowed-tools", "--allow"], ["-c", "--continue"],
    ["--disallowedTools", "--deny"], ["-h", "--help"], ["-m", "--model"], ["-p", "--single"],
    ["-r", "--resume"], ["--effort", "--reasoning-effort"], ["-s", "--session-id"],
    ["--system-prompt", "--system-prompt-override"], ["-v", "--version"], ["-w", "--worktree"],
    ["--ref", "--worktree-ref"]
  ],
  commands: [
    "agent", "clone", "completions", "cursor-worker", "dashboard", "doctor", "du", "disk-usage",
    "export", "help", "inspect", "leader", "login", "logout", "mcp", "memory", "models", "plugin",
    "sessions", "setup", "trace", "update", "usage", "version", "v", "worktree", "wrap"
  ]
};

const READ_ONLY_TOOL_NAMES = new Set(
  `${READ_ONLY_TOOLS},${READ_ONLY_WEB_TOOLS}`.split(",").map((item) => item.trim()).filter(Boolean)
);

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function classifyCliToolsWrite(tools) {
  if (tools === null || tools === undefined) {
    return "unknown";
  }
  const entries = String(tools).split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.length) {
    return false;
  }
  return entries.some((entry) => !READ_ONLY_TOOL_NAMES.has(entry));
}

export function buildCliGrammar(helpInput = "") {
  const helpAvailable = typeof helpInput === "object" && helpInput !== null
    ? Boolean(helpInput.ok && String(helpInput.text ?? "").trim())
    : Boolean(String(helpInput ?? "").trim());
  const helpText = typeof helpInput === "object" && helpInput !== null
    ? (helpAvailable ? String(helpInput.text ?? "") : "")
    : String(helpInput ?? "");

  const valueFlags = new Set(FALLBACK_CLI_GRAMMAR.valueFlags);
  const optionalValueFlags = new Set(FALLBACK_CLI_GRAMMAR.optionalValueFlags);
  const booleanFlags = new Set(FALLBACK_CLI_GRAMMAR.booleanFlags);
  const variadicFlags = new Set();
  const canonicalFlag = new Map(FALLBACK_CLI_GRAMMAR.canonicalPairs);
  for (const name of [...valueFlags, ...optionalValueFlags, ...booleanFlags]) {
    if (!canonicalFlag.has(name)) {
      canonicalFlag.set(name, name);
    }
  }
  const commandNames = new Set(FALLBACK_CLI_GRAMMAR.commands);

  function setArity(name, kind, isVariadic = false) {
    valueFlags.delete(name);
    optionalValueFlags.delete(name);
    booleanFlags.delete(name);
    if (kind === "value") {
      valueFlags.add(name);
    } else if (kind === "optional-value") {
      optionalValueFlags.add(name);
    } else {
      booleanFlags.add(name);
    }
    if (isVariadic) {
      variadicFlags.add(name);
    } else {
      variadicFlags.delete(name);
    }
  }

  if (helpAvailable) {
    const parsed = parseGrokHelp(helpText);
    for (const command of parsed.commands) {
      if (command.name) {
        commandNames.add(command.name);
      }
      for (const alias of command.aliases ?? []) {
        commandNames.add(alias);
      }
    }
    for (const flag of parsed.flags) {
      const canonical = flag.long ?? flag.short ?? flag.names?.[0] ?? null;
      const kind = flag.requiresValue ? "value" : flag.optionalValue ? "optional-value" : "boolean";
      for (const name of flag.names ?? []) {
        if (!name) {
          continue;
        }
        setArity(name, kind, Boolean(flag.variadic));
        if (canonical) {
          canonicalFlag.set(name, canonical);
        }
      }
    }
  }

  return {
    valueFlags,
    optionalValueFlags,
    booleanFlags,
    variadicFlags,
    canonicalFlag,
    commandNames,
    mutatingCommands: MUTATING_COMMANDS,
    helpAvailable
  };
}

function makeToken(kind, raw, { name = null, canonical = null, value = null, inline = false, passthroughIndex = 0, passthroughValueIndex = null } = {}) {
  return { kind, raw, name, canonical, value, inline, passthroughIndex, passthroughValueIndex };
}

function rejectionError(key, grammar) {
  const suffix = grammar && !grammar.helpAvailable
    ? " (grok --help was unavailable; parsed using fallback CLI grammar)"
    : "";
  return new Error(
    `--${key} is a router option and is not supported on cli. Pass native grok flags (or use analyze, exec, review, adversarial-review, or rescue).${suffix}`
  );
}

function routerOptionKey(token) {
  if (token === "-C") {
    return "cwd";
  }
  if (!token.startsWith("--") || token === "--") {
    return null;
  }
  const body = token.slice(2);
  const eq = body.indexOf("=");
  const key = eq === -1 ? body : body.slice(0, eq);
  return key || null;
}

function isRouterControlledKey(key) {
  return CLI_REJECTED_ROUTER_OPTIONS.has(key) || ROUTER_OWNED_OPTIONS.has(key);
}

function isConsumedRouterForm(token, key, inOptionPosition) {
  if (!inOptionPosition) {
    return false;
  }
  if (key === "cwd" && (token === "--cwd" || token === "-C" || token.startsWith("--cwd="))) {
    return true;
  }
  if (key === "timeout-ms" && (token === "--timeout-ms" || token.startsWith("--timeout-ms="))) {
    return true;
  }
  if ((key === "allow-mutating" || key === "allow-dangerous") && (token === `--${key}` || token.startsWith(`--${key}=`))) {
    return true;
  }
  return false;
}

function normalizeCliArgv(argv) {
  if (argv[0] === "--raw-arg-string" && argv.length === 2) {
    return splitRawArgumentString(argv[1]);
  }
  return argv;
}

export function tokenizeCliArgv(argv, grammar, { rejectRouterFlags = true } = {}) {
  const rawTokens = normalizeCliArgv(argv);
  const routerOptions = {};
  const passthroughArgs = [];
  const tokens = [];
  let inOptionPosition = true;

  function consumeSeparateFlagValue(token, flagName, canonical, passthroughIndex, currentIdx, { allowRewrite = true } = {}) {
    const next = rawTokens[currentIdx + 1];
    if (grammar.valueFlags.has(flagName)) {
      if (next === undefined) {
        tokens.push(makeToken("option", token, { name: flagName, canonical, value: null, passthroughIndex }));
        return currentIdx;
      }
      if (grammar.variadicFlags.has(flagName)) {
        const values = [];
        let firstValIdx = null;
        let cursor = currentIdx;
        while (cursor + 1 < rawTokens.length) {
          const candidate = String(rawTokens[cursor + 1] ?? "");
          if (candidate === "--" || (values.length > 0 && candidate.startsWith("-"))) {
            break;
          }
          const idx = passthroughArgs.length;
          if (firstValIdx === null) {
            firstValIdx = idx;
          }
          passthroughArgs.push(candidate);
          values.push(candidate);
          cursor += 1;
        }
        tokens.push(makeToken("option", token, {
          name: flagName,
          canonical,
          value: values.length === 1 ? values[0] : values,
          passthroughIndex,
          passthroughValueIndex: allowRewrite ? firstValIdx : null
        }));
        return cursor;
      }
      const valIdx = passthroughArgs.length;
      passthroughArgs.push(String(next));
      tokens.push(makeToken("option", token, {
        name: flagName,
        canonical,
        value: String(next),
        passthroughIndex,
        passthroughValueIndex: allowRewrite ? valIdx : null
      }));
      return currentIdx + 1;
    }
    if (grammar.optionalValueFlags.has(flagName) && next !== undefined && !String(next).startsWith("-")) {
      if (grammar.variadicFlags.has(flagName)) {
        const vals = [];
        let cursor = currentIdx;
        while (cursor + 1 < rawTokens.length) {
          const candidate = String(rawTokens[cursor + 1] ?? "");
          if (candidate === "--" || candidate.startsWith("-")) {
            break;
          }
          cursor += 1;
          passthroughArgs.push(candidate);
          vals.push(candidate);
        }
        tokens.push(makeToken("option", token, {
          name: flagName,
          canonical,
          value: vals.join(" "),
          passthroughIndex
        }));
        return cursor;
      }
      const valIdx = passthroughArgs.length;
      passthroughArgs.push(String(next));
      tokens.push(makeToken("option", token, {
        name: flagName,
        canonical,
        value: String(next),
        passthroughIndex,
        passthroughValueIndex: allowRewrite ? valIdx : null
      }));
      return currentIdx + 1;
    }
    tokens.push(makeToken("option", token, { name: flagName, canonical, value: true, passthroughIndex }));
    return currentIdx;
  }

  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = String(rawTokens[i] ?? "");
    const next = rawTokens[i + 1];

    if (token === "--") {
      const passthroughIndex = passthroughArgs.length;
      passthroughArgs.push("--");
      tokens.push(makeToken("separator", "--", { passthroughIndex }));
      for (let j = i + 1; j < rawTokens.length; j += 1) {
        const posToken = String(rawTokens[j] ?? "");
        const posIdx = passthroughArgs.length;
        passthroughArgs.push(posToken);
        tokens.push(makeToken("positional", posToken, { passthroughIndex: posIdx }));
      }
      break;
    }

    const routerKey = routerOptionKey(token);
    if (rejectRouterFlags && routerKey && isRouterControlledKey(routerKey) && !isConsumedRouterForm(token, routerKey, inOptionPosition)) {
      throw rejectionError(routerKey, grammar);
    }

    if (!inOptionPosition) {
      const posIdx = passthroughArgs.length;
      passthroughArgs.push(token);
      tokens.push(makeToken("positional", token, { passthroughIndex: posIdx }));
      continue;
    }

    if (token === "--cwd" || token === "-C") {
      if (next === undefined) {
        throw new Error(`Missing value for ${token}`);
      }
      routerOptions.cwd = String(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      routerOptions.cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token === "--timeout-ms") {
      if (next === undefined) {
        throw new Error("Missing value for --timeout-ms");
      }
      routerOptions["timeout-ms"] = String(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--timeout-ms=")) {
      routerOptions["timeout-ms"] = token.slice("--timeout-ms=".length);
      continue;
    }
    if (token === "--allow-mutating" || token === "--allow-dangerous") {
      routerOptions[token.slice(2)] = true;
      continue;
    }
    if (token.startsWith("--allow-mutating=") || token.startsWith("--allow-dangerous=")) {
      const [rawKey, val] = token.slice(2).split("=", 2);
      routerOptions[rawKey] = val !== "false";
      continue;
    }

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const flagName = eqIdx === -1 ? token : token.slice(0, eqIdx);
      const inlineVal = eqIdx === -1 ? undefined : token.slice(eqIdx + 1);
      const key = flagName.slice(2);
      if (rejectRouterFlags && CLI_REJECTED_ROUTER_OPTIONS.has(key)) {
        throw rejectionError(key, grammar);
      }
      const known = grammar.valueFlags.has(flagName) || grammar.optionalValueFlags.has(flagName) || grammar.booleanFlags.has(flagName);
      const canonical = known ? (grammar.canonicalFlag.get(flagName) ?? flagName) : null;
      const passthroughIndex = passthroughArgs.length;
      passthroughArgs.push(token);
      if (!known) {
        tokens.push(makeToken("option", token, {
          name: flagName,
          canonical: null,
          value: inlineVal !== undefined ? inlineVal : true,
          inline: inlineVal !== undefined,
          passthroughIndex
        }));
      } else if (inlineVal !== undefined) {
        tokens.push(makeToken("option", token, {
          name: flagName,
          canonical,
          value: inlineVal,
          inline: true,
          passthroughIndex,
          passthroughValueIndex: passthroughIndex
        }));
      } else {
        i = consumeSeparateFlagValue(token, flagName, canonical, passthroughIndex, i);
      }
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const passthroughIndex = passthroughArgs.length;
      passthroughArgs.push(token);
      if (token.length === 2) {
        const known = grammar.valueFlags.has(token) || grammar.optionalValueFlags.has(token) || grammar.booleanFlags.has(token);
        if (!known) {
          tokens.push(makeToken("option", token, {
            name: token,
            canonical: null,
            value: true,
            passthroughIndex
          }));
          continue;
        }
        const canonical = grammar.canonicalFlag.get(token) ?? token;
        i = consumeSeparateFlagValue(token, token, canonical, passthroughIndex, i);
        continue;
      }

      const body = token.slice(1);
      const provisional = [];
      let committed = false;
      for (let pos = 0; pos < body.length; pos += 1) {
        const shortFlag = `-${body[pos]}`;
        const rest = body.slice(pos + 1);
        const canonical = grammar.canonicalFlag.get(shortFlag) ?? shortFlag;

        if (grammar.booleanFlags.has(shortFlag)) {
          if (rest.startsWith("=")) {
            provisional.length = 0;
            tokens.push(makeToken("option", token, { name: token, canonical: null, value: true, inline: true, passthroughIndex }));
            committed = true;
            break;
          }
          provisional.push(makeToken("option", token, { name: shortFlag, canonical, value: true, inline: true, passthroughIndex }));
          continue;
        }

        if (grammar.valueFlags.has(shortFlag) || grammar.optionalValueFlags.has(shortFlag)) {
          tokens.push(...provisional);
          provisional.length = 0;
          committed = true;
          if (rest.length > 0) {
            const attachedVal = rest.startsWith("=") ? rest.slice(1) : rest;
            tokens.push(makeToken("option", token, {
              name: shortFlag,
              canonical,
              value: attachedVal,
              inline: true,
              passthroughIndex
            }));
          } else {
            i = consumeSeparateFlagValue(token, shortFlag, canonical, passthroughIndex, i, { allowRewrite: false });
          }
          break;
        }

        provisional.length = 0;
        tokens.push(makeToken("option", token, { name: token, canonical: null, value: true, inline: true, passthroughIndex }));
        committed = true;
        break;
      }
      if (!committed && provisional.length > 0) {
        tokens.push(...provisional);
      }
      continue;
    }

    const passthroughIndex = passthroughArgs.length;
    passthroughArgs.push(token);
    tokens.push(makeToken("positional", token, { passthroughIndex }));
    if (grammar.commandNames.has(token)) {
      inOptionPosition = false;
    }
  }

  return { routerOptions, passthroughArgs, tokens };
}

export function classifyCliTokens(tokens, grammar) {
  let firstPositionalIndex = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind === "separator") {
      break;
    }
    if (tokens[i].kind === "positional") {
      firstPositionalIndex = i;
      break;
    }
  }
  const firstPositional = firstPositionalIndex !== -1 ? tokens[firstPositionalIndex].raw : null;
  const firstToken = tokens[0]?.raw;
  const hasOpaqueOption = tokens.some(
    (token) => token.kind === "option" && token.canonical === null
  );
  const hasTopLevelHelpOption = !hasOpaqueOption && tokens.some(
    (token) => token.kind === "option" && (token.canonical === "--help" || token.name === "--help" || token.name === "-h")
  );
  let hasSubcommandHelpOnly = false;
  if (!hasOpaqueOption && firstPositional && grammar.commandNames.has(firstPositional)) {
    const afterSubcommand = [];
    let sawSeparator = false;
    for (let i = firstPositionalIndex + 1; i < tokens.length; i += 1) {
      if (tokens[i].kind === "separator") {
        sawSeparator = true;
        break;
      }
      afterSubcommand.push(tokens[i].raw);
    }
    if (!sawSeparator && afterSubcommand.length > 0) {
      const hasHelpFlag = afterSubcommand.some((arg) => arg === "--help" || arg === "-h");
      const allSafeSubcommandTokens = afterSubcommand.every(
        (arg) => arg === "--help" || arg === "-h" || !arg.startsWith("-")
      );
      hasSubcommandHelpOnly = hasHelpFlag && allSafeSubcommandTokens;
    }
  }
  const helpOnly = !hasOpaqueOption && (hasTopLevelHelpOption || firstPositional === "help" || hasSubcommandHelpOnly);
  const subcommandCandidate = firstPositional && grammar.commandNames.has(firstPositional)
    ? firstPositional
    : firstToken;
  const mutating = !helpOnly && Boolean(subcommandCandidate && grammar.mutatingCommands.has(subcommandCandidate));
  const unclassified = !helpOnly && Boolean(
    firstToken &&
    !grammar.commandNames.has(firstToken) &&
    !String(firstToken).startsWith("-") &&
    firstPositional === firstToken
  );
  return { helpOnly, mutating, unclassified, first: firstToken };
}

export function isUntrackedCliAllowList(tokens, grammar) {
  if (!tokens.length || tokens.some((token) => token.kind === "separator")) {
    return false;
  }
  if (tokens.some((token) => token.kind === "option" && token.canonical === null)) {
    return false;
  }
  const raw = tokens.map((token) => token.raw);
  if (raw.length === 1 && (raw[0] === "--help" || raw[0] === "-h")) {
    const token = tokens[0];
    return token.kind === "option" && (token.canonical === "--help" || token.name === "--help" || token.name === "-h");
  }
  if (
    raw.length === 1 &&
    grammar.commandNames.has(raw[0]) &&
    READ_ONLY_CLI_SUBCOMMANDS.has(raw[0])
  ) {
    return true;
  }
  if (!grammar.commandNames.has(raw[0])) {
    return false;
  }
  const rest = raw.slice(1);
  if (!rest.length) {
    return false;
  }
  const helpCount = rest.filter((token) => token === "--help" || token === "-h").length;
  if (helpCount < 1) {
    return false;
  }
  return rest.every((token) => token === "--help" || token === "-h" || !token.startsWith("-"));
}

export function classifyCliArgs(args, helpText = "") {
  const grammar = buildCliGrammar(helpText);
  const { tokens } = tokenizeCliArgv(args, grammar, { rejectRouterFlags: false });
  return classifyCliTokens(tokens, grammar);
}

export function extractCliMetadataFromTokens(tokens, cwd, grammar) {
  let resume = null;
  let resumeToken = null;
  let hasResumeFlag = false;
  let hasContinueFlag = false;
  let hasForkFlag = false;
  let hasAutoApproveFlag = false;
  let hasOpaqueOption = false;
  let prompt = null;
  let promptFile = null;
  let model = null;
  let effort = null;
  let tools = null;
  const positionalTokens = [];

  for (const token of tokens) {
    if (token.kind === "separator") {
      continue;
    }
    if (token.kind === "positional") {
      positionalTokens.push(token.raw);
      continue;
    }
    if (token.kind === "option") {
      const canonical = token.canonical;
      const val = token.value;
      if (canonical === null) {
        hasOpaqueOption = true;
      } else if (canonical === "--resume") {
        hasResumeFlag = true;
        resume = val !== null && val !== undefined ? val : true;
        resumeToken = token;
      } else if (canonical === "--continue") {
        hasContinueFlag = true;
      } else if (canonical === "--fork-session") {
        hasForkFlag = true;
      } else if (canonical === "--always-approve" || canonical === "--yolo") {
        hasAutoApproveFlag = true;
      } else if (canonical === "--single" && typeof val === "string") {
        prompt = val;
      } else if (canonical === "--prompt-file" && typeof val === "string") {
        promptFile = val;
      } else if (canonical === "--model" && typeof val === "string") {
        model = val;
      } else if (canonical === "--reasoning-effort" && typeof val === "string") {
        effort = val;
      } else if (canonical === "--tools" && typeof val === "string") {
        tools = val;
      }
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

  if (prompt === null && positionalTokens.length && !grammar.commandNames.has(positionalTokens[0])) {
    prompt = positionalTokens.join(" ");
  }

  const hasPromptOrResume = Boolean(
    prompt !== null ||
    resolvedPromptFile ||
    hasResumeFlag ||
    hasContinueFlag ||
    (hasOpaqueOption && (!positionalTokens.length || !grammar.commandNames.has(positionalTokens[0])))
  );

  return {
    resume,
    resumeToken,
    hasResumeFlag,
    hasForkFlag,
    hasOpaqueOption,
    hasPromptOrResume,
    prompt,
    promptFile: resolvedPromptFile,
    model,
    effort,
    tools,
    hasAutoApproveFlag,
    continue: hasContinueFlag
  };
}

export function rewriteResumeArg(passthroughArgs, resumeToken, sessionId) {
  const args = [...passthroughArgs];
  if (!resumeToken || resumeToken.passthroughValueIndex === null || resumeToken.passthroughValueIndex === undefined) {
    return args;
  }
  if (resumeToken.inline) {
    args[resumeToken.passthroughValueIndex] = `${resumeToken.name}=${sessionId}`;
  } else {
    args[resumeToken.passthroughValueIndex] = sessionId;
  }
  return args;
}

const SUCCESSFUL_JOB_STATUSES = new Set(["completed", "completed-with-warnings"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function effectiveExecutionCwd(job) {
  if (job?.executionCwd) {
    return path.resolve(job.executionCwd);
  }
  if (job?.mode === "cli") {
    return path.resolve(job.cwd ?? job.workspaceRoot ?? process.cwd());
  }
  return path.resolve(job?.workspaceRoot ?? job?.cwd ?? process.cwd());
}

function compareCandidatesNewestFirst(left, right) {
  const leftDone = Date.parse(left.completedAt ?? left.updatedAt ?? "");
  const rightDone = Date.parse(right.completedAt ?? right.updatedAt ?? "");
  if (Number.isFinite(leftDone) && Number.isFinite(rightDone) && leftDone !== rightDone) {
    return rightDone - leftDone;
  }
  const leftCreated = Date.parse(left.createdAt ?? "");
  const rightCreated = Date.parse(right.createdAt ?? "");
  if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
    return rightCreated - leftCreated;
  }
  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

function isEligibleParentJob(job) {
  if (!job) {
    return false;
  }
  if (job.jobClass) {
    return job.jobClass === "grok";
  }
  return !job.lane && !Array.isArray(job.lanes) && !String(job.id ?? "").includes("-lane-") && !String(job.id ?? "").includes("-panel-");
}

function matchesSessionNonContradictory(job, sessionId) {
  if (!job || !sessionId) {
    return false;
  }
  if (job.grokSessionId === sessionId) {
    return true;
  }
  if ((!job.grokSessionId || job.grokSessionId === "unknown") && UUID_RE.test(sessionId) && job.request?.controls?.resume === sessionId) {
    return true;
  }
  return false;
}

export function findPriorJobForResume(workspaceRoot, target, env = process.env) {
  if (!target || target === true) {
    return null;
  }
  const ref = String(target).trim();
  if (!ref) {
    return null;
  }
  const jobs = listJobs(workspaceRoot, env).sort(compareCandidatesNewestFirst);
  const byId = jobs.find((job) => job.id === ref);
  if (byId) {
    return byId;
  }
  if (!UUID_RE.test(ref)) {
    return null;
  }
  return (
    jobs.find((job) => isEligibleParentJob(job) && SUCCESSFUL_JOB_STATUSES.has(job.status) && matchesSessionNonContradictory(job, ref)) ??
    null
  );
}

export function findPriorJobForContinue(workspaceRoot, executionCwd, env = process.env) {
  const normalizedCwd = path.resolve(executionCwd);
  const jobs = listJobs(workspaceRoot, env).sort(compareCandidatesNewestFirst);
  return (
    jobs.find(
      (job) =>
        isEligibleParentJob(job) &&
        SUCCESSFUL_JOB_STATUSES.has(job.status) &&
        Boolean(job.grokSessionId && job.grokSessionId !== "unknown") &&
        effectiveExecutionCwd(job) === normalizedCwd
    ) ??
    null
  );
}

export function resolveKnownSessionId(workspaceRoot, job, env = process.env) {
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

function wouldFormCycle(candidate, currentJobId, jobById) {
  const visited = new Set([currentJobId]);
  let cursor = candidate;
  while (cursor) {
    if (visited.has(cursor.id)) {
      return true;
    }
    visited.add(cursor.id);
    cursor = cursor.resumeOf ? jobById.get(cursor.resumeOf) ?? null : null;
  }
  return false;
}

export function reconcileCompletedResumeOf(workspaceRoot, currentJob, execution, env = process.env) {
  if (!currentJob || !SUCCESSFUL_JOB_STATUSES.has(execution?.jobStatus)) {
    return currentJob?.resumeOf ?? null;
  }
  if (!currentJob.linkage || currentJob.linkage === "fork") {
    return currentJob.resumeOf ?? null;
  }
  const reportedSessionId = typeof execution.payload?.parsedOutput?.sessionId === "string"
    ? execution.payload.parsedOutput.sessionId.trim()
    : null;
  if (!reportedSessionId) {
    return currentJob.resumeOf ?? null;
  }
  const allJobs = listJobs(workspaceRoot, env);
  const jobById = new Map(allJobs.map((job) => [job.id, job]));
  const upperBoundMs = Date.parse(currentJob.startedAt ?? currentJob.createdAt ?? "");
  const matching = allJobs
    .filter((cand) => {
      if (cand.id === currentJob.id || !isEligibleParentJob(cand) || !SUCCESSFUL_JOB_STATUSES.has(cand.status)) {
        return false;
      }
      const candDoneMs = Date.parse(cand.completedAt ?? cand.updatedAt ?? "");
      if (Number.isFinite(upperBoundMs) && Number.isFinite(candDoneMs) && candDoneMs > upperBoundMs) {
        return false;
      }
      if (!matchesSessionNonContradictory(cand, reportedSessionId)) {
        return false;
      }
      return !wouldFormCycle(cand, currentJob.id, jobById);
    })
    .sort(compareCandidatesNewestFirst);
  const bestId = matching[0]?.id ?? null;
  if (currentJob.resumeOf && currentJob.resumeOf === bestId) {
    return currentJob.resumeOf;
  }
  return bestId;
}

export async function handleCli(argv, { runProcessImpl = runProcess } = {}) {
  const env = process.env;
  const help = readGrokHelp(process.cwd(), env);
  const grammar = buildCliGrammar(help);
  const { routerOptions, passthroughArgs, tokens } = tokenizeCliArgv(argv, grammar, { rejectRouterFlags: true });
  const cwd = resolveCwd(routerOptions);
  if (!passthroughArgs.length) {
    throw new Error("Provide Grok CLI arguments, for example: grok-router cli --help");
  }
  if (passthroughArgs[0] === "grok") {
    throw new Error("Do not include the grok binary name; provide only Grok CLI args.");
  }
  const classification = classifyCliTokens(tokens, grammar);
  if (classification.mutating && !routerOptions["allow-mutating"]) {
    throw new Error("Raw Grok command may mutate configuration or install state. Re-run with --allow-mutating only when the user explicitly requested this action.");
  }
  if (classification.unclassified && !routerOptions["allow-mutating"]) {
    throw new Error("Raw Grok command is not classified yet. Re-run with --allow-mutating when the user explicitly requested it, or pass a known grok subcommand.");
  }
  const timeoutMs = routerOptions["timeout-ms"] !== undefined && routerOptions["timeout-ms"] !== null && routerOptions["timeout-ms"] !== ""
    ? managedTimeoutMs(routerOptions["timeout-ms"])
    : 0;
  const meta = extractCliMetadataFromTokens(tokens, cwd, grammar);
  if (isUntrackedCliAllowList(tokens, grammar)) {
    const invocation = grokInvocation(passthroughArgs, env);
    const result = await runProcessImpl(invocation.command, invocation.args, { cwd, env, timeoutMs });
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
  const linkage = (meta.hasResumeFlag || meta.continue)
    ? (meta.hasForkFlag ? "fork" : (meta.resume && meta.resume !== true ? "resume" : "continue"))
    : null;
  const priorJob = meta.resume && meta.resume !== true
    ? findPriorJobForResume(workspaceRoot, meta.resume, env)
    : (meta.continue ? findPriorJobForContinue(workspaceRoot, cwd, env) : null);
  const resumedByJobId = Boolean(priorJob && meta.resume === priorJob.id);
  if (resumedByJobId && (!meta.resumeToken || meta.resumeToken.passthroughValueIndex === null || meta.resumeToken.passthroughValueIndex === undefined)) {
    throw new Error(`Router job ID "${priorJob.id}" cannot be translated inside "${meta.resumeToken?.raw ?? "-r"}". Pass standalone -r ${priorJob.id} or --resume ${priorJob.id}.`);
  }
  const priorSessionId = resumedByJobId ? resolveKnownSessionId(workspaceRoot, priorJob, env) : null;
  if (resumedByJobId && !priorSessionId) {
    throw new Error(`Job ${priorJob.id} has no known Grok session.`);
  }
  const resumeSessionId = resumedByJobId
    ? priorSessionId
    : (meta.resume && meta.resume !== true ? meta.resume : null);
  const args = resumedByJobId && priorSessionId
    ? rewriteResumeArg(passthroughArgs, meta.resumeToken, priorSessionId)
    : passthroughArgs;
  const resumeOf = priorJob?.id ?? null;
  const userRequest = (meta.prompt ?? args.join(" ")).trim();
  const write = (meta.hasAutoApproveFlag || Boolean(classification.mutating))
    ? true
    : (meta.hasOpaqueOption ? "unknown" : classifyCliToolsWrite(meta.tools));
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
    cwd,
    executionCwd: cwd,
    workspaceRoot,
    status: "queued",
    phase: "queued",
    write,
    request,
    linkage,
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
    const result = await runProcessImpl(invocation.command, invocation.args, {
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
    const sessionId = parsedSessionId ?? (jobStatus === "completed" ? "unknown" : null);
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
  }, {
    env,
    trackChildProcess: true,
    reconcileResumeOf: (current, execution) => reconcileCompletedResumeOf(workspaceRoot, current, execution, env)
  });

  if (rawResult?.stdout) {
    process.stdout.write(rawResult.stdout);
  }
  if (rawResult?.stderr) {
    process.stderr.write(rawResult.stderr);
  }
  process.exitCode = rawResult?.status ?? 1;
}
