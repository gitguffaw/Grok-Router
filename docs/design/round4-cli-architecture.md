# Round 4 Phase A Design: Single CLI Tokenizer and Session-Backed Ancestry (`lib/cli.mjs`)

## 1. Premise Test

### Premise Under Test

> "`grok-companion` can correctly reconstruct Grok's argument parsing from private hard-coded flag lists, and can infer which session Grok resumes from router job-record order."

### Plain Verdict on the Premise

**The premise does NOT hold.**

1. **Why private hard-coded flag lists fail**:
   - At head (`dbe13e0`), `grok-companion.mjs` scans the same `cli` argument array three times with three different grammars:
     1. `parseCliInput` (`grok-companion.mjs:406-472`) walks `argv` using a static 33-entry `CLI_KNOWN_VALUE_FLAGS` set and a 4-entry `CLI_KNOWN_OPTIONAL_VALUE_FLAGS` set without consulting live `grok --help`.
     2. `extractCliMetadata` (`grok-companion.mjs:553-677`) duplicates those exact two sets, extends them from `parseGrokHelp(helpText)`, and walks `args` a second time.
     3. `classifyCliArgs` (`grok-companion.mjs:371-379`) runs `args.includes("--help") || args.includes("-h")` across the raw array without option/value/positional boundaries.
   - Any divergence between those three passes produces a bug:
     - Passing a router-named value to a flag that only exists in live `grok --help` (e.g., `--future-flag --best`) is recognized as a flag value by `extractCliMetadata` (which reads help) but rejected as a top-level router flag by `parseCliInput` (which does not read help).
     - Passing `--help` or `-h` as a prompt value (`cli -p "--help"`) or after `--` (`cli -p hi -- --help`) is treated as `helpOnly: true` by `classifyCliArgs`, skipping job tracking.
2. **Why router job-record order fails for `--continue`**:
   - `findPriorJobForContinue` (`grok-companion.mjs:498-505`) selects the newest job by `updatedAt` in any status (including `failed` jobs with `grokSessionId: null`, `running` jobs, and `grok-lane` leaves) before `grok` even runs, and compares `job.cwd` against `--cwd <subfolder>` even though managed modes (`runStoredJob` -> `runGrokPrintJob(workspaceRoot, ...)`) execute `grok` in `workspaceRoot`.

---

### Can a Single Tokenizer Be Built from `grok --help`?

**Yes.** `parseGrokHelp(helpText)` in `plugins/grok-router/scripts/lib/help.mjs` already parses clap-formatted `grok --help` output into structured flag and subcommand descriptors.

#### Help-Text Formats in the Repository

1. **Multi-line root help (`tests/fixtures/grok-help.txt`, 175 lines)**:
   ```text
   Options:
         --agent <NAME>
             Agent name or definition file path
     -c, --continue
             Continue the most recent session for the current working directory
     -m, --model <MODEL>
             Model ID to use
     -p, --single <PROMPT>
             Single-turn prompt. Prints the response to stdout and exits
     -r, --resume [<SESSION_ID_OR_TITLE>]
             Resume a session by ID or title, or the most recent if omitted. ...
         --reasoning-effort <EFFORT>
             Reasoning effort for reasoning models
             [aliases: --effort]
         --allow <RULE>
             Permission allow rule (compat alias: --allowedTools)
         --deny <RULE>
             Permission deny rule (compat alias: --disallowedTools)
         --system-prompt-override <PROMPT>
             Override the agent's system prompt (compat alias: --system-prompt)
     -w, --worktree [<WORKTREE>]
             Start the session in a new git worktree, optionally named. ...
         --worktree-ref <WORKTREE_REF>
             Branch, tag, or commit to base the worktree on (with `--worktree`). ...
             [aliases: --ref]
   ```

2. **Single-line subcommand help (`tests/fixtures/grok-models-help.txt`, 10 lines)**:
   ```text
   Options:
         --debug                 Enable debug logging
         --debug-file <FILE>     Write debug logs to FILE
     -h, --help                  Print help
         --leader-socket <PATH>  Use a custom leader socket path ...
   ```

