# Round 4 Phase A Design (Revised): Single CLI Tokenizer and Session-Backed Ancestry (`lib/cli.mjs`)

## 1. Premise Test

### Premise Under Test

> "`grok-companion` can correctly reconstruct Grok's argument parsing from private hard-coded flag lists, and can infer which session Grok resumes from router job-record order."

### Plain Verdict on the Premise

**The premise does NOT hold.**

1. **Why private hard-coded flag lists fail (`A1`)**:
   - At head (`dbe13e0`), `grok-companion.mjs` (1,238 lines) scans the same `cli` argument array three times with three different grammars:
     1. `parseCliInput` (`grok-companion.mjs:409-472`) walks `argv` using a static 33-entry `CLI_KNOWN_VALUE_FLAGS` set and a 4-entry `CLI_KNOWN_OPTIONAL_VALUE_FLAGS` set without consulting live `grok --help`.
     2. `extractCliMetadata` (`grok-companion.mjs:553-677`) duplicates those exact two sets, extends them from `parseGrokHelp(helpText)`, and walks `args` a second time.
     3. `classifyCliArgs` (`grok-companion.mjs:371-379`) runs `args.includes("--help") || args.includes("-h")` across the raw array without option/value/positional boundaries.
   - Any divergence between those three passes produces a bug:
     - Passing a router-named value to a flag that only exists in live `grok --help` (e.g., `--custom-filter --best`) is recognized as a flag value by `extractCliMetadata` (which reads help) but rejected as a top-level router flag by `parseCliInput` (which runs before help is read).
     - Passing `--help` or `-h` as a prompt value (`cli -p "--help"`) or after `--` (`cli -p hi -- --help`) is treated as `helpOnly: true` by `classifyCliArgs`, skipping job tracking.
     - Passing combined short flags (`cli -cp "hi"`) is unrecognized by all three passes and runs untracked.
2. **Why router job-record order fails for `--continue` (`A2`)**:
   - `findPriorJobForContinue` (`grok-companion.mjs:498-505`) selects the newest job by `updatedAt` in any status (including `failed` jobs with `grokSessionId: null`, `running` jobs, and `grok-lane` leaves whose `cwd` is `undefined` and falls back to `workspaceRoot`) before `grok` runs, and compares `job.cwd` against `--cwd <subfolder>` even though managed modes (`runStoredJob` -> `runGrokPrintJob(workspaceRoot, ...)`) execute `grok` in `workspaceRoot`.

---

### Can a Single Tokenizer Be Built from `grok --help`? (`A-C`, `A-H`, `A-I`)

**Yes, with an explicit supported-grammar contract and bounded fallback policy.**

#### Help-Text Formats in the Repository and Live Grok 1.0.60 (`A-H`)

1. **Multi-line root help (`tests/fixtures/grok-help.txt`, 175 lines)**:
   ```text
   Options:
         --agent <NAME>
             Agent name or definition file path
         --allow <RULE>
             Permission allow rule (compat aliases: --allowedTools, --allowed-tools)
     -c, --continue
             Continue the most recent session for the current working directory
         --deny <RULE>
             Permission deny rule (compat alias: --disallowedTools)
     -m, --model <MODEL>
             Model ID to use
     -p, --single <PROMPT>
             Single-turn prompt. Prints the response to stdout and exits
     -r, --resume [<SESSION_ID_OR_TITLE>]
             Resume a session by ID or title, or the most recent if omitted. ...
         --reasoning-effort <EFFORT>
             Reasoning effort for reasoning models
             [aliases: --effort]
         --system-prompt-override <PROMPT>
             Override the agent's system prompt (compat alias: --system-prompt)
     -w, --worktree [<WORKTREE>]
             Start the session in a new git worktree, optionally named. ...
         --worktree-ref <WORKTREE_REF>
             Branch, tag, or commit to base the worktree on (with `--worktree`). ...
             [aliases: --ref]
   ```
   - **Live Grok 1.0.60 fixture drift (`A-H`)**: Live `grok 1.0.60 --help` prints `(compat aliases: --allowedTools, --allowed-tools)` (plural, comma-separated list) on `--allow` at line 17, while `tests/fixtures/grok-help.txt:17` had `(compat alias: --allowedTools)`.
   - Phase B will refresh `tests/fixtures/grok-help.txt:17` to match live 1.0.60 and extend `parseAliases(text)` in `plugins/grok-router/scripts/lib/help.mjs` to extract both `[aliases: ...]` and singular/plural `/\(compat alias(?:es)?:\s*([^)]+)\)/gi` comma-separated lists:
     ```js
     function parseAliases(text) {
       const raw = String(text ?? "");
       const collected = [];
       const bracket = raw.match(/\[aliases:\s*([^\]]+)\]/i);
       if (bracket) {
         collected.push(...bracket[1].split(","));
       }
       for (const compat of raw.matchAll(/\(compat alias(?:es)?:\s*([^)]+)\)/gi)) {
         collected.push(...compat[1].split(","));
       }
       return unique(
         collected
           .map((item) => item.trim())
           .filter((item) => item.startsWith("-"))
       );
     }
     ```

2. **Single-line subcommand help (`tests/fixtures/grok-models-help.txt`, 10 lines)**:
   ```text
   Options:
         --debug                 Enable debug logging
         --debug-file <FILE>     Write debug logs to FILE
     -h, --help                  Print help
         --leader-socket <PATH>  Use a custom leader socket path ...
   ```

