# Changelog

## Unreleased

## 0.3.9

- Extracted a single `cli` tokenizer (`lib/cli.mjs`) driven by live `grok --help` (with a 5s discovery timeout on `readGrokHelp`). Native `argv` is classified and extracted in one pass without re-expanding or rewriting user tokens, and a single `argv` element containing spaces (`cli "sessions --json"`) reaches `grok` as one element unless explicit `--raw-arg-string` is passed.
- `cli -p "--help"` and `cli -p <prompt> -- --help` are tracked as jobs instead of taking the untracked `--help` branch; combined short-flag clusters (`-cp hello`, `-cphello`, `-cph`, `-rc`, `-cr=SID`) are scanned left to right while `-C` inside a cluster and unknown flags (`--future-value --help`, `--future-flag`, `-Z`, `--future-value sessions --help`) fail closed (`write: "unknown"`, tracked, never allowing a trailing `--help` or a following known subcommand to skip job tracking); router job IDs inside a short cluster or inline `-r=` (`-r=<jobId>`, `-cr=<jobId>`, `-cr <jobId>`) are refused fail-closed rather than translated or silently forwarded.
- Untracked `cli` is an allow-list: bare `--help`/`-h` and `--version`/`-v` when grok help maps those spellings to help and version, `help <known subcommand>`, `<known subcommand> [path tokens] --help`/`-h` (except a child-argv command such as `wrap echo hi --help`), and bare read-only subcommands (`completions`, `doctor`, `help`, `inspect`, `sessions`, `usage`, `version`/`v`). `agent`, `cursor-worker`, `dashboard`, `du`/`disk-usage`, `export`, `leader`, `models`, `trace`, and `wrap` are tracked. `write: false` is an allow-list: a fully parsed prompt or session-resume, known options with their values, read-only `--tools`, and no positional token before `--`. A subcommand mixed with a prompt or resume (`cli --tools read_file -p hi doctor fix`, `-c doctor fix`, `-p hi sessions delete X`) records `write: "unknown"`, and `doctor fix`, `sessions delete`/`restore`, and `MUTATING_COMMANDS` require `--allow-mutating`. That check is only the dispatched path: `wrap` child argv, search terms, `usage` arguments, and tokens after the sub-action are payload and stay tracked with `write: "unknown"`. Router-owned options are rejected wherever they are not consumed, including after a subcommand, so a router-owned name cannot be passed through to grok. A first-position `--raw-arg-string` with the wrong number of arguments errors with "requires exactly one following token".
- Extended `parseGrokHelp` for singular/plural `(compat alias(es): ...)`, `=<VAL>`, `<X>...` and `[<X>...]` variadics, short-only flags, same-line descriptions/aliases, and `parseWarnings` on malformed option lines, while keeping header long flags (`--allow`) canonical and policy-owned.
- `--continue`/`-c` pre-run lookup skips failed jobs and `grok-lane` leaves (while keeping legacy records without `jobClass` eligible unless they are lane leaves by other fields) and matches `executionCwd` (`workspaceRoot` for managed modes, `cwd` for `cli`). Bare `-r` and title-based `-r <title>` start with `resumeOf: null` pre-run, and post-run reconciliation updates `resumeOf` from the structured `sessionId` reported by `grok` (clearing `resumeOf` to `null` when `grok` continued an untracked external session, and preserving `--fork-session` source links). Failed and timed-out jobs retain any reported `grokSessionId` so `rescue --resume-last` still works.
- `status <id> --json`, `result <id> --lane <k>`, and `cancel <id> --json` accept trailing options after `<jobId>` as in `0.3.8`, and `npm run lint` syntax-checks `plugins/grok-router/scripts/lib/*.mjs`.
- Known follow-ups (deferred to a subsequent release): lineage tests that check only the final reconciled record rather than inspecting the pre-reconciliation queued/running record, symlinked `cwd` realpath vs logical-path matching on `executionCwd`, `grok-router-mcp.mjs` `serverInfo.version` still reporting `0.1.0`, optional multi-value flags beyond `[<X>...]`, and a headless `cli agent` child orphaned when an external kill stops the companion (the reviewer's 60s alarm left the child with ppid 1). That is separate from `--timeout-ms`, which the companion handles and records as phase timed-out. The detached spawn does not forward SIGTERM/SIGINT to the child group; `cancel <id>` still works.

## 0.3.8

- Managed controls (`--model`/`-m`, `--effort`/`--reasoning-effort`, `--continue`/`-c`, `--prompt-file`, and named `--resume`/`-r`) are emitted once via `request.controls` instead of being duplicated by `nativeArgs` forwarding.
- `exec --lanes` parses the lane list as a value option rather than a boolean flag.
- `cli` preserves native passthrough flags such as `--resume` (instead of consuming them with the router option seed) and rejects router-only flags (`--json`, `--background`, `--lean`, `--best`, etc.) only in option position before `--`.
- `cli` tracks prompt and session-resume runs (`-p`/`--single`, `--prompt-file`, `--resume`/`-r`, `--continue`/`-c`, or a positional prompt) as router jobs with `Job ID` on stderr, stored prompt/result/log, and `status`/`result`/`cancel`. `write` is recorded as `true` when `--always-approve`/`--yolo`, a mutating command, or any non-read-only `--tools` entry is passed; `false` when `--tools` is restricted to read-only tools; and `"unknown"` when `--tools` is omitted (since Grok's default toolset can edit). Non-prompt discovery/help subcommands (`cli --help`, `cli models`, etc.) stay untracked, and `cli` runs have no timeout unless `--timeout-ms` is supplied.
- `--resume <jobId>` / `-r <jobId>` in both managed modes and `cli` translates a router job ID into the underlying Grok session ID in `grok`'s argv (passing explicit raw session IDs through unchanged, and failing clearly when the referenced job has no known Grok session). Resumed turns and best-effort `--continue`/`-c` turns link `resumeOf` to the most recent completed router job with a known session in the execution directory, reconciled after the run from the session ID `grok` reports in JSON output (`--output-format json` is required to chain multiple `cli -c` turns); `status` renders `Grok session: not reported` when a completed `cli` run did not report a session ID.
- Managed modes (`analyze`, `exec`, `rescue`, `adversarial-review`) read `--prompt-file <path>` when provided, pass the routed prompt to `grok` via a job prompt file, and report a clear error when `--prompt-file` is missing.
- Foreground `--json` runs of failed managed jobs now exit `1` (matching non-`--json` foreground runs).
- The MCP server answers initialize with one JSON line, and `.mcp.json` starts that server from the plugin directory. A session opened in another repo can connect.

## 0.3.7

- No Stop hook. Review `--panel` runs only when you call it.
- The host is told the job is ready. Startup noise (MCP did not connect, plugin collisions, skill-name mismatches, how the process was launched) stays in the job log. A startup line is forwarded only when it blocks the job, such as authentication.

## 0.3.1

- Foreground analyze/exec/review/rescue print `Job ID` and live progress on stderr as soon as the job is queued. Finished findings stay on stdout. `--background` still prints the job id on stdout and returns.

## 0.3.0

- Kill inner-parent Parallel: `--parallel` / `--panel` / `--lanes` now launch N `grok -p --no-subagents` leaves. Companion merges json-schema findings into one bounded report. `result --lane k` fetches a leaf. Nested fan-out refused (`GROK_ROUTER_NESTING`).
- Grok-as-host: `setup` copies `grok-router-review.rhai` and `grok-router-adversarial-review.rhai` to `~/.grok/workflows/`. Use `/workflow grok-router-review`. Do not install grok-router MCP/skill into a Grok session.
- See `docs/grok-host.md` and `policy/Grok/Workflows/Parallel.md`.

## 0.2.0

- Router-owned `--lean` (opt-in) / `--full`. Not a Grok flag. Live probe: `--system-prompt-override` replaces `system_prompt.txt` but house `Agents.md` still appears in `prompt_context.json`, so review does **not** default to lean.
- Lean bundle emits `--disallowed-tools search_tool,use_tool,Agent` (allowlist alone does not drop MCP meta-tools), `--disable-web-search`, `--no-subagents`, `--no-plan`, `GROK_MEMORY=0`, and a short `--system-prompt-override` on read-only modes. `--search` keeps web tools. `--parallel` conflicts with `--lean`.
- Review/adversarial-review send the prompt via `--prompt-file` and constrain findings with `--json-schema` (`.structuredOutput`).
- Read-only jobs that dirty git status complete as `completed-with-warnings`.
- `setup` / `models` report inspect load (instruction tokens, skills, plugins, MCP, hooks).
- Probe notes: `docs/lean-probe.md`.

## 0.1.0

- Turn the markdown Grok skill into **Grok Router**: a companion runtime (`grok-companion.mjs`) with Claude Code slash commands, Codex MCP tools, and an AGY skill.
- Live discovery from `grok --help`, `grok models`, and `grok inspect --json`. No pinned model ids or effort enums.
- Managed modes: `setup`, `models`, `surface`, `help`, `analyze`, `exec`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`, `cli`.
- Read-only modes use `--tools "read_file,grep,list_dir"`; exec uses `--always-approve`. Review embeds a git diff (Grok has no native review subcommand).
- New Grok flags/commands appear on `surface` the same day the binary updates; unmodeled subcommands go through `cli`.
- Keep a thin `grok-cli` plugin for raw `grok -p` without job tracking.

## v1.0.8 notes (skill era)

- LaunchPatterns Multi-Turn and CI now split writing (`--always-approve`) from findings-only (`--tools "read_file,grep,list_dir"`). Repeat those flags on every turn; `--resume` does not inherit them.
- Session DEFAULT LAUNCH points at that Multi-Turn module instead of a write-capable copy-paste spine.

## v1.0.8 — 2026-08-21

Install docs: `git clone` creates the repo at `~/.claude/Grok-Skill`. `~/.claude/skills/Grok` is only a symlink to `Grok/`. Removed the migrate/`mv` steps that ran `git fetch` in a folder that was not a clone.

On **main** (no new tag): un-nest. `SKILL.md` is at the repo root. Install is `git clone … ~/.claude/skills/Grok`. That path is a real git repo, not a symlink.

## v1.0.7 — 2026-08-21

Packaging: the installable skill is `Grok/` (`SKILL.md`, `Workflows/`, `references/`). README, LICENSE, and this changelog stay at the repo root and are no longer loaded as skill files.

Install is now clone-the-repo + symlink `Grok/` into each host. See README migrate notes if `~/.claude/skills/Grok` is still a full-repo clone.

`SKILL.md` is a router. Flag surface and launch recipes stay in `references/` and `Workflows/`.

## v1.0.6 — 2026-08-21

Skill package `v1.0.6`. Re-verify against `grok 1.0.5 (5115b46bc909) [stable]`.

### Breaking vs v0.2.94 skill recipes

- **`--check` / `--self-verify` gone.** Parser rejects them. Self-verification belongs in the prompt Validation section.
- **`--best-of-n` gone.** Parser rejects it. `Parallel` is subagent orchestration; independent attempts are N host-side `grok -p` runs.
- **`grok import` gone.** Session movement is `grok export` plus `grok sessions`.
- **Headless `-w` does not create a worktree.** Isolate with `--cwd` into an existing worktree, or inner subagent worktree isolation.
- **Live effort accept list is `low|medium|high|xhigh`.** User-guide extra tiers (`none`, `minimal`, `max`) currently reject.

### Added / updated

- Output format `streaming-messages-json` and `--include-partial-messages`.
- `--resume` matches session ID **or** title for the current directory (scripts should still pass IDs).
- `--restore-code` restores a session snapshot on resume; remote sessions require `--worktree`.
- JSON output may include spend fields (`usage`, `num_turns`, `modelUsage`, cost).
- Secondary commands: `grok doctor`, `grok du` (`disk-usage`), `grok wrap`.
- User-guide documents `GROK_HOME` and `GROK_MEMORY=1|0` (memory still experimental, off by default).
- Observed default model: `grok-4.6` (point-in-time).

### Unchanged

- Headless spine `grok -p`; create-only `-s`; multi-turn via `--resume` / `-c`.
- Prefer `--always-approve` (the short parser alias remains hidden from `grok --help`).
- Review allowlist `read_file,grep,list_dir`; denylist must include `write`.

## v0.2.94 — 2026-07-08

### Added

- **Google Antigravity** install paths:
  - Global: `~/.gemini/config/skills/Grok` (AGY / AGY IDE / AGY CLI)
  - Workspace: `<workspace>/.agents/skills/Grok`
- Multi-host **symlink** install as the recommended default (one clone under Claude Code, link Codex / Grok / Antigravity).

### Unchanged

- CLI contracts still those verified against **`grok 0.2.93`** (P0). No headless semantic changes in this packaging release.

## v0.2.93 — 2026-07-08

P0 re-verify against `grok 0.2.93`: create-only session UUID, resume multi-turn spine, write-safe review allowlist, surface snapshot, invariant-checked packaging. See `CHANGELOG-P0.md` for the full P0 delta.