3. **Compat aliases in description text (`references/cli-surface.json` and `tests/fixtures/grok-help.txt`)**:
   - `[aliases: --effort]` and `[aliases: --ref]` are already extracted by `parseAliases` in `lib/help.mjs:23-34`.
   - Inline prose `(compat alias: --allowedTools)`, `(compat alias: --disallowedTools)`, and `(compat alias: --system-prompt)` appear in `grok-help.txt` lines 17, 35, 130. Extending `parseAliases` in `lib/help.mjs` (or the CLI grammar builder in `lib/cli.mjs`) to also match `/\(compat alias:\s*(--[a-z0-9-]+)\)/gi` derives `--allowedTools`, `--disallowedTools`, and `--system-prompt` directly from the help text instead of hard-coding them.
   - Hidden short alias `-C` for `--cwd`: `grok --help` lists `--cwd <CWD>` without `-C`, and hidden `--yolo` is not printed in `grok --help`. Those belong in a tiny, explicit `FALLBACK_CLI_GRAMMAR` seed (used alongside live help and as the fallback when `grok --help` fails).

#### Complete Flag & Arity Table Yielded from `tests/fixtures/grok-help.txt` + Compat Alias Extraction

| Flag(s) | Short | Aliases | Arity (`kind`) | Value Hint |
|---|---|---|---|---|
| `--agent` | — | — | `value` (required) | `<NAME>` |
| `--agents` | — | — | `value` (required) | `<JSON>` |
| `--allow` | — | `--allowedTools` | `value` (required) | `<RULE>` |
| `--always-approve` | — | — | `boolean` (0) | — |
| `--continue` | `-c` | — | `boolean` (0) | — |
| `--cwd` | `-C` *(seed)* | — | `value` (required) | `<CWD>` |
| `--debug` | — | — | `boolean` (0) | — |
| `--debug-file` | — | — | `value` (required) | `<FILE>` |
| `--deny` | — | `--disallowedTools` | `value` (required) | `<RULE>` |
| `--disable-web-search` | — | — | `boolean` (0) | — |
| `--disallowed-tools` | — | — | `value` (required) | `<TOOLS>` |
| `--fork-session` | — | — | `boolean` (0) | — |
| `--fullscreen` | — | — | `boolean` (0) | — |
| `--help` | `-h` | — | `boolean` (0) | — |
| `--include-partial-messages` | — | — | `boolean` (0) | — |
| `--json-schema` | — | — | `value` (required) | `<SCHEMA>` |
| `--leader-socket` | — | — | `value` (required) | `<PATH>` |
| `--model` | `-m` | — | `value` (required) | `<MODEL>` |
| `--max-turns` | — | — | `value` (required) | `<N>` |
| `--minimal` | — | — | `boolean` (0) | — |
| `--no-alt-screen` | — | — | `boolean` (0) | — |
| `--no-plan` | — | — | `boolean` (0) | — |
| `--no-subagents` | — | — | `boolean` (0) | — |
| `--oauth` | — | — | `boolean` (0) | — |
| `--output-format` | — | — | `value` (required) | `<OUTPUT_FORMAT>` |
| `--single` | `-p` | — | `value` (required) | `<PROMPT>` |
| `--permission-mode` | — | — | `value` (required) | `<MODE>` |
| `--prompt-file` | — | — | `value` (required) | `<PATH>` |
| `--prompt-json` | — | — | `value` (required) | `<JSON>` |
| `--resume` | `-r` | — | `optional-value` (0 or 1 non-flag token, or inline `=`) | `[<SESSION_ID_OR_TITLE>]` |
| `--reasoning-effort` | — | `--effort` | `value` (required) | `<EFFORT>` |
| `--restore-code` | — | — | `boolean` (0) | — |
| `--rules` | — | — | `value` (required) | `<RULES>` |
| `--session-id` | `-s` | — | `value` (required) | `<SESSION_ID>` |
| `--sandbox` | — | — | `value` (required) | `<PROFILE>` |
| `--system-prompt-override` | — | `--system-prompt` | `value` (required) | `<PROMPT>` |
| `--tools` | — | — | `value` (required) | `<TOOLS>` |
| `--version` | `-v` | — | `boolean` (0) | — |
| `--verbatim` | — | — | `boolean` (0) | — |
| `--worktree` | `-w` | — | `optional-value` (0 or 1 non-flag token, or inline `=`) | `[<WORKTREE>]` |
| `--worktree-ref` | — | `--ref` | `value` (required) | `<WORKTREE_REF>` |
| `--yolo` *(hidden seed)* | — | — | `boolean` (0) | — |