#### Supported Help Grammar and Parse Warnings (`A-I`)

`parseGrokHelp(text)` in `plugins/grok-router/scripts/lib/help.mjs` will explicitly support the following option declaration grammar and warn on anything outside it:

1. **Long, short+long, and short-only option headers**:
   - Paired or long-only: `^\s{2,}(?:(-[A-Za-z0-9]),\s*)?(--[A-Za-z0-9][A-Za-z0-9-]*)`
   - Short-only: `^\s{2,}(-[A-Za-z0-9])(?=\s|$)` (sets `short: "-x"`, `long: null`, `names: ["-x"]`).
2. **Value hint forms and arities**:
   - Space- or `=`-separated required value: `<VAL>` or `=<VAL>` -> `requiresValue: true`, `optionalValue: false`.
   - Space- or `=`-separated optional value: `[<VAL>]`, `[=<VAL>]`, or `=[<VAL>]` -> `requiresValue: false`, `optionalValue: true`.
   - Variadic suffix: `<VAL>...` or `[<VAL>...]` -> strips trailing `...` from `valueHint`, preserves `requiresValue` / `optionalValue`, and sets `variadic: true`, `repeatable: true`.
   - No value token -> `requiresValue: false`, `optionalValue: false` (`boolean`).
3. **Same-line descriptions and aliases**:
   - When an option header line has trailing description text separated by 2+ spaces (as in `grok-models-help.txt`), `parseFlagLine` captures `inlineDescription` and seeds `currentFlag.description`, `possibleValues`, `default`, and `aliases` immediately so same-line `[aliases: ...]` or `(compat alias...: ...)` are never dropped.
4. **Parse warnings on unparsed option lines**:
   - In `parseGrokHelp(text)`, when `section === "options"` and a line begins with 2–6 spaces followed by `-` (`^\s{2,6}-\S`) but `parseFlagLine(line)` returns `null`, `parseWarnings.push(\`unparsed option line: ${trimmed}\`)` is recorded (matching `unparsed command line:` in the `commands` section).
5. **Subcommand grammar boundary**:
   - Root `grok --help` describes root options and top-level subcommand names (`commands`). It does not include subcommand-local option tables (e.g., `grok sessions` or `grok wrap`). Accordingly, the CLI tokenizer treats the first known subcommand positional token as the end of top-level option position (see §2).

#### Complete Flag & Arity Table Yielded from `tests/fixtures/grok-help.txt` (41 Flags: 23 Required-Value, 2 Optional-Value, 16 Boolean; 25 Subcommands)

| Canonical Flag | Short | Extracted Aliases (from Help) | Arity (`kind`) | Value Hint |
|---|---|---|---|---|
| `--agent` | — | — | `value` (required) | `NAME` |
| `--agents` | — | — | `value` (required) | `JSON` |
| `--allow` | — | `--allowedTools`, `--allowed-tools` | `value` (required, repeatable) | `RULE` |
| `--always-approve` | — | — | `boolean` (0) | — |
| `--continue` | `-c` | — | `boolean` (0) | — |
| `--cwd` | — | — | `value` (required) | `CWD` |
| `--debug` | — | — | `boolean` (0) | — |
| `--debug-file` | — | — | `value` (required) | `FILE` |
| `--deny` | — | `--disallowedTools` | `value` (required, repeatable) | `RULE` |
| `--disable-web-search` | — | — | `boolean` (0) | — |
| `--disallowed-tools` | — | — | `value` (required) | `TOOLS` |
| `--fork-session` | — | — | `boolean` (0) | — |
| `--fullscreen` | — | — | `boolean` (0) | — |
| `--help` | `-h` | — | `boolean` (0) | — |
| `--include-partial-messages` | — | — | `boolean` (0) | — |
| `--json-schema` | — | — | `value` (required) | `SCHEMA` |
| `--leader-socket` | — | — | `value` (required) | `PATH` |
| `--model` | `-m` | — | `value` (required) | `MODEL` |
| `--max-turns` | — | — | `value` (required) | `N` |
| `--minimal` | — | — | `boolean` (0) | — |
| `--no-alt-screen` | — | — | `boolean` (0) | — |
| `--no-plan` | — | — | `boolean` (0) | — |
| `--no-subagents` | — | — | `boolean` (0) | — |
| `--oauth` | — | — | `boolean` (0) | — |
| `--output-format` | — | — | `value` (required) | `OUTPUT_FORMAT` |
| `--single` | `-p` | — | `value` (required) | `PROMPT` |
| `--permission-mode` | — | — | `value` (required) | `MODE` |
| `--prompt-file` | — | — | `value` (required) | `PATH` |
| `--prompt-json` | — | — | `value` (required) | `JSON` |
| `--resume` | `-r` | — | `optional-value` (0 or 1 non-flag token, or inline `=`) | `SESSION_ID_OR_TITLE` |
| `--reasoning-effort` | — | `--effort` | `value` (required) | `EFFORT` |
| `--restore-code` | — | — | `boolean` (0) | — |
| `--rules` | — | — | `value` (required) | `RULES` |
| `--session-id` | `-s` | — | `value` (required) | `SESSION_ID` |
| `--sandbox` | — | — | `value` (required) | `PROFILE` |
| `--system-prompt-override` | — | `--system-prompt` | `value` (required) | `PROMPT` |
| `--tools` | — | — | `value` (required) | `TOOLS` |
| `--version` | `-v` | — | `boolean` (0) | — |
| `--verbatim` | — | — | `boolean` (0) | — |
| `--worktree` | `-w` | — | `optional-value` (0 or 1 non-flag token, or inline `=`) | `WORKTREE` |
| `--worktree-ref` | — | `--ref` | `value` (required) | `WORKTREE_REF` |

