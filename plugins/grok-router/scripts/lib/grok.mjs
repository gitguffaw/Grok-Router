import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractVersion } from "./help.mjs";
import { parseGrokModels } from "./models.mjs";
import { binaryAvailable, runCommand, runProcess } from "./process.mjs";
import { stripHostNoise, takeCompleteLines } from "./render.mjs";

export const DEFAULT_MANAGED_TIMEOUT_MS = 30 * 60 * 1000;
export const READ_ONLY_TOOLS = "read_file,grep,list_dir";
export const READ_ONLY_WEB_TOOLS = "read_file,grep,list_dir,web_search,web_fetch";

export function grokBinary(env = process.env) {
  return env.GROK_ROUTER_GROK || "grok";
}

export function grokInvocation(args, env = process.env) {
  const binary = grokBinary(env);
  if (/\.(mjs|js)$/.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

export function grokHome(env = process.env) {
  return env.GROK_HOME || path.join(os.homedir(), ".grok");
}

export function getGrokAvailability(cwd, env = process.env) {
  const invocation = grokInvocation(["--version"], env);
  return binaryAvailable(invocation.command, invocation.args, { cwd, env });
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getGrokAuthStatus(cwd, env = process.env) {
  if (env.XAI_API_KEY || env.GROK_CODE_XAI_API_KEY) {
    return { loggedIn: true, method: "api-key", detail: "XAI_API_KEY is set" };
  }
  const authFile = path.join(grokHome(env), "auth.json");
  if (fs.existsSync(authFile)) {
    return { loggedIn: true, method: "auth.json", detail: `credentials at ${authFile}` };
  }
  const invocation = grokInvocation(["models"], env);
  const models = runCommand(invocation.command, invocation.args, { cwd, env });
  const parsed = parseGrokModels(models.stdout || models.stderr);
  if (parsed.loggedIn) {
    return { loggedIn: true, method: "session", detail: parsed.loginDetail };
  }
  return {
    loggedIn: false,
    method: null,
    detail: (models.stderr || models.stdout || "not logged in").trim()
  };
}

export const DEFAULT_HELP_TIMEOUT_MS = 5000;
const MAX_HELP_BYTES = 256 * 1024;

export function readGrokHelp(cwd, env = process.env, { timeoutMs = DEFAULT_HELP_TIMEOUT_MS } = {}) {
  const invocation = grokInvocation(["--help"], env);
  const result = runCommand(invocation.command, invocation.args, { cwd, env, timeoutMs });
  const stdout = String(result.stdout ?? "");
  const byteLength = Buffer.byteLength(stdout, "utf8");
  const ok = !result.error && result.status === 0 && stdout.trim().length > 0 && byteLength <= MAX_HELP_BYTES;
  return {
    ok,
    text: ok ? stdout : "",
    result
  };
}

export function readGrokVersion(cwd, env = process.env) {
  const invocation = grokInvocation(["--version"], env);
  const result = runCommand(invocation.command, invocation.args, { cwd, env });
  const raw = (result.stdout || result.stderr || "").trim();
  return {
    ok: !result.error && result.status === 0,
    raw,
    version: extractVersion(raw),
    result
  };
}

export function readGrokModels(cwd, env = process.env) {
  const invocation = grokInvocation(["models"], env);
  const result = runCommand(invocation.command, invocation.args, { cwd, env });
  return {
    ok: !result.error && result.status === 0,
    catalog: parseGrokModels(result.stdout || result.stderr || ""),
    raw: result.stdout || result.stderr || "",
    result
  };
}

export function readGrokInspect(cwd, env = process.env) {
  const invocation = grokInvocation(["inspect", "--json"], env);
  const result = runCommand(invocation.command, invocation.args, { cwd, env });
  return {
    ok: !result.error && result.status === 0,
    parsed: parseJsonOrNull(result.stdout),
    raw: result.stdout || result.stderr || "",
    result
  };
}

export function managedTimeoutMs(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_MANAGED_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid timeout "${value}". Use a non-negative millisecond value.`);
  }
  return parsed;
}

function appendValue(args, flag, value) {
  if (value !== null && value !== undefined && value !== false && value !== "") {
    args.push(flag, String(value));
  }
}

export function buildGrokPrintArgs(request) {
  const args = [];
  const controls = request.controls ?? {};
  if (request.promptFile) {
    args.push("--prompt-file", request.promptFile);
  } else {
    args.push("-p", request.prompt);
  }
  args.push("--output-format", request.outputFormat ?? "json");
  appendValue(args, "--cwd", controls.cwd);
  appendValue(args, "-m", controls.model);
  appendValue(args, "--reasoning-effort", controls.effort);
  if (request.write) {
    args.push("--always-approve");
  } else if (request.tools) {
    args.push("--tools", request.tools);
  }
  if (request.disallowedTools) {
    args.push("--disallowed-tools", request.disallowedTools);
  }
  if (request.disableWebSearch) {
    args.push("--disable-web-search");
  }
  if (request.noSubagents) {
    args.push("--no-subagents");
  }
  if (request.noPlan) {
    args.push("--no-plan");
  }
  appendValue(args, "--system-prompt-override", request.systemPromptOverride);
  appendValue(args, "--json-schema", request.jsonSchema);
  if (Array.isArray(request.nativeArgs) && request.nativeArgs.length) {
    args.push(...request.nativeArgs);
  }
  if (controls.resume) {
    args.push("--resume", String(controls.resume));
  }
  if (controls.continue) {
    args.push("--continue");
  }
  return args;
}

export function classifyGrokPrintFailure({ timedOut = false, rawOutput = "", sessionId = null } = {}) {
  const hasOutput = Boolean(String(rawOutput ?? "").trim());
  const hasSession = Boolean(sessionId);
  if (timedOut && (hasSession || hasOutput)) {
    return "killed-in-progress";
  }
  if (timedOut && !hasOutput && !hasSession) {
    return "timed-out-empty";
  }
  if (!hasOutput && !hasSession) {
    return "empty";
  }
  return null;
}

export function extractSessionId(parsed, stdout) {
  if (parsed && typeof parsed.sessionId === "string" && parsed.sessionId) {
    return parsed.sessionId;
  }
  const match = String(stdout ?? "").match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function extractGrokText(parsed, stdout) {
  if (parsed && parsed.structuredOutput && typeof parsed.structuredOutput === "object") {
    return JSON.stringify(parsed.structuredOutput, null, 2);
  }
  if (parsed && typeof parsed.text === "string") {
    return parsed.text;
  }
  return String(stdout ?? "").trim();
}

export function gitStatusChanged(before, after) {
  if (!before?.available || !after?.available) {
    return false;
  }
  return String(before.short ?? "") !== String(after.short ?? "");
}

export function summarizeInspect(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const instructions = Array.isArray(parsed.projectInstructions)
    ? parsed.projectInstructions.map((item) => ({
      path: item.path ?? null,
      scope: item.scope ?? null,
      approxTokens: Number.isFinite(item.approxTokens) ? item.approxTokens : null
    }))
    : [];
  const instructionTokens = instructions.reduce((sum, item) => sum + (item.approxTokens ?? 0), 0);
  return {
    grokVersion: parsed.grokVersion ?? null,
    instructionTokens,
    instructions,
    skills: Array.isArray(parsed.skills) ? parsed.skills.length : 0,
    plugins: Array.isArray(parsed.plugins) ? parsed.plugins.length : 0,
    mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers.length : 0,
    hooks: Array.isArray(parsed.hooks) ? parsed.hooks.length : 0
  };
}

export async function runGrokPrintJob(cwd, request, options = {}) {
  const env = { ...(options.env ?? process.env), ...(request.extraEnv ?? {}) };
  const args = buildGrokPrintArgs(request);
  const timeoutMs = managedTimeoutMs(options.timeoutMs ?? request.controls?.timeoutMs);
  const invocation = grokInvocation(args, env);
  let stderrLine = "";
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    env,
    timeoutMs,
    detached: options.detached,
    onSpawn: options.onSpawn,
    onStdout: (chunk) => options.onProgress?.({ message: "Grok stdout", logBody: chunk }),
    onStderr: (chunk) => {
      options.onProgress?.({ logBody: chunk });
      const taken = takeCompleteLines(stderrLine, chunk);
      stderrLine = taken.rest;
      for (const line of taken.lines) {
        options.onProgress?.({ message: line });
      }
    }
  });
  if (stderrLine.trim()) {
    options.onProgress?.({ message: stderrLine });
  }
  const parsed = parseJsonOrNull(result.stdout?.trim?.() ? result.stdout.trim() : result.stdout);
  const sessionId = extractSessionId(parsed, result.stdout);
  const text = extractGrokText(parsed, result.stdout);
  const failureKind = classifyGrokPrintFailure({
    timedOut: Boolean(result.timedOut),
    rawOutput: text,
    sessionId
  });
  const gitAfter = options.readGitStatus?.() ?? null;
  const warnings = [];
  if (!request.write && gitStatusChanged(request.gitBefore, gitAfter)) {
    warnings.push("Read-only Grok route changed git status.");
  }
  const exitStatus = result.error ? 1 : (result.status ?? 1);
  const hostStderr = stripHostNoise(result.stderr);
  const jobStatus = result.timedOut
    ? "failed"
    : exitStatus === 0
      ? (warnings.length ? "completed-with-warnings" : "completed")
      : "failed";
  return {
    exitStatus,
    jobStatus,
    phase: result.timedOut ? "timed-out" : jobStatus === "completed" || jobStatus === "completed-with-warnings" ? "done" : "failed",
    grokSessionId: sessionId,
    payload: {
      mode: request.mode,
      workflow: request.workflow,
      command: invocation.command,
      args,
      timedOut: Boolean(result.timedOut),
      signal: result.signal,
      rawOutput: text,
      parsedOutput: parsed,
      structuredOutput: parsed?.structuredOutput ?? null,
      stderr: result.stderr,
      failureKind,
      sessionId,
      gitAfter
    },
    rendered: [
      text || hostStderr || (result.error ? result.error.message : `Grok exited ${exitStatus} with no result.`),
      warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : ""
    ].join("").trimEnd(),
    warnings
  };
}