Subcommands yielded from `tests/fixtures/grok-help.txt`:
`agent`, `clone`, `completions`, `cursor-worker`, `dashboard`, `doctor`, `du` (alias `disk-usage`), `export`, `help`, `inspect`, `leader`, `login`, `logout`, `mcp`, `memory`, `models`, `plugin`, `sessions`, `setup`, `trace`, `update`, `usage`, `version` (alias `v`), `worktree`, `wrap`.

#### Failure Mode When `grok --help` Is Unavailable

When `readGrokHelp(cwd, env)` fails (binary missing, non-zero exit, or empty output):
1. `buildCliGrammar(helpText)` falls back to `FALLBACK_CLI_GRAMMAR` (one canonical constant inside `lib/cli.mjs`, never duplicated across functions) containing the baseline value flags, optional-value flags (`-r`/`--resume`, `-w`/`--worktree`), and known subcommands.
2. Router-owned options (`--cwd`/`-C`, `--timeout-ms`, `--allow-mutating`, `--allow-dangerous`) and rejected router-only options (`--json`, `--background`, `--lean`, `--best`, etc.) are still parsed/rejected identically because router option rules are defined once in `lib/cli.mjs`.
3. If `grok` itself is missing or unexecutable, the subsequent `runProcess` / `runCommand` invocation surfaces the process error cleanly as before.

---

## 2. Architect Sketch for `plugins/grok-router/scripts/lib/cli.mjs`

### Module Boundaries & Line Count Impact (Fixes A1, A4, C3)

- **New module**: `plugins/grok-router/scripts/lib/cli.mjs` (~280 lines) owns all `cli` grammar construction, single-pass tokenization, router-option extraction/rejection, subcommand classification, metadata extraction, session/job lineage lookup, and `handleCli`.
- **Entry script (`plugins/grok-router/scripts/grok-companion.mjs`)**:
  - Deletes `classifyCliArgs`, `CLI_ALLOWED_ROUTER_OPTIONS`, `CLI_REJECTED_ROUTER_OPTIONS`, `CLI_KNOWN_VALUE_FLAGS`, `CLI_KNOWN_OPTIONAL_VALUE_FLAGS`, `parseCliInput`, `parseJsonOrNull`, `findPriorJobForResume`, `findPriorJobForContinue`, `resolveKnownSessionId`, `READ_ONLY_TOOL_NAMES`, `classifyCliToolsWrite`, `extractCliMetadata`, and `handleCli` (~445 lines removed).
  - `grok-companion.mjs` drops from **1,240 lines** down to **~800 lines** (matching `main`).
  - `grok-companion.mjs` no longer exports `handleCli` or `resolveKnownSessionId` for test-only access; tests import `lib/cli.mjs` directly.

### Types & Data Structures

```js
/**
 * @typedef {Object} CliGrammar
 * @property {Set<string>} valueFlags         // e.g. "--model", "-m", "--single", "-p", "--rules", ...
 * @property {Set<string>} optionalValueFlags // e.g. "--resume", "-r", "--worktree", "-w"
 * @property {Set<string>} booleanFlags       // e.g. "--continue", "-c", "--help", "-h", "--yolo", ...
 * @property {Set<string>} commandNames       // e.g. "models", "clone", "help", ...
 * @property {Set<string>} mutatingCommands   // "login", "logout", "plugin", "mcp", "setup", "update", "memory", "worktree", "clone"
 */

/**
 * @typedef {Object} CliToken
 * @property {"router-option" | "option" | "positional" | "separator"} kind
 * @property {string} raw                     // raw token (or flag name when split)
 * @property {string|null} name               // canonical flag name (e.g. "--resume", "-p", "--cwd") or null for positional
 * @property {string|boolean|null} value      // associated option value if consumed (inline `=` or next argv token), true for boolean flags, null for positionals
 * @property {boolean} inline                 // true if value came from `--flag=value`
 * @property {number} rawIndex                // index in normalized argv where the option/positional appeared
 * @property {number|null} valueRawIndex      // index in normalized argv of the value token (or rawIndex if inline)
 */

/**
 * @typedef {Object} ParsedCliInvocation
 * @property {{ cwd?: string, "timeout-ms"?: string, "allow-mutating"?: boolean, "allow-dangerous"?: boolean }} routerOptions
 * @property {string[]} passthroughArgs       // native args to pass to `grok` (router options stripped)
 * @property {CliToken[]} tokens              // token stream over passthroughArgs
 * @property {{ helpOnly: boolean, mutating: boolean, unclassified: boolean, first: string|null }} classification
 * @property {{
 *   resume: string|boolean|null,
 *   resumeToken: CliToken|null,
 *   hasResumeFlag: boolean,
 *   hasPromptOrResume: boolean,
 *   prompt: string|null,
 *   promptFile: string|null,
 *   model: string|null,
 *   effort: string|null,
 *   tools: string|null,
 *   hasAutoApproveFlag: boolean,
 *   continue: boolean
 * }} metadata
 */
```