Note on `-C` and `--yolo` (`C-F` / `R4-12`):
- `-C` is a **router-owned alias** for `--cwd` (`references/cli-surface.json` records `short: null` for `--cwd`), so `-C` belongs in Tier 1 (router-owned options), not in the native Grok flag table.
- `--yolo` is a hidden Grok policy flag not printed by `grok --help`; it is included in the Tier 3 fallback seed as a `boolean` flag.

---

#### Help Timeout, Validation Gate, Merge Precedence, and Fallback Mode (`A-C`, `C-C`)

1. **Bounded Synchronous Discovery (`DEFAULT_DISCOVERY_TIMEOUT_MS = 5000`)**:
   - In `plugins/grok-router/scripts/lib/process.mjs`, `runCommand(command, args, options)` passes `timeout: options.timeoutMs ?? 5000` to `spawnSync`. If `spawnSync` times out (`result.error?.code === "ETIMEDOUT"` or `result.signal`), `runCommand` returns `status: 1` with `error: result.error`.
   - In `plugins/grok-router/scripts/lib/grok.mjs`, `readGrokHelp(cwd, env, { timeoutMs = 5000 } = {})` gates validity strictly on:
     ```js
     const stdout = String(result.stdout ?? "");
     const ok = !result.error && result.status === 0 && stdout.trim().length > 0 && stdout.length <= 256 * 1024;
     return { ok, text: ok ? stdout : "", result };
     ```
   - `readGrokHelp` **never** falls back to `result.stderr` as help text when `grok --help` fails, and `handleCli` checks `help.ok` before parsing (matching `discoverRoutedSurface`).
   - Help discovery runs once per CLI invocation from `process.cwd()` bounded by this 5s timeout (`C-C`); cross-process disk caching is out of scope for Phase B.

2. **Three-Tier Precedence (`A-C`)**:
   - **Tier 1 — Router-owned options (evaluated first in option position, independent of `grok --help`)**:
     - Allowed router options on `cli`: `--cwd` (and router short alias `-C`), `--timeout-ms`, `--allow-mutating`, `--allow-dangerous`.
     - Rejected router-only options on `cli` (in option position): `--base`, `--scope`, `--tool`, `--lanes`, `--lane`, `--json`, `--background`, `--wait`, `--best`, `--lean`, `--full`, `--search`, `--docs`, `--parallel`, `--panel`, `--all`, `--write`, `--fresh`, `--resume-last`, `--enable-review-gate`, `--disable-review-gate`.
     - Help output can never override Tier 1 router ownership.
   - **Tier 2 — Validated live `grok --help` (`help.ok === true`)**:
     - Parsed via `parseGrokHelp(help.text)`.
     - For every flag name and alias declared in live help, its live-help arity (`value`, `optional-value`, or `boolean`) **wins** over `FALLBACK_CLI_GRAMMAR`. Adding a name to one arity set removes it from the other two sets so a flag whose arity changed between Grok versions never has stale dual membership.
   - **Tier 3 — `FALLBACK_CLI_GRAMMAR` seed (lowest precedence)**:
     - When `help.ok === true`, contributes only names absent from live help (such as hidden `--yolo` and any baseline commands absent from partial help).
     - When `help.ok === false`, supplies the full baseline Grok 1.0.60 flag and command sets.

3. **Explicit Fallback-Mode Limitation (`A-C`)**:
   - Consolidating into one tokenizer eliminates all divergence *between* passes inside the router, but when `help.ok === false` (fallback mode), the router only knows the arities in `FALLBACK_CLI_GRAMMAR`.
   - Therefore, in fallback mode, an unknown future native value flag followed by a router-named value (e.g. `cli --unknown-future-flag --best -p hi`) can still misparse `--best` as an option-position token and reject it (or misclassify `--unknown-future-flag --help` as help-only).
   - To surface this clearly, `CliGrammar` carries `helpAvailable: boolean`. If `tokenizeCliArgv` rejects a router-only flag while `grammar.helpAvailable === false`, the thrown error appends:
     ` (grok --help was unavailable; parsed using fallback CLI grammar)`.

---

## 2. Architect Sketch for `plugins/grok-router/scripts/lib/cli.mjs` (`A1`, `A4`, `A-D`, `A-I`, `C-A`)

### Module Boundaries, Shared Helpers, and Line-Count Impact (`A4`, `C-A`)

- **Shared helpers moved to existing library modules (no circular imports from `grok-companion.mjs`)**:
  - `normalizeArgv(argv)` moves from `grok-companion.mjs:109` to `plugins/grok-router/scripts/lib/args.mjs`.
  - `resolveCwd(options)` moves from `grok-companion.mjs:138` to `plugins/grok-router/scripts/lib/workspace.mjs`.
  - `emitJobStarted(job)` is already in `plugins/grok-router/scripts/lib/render.mjs:73`.
