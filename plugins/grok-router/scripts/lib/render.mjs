import fs from "node:fs";
import process from "node:process";
import { isActiveJobStatus, readLogPreview } from "./jobs.mjs";

const PROGRESS_LINE_MAX = 240;

function writeStderr(text) {
  try {
    fs.writeSync(process.stderr.fd ?? 2, text);
  } catch {
    process.stderr.write(text);
  }
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function elapsed(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "";
  }
  return `${Math.max(0, Math.round((end - start) / 1000))}s`;
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok Router Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- grok: ${report.grok.detail}`,
    `- auth: ${report.auth.detail}`,
    `- inspect: ${report.inspect.ok ? `grok ${report.inspect.parsed?.grokVersion ?? "ok"}` : report.inspect.detail}`
  ];
  if (report.load) {
    lines.push(
      `- load: ${report.load.instructionTokens ?? 0} instruction tokens, ${report.load.skills} skills, ${report.load.plugins} plugins, ${report.load.mcpServers} MCP, ${report.load.hooks} hooks`
    );
    for (const item of report.load.instructions ?? []) {
      lines.push(`  - ${item.path ?? "instruction"} (${item.scope ?? "unknown"}, ${item.approxTokens ?? "?"} tokens)`);
    }
  }
  if (report.reviewGate) {
    lines.push(`- review gate: ${report.reviewGate.enabled ? "enabled" : "disabled"}`);
  }
  if (report.nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderStartedJob(job) {
  return [
    `# Grok ${job.kindLabel} Started`,
    "",
    `Job ID: ${job.id}`,
    `Status: ${job.status}`,
    `Result: grok-router result ${job.id}`,
    `Status: grok-router status ${job.id}`,
    `Cancel: grok-router cancel ${job.id}`,
    ""
  ].join("\n");
}

export function emitJobStarted(job) {
  writeStderr(renderStartedJob(job));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const BLOCKING_START = /\b(not logged in|please log in|login required|authentication failed|authentication required|auth required|unauthorized|invalid api key|missing api key|api key is invalid|credentials)\b/i;
const HARNESS_NOISE = /\b(plugin name collision|skill name does not match|MCP server|Skipping MCP tool|Error killing MCP|handshake failed|worker quit with fatal|Transport channel closed|grep timed out)\b/i;

export function hostProgressText(message) {
  return String(message ?? "").replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
}

export function shouldEmitLiveProgress(message) {
  const text = hostProgressText(message);
  if (!text || text === "Grok stdout") {
    return false;
  }
  if (BLOCKING_START.test(text)) {
    return true;
  }
  if (/^\d{4}-\d{2}-\d{2}T\S+\s+(WARN|ERROR|INFO|DEBUG)\b/.test(text) || HARNESS_NOISE.test(text)) {
    return false;
  }
  if (/^Grok pid\b/.test(text) || /^Invoking Grok\b/.test(text)) {
    return false;
  }
  return true;
}

export function stripHostNoise(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => hostProgressText(line))
    .filter((line) => shouldEmitLiveProgress(line))
    .join("\n")
    .trim();
}