### Function Signatures in `lib/cli.mjs`

```js
// 1. Build grammar from live `grok --help` text + minimal fallback seed
export function buildCliGrammar(helpText = "") -> CliGrammar

// 2. Single-pass tokenizer over normalized argv:
//    - Before `--`, identifies router-owned options (`--cwd`/`-C`, `--timeout-ms`, `--allow-mutating`, `--allow-dangerous`),
//      rejects disallowed router-only options (`--json`, `--background`, `--lean`, `--best`, etc.) ONLY in option position,
//      and classifies every native flag (`option` with its consumed `value`, if any) using `CliGrammar`.
//    - At `--`, emits a `separator` token and classifies all remaining tokens as `positional`.
export function tokenizeCliArgv(argv, grammar) -> {
  routerOptions: Record<string, any>,
  passthroughArgs: string[],
  tokens: CliToken[]
}

// 3. Derive subcommand/help/mutating classification from the token stream (NOT `args.includes("--help")`):
//    - `helpOnly` is true iff a token has `kind === "option"` and `name === "--help" || name === "-h"`,
//      OR the first positional token (before `--`) is `"help"`.
export function classifyCliTokens(tokens, grammar) -> {
  helpOnly: boolean,
  mutating: boolean,
  unclassified: boolean,
  first: string|null
}

// 4. Derive prompt, resume, continue, model, effort, tools, and write-approval metadata from the SAME token stream:
export function extractCliMetadataFromTokens(tokens, cwd, grammar) -> Metadata

// 5. Combined convenience entry point when helpText is already available:
export function analyzeCliArgv(argv, { cwd, helpText }) -> ParsedCliInvocation

// 6. Session & predecessor resolution (used by both `handleCli` and `runRouted` in `grok-companion.mjs`):
export function findPriorJobForResume(workspaceRoot, target, env = process.env) -> Job|null
export function findPriorJobForContinue(workspaceRoot, executionCwd, env = process.env) -> Job|null
export function findPriorJobBySessionId(workspaceRoot, sessionId, { excludeJobId = null } = {}, env = process.env) -> Job|null
export function resolveKnownSessionId(workspaceRoot, job, env = process.env) -> string|null
export function classifyCliToolsWrite(tools) -> boolean | "unknown"

// 7. CLI command handler (with optional `runProcessImpl` DI seam on the library function):
export async function handleCli(argv, { runProcessImpl = runProcess } = {}) -> Promise<void>
```

### How Single-Pass Tokenization Solves `readGrokHelp` Ordering (`--cwd`)

In `handleCli(argv)`:
1. A lightweight pre-scan (or phase 1 of `tokenizeCliArgv` using the grammar) extracts `--cwd` / `-C` only when it appears in option position before `--`, or we first read `--cwd` so we know which directory to run `readGrokHelp(cwd, env)` in.
   - Specifically: `--cwd` is a known value flag in both live help and the fallback seed. Reading `cwd` first, then calling `readGrokHelp(cwd, env)`, and then running `tokenizeCliArgv(argv, buildCliGrammar(help.text))` means **live help is always loaded before router-flag rejection and token classification run**.
   - Consequently, if live `grok --help` declares a new flag `--new-native-flag <VAL>`, `tokenizeCliArgv` knows `--new-native-flag` takes a value, so `cli --new-native-flag --best -p hi` consumes `--best` as the value of `--new-native-flag` and **never** falsely rejects it!

### Call Sites in `grok-companion.mjs` Replaced by `lib/cli.mjs`

