import path from "node:path";
import process from "node:process";
import { runCommand } from "./process.mjs";

export function resolveCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}

export function readGitStatus(cwd) {
  const result = runCommand("git", ["status", "--short"], { cwd });
  if (result.error || result.status !== 0) {
    return { available: false, short: "", dirty: false };
  }
  const short = result.stdout.trim();
  return { available: true, short, dirty: Boolean(short) };
}

export function readGitDiff(cwd, { base = null, staged = false } = {}) {
  const args = ["diff"];
  if (staged) {
    args.push("--staged");
  } else if (base) {
    args.push(`${base}...`);
  }
  const result = runCommand("git", args, { cwd });
  if (result.error || result.status !== 0) {
    return { available: false, text: "", command: `git ${args.join(" ")}` };
  }
  return { available: true, text: result.stdout, command: `git ${args.join(" ")}` };
}