- **New module**: `plugins/grok-router/scripts/lib/cli.mjs` (**~450–520 lines** realistic estimate, `C-A`) owns:
  - `FALLBACK_CLI_GRAMMAR` and `buildCliGrammar(helpResult)`
  - `tokenizeCliArgv(argv, grammar)`
  - `classifyCliTokens(tokens, grammar)` and backward-compatible `classifyCliArgs(args, helpText)`
  - `extractCliMetadataFromTokens(tokens, cwd, grammar)`
  - `rewriteResumeArg(passthroughArgs, resumeToken, sessionId)`
  - `findPriorJobForResume`, `findPriorJobForContinue`, `findPriorJobBySessionId`, `resolveKnownSessionId`, `reconcileCompletedResumeOf`, `effectiveExecutionCwd`, and `classifyCliToolsWrite`
  - `handleCli(argv, { runProcessImpl = runProcess } = {})`
- **Entry script (`plugins/grok-router/scripts/grok-companion.mjs`)**:
  - Removes ~445 lines of inline CLI parsing, metadata, lineage, and handler code (`grok-companion.mjs` drops from **1,238 lines** back to **~795 lines**).
  - `grok-companion.mjs` no longer exports `handleCli` or `resolveKnownSessionId`; tests import them from `lib/cli.mjs`.

### Dropping the `--cwd` Pre-Scan (`A-D`)

- Root `grok --help` is binary-global and does not vary by target working directory.
- Pre-scanning `argv` for `--cwd` before loading `grok --help` would recreate the bootstrap bug (`--new-value-flag --cwd -p hi`).
- Therefore, `handleCli` **never pre-scans `argv` for `--cwd`**:
  1. `handleCli` calls `const help = readGrokHelp(process.cwd(), env)` once.
  2. `const grammar = buildCliGrammar(help)` builds the unified grammar.
  3. `tokenizeCliArgv(normalizeArgv(argv), grammar)` tokenizes `argv` in a single pass, extracting `routerOptions.cwd` (when `--cwd` or `-C` appeared in option position) along with `passthroughArgs` and `tokens`.
  4. `const cwd = resolveCwd(routerOptions)` resolves the target directory for workspace lookup, `--prompt-file` reading, job creation, and spawning `grok`.

### Token Stream, Short-Flag Clusters, Subcommand Boundary, and Index Mapping (`A-I`, `C-A`)

```js
/**
 * @typedef {Object} CliGrammar
 * @property {Set<string>} valueFlags         // e.g. "--model", "-m", "--single", "-p", "--allow", "--allowedTools", "--allowed-tools", ...
 * @property {Set<string>} optionalValueFlags // e.g. "--resume", "-r", "--worktree", "-w"
 * @property {Set<string>} booleanFlags       // e.g. "--continue", "-c", "--help", "-h", "--yolo", ...
 * @property {Map<string, string>} canonicalFlag // maps any short/alias (e.g. "-p", "--effort", "--allowed-tools") to canonical long flag ("--single", "--reasoning-effort", "--allow")
 * @property {Set<string>} commandNames       // e.g. "models", "clone", "sessions", "help", ...
 * @property {Set<string>} mutatingCommands   // "login", "logout", "plugin", "mcp", "setup", "update", "memory", "worktree", "clone"
 * @property {boolean} helpAvailable          // true iff built from a valid `readGrokHelp` response
 */

/**
 * @typedef {Object} CliToken
 * @property {"option" | "positional" | "separator"} kind
 * @property {string} raw                     // token text in passthroughArgs
 * @property {string|null} name               // flag token as written (e.g. "-r", "--resume", "-c") or null for positional/separator
 * @property {string|null} canonical          // canonical long name from grammar (e.g. "--resume", "--continue", "--single")
 * @property {string|boolean|null} value      // option argument (string) or true (boolean/bare optional-value) or null (positional)
 * @property {boolean} inline                 // true if value was attached via `=` (`--resume=SID`) or short-attached (`-phello`)
 * @property {number} passthroughIndex        // index of the flag/positional token in `passthroughArgs`
 * @property {number|null} passthroughValueIndex // index in `passthroughArgs` holding the value (equals `passthroughIndex` when `inline: true`, or `passthroughIndex + 1` when separate)
 */
```

#### Single-Pass Rules in `tokenizeCliArgv(normalizedArgv, grammar)`

1. **Option-position state (`inOptionPosition`)**:
   - Starts `true`.
   - Becomes `false` immediately when:
     a. `--` is encountered (emits `{ kind: "separator", raw: "--", passthroughIndex }`; all subsequent tokens are pushed to `passthroughArgs` and emitted as `{ kind: "positional" }`), OR
     b. A positional token is encountered that is a known subcommand (`grammar.commandNames.has(token)`), e.g., `models`, `sessions`, `clone`, `wrap`, `help` (`A-I` / `R4-8`).
   - Once `inOptionPosition === false` after a subcommand:
     - Router-only flag rejection (`--json`, `--best`, etc.) and router-option stripping (`--cwd`, `--timeout-ms`) **do not run** on subcommand arguments (so `cli sessions list --json` or `cli wrap -- cmd --best` are not falsely rejected).
     - Tokens after a subcommand before `--` are still checked only for `-h` / `--help` so `cli clone --help` or `cli models -h` is classified as `helpOnly: true`.