1. `HANDLERS.cli`: calls `handleCli` imported from `./lib/cli.mjs`.
2. `runRouted`: calls `findPriorJobForResume`, `findPriorJobForContinue`, `findPriorJobBySessionId`, and `resolveKnownSessionId` imported from `./lib/cli.mjs`.
3. Exports of `grok-companion.mjs`: `classifyCliArgs` (thin wrapper over `buildCliGrammar` + `tokenizeCliArgv` + `classifyCliTokens` for backward export compatibility), while `handleCli` and `resolveKnownSessionId` live in `lib/cli.mjs`.

---

## 3. A2 Options and Recommendation (`--continue` / Session Ancestry)

### Option (a): Link turns by the session ID Grok actually reports after the run

- **Mechanism**:
  - Do not guess `resumeOf` for `--continue` / `-c` (or bare `-r`) before `grok` runs.
  - After `grok` finishes and reports `sessionId` (extracted from JSON stdout), look up the most recent prior completed job in `workspaceRoot` (excluding the current job) whose `grokSessionId === sessionId` (or `request.controls.resume === sessionId`).
  - Set `resumeOf: matchedPriorJob?.id ?? null` in the terminal job transition.
- **Pros**:
  - Ground truth when `grok` outputs JSON (`--output-format json`): never links to a failed job, a running sibling, a lane leaf from another session, or the wrong directory's session.
  - Automatically reconciles even if the user ran native `grok` turns in between or if multiple sessions exist.
- **Cons / Edge Cases**:
  - In `cli` plain mode (`grok -c -p "hi"` without `--output-format json`), `grok` prints plain text and does not emit `sessionId` on stdout (`parsedSessionId` is `null`, `grokSessionId` becomes `"unknown"`). Pure post-hoc matching alone cannot link a plain-output `cli -c` turn unless combined with a pre-run fallback or restricted to JSON runs.
  - While the job is in `queued`/`running` status (before completion), `resumeOf` is `null` until completion.

### Option (b): Best-effort pre-run `--continue` linking, restricted to completed jobs with a known session in the effective execution `cwd`

- **Mechanism**:
  - Filter candidate predecessors to jobs where:
    1. `job.status === "completed" || job.status === "completed-with-warnings"` (never `failed`, `cancelled`, `queued`, `running`, `interrupted`).
    2. `job.jobClass === "grok"` (excludes both `grok-panel` parents and `grok-lane` leaves).
    3. `Boolean(job.grokSessionId && job.grokSessionId !== "unknown")` (must actually have a known Grok session).
    4. `path.resolve(job.executionCwd ?? job.cwd ?? job.workspaceRoot) === path.resolve(executionCwd)`, where `executionCwd` is the directory in which the router actually spawns `grok` (`workspaceRoot` for managed modes unless managed modes pass `cwd`, and `cwd` for `cli`).
  - Sort eligible jobs by `completedAt ?? updatedAt` descending.
  - Treat bare `-r` / `--resume` (`resume === true`) identically to `--continue` / `-c` (fixes C4 / R3-8).
  - Document `--continue` linkage in `CHANGELOG.md` as **best-effort** rather than an unconditional turn-by-turn guarantee.
- **Pros**:
  - Works even for plain-text `cli -c -p "hi"` runs that do not emit JSON `sessionId`.
  - `resumeOf` is immediately visible while the job is running.
  - Eliminates all reproduced failure modes in A2 (never links to a failed job, running job, lane leaf, or mismatched execution directory).
- **Cons**:
  - If the user created an untracked session directly in raw `grok` TUI outside the router after the last router job, `grok -c` will continue that external session while the router's best-effort heuristic links to the last router job in that directory (unless post-hoc reconciliation overrides it when `sessionId` is reported).

### Recommendation: **Hybrid (Option (a) post-run reconciliation + Option (b) strict best-effort pre-run filter, labeled best-effort in CHANGELOG)**

