import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_STOP_HARD_TIMEOUT_MS = 8000;
const DEFAULT_STOP_POLL_MS = 50;

export function runCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    command,
    args,
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
    timedOut
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { available: false, detail: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { available: true, detail: (result.stdout || result.stderr || "ok").trim() };
}

export function getProcessStartTime(pid, options = {}) {
  if (!Number.isFinite(pid) || process.platform === "win32") {
    return null;
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl("ps", ["-p", String(pid), "-o", "lstart="], options);
  if (result.error || result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? "").trim() || null;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

export function buildProcessRecord(pid, options = {}) {
  const base = Number.isFinite(pid)
    ? { pid, processStartTime: getProcessStartTime(pid, options) }
    : { pid: null, processStartTime: null };
  if (typeof options.processGroup === "boolean") {
    base.processGroup = options.processGroup;
  }
  return base;
}

export function currentProcessRecord(options = {}) {
  return buildProcessRecord(process.pid, options);
}

export function verifyProcessRecord(record, options = {}) {
  const pid = typeof record === "number" ? record : record?.pid;
  if (!Number.isFinite(pid)) {
    return { alive: false, matches: false, reason: "missing-pid", currentStartTime: null };
  }
  const expectedStartTime = typeof record === "object" ? (record.processStartTime ?? null) : null;
  const currentStartTime = getProcessStartTime(pid, options);
  if (currentStartTime) {
    if (expectedStartTime && currentStartTime !== expectedStartTime) {
      return { alive: true, matches: false, reason: "pid-reused", currentStartTime };
    }
    if (!expectedStartTime) {
      return options.allowUnverified
        ? { alive: true, matches: true, reason: "unverified", currentStartTime }
        : { alive: true, matches: false, reason: "unverifiable", currentStartTime };
    }
    return { alive: true, matches: true, reason: "matched", currentStartTime };
  }
  const exists = isProcessAlive(pid);
  if (!exists) {
    return { alive: false, matches: false, reason: "not-running", currentStartTime: null };
  }
  if (options.allowUnverified || process.platform === "win32") {
    return { alive: true, matches: true, reason: "unverified", currentStartTime: null };
  }
  return { alive: true, matches: false, reason: "unverifiable", currentStartTime: null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const detached = options.detached ?? process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached,
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    const processRecord = buildProcessRecord(child.pid ?? Number.NaN, {
      processGroup: Boolean(detached && process.platform !== "win32")
    });
    try {
      options.onSpawn?.(processRecord);
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({
        command,
        args,
        status: 1,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        error,
        pid: child.pid ?? null,
        processStartTime: processRecord.processStartTime,
        processGroup: processRecord.processGroup,
        timedOut: false
      });
      return;
    }
    const MAX_TIMEOUT_MS = 2147483647;
    const rawTimeoutMs = Number(options.timeoutMs) || 0;
    const timeoutMs = rawTimeoutMs > 0 ? Math.min(rawTimeoutMs, MAX_TIMEOUT_MS) : 0;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(processRecord, {
          stopGraceMs: options.stopGraceMs ?? 1000,
          hardTimeoutMs: options.hardTimeoutMs ?? 3000
        });
      }, timeoutMs)
      : null;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        ...payload,
        timedOut,
        pid: child.pid ?? null,
        processStartTime: processRecord.processStartTime,
        processGroup: processRecord.processGroup
      });
    };
    child.on("error", (error) => {
      finish({ command, args, status: 1, signal: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      finish({
        command,
        args,
        status: status ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

export function spawnDetached(command, args = [], options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });
  child.unref();
  return buildProcessRecord(child.pid ?? Number.NaN, { processGroup: process.platform !== "win32" });
}

export async function terminateProcessTree(record, options = {}) {
  const pid = typeof record === "number" ? record : record?.pid;
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, escalated: false, verification: { reason: "missing-pid" } };
  }
  const verification = verifyProcessRecord(record, { allowUnverified: true, ...options });
  if (!verification.matches) {
    return { attempted: false, delivered: false, escalated: false, verification };
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const stopGraceMs = Math.max(0, Number(options.stopGraceMs) || DEFAULT_STOP_GRACE_MS);
  const hardTimeoutMs = Math.max(stopGraceMs, Number(options.hardTimeoutMs) || DEFAULT_STOP_HARD_TIMEOUT_MS);
  const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs) || DEFAULT_STOP_POLL_MS);
  const group = process.platform !== "win32" && (record?.processGroup !== false);
  const target = group ? -pid : pid;
  try {
    killImpl(target, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
      } catch (inner) {
        if (inner?.code !== "ESRCH") {
          throw inner;
        }
      }
    }
  }
  const graceDeadline = Date.now() + stopGraceMs;
  while (verifyProcessRecord(record, { allowUnverified: true }).matches && Date.now() < graceDeadline) {
    await sleep(pollIntervalMs);
  }
  if (!verifyProcessRecord(record, { allowUnverified: true }).matches) {
    return {
      attempted: true,
      delivered: true,
      escalated: false,
      verification: verifyProcessRecord(record, { allowUnverified: true })
    };
  }
  try {
    killImpl(target, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  const hardDeadline = Date.now() + Math.max(0, hardTimeoutMs - stopGraceMs);
  while (verifyProcessRecord(record, { allowUnverified: true }).matches && Date.now() < hardDeadline) {
    await sleep(pollIntervalMs);
  }
  return {
    attempted: true,
    delivered: true,
    escalated: true,
    verification: verifyProcessRecord(record, { allowUnverified: true })
  };
}
