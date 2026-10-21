# Round 4 Phase A Design (Rev 2): Single CLI Tokenizer and Session-Backed Ancestry (`lib/cli.mjs`)

## 1. Premise Test & Core Tokenizer Invariants

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
     - Passing combined short flags (`cli -cp "hello"`) leaves `request.controls.continue` as `false` because `-cp` is not recognized as `-c` + `-p`.
2. **Why router job-record order fails for `--continue` (`A2`)**:
   - `findPriorJobForContinue` (`grok-companion.mjs:498-505`) selects the newest job by `updatedAt` in any status (including `failed` jobs with `grokSessionId: null`, `running` jobs, and `grok-lane` leaves whose `cwd` is `undefined` and falls back to `workspaceRoot`) before `grok` runs, and compares `job.cwd` against `--cwd <subfolder>` even though managed modes (`runStoredJob` -> `runGrokPrintJob(workspaceRoot, ...)`) execute `grok` in `workspaceRoot`.

---

### Two Foundational Design Rules (Adopted to Prevent Over-Modelling Grok's Grammar)

Several round-4a review findings (`R-B`, `R-C`, `R-D`) stemmed from trying to make the router fully reproduce clap's internal grammar and rewrite `grok`'s `argv`. We adopt two strict rules across `lib/cli.mjs` and `lib/help.mjs`:

1. **Rule (1) — Classify and extract only; never re-expand or rewrite native `argv`**:
   - The `passthroughArgs` array passed to `grok` is **always** the user's original tokens minus stripped router-owned options (`--cwd`, `-C`, `--timeout-ms`, `--allow-mutating`, `--allow-dangerous`).
   - Short-flag cluster expansion (`-cp`, `-cphello`, `-rc`) is **purely internal** to `tokenizeCliArgv` for classification and metadata extraction; `passthroughArgs` keeps the exact original token (`-cp`, `-cphello`, `-rc`) untouched.
   - The **sole** exception where a native argument value is translated is when the user explicitly passes a router `<jobId>` to standalone `-r <jobId>`, `--resume <jobId>`, or `--resume=<jobId>` (the documented router convenience feature from #5 / Finding 4). If a router `<jobId>` is embedded inside an ambiguous or combined short cluster (e.g., `-cr=<jobId>`), the router does not rewrite the cluster; it fails closed or requires standalone `-r <jobId>` / `--resume <jobId>`.
2. **Rule (2) — Fail closed on ambiguity**:
   - Untracked `cli` is an allow-list, not a denylist. A run is untracked only when every option is recognized from the grammar built from live `grok --help` and the whole shape is one of:
     1. bare `--help` / `-h`, or bare `--version` / `-v`, only when the grammar built from `grok --help` maps that spelling to `--help` or `--version` (both were untracked in 0.3.8 when the fixture agreed),
     2. `help <known subcommand...>` where every token after `help` is a command name from that grammar,
     3. `<known subcommand> [path tokens] [--help | -h]...` with at least one help flag, nothing before the subcommand, and no other dash token. A child-argv command is the exception: `wrap` forwards trailing argv to a child, so any non-help token (`cli wrap echo hi --help`) is tracked. `cli wrap --help` with only help flags stays untracked,
     4. a bare command from the explicit read-only set `READ_ONLY_CLI_SUBCOMMANDS` (evidence in the table below).
   - Anything else is tracked, or rejected when the token is an unconsumed router-owned option. That includes an unknown long flag, an unknown short flag, an unknown `--flag=value`, any token before a subcommand (`cli --future-value sessions --help`, `cli -Z sessions`), and bare commands that execute, mutate, register, or network. A new grok subcommand is tracked until it is added to that set.
   - A router-owned flag name cannot be passed through to a grok subcommand. `ROUTER_OWNED_OPTIONS` and `CLI_REJECTED_ROUTER_OPTIONS` (including `--json`, `-C` / `--cwd`, `--timeout`, and `--raw-arg-string`) are rejected in every position where they are not consumed by the router. There is no escape hatch if grok later adds one of those names to a subcommand. `--` forwards the following tokens literally, and it also ends grok's option parsing, so it does not deliver `--json` as a subcommand flag. Real grok 1.0.62 has no `--json` on `sessions`, `sessions list`, or `models`.
   - `write: false` is an allow-list, the same way untracked is. It is recorded only when the argv exactly matches a fully parsed prompt or session-resume:
     1. every option before `--` is a known grammar option, and every value-taking option has its value,
     2. `--tools` is present and every listed tool is read-only,
     3. the shape is a prompt or session-resume (`-p` / `--single`, `--prompt-file`, `--resume` / `-r`, or `--continue` / `-c`),
     4. there is no positional token before `--`.
   - Tokens after `--` are literal payload and do not by themselves leave that allow-list. Anything else records `write: "unknown"`, including a positional grok subcommand, a mixed shape (`--tools read_file -p hi doctor fix`, `-c doctor fix`, `-p hi sessions delete X`), a positional prompt, and any unparsed option. A fully parsed prompt whose `--tools` include a non-read-only tool still records `write: true`, as do `--always-approve` and `--yolo` on that same fully parsed shape.
   - A mutating shape requires `--allow-mutating`. Grok's real usage is `[OPTIONS] [PROMPT] [COMMAND]`, so the router does not guess which positional is the command. The first and the second plain positional (a non-option word before `--`) are both candidate commands. No positional token is rewritten.
   - Require `--allow-mutating` when any candidate is a `MUTATING_COMMAND` (`login`, `logout`, `plugin`, `mcp`, `setup`, `update`, `memory`, `worktree`, `clone`) or a parent with mutating sub-actions (`doctor fix`, `sessions delete`, `sessions restore`). `mcp add`/`remove` stays refused because `mcp` itself is a mutating command. For a parent, any later plain token is a sub-action; an unknown option does not occupy that slot, so `sessions --future delete X`, `sessions -Z delete X`, and `doctor --future fix` are refused. Help-only shapes do not require the flag.
   - Known payload stays excluded after a non-mutating candidate command: `wrap` child argv, `sessions list`/`search` terms, and `usage` arguments. Those tokens are not candidates and are not sub-actions, so `wrap echo login`, `sessions search delete`, and `usage login` stay tracked with `write: "unknown"`.
   - This refuses some shapes that are safe. `-c login version` puts `login` in a candidate slot even when the word is only a prompt and `version` is the command. `--allow-mutating` is the escape hatch. The gate still does not rewrite argv.
   - Whenever a token or boundary is ambiguous (an unknown short-flag cluster, an unknown flag after a subcommand, an unverified variadic boundary, or an unparsed option when `grok --help` is unavailable), the router **fails closed**:
     - It does **not** guess that the run is `helpOnly: true` (so the run is tracked as a job rather than silently dropped).
     - It does **not** guess that `write` is `false` outside the allow-list above. `-h` and `-v` are help or version only when the grammar built from `grok --help` gives them that canonical meaning, not because of their spelling.
     - In `discoverGrokControls`, canonical flag identity and policy/danger classification (`POLICY_OWNED_OPTIONS`) are anchored on the declared header `long` flag so no alias can ever demote a policy-owned flag into `safe-forward`.

#### Read-only allow-list evidence

The round-4 triage measured these bare commands on real grok 1.0.62 under a sandbox that denied network, writes under the home directory, and the pasteboard. The one-line descriptions are still the `Commands:` section of `tests/fixtures/grok-help.txt`.

Kept (bare argv only; any extra token is tracked):

| Entry | Evidence | Why bare stays untracked |
|---|---|---|
| `completions` | Fixture: "Generate shell completion scripts (bash, zsh, fish, powershell, ...)". Real grok 1.0.62 exits 2 when run bare because it needs `<SHELL>`. | Bare `completions` does not install a script or edit a shell rc. `cli completions zsh` has an extra token and is tracked. |
| `doctor` | Fixture: "Check terminal, clipboard, color, and input support without starting Grok". Real grok 1.0.62 exits 0 and prints a report. `doctor fix` applies fixes and requires `--allow-mutating`. | Bare `doctor` does not start Grok. `cli doctor fix` is tracked and refused without `--allow-mutating`. |
| `help` | Fixture: "Print this message or the help of the given subcommand(s)". Real grok 1.0.62 exits 0. | Prints help. `help <known command>` is allow-list shape 2. `help <unknown>` is tracked. |
| `inspect` | Fixture: "Show the configuration Grok discovers for this directory" (rules, skills, plugins, hooks, MCP). Real grok 1.0.62 exits 0 and prints a local config report. | Local discovery report. An extra flag is tracked, and `--json` is rejected as router-owned. |
| `sessions` | Fixture: "List, search, or restore sessions". Real grok 1.0.62 exits 2 when run bare because it needs `list`, `search`, or `delete`. | Bare `sessions` does not delete or restore. `delete` and `restore` require `--allow-mutating`. `list` and `search` are tracked. Native flags such as `--limit` are tracked, not rejected. |
| `usage` | Fixture: "Print persisted token and cost usage for a session". Real grok 1.0.62 exits 2 when run bare because it needs `SESSION_ID`. | Bare `usage` does not print or upload a session. `cli usage <session-id>` is tracked. |
| `version`, `v` | Fixture: "Print version information [aliases: v]". Real grok 1.0.62 exits 0. | Prints the version. Bare `cli --version` and `cli -v` are allow-list shape 1 only while the help grammar maps those spellings to `--version`. |

Removed from the bare set:

| Entry | Evidence | Why it is tracked |
|---|---|---|
| `wrap` | Fixture: "Run any command with local clipboard support (forwards OSC 52 to the system clipboard)". | Executes an arbitrary child and writes the clipboard. `CHILD_ARGV_COMMANDS` also keeps `cli wrap echo hi --help` tracked. `cli wrap --help` alone stays untracked. |
| `agent` | Fixture: "Run Grok without the interactive UI". Real grok 1.0.62 `agent --help` (round-3 triage) includes stdio, headless, serve, and leader modes plus `--always-approve`. | Executes Grok. |
| `cursor-worker` | Fixture: "Register this machine as a Cursor private worker (via the leader)". Confirmed by real `grok cursor-worker --help` on 1.0.62. | Registers this machine. |
| `dashboard` | Fixture: "Open the Agent Dashboard view at startup". The dashboard can reply, dispatch, pin, and stop agents. | Executes an interactive UI. |
| `leader` | Fixture: "Manage running leader processes". | Process control, not a print-only command. Not verified as free of `kill`, so it is not allow-listed. |
| `export` | Fixture: "Export a session transcript as Markdown". `grok export [output]` can write a path or the clipboard. | Can mutate the filesystem or clipboard. |
| `trace` | Fixture: "Export or upload session trace data". | Writes a trace export and can upload it. |
| `models` | Fixture: "List available models and exit". Real grok 1.0.62, with network denied, prints a stale catalog (grok-4.6) instead of the live catalog (grok-4.7-build-fast) and logs a telemetry HTTP export error. | Uses the network and sends telemetry. No exception. |
| `du`, `disk-usage` | Fixture: "Show what the grok home (~/.grok) uses on disk [aliases: disk-usage]". Real grok 1.0.62 exits 0, and the write-deny sandbox blocked an attempt to open `~/.grok/worktrees.db` for writing. `--clean` exists and is an extra token. | Opens `~/.grok/worktrees.db` read-write (blocked in test). No exception. The alias is tracked too. |

---

### Can a Single Tokenizer Be Built from `grok --help`? (`A-C`, `A-H`, `A-I`, `R-A`, `R-B`, `R-D`)

**Yes, under Rules (1) and (2).**

#### Help-Text Formats in the Repository and Live Grok 1.0.60 (`A-H`, `R-B`)

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
2. **Single-line subcommand help (`tests/fixtures/grok-models-help.txt`, 10 lines)**:
   ```text
   Options:
         --debug                 Enable debug logging
         --debug-file <FILE>     Write debug logs to FILE
     -h, --help                  Print help
         --leader-socket <PATH>  Use a custom leader socket path ...
   ```
3. **Alias Extraction Without Dropping Command Aliases or Flipping Policy (`A-H`, `R-B`)**:
   - **Live Grok 1.0.60 fixture refresh**: `tests/fixtures/grok-help.txt:17` is updated to `Permission allow rule (compat aliases: --allowedTools, --allowed-tools)`.
   - **Generic `parseAliases(text)` in `plugins/grok-router/scripts/lib/help.mjs` (`R-B` part 1)**:
     - `parseAliases(text)` is called for both commands (`du` -> `["disk-usage"]`, `version` -> `["v"]`) and flags (`--reasoning-effort` -> `["--effort"]`, `--allow` -> `["--allowedTools", "--allowed-tools"]`).
     - Therefore, `parseAliases(text)` must **not** filter by `startsWith("-")`. Instead, `parseAliases(text)` returns all comma-separated tokens from `[aliases: ...]` and `(compat alias(es): ...)`, and only flag attachment filters to `alias.startsWith("-")`:
       ```js
       function parseAliases(text) {
         const raw = String(text ?? "");
         const collected = [];
         for (const bracket of raw.matchAll(/\[aliases:\s*([^\]]+)\]/gi)) {
           collected.push(...bracket[1].split(","));
         }
         for (const compat of raw.matchAll(/\(compat alias(?:es)?:\s*([^)]+)\)/gi)) {
           collected.push(...compat[1].split(","));
         }
         return unique(
           collected
             .map((item) => item.trim())
             .filter(Boolean)
         );
       }
       ```
     - In `parseCommandLine`, `parseAliases(description).map((alias) => alias.replace(/^--/, ""))` continues to yield `["disk-usage"]` for `du` and `["v"]` for `version`.
     - In `parseGrokHelp` flag handling, `extraAliases.filter((alias) => alias.startsWith("-"))` attaches only dash-prefixed aliases to `currentFlag.aliases`.
   - **Canonical Flag Identity & Policy Classification in `plugins/grok-router/scripts/lib/live-controls.mjs` (`R-B` part 2)**:
     - In `live-controls.mjs:50-87`, `discoverGrokControls(helpText)` previously picked `const flag = longName(parsed.names)` (the longest lowercase `--` name). When `--allowed-tools` was added to `parsed.names` on `--allow`, `longName` picked `--allowed-tools` (`option: "allowed-tools"`) instead of the header `parsed.long` (`"--allow"`), which caused `POLICY_OWNED_OPTIONS.has(option)` and ` ["allow", "deny"].includes(option)` to evaluate to `false`!
     - Fix (`R-B`): The canonical flag is **always** `const flag = parsed.long ?? longName(parsed.names);` (the header long flag when present). Furthermore, `policy`, `routerOwned`, `dangerous`, and `repeatable` check both the canonical `option` and all `aliases`:
       ```js
       const flag = parsed.long ?? longName(parsed.names);
       if (!flag) {
         return [];
       }
       const option = optionName(flag);
       const aliases = unique(
         parsed.names
           .filter((name) => name && name !== flag)
           .map(optionName)
       );
       const allOptionNames = [option, ...aliases];
       const policy = allOptionNames.some((name) => POLICY_OWNED_OPTIONS.has(name));
       const routerOwned = allOptionNames.some((name) => ROUTER_OWNED_OPTIONS.has(name));
       const repeatable = Boolean(parsed.variadic) || allOptionNames.some((name) => ["allow", "deny"].includes(name));
       ```
     - Result: `--allow` remains `flag: "--allow"`, `option: "allow"`, `optionAliases: ["allowedTools", "allowed-tools"]`, `policy: true`, `dangerous: true`, `repeatable: true`, and is never exposed in `safeForward`.

#### Supported Help Grammar, Variadics, and Parse Warnings (`A-I`, `R-D`)

1. **Option header formats supported by `parseFlagLine(line)`**:
   - Long or short+long: `^\s{2,}(?:(-[A-Za-z0-9]),\s*)?(--[A-Za-z0-9][A-Za-z0-9-]*)`
   - Short-only: `^\s{2,}(-[A-Za-z0-9])(?=\s|$)` (`short: "-x"`, `long: null`, `names: ["-x"]`).
   - Value token separator: whitespace or `=` (`(?:\s+|=)(<[^>]+>|\[\s*<[^>]+>\s*\])`).
   - Variadic value token (`<X>...` or `[<X>...]`): sets `variadic: true`, strips `...` from `valueHint`, and preserves `requiresValue` / `optionalValue`.
   - Same-line description (`(?:\s{2,}(.+))?$`): captured on the header line so single-line help (`grok-models-help.txt`) and same-line `[aliases: ...]` / `(compat alias...: ...)` are parsed immediately.
2. **Parse warnings on unparsed option lines**:
   - In `parseGrokHelp(text)`, when `section === "options"` and a line matches `/^\s{2,6}-\S/` but `parseFlagLine(line)` returns `null`, `parseWarnings.push(\`unparsed option line: ${trimmed}\`)` is emitted.
3. **Variadic `<X>...` consumption rule in `tokenizeCliArgv` (`R-D`)**:
   - `CliGrammar` carries `variadicFlags: Set<string>` (populated from any flag where `parsed.variadic === true`).
   - When `tokenizeCliArgv` encounters a separate-value flag in `grammar.valueFlags` or `grammar.optionalValueFlags`:
     - It consumes the first value token (if required, or if optional and not starting with `-`).
     - If the flag is also in `grammar.variadicFlags`, it continues consuming subsequent tokens into an array `values` **up to the next token starting with `"-"` (or `"--"` or end of `argv`)**, pushing each consumed token unchanged to `passthroughArgs`.

#### Complete Flag & Arity Table Yielded from `tests/fixtures/grok-help.txt` (41 Flags: 23 Required-Value, 2 Optional-Value, 16 Boolean; 25 Subcommands)

| Canonical Flag (`parsed.long`) | Short | Extracted Aliases (from Help) | Arity (`kind`) | Policy / Router |
|---|---|---|---|---|
| `--agent` | — | — | `value` (required) | `safe-forward` |
| `--agents` | — | — | `value` (required) | `safe-forward` |
| `--allow` | — | `--allowedTools`, `--allowed-tools` | `value` (required, repeatable) | `policy-owned` |
| `--always-approve` | — | — | `boolean` (0) | `policy-owned` |
| `--continue` | `-c` | — | `boolean` (0) | `safe-forward` (managed control) |
| `--cwd` | — | — | `value` (required) | `router-owned` |
| `--debug` | — | — | `boolean` (0) | `safe-forward` |
| `--debug-file` | — | — | `value` (required) | `safe-forward` |
| `--deny` | — | `--disallowedTools` | `value` (required, repeatable) | `policy-owned` |
| `--disable-web-search` | — | — | `boolean` (0) | `safe-forward` |
| `--disallowed-tools` | — | — | `value` (required) | `policy-owned` |
| `--fork-session` | — | — | `boolean` (0) | `safe-forward` |
| `--fullscreen` | — | — | `boolean` (0) | `safe-forward` |
| `--help` | `-h` | — | `boolean` (0) | `safe-forward` |
| `--include-partial-messages` | — | — | `boolean` (0) | `safe-forward` |
| `--json-schema` | — | — | `value` (required) | `safe-forward` |
| `--leader-socket` | — | — | `value` (required) | `safe-forward` |
| `--model` | `-m` | — | `value` (required) | `safe-forward` (managed control) |
| `--max-turns` | — | — | `value` (required) | `safe-forward` |
| `--minimal` | — | — | `boolean` (0) | `safe-forward` |
| `--no-alt-screen` | — | — | `boolean` (0) | `safe-forward` |
| `--no-plan` | — | — | `boolean` (0) | `safe-forward` |
| `--no-subagents` | — | — | `boolean` (0) | `safe-forward` |
| `--oauth` | — | — | `boolean` (0) | `safe-forward` |
| `--output-format` | — | — | `value` (required) | `safe-forward` |
| `--single` | `-p` | — | `value` (required) | `safe-forward` |
| `--permission-mode` | — | — | `value` (required) | `policy-owned` |
| `--prompt-file` | — | — | `value` (required) | `safe-forward` (managed control) |
| `--prompt-json` | — | — | `value` (required) | `safe-forward` |
| `--resume` | `-r` | — | `optional-value` (0 or 1) | `safe-forward` (managed control) |
| `--reasoning-effort` | — | `--effort` | `value` (required) | `safe-forward` (managed control) |
| `--restore-code` | — | — | `boolean` (0) | `safe-forward` |
| `--rules` | — | — | `value` (required) | `safe-forward` |
| `--session-id` | `-s` | — | `value` (required) | `safe-forward` |
| `--sandbox` | — | — | `value` (required) | `policy-owned` |
| `--system-prompt-override` | — | `--system-prompt` | `value` (required) | `safe-forward` |
| `--tools` | — | — | `value` (required) | `policy-owned` |
| `--version` | `-v` | — | `boolean` (0) | `safe-forward` |
| `--verbatim` | — | — | `boolean` (0) | `safe-forward` |
| `--worktree` | `-w` | — | `optional-value` (0 or 1) | `safe-forward` |
| `--worktree-ref` | — | `--ref` | `value` (required) | `safe-forward` |

---

#### Help Timeout Scoped Only to `readGrokHelp`, Validation Gate, and Merge Precedence (`A-C`, `R-A`, `K-A`)

1. **Timeout Scoped Only to `readGrokHelp` (`R-A`)**:
   - `runCommand(command, args = [], options = {})` in `plugins/grok-router/scripts/lib/process.mjs` remains **unbounded by default** (`timeout: options.timeoutMs > 0 ? options.timeoutMs : undefined`). It does **not** impose a default timeout on `git rev-parse`, `git status`, `git diff`, `grok models`, `grok inspect`, `ps`, or `help <subcommand>`.
   - When `spawnSync` returns `result.error` or a non-null `result.signal`, `runCommand` normalizes `status`:
     ```js
     const timedOut = result.error?.code === "ETIMEDOUT";
     const status = result.status ?? (result.error || result.signal ? 1 : 0);
     return { command, args, status, signal: result.signal ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null, timedOut };
     ```
   - Only `readGrokHelp(cwd, env = process.env, { timeoutMs = 5000 } = {})` in `plugins/grok-router/scripts/lib/grok.mjs` passes `{ cwd, env, timeoutMs }` to `runCommand`.
2. **Shared Help Acceptance Gate (`A-C`, `K-A`)**:
   - In `readGrokHelp`:
     ```js
     const stdout = String(result.stdout ?? "");
     const byteLength = Buffer.byteLength(stdout, "utf8");
     const ok = !result.error && result.status === 0 && stdout.trim().length > 0 && byteLength <= 256 * 1024;
     return { ok, text: ok ? stdout : "", result };
     ```
   - **Degraded behavior across all callers when `ok === false` (`K-A`)**:
     - `handleCli`: `buildCliGrammar(help)` uses `FALLBACK_CLI_GRAMMAR` (`helpAvailable: false`).
     - `discoverRoutedSurface` (`grok-companion.mjs:159`): `helpText` is `""`, so `nativeControls` is `[]` (managed modes still support all router-owned options and controls).
     - `handleSurface` (`grok-companion.mjs:328`): `coverageForSurface(help.text)` receives `""` (empty coverage lists rather than misparsing `stderr`), while `help: commandPayload(help.result)` still shows the raw `stderr`/exit status of `grok --help`.
     - `listTools` (`grok-router-mcp.mjs:50`): `help.ok` is `false`, so MCP tools expose `staticProperties()` without crashing.
3. **Three-Tier Precedence & Fallback-Mode Limitation (`A-C`)**:
   - **Tier 1 (Router-owned options)**: `--cwd` (and standalone `-C`), `--timeout-ms`, `--allow-mutating`, `--allow-dangerous`, plus the rejected router-only option set (`--json`, `--background`, `--lean`, `--best`, etc.), are resolved first in option position before consulting `CliGrammar`.
   - **Tier 2 (Validated live `grok --help` when `help.ok === true`)**: Every flag name/alias in `parseGrokHelp(help.text)` is placed into its live arity set (`valueFlags`, `optionalValueFlags`, or `booleanFlags`) and removed from the other two sets, overriding `FALLBACK_CLI_GRAMMAR`.
   - **Tier 3 (`FALLBACK_CLI_GRAMMAR` seed)**: Contributes only names absent from live help (such as hidden `--yolo`) when `help.ok === true`, or the full Grok 1.0.60 baseline when `help.ok === false`.
   - **Fallback-mode limitation**: When `help.ok === false`, an unknown future native value flag followed by a router-named value (`--unknown-future-flag --best`) can still misparse `--best` as an option-position token. When `tokenizeCliArgv` rejects a router flag while `grammar.helpAvailable === false`, the error message appends ` (grok --help was unavailable; parsed using fallback CLI grammar)`.

---

## 2. Architect Sketch for `plugins/grok-router/scripts/lib/cli.mjs` (`A1`, `A4`, `A-D`, `A-I`, `R-C`, `R-D`, `K-C`)

### Module Boundaries & Shared Helpers (`A4`, `C-A`, `K-C`)

- **Helpers moved so `lib/cli.mjs` has zero dependency on `grok-companion.mjs`**:
  - `normalizeArgv(argv)` lives in `plugins/grok-router/scripts/lib/args.mjs` for non-cli entry points. `cli` does not call it. `normalizeCliArgv` splits only the explicit first-position wrapper `--raw-arg-string <one token>`. Any other arity of a first-position `--raw-arg-string` throws `--raw-arg-string requires exactly one following token: the raw argument string`. A non-first `--raw-arg-string` or `--raw-arg-string=...` stays a router-option rejection. A single argv element that contains spaces (`cli "sessions --json"`) is not re-split.
  - `resolveCwd(options)` moves to `plugins/grok-router/scripts/lib/workspace.mjs` (and is re-imported by `grok-companion.mjs`).
  - `emitJobStarted(job)` is imported from `plugins/grok-router/scripts/lib/render.mjs`.
- **New module**: `plugins/grok-router/scripts/lib/cli.mjs` (~450–520 lines).
- **Entry script (`plugins/grok-router/scripts/grok-companion.mjs`)**:
  - Drops from **1,238 lines** to **~795 lines**.
  - Re-exports `classifyCliArgs` from `./lib/cli.mjs`.
  - **Backward-compatible `classifyCliArgs(args, helpText)` contract (`K-C`)**:
    - Returns `{ helpOnly, mutating, unclassified, first }` without throwing on router-only flags (passes `{ rejectRouterFlags: false }` to `tokenizeCliArgv`), preserving full behavioral and shape compatibility for any external caller of `classifyCliArgs`.
  - In the extraction commit, test imports of `handleCli` and `resolveKnownSessionId` in `tests/companion.test.mjs` are updated in the same commit to import from `../plugins/grok-router/scripts/lib/cli.mjs` (`K-C`).

### Single-Pass Tokenizer Rules (`tokenizeCliArgv(normalizedArgv, grammar, { rejectRouterFlags = true } = {})`)

1. **No `--cwd` Pre-Scan (`A-D`)**:
   - `handleCli` calls `const help = readGrokHelp(process.cwd(), env)` once, builds `const grammar = buildCliGrammar(help)`, and runs `tokenizeCliArgv(normalizeCliArgv(argv), grammar)`.
2. **Option-Position Boundary and Subcommand Handling (`A-I`, `R-D`, `R-G`)**:
   - `inOptionPosition` starts `true`.
   - It becomes `false` when:
     a. `--` is reached: `--` and all remaining tokens are pushed verbatim to `passthroughArgs` and emitted as `{ kind: "separator" }` followed by `{ kind: "positional" }`.
     b. A positional token is reached that is a known subcommand (`grammar.commandNames.has(token)`), e.g., `models`, `sessions`, `clone`, `wrap`, `help`.
   - **After a known subcommand (`inOptionPosition === false`, before `--`) (`R-D`, round-2 allow-list)**:
     - Recognized non-router tokens are pushed verbatim to `passthroughArgs`. Router-owned options are rejected anywhere they are not consumed, including after a subcommand and as `--flag=value`. Consumed forms are only `--cwd` / `-C`, `--timeout-ms`, `--allow-mutating`, `--allow-dangerous` (in option position), and `--raw-arg-string` as the first-position wrapper. `--raw-arg-string` and `--timeout` are in `CLI_REJECTED_ROUTER_OPTIONS`. Tokens after `--` stay literal. This supersedes the earlier rule that forwarded router-named flags such as `cli sessions --json`.
     - **Help-only is a narrow shape (`R-D`)**: Because root help does not describe subcommand option arities, a general scan for the spelling `--help` or `-h` could mistake a subcommand option's value (or `grok wrap` child arguments) for a help flag and suppress mutating classification. `-h` counts as help only when the grammar's canonical for that spelling is `--help`. A subcommand invocation is classified as `helpOnly: true` **only** when:
       1. The subcommand itself is `"help"` (`first === "help"`), OR
       2. A top-level `--help` / `-h` option appeared *before* the subcommand, OR
       3. Every token after the subcommand `first` (with no `--` separator) is either a non-flag subcommand path token or `"--help"` / `"-h"` and at least one `"--help"` / `"-h"` is present (e.g., `cli clone --help`, `cli models -h`, or `cli mcp add --help`). If any other `-` flag appears after the subcommand (e.g. `cli login -x --help`), the classifier fails closed (`helpOnly: false`) so `mutating` is never suppressed. The untracked allow-list is stricter than this `helpOnly` flag for child-argv commands: `wrap` with any non-help token (`cli wrap echo hi --help`) is tracked even though those tokens are not dash flags.
3. **Left-to-Right Short-Token & Cluster Algorithm (`R-C`, Rules (1) & (2))**:
   - Under **Rule (1)**, the token pushed to `passthroughArgs` is **always** the original `token` (plus the next token if a separate value is consumed). Cluster scanning only emits `CliToken` metadata records.
   - When `inOptionPosition === true` and `token` is a short option (`token.startsWith("-") && !token.startsWith("--") && token !== "-"`):
     - **Step 1 — Standalone Router `-C`**:
       - If `token === "-C"`: consume `next` into `routerOptions.cwd` (throw if `next === undefined`), do not push to `passthroughArgs`.
       - `-C` is **only** recognized as a router option when standalone (`token === "-C"`). Inside any cluster (e.g. `-cC`), `'C'` is not a known native short flag, so the cluster fails closed as an opaque option (Step 3) and is forwarded untouched to `grok`.
     - **Step 2 — Standalone 2-char Short Flag (`token.length === 2`, e.g. `-p`, `-r`, `-c`, `-m`, `-h`)**:
       - Let `shortName = token`, `canonical = grammar.canonicalFlag.get(shortName) ?? shortName`.
       - If `grammar.valueFlags.has(shortName)`: consume `next` (if present) as its value, push `token` (and `next`) to `passthroughArgs`, emit `{ kind: "option", name: shortName, canonical, value: next ?? null, inline: false, passthroughIndex, passthroughValueIndex }`.
       - Else if `grammar.optionalValueFlags.has(shortName)`: if `next !== undefined && !String(next).startsWith("-")`, consume `next` as its value, push `token` and `next` to `passthroughArgs`, emit with `value: next, inline: false, passthroughValueIndex`; otherwise push `token` and emit with `value: true, inline: false, passthroughValueIndex: null`.
       - Else: push `token` to `passthroughArgs` and emit `{ kind: "option", name: shortName, canonical, value: true, inline: false, passthroughIndex, passthroughValueIndex: null }`.
     - **Step 3 — Multi-char Short Token (`token.length > 2`, e.g. `-cp`, `-cphello`, `-cph`, `-rc`, `-cr=SID`, `-r=SID`, `-phello`)**:
       - Push `token` to `passthroughArgs` at `passthroughIndex`.
       - Scan `body = token.slice(1)` left to right (`pos = 0..body.length - 1`):
         - Let `ch = body[pos]`, `shortFlag = "-" + ch`, `rest = body.slice(pos + 1)`.
         - **Case A (`shortFlag` is in `grammar.booleanFlags`)**:
           - If `rest.startsWith("=")`: invalid boolean `=`; stop scanning, emit one opaque `{ kind: "option", name: token, canonical: null, value: true, inline: true, passthroughIndex, passthroughValueIndex: null }` (fails closed).
           - Otherwise record a provisional boolean token `{ kind: "option", name: shortFlag, canonical: grammar.canonicalFlag.get(shortFlag) ?? shortFlag, value: true, inline: true, passthroughIndex, passthroughValueIndex: null }` and advance `pos += 1`.
         - **Case B (`shortFlag` is in `grammar.valueFlags` or `grammar.optionalValueFlags`)**:
           - The first value or optional-value short flag consumes the remainder `rest` of the token:
             - If `rest.length > 0`:
               - Let `attachedVal = rest.startsWith("=") ? rest.slice(1) : rest`.
               - Commit all provisional boolean tokens from earlier in the cluster, then emit `{ kind: "option", name: shortFlag, canonical: grammar.canonicalFlag.get(shortFlag) ?? shortFlag, value: attachedVal, inline: true, passthroughIndex, passthroughValueIndex: null }` (`passthroughValueIndex: null` because it is inside a cluster/attached token and under Rule (1) will not be rewritten).
               - Trace of required examples (`R-C`):
                 - `-cphello`: `pos=0` (`-c` boolean) -> `pos=1` (`-p` value flag, `rest="hello"`) -> emits `-c` (`continue: true`) and `-p` (`value: "hello"`). `passthroughArgs` keeps `["-cphello"]`.
                 - `-cph`: `pos=0` (`-c` boolean) -> `pos=1` (`-p` value flag, `rest="h"`) -> emits `-c` (`continue: true`) and `-p` (`value: "h"`, **not** `-h` help!). `passthroughArgs` keeps `["-cph"]`.
                 - `-rc`: `pos=0` (`-r` optional-value flag, `rest="c"`) -> emits `-r` (`canonical: "--resume"`, `value: "c"`). `passthroughArgs` keeps `["-rc"]`.
                 - `-cr=SID`: `pos=0` (`-c` boolean) -> `pos=1` (`-r` optional-value flag, `rest="=SID"`) -> emits `-c` (`continue: true`) and `-r` (`canonical: "--resume"`, `value: "SID"`).
               - Stop scanning the cluster.
             - Else (`rest === ""`, so `shortFlag` is the **last** character of the cluster, e.g. `-cp` in `-cp "hello"` or `-cr` in `-cr SID`):
               - Commit all provisional boolean tokens.
               - If `grammar.valueFlags.has(shortFlag)` and `next !== undefined`:
                 - Push `next` to `passthroughArgs` at `valIdx = passthroughArgs.length - 1`, advance `i += 1`, and emit `{ kind: "option", name: shortFlag, canonical: grammar.canonicalFlag.get(shortFlag) ?? shortFlag, value: String(next), inline: false, passthroughIndex, passthroughValueIndex: valIdx }`.
               - Else if `grammar.optionalValueFlags.has(shortFlag)` and `next !== undefined && !String(next).startsWith("-")`:
                 - Push `next` to `passthroughArgs` at `valIdx = passthroughArgs.length - 1`, advance `i += 1`, and emit `{ kind: "option", name: shortFlag, canonical: grammar.canonicalFlag.get(shortFlag) ?? shortFlag, value: String(next), inline: false, passthroughIndex, passthroughValueIndex: valIdx }`.
               - Else:
                 - Emit `{ kind: "option", name: shortFlag, canonical: grammar.canonicalFlag.get(shortFlag) ?? shortFlag, value: true, inline: true, passthroughIndex, passthroughValueIndex: null }`.
               - Stop scanning the cluster.
         - **Case C (`shortFlag` is unknown, including `'C'` inside `-cC`)**:
           - Discard provisional boolean tokens for this token and emit a single opaque `{ kind: "option", name: token, canonical: null, value: true, inline: true, passthroughIndex, passthroughValueIndex: null }` (Rule (2) fail closed: never sets `helpOnly`, and if no other prompt/resume is present, `classifyCliTokens` / `extractCliMetadataFromTokens` treats an unknown-cluster-only invocation as tracked or unclassified rather than silently dropping it).
       - If the loop finishes with only provisional boolean tokens (e.g. `-cv`), commit all of them.

4. **Standalone `-r <jobId>` / `--resume <jobId>` / `--resume=<jobId>` Translation (`rewriteResumeArg`)**:
   - Under Rule (1), `rewriteResumeArg(passthroughArgs, resumeToken, sessionId)` rewrites `passthroughArgs` **only** when `resumeToken` came from a standalone `-r <jobId>`, `--resume <jobId>`, or `--resume=<jobId>` token (`resumeToken.passthroughValueIndex !== null`).
   - If `resumeToken.inline` (`--resume=<jobId>`), `clone[resumeToken.passthroughValueIndex] = "--resume=" + sessionId`.
   - If separate (`-r <jobId>` or `--resume <jobId>`), `clone[resumeToken.passthroughValueIndex] = sessionId`.

---

## 3. Hybrid A2 Specification: Execution Directory, Pre-Run Filter, and Post-Run Reconciliation (`A-A`, `A-B`, `A-E`, `A-F`, `R-E`, `R-G`, `R-H`, `K-B`, `K-D`)

### 1. Execution Directory Policy and Legacy Records (`A-A`)

- **Managed modes (`analyze`, `exec`, `review`, `adversarial-review`, `rescue`)**: execute `grok` in `workspaceRoot`, and record `cwd`, `workspaceRoot`, and `executionCwd: workspaceRoot` on every new job.
- **`cli` mode**: executes `grok` in `cwd` (`resolveCwd(routerOptions)`), and records `cwd`, `workspaceRoot`, and `executionCwd: cwd` on every new tracked job.
- **Legacy records without `executionCwd`**:
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

### 2. `linkage` Field and Pre-Run Lookup (`A-B`, `A-E`, `R-E`, `K-D`)

Let `SUCCESSFUL_JOB_STATUSES = new Set(["completed", "completed-with-warnings"])` and `UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.

- **`linkage` field on every new job record (`A-B`, `K-D`)**:
  - `"fork"` if `--fork-session` was passed alongside `--continue`/`-c` or `--resume`/`-r` (note: `--session-id` with `--resume`/`--continue` is only valid in `grok` together with `--fork-session` per `grok-help.txt:121-122`).
  - `"continue"` if `--continue` / `-c` or bare `--resume` / `-r` (`resume === true`) was passed (and not `"fork"`).
  - `"resume"` if a named `--resume <target>` / `-r <target>` was passed (and not `"fork"`).
  - `null` otherwise.

- **Pre-run implicit continue (`findPriorJobForContinue(workspaceRoot, executionCwd, env)`)**:
  - Invoked pre-run only when `--continue` / `-c` is passed. Bare `--resume` / `-r` (`resume === true`, where `grok` picks or prompts for a session) starts with `resumeOf: null` pre-run (`linkage: "continue"`) so plain-output bare `-r` runs never guess or invent ancestry; when JSON output reports a `sessionId`, post-run reconciliation (`reconcileCompletedResumeOf`) links `resumeOf` to the matching prior job.
  - Filters `listJobs(workspaceRoot, env)` to jobs where:
    1. `isEligibleParentJob(job)` (`job.jobClass === "grok"`, or legacy record without `jobClass` that is not a lane leaf or panel),
    2. `SUCCESSFUL_JOB_STATUSES.has(job.status)`,
    3. `Boolean(job.grokSessionId && job.grokSessionId !== "unknown")`,
    4. `effectiveExecutionCwd(job) === path.resolve(executionCwd)`.
  - Sorted by `Date.parse(job.completedAt ?? job.updatedAt)` descending, then `Date.parse(job.createdAt)` descending, then `job.id` descending.

- **Pre-run named resume (`findPriorJobForResume(workspaceRoot, target, env)`) (`A-E`, `R-E`)**:
  - Let `ref = String(target ?? "").trim()`.
  - Step 1 (Router Job ID match): `const byId = jobs.find((job) => job.id === ref)`.
    - If found (`resumedByJobId === true`), resolve `priorSessionId = resolveKnownSessionId(workspaceRoot, byId, env)`. If `!priorSessionId`, throw `Job ${byId.id} has no known Grok session.`. Rewrite standalone `-r`/`--resume` in `passthroughArgs` to `priorSessionId`.
  - Step 2 (UUID-shaped session ID match, `resumedByJobId === false`):
    - **Single rule for title-based vs UUID-based `-r` (`R-E`)**:
      - If `!UUID_RE.test(ref)` (i.e., `ref` is a session title rather than a UUID or router job ID), `findPriorJobForResume` returns `null` pre-run! That guarantees a prior plain `-r mytitle` job (with `controls.resume === "mytitle"` and `grokSessionId === "unknown"`) is **never** selected by string-matching the title pre-run; title-based `-r` is linked solely by post-run reconciliation from the UUID `grok` reports.
      - If `UUID_RE.test(ref)` (a session UUID), `findPriorJobForResume` searches completed `jobClass === "grok"` jobs (`SUCCESSFUL_JOB_STATUSES.has(job.status)`) sorted newest-first where:
        - `job.grokSessionId === ref`, **OR**
        - `(!job.grokSessionId || job.grokSessionId === "unknown") && job.request?.controls?.resume === ref` (matches requested UUID `ref` only when the job's reported session is absent or `"unknown"` — never when it reported a different UUID `B !== ref`).

### 3. Post-Run Session Reconciliation (`A-B`, `R-E`, `R-H`, `K-B`)

- **Preserving `grokSessionId` on failed/timed-out managed jobs (`R-H`)**:
  - In `lib/jobs.mjs:136`, `runTrackedJob` keeps `grokSessionId: execution.grokSessionId ?? null` exactly as it does today!
  - Why (`R-H`): In managed modes, `runGrokPrintJob` (`lib/grok.mjs:256, 279`) extracts `sessionId` from partial stdout even when a job times out (`killed-in-progress`) or exits non-zero after starting a session, and `rescue --resume-last` (`lastRescueSession`) relies on that stored `grokSessionId` to rescue the interrupted session. When no session was emitted in stdout (e.g., auth failure before a session starts, or a failed `cli` run where `handleCli` only sets `sessionId` when `jobStatus === "completed"` or when `parsedOutput?.sessionId` is actually present), `execution.grokSessionId` is already `null`. Thus `runTrackedJob` does **not** null out a real `execution.grokSessionId` on failure.
- **Terminal transition seam in `lib/jobs.mjs`**:
  ```js
  const status = execution.jobStatus ?? (execution.exitStatus === 0 ? "completed" : "failed");
  const grokSessionId = execution.grokSessionId ?? null;
  const resumeOf = typeof options.reconcileResumeOf === "function"
    ? options.reconcileResumeOf(current, { ...execution, jobStatus: status, grokSessionId })
    : (execution.resumeOf !== undefined ? execution.resumeOf : (current.resumeOf ?? null));
  ```
- **Unified Post-Run Reconciliation Rule (`R-E`, `K-B`)**:
  - In `reconcileCompletedResumeOf(workspaceRoot, currentJob, execution, env = process.env)`:
    1. If `!SUCCESSFUL_JOB_STATUSES.has(execution.jobStatus)`, return `currentJob.resumeOf ?? null`.
    2. If `!currentJob.linkage || currentJob.linkage === "fork"`, return `currentJob.resumeOf ?? null` (preserving the pre-run source link for `--fork-session`).
    3. Extract structured `reportedSessionId = typeof execution.payload?.parsedOutput?.sessionId === "string" ? execution.payload.parsedOutput.sessionId.trim() : null`.
       - If `!reportedSessionId` (plain-text output with no JSON `sessionId`), keep the pre-run `currentJob.resumeOf ?? null`.
    4. **In-memory candidate map & cycle guard (`K-B`)**:
       - Load `const allJobs = listJobs(workspaceRoot, env)` **once** and build `const jobById = new Map(allJobs.map((j) => [j.id, j]))` in memory (zero extra `readJobFile` or `git rev-parse` calls inside the lock).
       - Let `upperBoundMs = Date.parse(currentJob.startedAt ?? currentJob.createdAt ?? "")`.
       - Filter `allJobs` to candidates `cand` where:
         - `cand.id !== currentJob.id` and `cand.jobClass === "grok"`,
         - `SUCCESSFUL_JOB_STATUSES.has(cand.status)`,
         - `candDoneMs <= upperBoundMs`,
         - `cand.grokSessionId === reportedSessionId || ((!cand.grokSessionId || cand.grokSessionId === "unknown") && UUID_RE.test(reportedSessionId) && cand.request?.controls?.resume === reportedSessionId)`,
         - **In-memory cycle check**: walking `cursor = jobById.get(cursor.resumeOf)` from `cand` never visits `currentJob.id` or repeats a node.
       - Sort matching candidates by `Date.parse(cand.completedAt ?? cand.updatedAt)` descending, then `Date.parse(cand.createdAt)` descending, then `cand.id` descending.
    5. **Reported session always overrides pre-run link (`R-E`)**:
       - For **both** `currentJob.linkage === "continue"` and `currentJob.linkage === "resume"`:
         - If `currentJob.resumeOf` is already equal to `matchingCandidates[0]?.id`, keep `currentJob.resumeOf`.
         - Otherwise, return `matchingCandidates[0]?.id ?? null` (so the session UUID `grok` actually reported always overrides any stale pre-run link, and clears `resumeOf` to `null` if `grok` continued or resumed an external session untracked by the router).

---

## 4. Phase B Test Plan (With Exact Failure Reasons at `dbe13e0` and Explicit Guard Labels) (`R-F`)

Every test commit in Phase B contains at least one assertion that is ** genuinely red at `dbe13e0` for a behavioral reason** (never a missing export). Setup assertions and green-before regression guards within a test are explicitly labeled below (`R-F`).

| # | Target Finding | Test Legs & Explicit Labels (`[RED]`, `[SETUP]`, `[GUARD]`) | Exact Failure Reason at `dbe13e0` (Before Fix) |
|---|---|---|---|
| **T-A1a** | **A1 / R3-10 / R-C / R-F** | 1. **`[RED]`** `cli -p "--help" --output-format json`: assert `stderr` matches `/Job ID:\s+\S+/` and stored job has `request.prompt === "--help"`.<br>2. **`[RED]`** `cli -p "hello" -- --help`: assert `stderr` matches `/Job ID:\s+\S+/`.<br>3. **`[RED]`** `cli -cp "hello" --output-format json`: assert stored job has `request.controls.continue === true` and `request.prompt === "hello"`.<br>4. **`[RED]`** `cli -cphello --output-format json`: assert `stderr` matches `/Job ID:\s+\S+/` and stored job has `request.controls.continue === true` and `request.prompt === "hello"`. | - Legs 1 & 2 fail `assert.match(res.stderr, /Job ID:\s+\S+/)`: `classifyCliArgs` at `dbe13e0` uses `args.includes("--help")`, sets `helpOnly: true`, and skips job tracking (`stderr` is `""`).<br>- Leg 3 (`-cp "hello"`) creates a job at `dbe13e0` (because `"hello"` is a positional token), **but fails `assert.equal(job.request.controls.continue, true)`** (`actual: false`) because `-cp` is not recognized as `-c` + `-p`.<br>- Leg 4 (`-cphello`) fails `assert.match(res.stderr, /Job ID:\s+\S+/)` because `-cphello` has no separate positional token, so `hasPromptOrResume` is `false` at `dbe13e0`. |
| **T-A1b** | **A1 / A-G / A-I / R-D** | Using `GROK_FAKE_FIXTURES` pointed at a temp fixture dir written with `helpText({ flags: "      --custom-filter <EXPR>\n          Filter expression\n" })`:<br>1. **`[SETUP]`** `cli --help`: assert stdout contains `--custom-filter <EXPR>` (verifies fixture injection works).<br>2. **`[RED]`** `cli --custom-filter --best -p "hello" --output-format json`: assert `status === 0` and job is tracked.<br>3. **`[RED]`** `cli sessions --json`: assert `status !== 0` and stderr matches `/--json is a router option/` (a router-owned name after a subcommand is rejected, not forwarded). | - Leg 1 is `[SETUP]` (green at `dbe13e0`).<br>- Leg 2 fails `assert.equal(res.status, 0)`: `parseCliInput` at `dbe13e0` runs before `readGrokHelp`, uses the static `CLI_KNOWN_VALUE_FLAGS` set (which lacks `--custom-filter`), and exits `1` with `--best is a router option...`.<br>- Leg 3's rejection already held at `dbe13e0` (`--json is a router option`). The interim plan to forward `cli sessions --json` was reverted before release: real grok 1.0.62 has no such flag, and a router-owned name cannot be passed through to a subcommand. |
| **T-A1c** | **A-H / A-I / R-B / R-D** | In `tests/help.test.mjs` (with `tests/fixtures/grok-help.txt:17` refreshed to `(compat aliases: --allowedTools, --allowed-tools)`):<br>1. **`[RED]`** Assert `parseGrokHelp` extracts `allow.aliases` as `["--allowedTools", "--allowed-tools"]` and `deny.aliases` as `["--disallowedTools"]`.<br>2. **`[GUARD]`** Assert command aliases `du` -> `["disk-usage"]` and `version` -> `["v"]` are preserved (`R-B`).<br>3. **`[GUARD]`** Assert `classifyControls(fixtureHelp).policy` still contains `option === "allow"` with `flag === "--allow"` and `repeatable === true`, and `safeForward` does **not** contain `"allow"` or `"allowed-tools"` (`R-B`).<br>4. **`[RED]`** Assert `parseGrokHelp` on synthetic option lines parses `--flag=<VAL>` as `requiresValue: true`, `<FILE>...` as `variadic: true`, short-only `-x` as `short: "-x"`, same-line `[aliases: --alias]`, and records `parseWarnings` on an unparseable option line `   ---bad-option`. | - Leg 1 fails `assert.deepEqual(allow.aliases, ["--allowedTools", "--allowed-tools"])` (`actual: []`) because `parseAliases` at `dbe13e0` only matches `[aliases: ...]`.<br>- Leg 4 fails on `requiresValue: true` for `--flag=<VAL>` (`actual: false`), `variadic: true` (`actual: undefined`), short-only `-x` (dropped), same-line aliases (dropped), and `parseWarnings.length === 1` (`actual: 0`).<br>- Legs 2 & 3 are `[GUARD]` assertions that prevent the `R-B` regressions when `parseAliases` is updated. |
| **T-A2a** | **A2 / C-B / C4 / A-B / R-F** | In `tests/companion.test.mjs`:<br>1. **`[SETUP]`** Turn 1: `analyze --json "Root turn 1"` (`GROK_FAKE_SESSION: sid1`) -> `turn1Id`.<br>2. **`[SETUP]`** Turn 2: `analyze --lanes a,b --json "Inspect lanes"` (`GROK_FAKE_SESSION: sidLanes`) -> creates completed `grok-lane` leaf jobs.<br>3. **`[RED]`** Turn 3 (immediately after lanes, before any failed job — `R-F`): `cli -c -p "after lanes" --output-format json` (`GROK_FAKE_SESSION: sid1`) -> assert `turn3Job.resumeOf === turn1Id` (proves `grok-lane` leaves are excluded).<br>4. **`[SETUP]`** Turn 4: `cli -p "fail"` with `GROK_FAKE_AUTH: "1"` (creates a `failed` job).<br>5. **`[RED]`** Turn 5: `cli -c -p "after fail" --output-format json` (`GROK_FAKE_SESSION: sid1`) -> assert `turn5Job.resumeOf === turn3Id` (proves `failed` jobs are excluded).<br>6. **`[RED]` / `[GUARD]`** Turn 6 (bare `-r` post-run reconciliation): bare `cli -r -p "bare resume plain"` (plain output) -> `[GUARD]` assert `barePlainJob.resumeOf === null` (does not invent ancestry when session is unreported); bare `cli -r -p "bare resume" --output-format json` (`GROK_FAKE_SESSION: sid1`) -> `[RED]` assert `turn6Job.resumeOf === turn5Id` (reconciled post-run from reported `sid1`).<br>7. **`[RED]`** Turn 7 (post-run reconcile): after a Turn 6b with `GROK_FAKE_SESSION: sid2`, run `cli -c -p "reconcile to sid1" --output-format json` with `GROK_FAKE_FORCE_SESSION: sid1` -> assert `turn7Job.resumeOf === turn6Id` (reconciled by reported `sid1`). | - Leg 3 fails `assert.equal(turn3Job.resumeOf, turn1Id)`: at `dbe13e0`, `findPriorJobForContinue` does not exclude `grok-lane` leaves (whose `job.cwd` is `undefined`, falling back to `workspaceRoot`), so it links to the newest lane leaf instead of `turn1Id`.<br>- Leg 5 fails `assert.equal(turn5Job.resumeOf, turn3Id)`: at `dbe13e0`, `findPriorJobForContinue` picks the failed Turn 4 job.<br>- Leg 6 fails `assert.equal(turn6Job.resumeOf, turn5Id)` (`actual: null`) because bare `-r` is not reconciled post-run at `dbe13e0` (while plain-output bare `-r` stays `null` as a `[GUARD]`).<br>- Leg 7 fails `assert.equal(turn7Job.resumeOf, turn6Id)` (`actual: turn6bId`) because no post-run reconciliation exists at `dbe13e0`. |
| **T-A2b** | **A-A / R-F** | In `tests/companion.test.mjs`:<br>1. **`[SETUP]`** Initialize Git repo (`initGitRepo(tempDir)`), create `subDir = path.join(tempDir, "sub")`, and assert `resolveStateDir(tempDir) === resolveStateDir(subDir)`.<br>2. **`[RED]`** Managed `--cwd subDir --continue`: after Turn 1 `analyze --json "Root turn"` in `tempDir` (`GROK_FAKE_SESSION: sid`), run `analyze --cwd subDir --continue --json "Managed sub turn"` (`GROK_FAKE_SESSION: sid`) -> assert `managedSubJob.resumeOf === turn1Job.id` and `managedSubJob.executionCwd === fs.realpathSync.native(tempDir)` (or `path.resolve(tempDir)`).<br>3. **`[GUARD]`** Isolated `cli` subdirectory guard: run `cli --cwd subDir --continue -p "Isolated cli sub turn"` -> assert `cliSubJob.resumeOf === null` (because `cli` executes in `subDir` while both Turn 1 and `managedSubJob` recorded `executionCwd === workspaceRoot`, so `subDir` still has no matching `cli` predecessor). | - Leg 1 is `[SETUP]`.<br>- Leg 2 is **`[RED]`** (runs first so the `[RED]` commit fails immediately on the managed `--cwd subDir --continue` assertion): fails `assert.equal(managedSubJob.resumeOf, turn1Job.id)` (`actual: null`) because at `dbe13e0`, `runRouted` calls `findPriorJobForContinue(workspaceRoot, subDir)`, which compares `turn1Job.cwd` (`tempDir`) against `subDir` and returns `null`.<br>- Leg 3 is `[GUARD]` (remains isolated even after Leg 2 because `managedSubJob.executionCwd` is `workspaceRoot`, not `subDir`). |
| **T-C2** | **C2 / A-E / R-E / R-F** | In `tests/companion.test.mjs`:<br>1. **`[SETUP]`** Turn 1 (`J1`): `analyze --json "Start S"` (`GROK_FAKE_SESSION: S`).<br>2. **`[SETUP]`** Turn 2 (`J2`): `cli -r S -p "plain turn"` (plain output -> `grokSessionId: "unknown"`, `request.controls.resume: "S"`).<br>3. **`[RED]`** Turn 3 (`J3`): `cli -r S -p "third turn" --output-format json` (`GROK_FAKE_SESSION: S`) -> assert `J3.resumeOf === J2.id`.<br>4. **`[RED]`** Title-based `-r` reconciliation (`R-E`): Turn 4 runs `cli -r "my-session-title" -p "by title" --output-format json` (`GROK_FAKE_FORCE_SESSION: S`) -> assert `J4.resumeOf === J3.id` (reconciled post-run from reported UUID `S`, even though `"my-session-title"` was not a UUID pre-run).<br>5. **`[GUARD]`** `--fork-session` preservation (`A-E`): Turn 5 runs `cli -c --fork-session -p "forked" --output-format json` (`GROK_FAKE_FORCE_SESSION: forkedSid`) -> assert `J5.resumeOf === J4.id`.<br>6. **`[GUARD]`** Contradictory session guard (`A-E`): Turn 6 runs `cli -r S -p "reassigned" --output-format json` (`GROK_FAKE_FORCE_SESSION: otherSid`), then Turn 7 runs `cli -r S -p "back to S" --output-format json` (`GROK_FAKE_SESSION: S`) -> assert `J7.resumeOf === J4.id` (does not pick Turn 6 which reported `otherSid`). | - Leg 3 is **`[RED]`**: fails `assert.equal(J3.resumeOf, J2.id)` (`actual: J1.id`) because `findPriorJobForResume` at `dbe13e0` only checks `job.grokSessionId === ref`, skipping `J2`.<br>- Leg 4 is **`[RED]`**: fails `assert.equal(J4.resumeOf, J3.id)` (`actual: null`) because `"my-session-title"` does not match any job pre-run and no post-run reconciliation exists at `dbe13e0`.<br>- Legs 5 & 6 are `[GUARD]` assertions protecting the new reconciliation and requested-session fallback rules. |

---

## 5. Additional Phase B Items (Queued for Phase B Implementation) (`A3`, `A5`, `C1`, `R-G`)

1. **`R-G` (`CHANGELOG.md` 0.3.8 wording)**:
   - Rewrite line 11 of `CHANGELOG.md` so `--continue` / `-c` (and bare `-r`) linkage is explicitly described as **best-effort**:
     > `- --resume <jobId> / -r <jobId> in both managed modes and cli translates a router job ID into the underlying Grok session ID in grok's argv (passing explicit raw session IDs through unchanged, and failing clearly when the referenced job has no known Grok session). Resumed turns and best-effort --continue/-c (or bare -r) turns link resumeOf to the most recent completed router job with a known session in the execution directory, reconciled after the run from the session ID grok reports in JSON output (and cleared to null when grok continued an untracked external session; --output-format json is required to chain multiple cli -c turns). Router-owned option names are rejected wherever they are not consumed, including after a subcommand (`cli sessions --json` is not forwarded). Other flags after a subcommand are forwarded verbatim and the run is tracked. A router-owned name cannot be passed through to a grok subcommand. status renders Grok session: not reported when a completed cli run did not report a session ID.`
2. **`A3` (Relabel `5b210f1` / `f19aaf0` in PR body and clean up F2 test)**:
   - In the PR #6 description, relabel `5b210f1 -> f19aaf0` (F2 and N4) as **strengthened regression coverage + test-export refactor**, citing `b3b5695` (F2 timeout) and `6dc1833` (N4 chain walk) for the behavioral changes.
   - Simplify the F2 test in `tests/companion.test.mjs` to call `handleCli` from `lib/cli.mjs` via its `runProcessImpl` seam without mutating `globalThis.setTimeout`, `process.stdout.write`, or `process.env`.
3. **`A5` (Remove explanatory comments)**:
   - Remove the explanatory comments in `tests/companion.test.mjs` (lines 316, 352, 369, 715, 719, 724, 786, 799, 811) and `plugins/grok-router/scripts/lib/router.mjs` (lines 171-173), folding any needed context into test names or assertion messages.
4. **`C1` / `M2` (`stopAtPositional: false` on `status` / `result` / `cancel`)**:
   - Keep `stopAtPositional: false` on `handleStatus`, `handleResult`, and `handleCancel` in `grok-companion.mjs` so the documented 0.3.8 trailing option syntax (`result <id> --lane <k>`, `status <id> --json`, `cancel <id> --json`) continues to work alongside leading options (`result --json --cwd ... <id>`).