Combining both gives the strongest behavior with zero downside:
1. **Before `grok` runs (Option b strict filter)**:
   - For `--continue` / `-c` or bare `--resume` / `-r` (`resume === true`), `findPriorJobForContinue(workspaceRoot, executionCwd, env)` only considers jobs with:
     - `job.jobClass === "grok"` (not `grok-panel` or `grok-lane`),
     - `job.status === "completed" || job.status === "completed-with-warnings"`,
     - `job.grokSessionId && job.grokSessionId !== "unknown"`,
     - matching `executionCwd` (and for managed modes, `runGrokPrintJob` either runs in `cwd` or passes `--cwd` / matches `workspaceRoot` consistently — specifically, in `runRouted`, `request.controls.cwd` or the process `cwd` is unified so `executionCwd` is always the exact directory `grok` uses for session lookup).
   - For named `--resume <target>` / `-r <target>` (fixes C2 / Codex G2):
     - Separate **argv translation** (`resumedByJobId`: only when `target === priorJob.id`) from **predecessor linkage** (`findPriorJobForResume`: matches `job.id === ref`, or the most recent completed job where `job.grokSessionId === ref || job.request?.controls?.resume === ref`). That way, if `J1` reported `S` and `J2` resumed `S` with plain output (`grokSessionId: "unknown"`, `request.controls.resume: "S"`), a third turn `-r S` links `resumeOf` to `J2` (preserving the turn-by-turn chain) while `resumedByJobId` is `false` so `-r S` is still never rewritten in `argv`!
2. **After `grok` finishes (Option a post-run reconciliation)**:
   - When `grok` completes and reports a concrete `sessionId` (`sessionId && sessionId !== "unknown"`):
     - For `--continue` / `-c` or bare `-r`, if `priorJob` had a different `grokSessionId !== sessionId`, reconcile `resumeOf` to `findPriorJobBySessionId(workspaceRoot, sessionId, { excludeJobId: job.id })?.id ?? null`.
     - If `grok` fails (`jobStatus !== "completed"`), `grokSessionId` remains `null`.
3. **Documentation**:
   - In `CHANGELOG.md`, describe `--continue` / `-c` linkage as best-effort session/directory matching rather than an unconditional guarantee.

---

## 4. Phase B Test Plan (Strict Test-First Verification)

Every behavioral change in Phase B will be committed as a `test:` commit first, verified to **fail for the exact behavioral assertion** (never for a missing export or `typeof` check), and then made green by the following `impl:` commit without editing the test.

Wait — how do we avoid missing-export failures when introducing `lib/cli.mjs`?
- Either:
  1. All new tests in `tests/companion.test.mjs` invoke the companion CLI (`runCompanion(...)`) or existing exported functions (`buildRouterRequest`, `parseRoutedInput`) so they test behavior end-to-end and fail on the behavioral assertion against current head `dbe13e0`, **or**
  2. If a unit test imports `lib/cli.mjs`, `lib/cli.mjs` is extracted first as a pure behavior-preserving refactor commit (or the test exercises `runCompanion` / `classifyCliArgs` which already exists).
- By writing the Round 4 tests against `runCompanion` and existing exports (`classifyCliArgs`), **every single test runs and fails on its behavioral assertion at head `dbe13e0` before `lib/cli.mjs` is even written!**

### Planned New Tests and Their Exact Failing Reasons Before the Fix