2. **Router-owned options (while `inOptionPosition === true`)**:
   - `--cwd` / `-C` and `--timeout-ms` (separate value or `--flag=value`) are consumed into `routerOptions` and **not** pushed to `passthroughArgs`.
   - `--allow-mutating` and `--allow-dangerous` (boolean or `=true`/`=false`) are consumed into `routerOptions` and **not** pushed to `passthroughArgs`.
   - Any flag in `CLI_REJECTED_ROUTER_OPTIONS` (`--json`, `--background`, `--lean`, `--best`, etc.) throws `--<key> is a router option and is not supported on cli...`.
3. **Combined short flags and attached values (`A-I` / `R4-7`)**:
   - For a short token `-xyz` (`token.startsWith("-") && !token.startsWith("--") && token.length > 2`):
     - **Short `=` form (`-m=grok-4.6`, `-r=SID`)**: split at first `=`; push `token` to `passthroughArgs` at `idx` and emit `{ kind: "option", name: "-r", canonical: "--resume", value: "SID", inline: true, passthroughIndex: idx, passthroughValueIndex: idx }`.
     - **Combinable short cluster (`-cp hi`, `-cr SID`)**: if every char `c` in `token.slice(1)` is a known short flag `-${c}` in `grammar`, and every char except possibly the last is in `grammar.booleanFlags`:
       - Expand the cluster into individual flags in `passthroughArgs` (e.g., `"-c"`, `"-p"`, `"hi"`). That way `cli -cp "hi"` is tokenized as `-c` (`continue: true`) + `-p "hi"` (`prompt: "hi"`), runs **tracked**, and if `-cr <jobId>` is used, `-r` has its own clean `passthroughValueIndex` for `<jobId>` -> `<sessionId>` translation!
     - **Attached short value (`-phello`, `-mgrok-4.6`)**: if `token.slice(0, 2)` is in `grammar.valueFlags` or `grammar.optionalValueFlags`:
       - Push `token` to `passthroughArgs` at `idx` and emit `{ kind: "option", name: token.slice(0, 2), canonical, value: token.slice(2), inline: true, passthroughIndex: idx, passthroughValueIndex: idx }`.
     - **Otherwise**: push `token` to `passthroughArgs` and emit as a boolean option token.
4. **Lossless `-r <jobId>` Translation Helper (`C-A` / `Codex R4-8`)**:
   - `rewriteResumeArg(passthroughArgs, resumeToken, sessionId)`:
     - Clones `passthroughArgs`.
     - If `!resumeToken` or `resumeToken.passthroughValueIndex == null`, returns the clone unchanged.
     - If `resumeToken.inline` (e.g., `--resume=<jobId>` or `-r=<jobId>` or `-r<jobId>`), replaces `clone[resumeToken.passthroughValueIndex]` with `${resumeToken.name}=${sessionId}` (or `${resumeToken.name}${sessionId}` when raw did not contain `=`).
     - Otherwise, replaces `clone[resumeToken.passthroughValueIndex]` with `sessionId`.

### Call Sites in `grok-companion.mjs` Replaced by `lib/cli.mjs`

1. `HANDLERS.cli`: calls `handleCli` imported from `./lib/cli.mjs`.
2. `runRouted` and `runStoredJob`: call `findPriorJobForResume`, `findPriorJobForContinue`, `resolveKnownSessionId`, and `reconcileCompletedResumeOf` imported from `./lib/cli.mjs`.
3. `classifyCliArgs`: re-exported from `./lib/cli.mjs` for backward compatibility.

---

## 3. Hybrid A2 Specification: Execution Directory, Pre-Run Filter, and Post-Run Reconciliation (`A-A`, `A-B`, `A-E`, `A-F`, `C-D`, `C-E`)

### 1. Execution Directory Policy and Legacy Records (`A-A`)