export function takeCompleteLines(buffer, chunk) {
  const parts = `${buffer}${chunk}`.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export function emitLiveProgress(message) {
  if (!shouldEmitLiveProgress(message)) {
    return;
  }
  const text = hostProgressText(message);
  const clipped = text.length > PROGRESS_LINE_MAX ? `${text.slice(0, PROGRESS_LINE_MAX - 3)}...` : text;
  writeStderr(`[grok-router] ${clipped}\n`);
}

export function renderStatusReport(jobs) {
  if (!jobs.length) {
    return "No Grok Router jobs found.\n";
  }
  const lines = [
    "| Job | Kind | Status | Phase | Elapsed | Summary | Actions |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const job of jobs) {
    const actions = [`result ${job.id}`];
    if (isActiveJobStatus(job.status)) {
      actions.push(`cancel ${job.id}`);
    }
    lines.push(`| ${escapeCell(job.id)} | ${escapeCell(job.kindLabel)} | ${escapeCell(job.status)} | ${escapeCell(job.phase)} | ${escapeCell(elapsed(job))} | ${escapeCell(job.summary)} | ${escapeCell(actions.join(", "))} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobStatus(job) {
  const lines = [
    `# Grok Job ${job.id}`,
    "",
    `Status: ${job.status}`,
    `Kind: ${job.kindLabel ?? job.mode ?? ""}`,
    `Phase: ${job.phase ?? ""}`,
    `Elapsed: ${elapsed(job)}`
  ];
  if (job.contextPack?.id) {
    lines.push(`Context pack: ${job.contextPack.id}`);
  }
  if (job.grokSessionId) {
    lines.push(`Grok session: ${job.grokSessionId === "unknown" ? "not reported" : job.grokSessionId}`);
  }
  if (job.resumeOf) {
    lines.push(`Resume of: ${job.resumeOf}`);
  }
  if (job.logFile) {
    lines.push("", "Log preview:");
    for (const line of readLogPreview(job.logFile)) {
      lines.push(`- ${line}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job) {
  if (!job) {
    return "Grok Router job not found.\n";
  }
  const lines = [`# Grok Job Result ${job.id}`, "", `Status: ${job.status}`];
  if (job.phase) {
    lines.push(`Phase: ${job.phase}`);
  }
  if (job.result?.failureKind) {
    lines.push(`Failure: ${job.result.failureKind}`);
  }
  if (job.contextPack?.id) {
    lines.push(`Context pack: ${job.contextPack.id}`);
  }
  if (job.logFile) {
    lines.push(`Job log: ${job.logFile}`);
  }
  if (job.grokSessionId && job.grokSessionId !== "unknown") {
    lines.push(`Resume in Grok: grok --resume ${job.grokSessionId}`);
  }
  if (job.resumeOf) {
    lines.push(`Resume of: ${job.resumeOf}`);
  }
  lines.push("", job.rendered || JSON.stringify(job.result ?? {}, null, 2));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSurface(payload) {
  const lines = [
    "# Grok Router Surface",
    "",
    `Grok Router: ${payload.router.version}`,
    `Grok CLI: ${payload.version}`,
    "",
    "Router commands:",
    `- Managed work: ${payload.router.managedWorkTools.join(", ")}`,
    `- Live discovery: ${payload.router.discoveryTools.join(", ")}`,
    `- Job lifecycle: ${payload.router.jobTools.join(", ")}`,
    `- Guarded full surface: ${payload.router.fullSurfaceTools.join(", ")}`,
    "",
    payload.router.note,
    "",
    "Flag coverage (from live `grok --help`):"
  ];
  const byCoverage = { "safe-forward": [], "policy-owned": [], "router-owned": [] };
  for (const flag of payload.coverage.flags) {
    (byCoverage[flag.coverage] ?? (byCoverage[flag.coverage] = [])).push(flag.flag);
  }
  lines.push(`- safe-forward: ${byCoverage["safe-forward"].join(", ") || "(none)"}`);
  lines.push(`- policy-owned: ${byCoverage["policy-owned"].join(", ") || "(none)"}`);
  lines.push(`- router-owned: ${byCoverage["router-owned"].join(", ") || "(none)"}`);
  lines.push("", "Commands (from live help):");
  for (const command of payload.coverage.commands) {
    lines.push(`- ${command.name}: ${command.coverage}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCommandPayload(title, payload) {
  const lines = [`# ${title}`, "", `Status: ${payload.status}${payload.timedOut ? " (timed out)" : ""}`];
  if (payload.stdout) {
    lines.push("", "STDOUT:", "```", payload.stdout.trimEnd(), "```");
  }
  if (payload.stderr) {
    lines.push("", "STDERR:", "```", payload.stderr.trimEnd(), "```");
  }
  if (payload.error) {
    lines.push("", `Error: ${payload.error}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