| # | Target Finding | Test Description | How It Is Invoked | Exact Failure Reason Before Fix (at `dbe13e0`) |
|---|---|---|---|---|
| **T-A1a** | **A1 / R3-10** | `cli -p "--help" --output-format json` and `cli -p "hello" -- --help` are tracked as router jobs (emit `Job ID:` on stderr and write a job record) because `--help` is a prompt value or post-`--` positional, not a help option. | `runCompanion(["cli", "-p", "--help", "--output-format", "json"], tempDir)` | Fails `assert.match(res.stderr, /Job ID:\s+\S+/)`: `classifyCliArgs` uses `args.includes("--help")`, sets `helpOnly: true`, and skips job tracking (`stderr` is `""`). |
| **T-A1b** | **A1 / Codex G1 / Claude R3-1** | When live `grok --help` advertises a new value flag (e.g. `--custom-filter <EXPR>`), `cli --custom-filter --best -p "hello" --output-format json` treats `--best` as the value of `--custom-filter` and does not reject `--best` as a router option. | `runCompanion(["cli", "--custom-filter", "--best", "-p", "hello", "--output-format", "json"], tempDir, { GROK_FAKE_EXTRA_HELP_FLAGS: "      --custom-filter <EXPR>\n          Filter expression\n" })` | Fails `assert.equal(res.status, 0)`: `parseCliInput` uses the static `CLI_KNOWN_VALUE_FLAGS` set (which lacks `--custom-filter`), sees `--best` as a standalone option, and exits `1` with `--best is a router option and is not supported on cli`. |
| **T-A2a** | **A2 / Codex G3 / Claude R3-5** | `--continue` / `-c` skips failed jobs (with `grokSessionId: null`) and `grok-lane` leaves, linking `resumeOf` to the most recent completed job with a known session (or `null` if only a failed job exists). Also bare `cli -r -p "next"` links `resumeOf` the same way (C4 / R3-8). | `runCompanion`: Turn 1 `analyze` succeeds (`sid`); Turn 2 `cli -p "fail"` fails (`GROK_FAKE_AUTH: "1"`); Turn 3 `cli -c -p "after fail" --output-format json`. Assert `turn3Job.resumeOf === turn1Id`. | Fails `assert.equal(turn3Job.resumeOf, turn1Id)`: `findPriorJobForContinue` picks the failed Turn 2 (`cli-...`) instead of Turn 1 (`analyze-...`). |
| **T-A2b** | **A2 / Codex G4 / Claude R3-4** | Inside a single initialized Git repository (`git init`), running Turn 1 in repo root and Turn 2 with `--cwd sub --continue` (both `cli` and `analyze`) uses a consistent execution directory and does not link a subdirectory `--cwd` job to a root-directory session while executing in root (and both jobs share the same `resolveStateDir`). | `initGitRepo(tempDir)`, `fs.mkdirSync(subDir)`: verify `resolveStateDir(tempDir) === resolveStateDir(subDir)`, run Turn 1 in `tempDir`, run `analyze --cwd sub --continue` and `cli --cwd sub --continue`. | Fails in a real Git repo because: (1) managed `runRouted` spawns `grok` in `workspaceRoot` without passing `--cwd sub` while `findPriorJobForContinue` filters by `sub`, and (2) when Turn 1 is a failed job in `sub`, `--continue` links to it. |
| **T-C2** | **C2 / Codex G2** | When Turn 1 (`J1`) reports session `S`, Turn 2 (`J2`) runs `cli -r S -p "plain"` (plain output -> `grokSessionId: "unknown"`, `request.controls.resume: "S"`), and Turn 3 (`J3`) runs `cli -r S -p "third" --output-format json`, `J3.resumeOf` links to `J2.id` (not skipping `J2` back to `J1`), while N1 still holds (`cli -r A` after `J2` forced session `B` still sends `-r A`). | `runCompanion` 3-turn sequence in `tempDir`. | Fails `assert.equal(turn3Job.resumeOf, turn2Id)`: `findPriorJobForResume` at `dbe13e0` only checks `job.grokSessionId === ref`, so it returns `J1` instead of `J2`. |

### Confirmation Against Export-Only Failures

- None of `T-A1a`, `T-A1b`, `T-A2a`, `T-A2b`, or `T-C2` imports any unexported symbol or asserts `typeof fn === "function"`.
- Every test executes through `runCompanion` (black-box child process) and fails on an actual behavioral assertion (`status`, `stderr`, `resumeOf`, or `argv`) against `dbe13e0`.

---

## 5. Additional Phase B Items (Planned, Not Executed in Phase A)

1. **A3 (Relabel `5b210f1` / `f19aaf0` in PR body)**:
   - Update the PR #6 description so `5b210f1 -> f19aaf0` (F2 and N4) are explicitly labeled as **strengthened regression coverage + test-export refactor**, not as behavioral test-first pairs, while citing the earlier historical commits (`b3b5695` for F2 timeout, `6dc1833` for N4 chain walk) where the behaviors were introduced.
   - Replace the in-process `main()` + `globalThis.setTimeout` monkey-patching in the F2 test with a clean unit test against `lib/cli.mjs`'s `handleCli` DI seam (`Claude R3-11` / `Codex G6`).
2. **A5 (Remove explanatory comments)**:
   - Remove the explanatory comments added in `tests/companion.test.mjs` (lines 316, 352, 369, 715, 719, 724, 786, 799, 811) and `plugins/grok-router/scripts/lib/router.mjs` (lines 171-173), folding any needed context into test names or assertion messages.
3. **C1 (`status` / `result` / `cancel` `stopAtPositional` change in `3de1619`)**:
   - Revert `stopAtPositional: false` back to `stopAtPositional: true` on `handleStatus`, `handleResult`, and `handleCancel` in `grok-companion.mjs`, and pass `--cwd <dir>` before the positional `<jobId>` in the test (`["result", "--json", "--cwd", otherCwd, otherCwdId]`), keeping the PR scope tight.