- **Fixed Execution Directory Policy**:
  - **Managed modes (`analyze`, `exec`, `review`, `adversarial-review`, `rescue`)**: always execute `grok` in `workspaceRoot` (`runStoredJob` -> `runGrokPrintJob(workspaceRoot, ...)`). Every new managed job record stores:
    - `cwd`: `resolveCwd(options)` (the caller's requested directory)
    - `workspaceRoot`: `resolveWorkspaceRoot(cwd)`
    - `executionCwd`: `workspaceRoot` (the actual directory `grok` runs in and uses for session lookup)
  - **`cli` mode**: executes `grok` in `cwd` (`resolveCwd(routerOptions)`). Every new tracked `cli` job record stores:
    - `cwd`: `cwd`
    - `workspaceRoot`: `resolveWorkspaceRoot(cwd)`
    - `executionCwd`: `cwd`
  - **Lane leaf jobs (`grok-lane`)**: store `cwd` and `executionCwd: workspaceRoot` (and are excluded from `--continue` lookup by `jobClass === "grok"`).
- **Legacy Job Records Without `executionCwd`**:
  - Historical managed job records stored `job.cwd` (which could be a subdirectory) even though `grok` executed in `job.workspaceRoot`. Falling back to `job.cwd` on a legacy managed job would preserve the mismatch bug (`Codex R4-4`).
  - Therefore, `effectiveExecutionCwd(job)` is defined as:
    ```js
    export function effectiveExecutionCwd(job) {
      if (job?.executionCwd) {
        return path.resolve(job.executionCwd);
      }
      if (job?.mode === "cli") {
        return path.resolve(job.cwd ?? job.workspaceRoot ?? process.cwd());
      }
      return path.resolve(job?.workspaceRoot ?? job?.cwd ?? process.cwd());
    }
    ```

### 2. Pre-Run Lookup Rules (`A-A`, `A-E`, `A-F`, `C2`, `C4`)

Let `SUCCESSFUL_JOB_STATUSES = new Set(["completed", "completed-with-warnings"])`.

- **`linkage` field stored on every new job record (`A-B`)**:
  - `"fork"` if `--fork-session` or `--session-id` / `-s` was passed alongside `--continue`/`-c` or `--resume`/`-r`.
  - `"continue"` if `--continue` / `-c` or bare `--resume` / `-r` (`resume === true`) was passed (and not `"fork"`).
  - `"resume"` if a named `--resume <target>` / `-r <target>` was passed (and not `"fork"`).
  - `null` otherwise.

- **Implicit continue (`--continue` / `-c` or bare `-r` / `--resume`, `findPriorJobForContinue(workspaceRoot, executionCwd, env)`)**:
  - Filters `listJobs(workspaceRoot, env)` to candidates where:
    1. `job.jobClass === "grok"` (excludes `grok-panel` and `grok-lane`),
    2. `SUCCESSFUL_JOB_STATUSES.has(job.status)`,
    3. `Boolean(job.grokSessionId && job.grokSessionId !== "unknown")` (plain-output turns with `"unknown"` are never eligible predecessors — `A-F`),
    4. `effectiveExecutionCwd(job) === path.resolve(executionCwd)`.
  - Sorts eligible candidates by `Date.parse(job.completedAt ?? job.updatedAt)` descending, then `Date.parse(job.createdAt)` descending, then `job.id` descending.
  - Returns the top candidate or `null`.

- **Named resume (`--resume <target>` / `-r <target>`, `findPriorJobForResume(workspaceRoot, target, env)`) (`A-E`, `C2`)**:
  - Trims `ref = String(target).trim()`.
  - First checks for an exact router job ID match: `jobs.find((job) => job.id === ref)`.
    - **Only when `priorJob && ref === priorJob.id` (`resumedByJobId === true`)** does the router resolve `priorSessionId = resolveKnownSessionId(workspaceRoot, priorJob, env)`, throw `Job ${priorJob.id} has no known Grok session.` if `!priorSessionId` (`N2b`), and rewrite `<jobId>` to `priorSessionId` in `grok`'s argv (`N1`).
  - Otherwise (`resumedByJobId === false`, so `ref` is a raw session UUID or a session title):
    - `ref` is passed through to `grok` **unchanged** (`N1`).
    - For pre-run `resumeOf` lineage (`C2` & `A-E`), searches completed `jobClass === "grok"` jobs (`SUCCESSFUL_JOB_STATUSES.has(job.status)`) sorted newest-first by `completedAt ?? updatedAt` where:
      - `job.grokSessionId === ref` (reported session matches `ref`), **OR**
      - `(!job.grokSessionId || job.grokSessionId === "unknown") && job.request?.controls?.resume === ref` (requested session matches `ref` **only when** the job's reported session is absent or `"unknown"` — never when the job reported a contradictory session `B !== ref`, `A-E`).
    - If `ref` is a session title (no UUID match pre-run), `findPriorJobForResume` returns `null` pre-run, and post-run reconciliation (`A-B`) links `resumeOf` once `grok` resolves the title and reports the session UUID in JSON output (`A-E`).

### 3. Post-Run Reconciliation Seam and Ordering Rules (`A-B`, `A-E`, `C-D`, `C-E`)

- **Seam in `plugins/grok-router/scripts/lib/jobs.mjs`**:
  - In `runTrackedJob(job, runner, options = {})` (`lib/jobs.mjs:119-141`), the terminal `transitionJob` callback computes:
    ```js
    const status = execution.jobStatus ?? (execution.exitStatus === 0 ? "completed" : "failed");
    const succeeded = status === "completed" || status === "completed-with-warnings";
    const grokSessionId = succeeded ? (execution.grokSessionId ?? null) : null;
    const resumeOf = typeof options.reconcileResumeOf === "function"
      ? options.reconcileResumeOf(current, { ...execution, jobStatus: status, grokSessionId })
      : (execution.resumeOf !== undefined ? execution.resumeOf : (current.resumeOf ?? null));
    ```
    and writes `resumeOf` and `grokSessionId` onto the terminal job record.
- **Signature & Logic of `reconcileCompletedResumeOf(workspaceRoot, currentJob, execution, env = process.env)` in `lib/cli.mjs`**:
  1. **Failure guard**: If `!SUCCESSFUL_JOB_STATUSES.has(execution.jobStatus)`, return `currentJob.resumeOf ?? null` (and `grokSessionId` is `null`).
  2. **Non-linked or forked runs (`A-E`)**: If `!currentJob.linkage || currentJob.linkage === "fork"`, return `currentJob.resumeOf ?? null` unchanged (preserving the pre-run source link when `--fork-session` or `--session-id` / `-s` created a new session ID).
  3. **Authoritative session evidence (`C-E`)**: Extract `reportedSessionId = typeof execution.payload?.parsedOutput?.sessionId === "string" ? execution.payload.parsedOutput.sessionId.trim() : null`.
     - If `!reportedSessionId` (e.g., plain-text output where no JSON `sessionId` was emitted), keep the pre-run best-effort `currentJob.resumeOf ?? null`.
  4. **Candidate search (runs even when `currentJob.resumeOf` was `null` pre-run)**:
     - Let `upperBoundMs = Date.parse(currentJob.startedAt ?? currentJob.createdAt ?? "")`.
     - Filter `listJobs(workspaceRoot, env)` to candidates `cand` where:
       a. `cand.id !== currentJob.id`
       b. `cand.jobClass === "grok"`
       c. `SUCCESSFUL_JOB_STATUSES.has(cand.status)`
       d. **Earlier-than boundary**: `const candDoneMs = Date.parse(cand.completedAt ?? cand.updatedAt ?? "");` require `Number.isFinite(candDoneMs) && Number.isFinite(upperBoundMs) && candDoneMs <= upperBoundMs` (only jobs that finished on or before `currentJob` started can be its parent).
       e. **Non-contradictory session match (`A-E`)**:
          `cand.grokSessionId === reportedSessionId || ((!cand.grokSessionId || cand.grokSessionId === "unknown") && cand.request?.controls?.resume === reportedSessionId)`
       f. **Cycle guard**: walking `cand -> cand.resumeOf -> ...` via `readJobFile(workspaceRoot, id, env)` with a `visited = new Set([currentJob.id])` set must not encounter `currentJob.id` or any repeated job ID.
     - Sort matching candidates by `Date.parse(cand.completedAt ?? cand.updatedAt)` descending, then `Date.parse(cand.createdAt)` descending, then `cand.id` descending.
  5. **Reconcile decision**:
     - If `currentJob.linkage === "continue"`:
       - If the pre-run `currentJob.resumeOf` already points to a candidate that is in the matching set and is the top candidate, keep `currentJob.resumeOf`.
       - Otherwise, return `matchingCandidates[0]?.id ?? null` (which updates `resumeOf` when `grok` continued a different router session than guessed, and **clears `resumeOf` to `null`** when `grok` continued an external session unknown to the router).
     - If `currentJob.linkage === "resume"`:
       - If `currentJob.resumeOf` was `null` pre-run (e.g., title-based `-r <title>`), return `matchingCandidates[0]?.id ?? null`.
       - Otherwise keep `currentJob.resumeOf` (unless it would form a cycle).

### 4. Plain-Output Chains and Concurrency Notes (`A-F`, `C-D`)

- **Chains of plain-output `-c` turns (`A-F`)**:
  - Plain-output `cli` runs (without `--output-format json`) record `grokSessionId: "unknown"`. Because `"unknown"` is excluded by the known-session filter and emits no JSON `sessionId` for post-run reconciliation, a plain-output turn cannot serve as the predecessor for a subsequent `-c` turn. A chain of two plain-output `cli -c -p` turns will link the first plain turn to the prior JSON job (if any), while the second plain turn will skip the first plain turn (or record `resumeOf: null` if no prior JSON job exists).
  - This will be stated explicitly in `CHANGELOG.md` under `0.3.8`, noting that `--output-format json` is required when chaining multiple `cli -c` turns.
- **Concurrent `-c` runs (`C-D`)**:
  - If two `-c` jobs start concurrently before either finishes, the `candDoneMs <= upperBoundMs` boundary prevents them from linking to each other, the cycle guard prevents reciprocal cycles, and both link to the same prior completed session job.

---

## 4. Phase B Test Plan (With Exact Failure Reasons at `dbe13e0`)

All behavioral tests below run through `runCompanion` (in `tests/companion.test.mjs`) or `parseGrokHelp` (in `tests/help.test.mjs`) and fail on their behavioral assertions at `dbe13e0` before any implementation code is written.

| # | Target Finding | Test Description & Setup | Exact Failure Reason at `dbe13e0` (Before Fix) |
|---|---|---|---|
| **T-A1a** | **A1 / R3-10 / A-I** | `cli -p "--help" --output-format json`, `cli -p "hello" -- --help`, and combined short cluster `cli -cp "hello" --output-format json` are tracked as router jobs (emit `Job ID:` on stderr and persist a job record with `request.prompt`). | Fails `assert.match(res.stderr, /Job ID:\s+\S+/)`: at `dbe13e0`, `classifyCliArgs` uses `args.includes("--help")` and sets `helpOnly: true` for the first two legs (`stderr` is `""`), and `-cp` is unrecognized as `-c` + `-p` so `hasPromptOrResume` is `false` for the third leg. |
| **T-A1b** | **A1 / A-G / A-I** | Using `GROK_FAKE_FIXTURES` pointed at a temp fixture dir written with `helpText({ flags: "      --custom-filter <EXPR>\n          Filter expression\n" })`: (1) assert `cli --help` output contains `--custom-filter <EXPR>`; (2) assert `cli --custom-filter --best -p "hello" --output-format json` exits `0` and is tracked; (3) assert `cli sessions --json` (router-named flag after a known subcommand) is not rejected as a router option. | Fails `assert.equal(res.status, 0)` on legs (2) and (3): at `dbe13e0`, `parseCliInput` runs before `readGrokHelp`, uses the static `CLI_KNOWN_VALUE_FLAGS` set (which lacks `--custom-filter`), and continues scanning past subcommand positionals, exiting `1` with `--best is a router option...` and `--json is a router option...`. |
| **T-A1c** | **A-H / A-I** | In `tests/help.test.mjs`: refresh `tests/fixtures/grok-help.txt` line 17 to `(compat aliases: --allowedTools, --allowed-tools)` and test `parseGrokHelp` on plural/singular `(compat alias(es): ...)`, `--flag=<VAL>`, `<FILE>...` variadics, short-only `-x`, same-line `[aliases: ...]`, and `parseWarnings` on malformed option lines. | Fails `assert.deepEqual(allow.aliases, ["--allowedTools", "--allowed-tools"])`: at `dbe13e0`, `parseAliases` only matches `[aliases: ...]`, returning `[]` for `--allow`, `--deny`, and `--system-prompt-override`, misclassifying `--flag=<VAL>` as boolean, and returning `parseWarnings: []` on malformed option lines. |
| **T-A2a** | **A2 / C-B / C4 / A-B** | In `tests/companion.test.mjs`: Turn 1 `analyze` succeeds with session `sid1`; Turn 2 `analyze --lanes a,b` creates completed `grok-lane` leaf jobs; Turn 3 `cli -p "fail"` fails (`GROK_FAKE_AUTH: "1"`); Turn 4 `cli -c -p "after fail and lanes" --output-format json` (`GROK_FAKE_SESSION: sid1`) asserts `turn4Job.resumeOf === turn1Id`; Turn 5 bare `cli -r -p "bare resume" --output-format json` (`GROK_FAKE_SESSION: sid1`) asserts `turn5Job.resumeOf === turn4Id`; Turn 6 `cli -c -p "reconcile to sid1" --output-format json` after a Turn 5b with `sid2` but reporting `GROK_FAKE_FORCE_SESSION: sid1` reconciles `resumeOf` to `turn5Id`. | Fails `assert.equal(turn4Job.resumeOf, turn1Id)`: at `dbe13e0`, `findPriorJobForContinue` picks the failed Turn 3 job (`cli-...`) because it neither filters out `failed` jobs nor excludes `grok-lane` leaves, and bare `cli -r` records `resumeOf: null`. |
| **T-A2b** | **A-A / Codex R4-4 / Claude R4-1** | Initialize a real Git repo (`initGitRepo(tempDir)`) and create subdirectory `subDir = path.join(tempDir, "sub")`. Assert `resolveStateDir(tempDir) === resolveStateDir(subDir)`. Turn 1: `analyze --json "Root turn"` in `tempDir` (`GROK_FAKE_SESSION: sid`). Turn 2: `analyze --cwd subDir --continue --json "Managed sub turn"` (`GROK_FAKE_SESSION: sid`). Assert `turn2Job.resumeOf === turn1Job.id` and `turn2Job.executionCwd === fs.realpathSync.native(tempDir)` (or `path.resolve(tempDir)`). Also run labeled guard `cli --cwd subDir --continue -p "Plain cli sub turn"` and assert `resumeOf === null`. | Fails `assert.equal(turn2Job.resumeOf, turn1Job.id)`: at `dbe13e0`, `runRouted` calls `findPriorJobForContinue(workspaceRoot, subDir)` which compares `turn1Job.cwd` (`tempDir`) against `subDir`, returning `null` (`null !== turn1Job.id`), even though managed mode executes `grok` in `workspaceRoot` (`tempDir`). |
| **T-C2** | **C2 / A-E** | Turn 1 (`J1`) reports session `S`; Turn 2 (`J2`) runs `cli -r S -p "plain"` (plain output -> `grokSessionId: "unknown"`, `request.controls.resume: "S"`); Turn 3 (`J3`) runs `cli -r S -p "third" --output-format json` (`GROK_FAKE_SESSION: S`) -> assert `J3.resumeOf === J2.id`. Also verify `--fork-session`: Turn 4 runs `cli -c --fork-session -p "forked" --output-format json` (`GROK_FAKE_FORCE_SESSION: forkedSid`) -> assert `J4.resumeOf === J3.id` (not erased by post-run reconcile). Also verify contradictory session guard (`A-E`): if `J_reassign` requested `-r S` but reported `otherSid`, a subsequent `-r S` links to `J3` (not `J_reassign`). | Fails `assert.equal(turn3Job.resumeOf, turn2Id)`: at `dbe13e0`, `findPriorJobForResume` only checks `job.grokSessionId === ref`, skipping `J2` and returning `J1`. |

---

## 5. Additional Phase B Items (Queued for Phase B Implementation)

1. **A3 (Relabel `5b210f1` / `f19aaf0` in PR body and clean up F2 test)**:
   - In the PR #6 description, relabel `5b210f1 -> f19aaf0` (F2 and N4) as **strengthened regression coverage + test-export refactor**, citing `b3b5695` (F2 timeout) and `6dc1833` (N4 chain walk) for the behavioral changes.
   - Simplify the F2 test in `tests/companion.test.mjs` to call `handleCli` from `lib/cli.mjs` via its `runProcessImpl` seam without mutating `globalThis.setTimeout`, `process.stdout.write`, or `process.env` (`Claude R3-11` / `Codex G6`).
2. **A5 (Remove explanatory comments)**:
   - Remove the explanatory comments in `tests/companion.test.mjs` (lines 316, 352, 369, 715, 719, 724, 786, 799, 811) and `plugins/grok-router/scripts/lib/router.mjs` (lines 171-173), folding any needed context into test names or assertion messages.
3. **C1 (Revert `stopAtPositional: false` on `status` / `result` / `cancel`)**:
   - Restore `stopAtPositional: true` on `handleStatus`, `handleResult`, and `handleCancel` in `grok-companion.mjs`, and pass `--cwd` before the positional `<jobId>` in `tests/companion.test.mjs`.
