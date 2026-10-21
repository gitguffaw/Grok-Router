---
description: Pass an unmodeled command to the local grok binary
argument-hint: '[--allow-mutating] <grok args...>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a Grok Router `cli` command through the shared companion.

Raw slash-command arguments:
`$ARGUMENTS`

- Do not use cli as a substitute for analyze, exec, review, or rescue.
- Prompt and session-resume `cli` runs (`-p`, `--prompt-file`, `--resume`/`-r`, `--continue`/`-c`) are recorded as tracked router jobs (`status`, `result`, `cancel`). `write: false` is an allow-list: a fully parsed prompt or session-resume, known options with their values, read-only `--tools`, and no positional token before `--`. Any subcommand positional, mixed shape, or unparsed option records `write: "unknown"`. Editing tools and `--always-approve`/`--yolo` record `write: true` only on that fully parsed shape. Grok's usage is `[OPTIONS] [PROMPT] [COMMAND]`. The first and second plain positionals are both candidate commands, and a mutating candidate (`login`, `doctor fix`, `sessions delete`, `mcp add`, including `cli -c hello doctor fix`) requires `--allow-mutating`. That also refuses some safe shapes, such as `-c login version`. `--allow-mutating` is the escape hatch. Argv is not rewritten. `wrap` child argv, `sessions search` terms, and `usage` arguments stay tracked.
- Untracked runs are an allow-list: bare `--help`/`-h` and `--version`/`-v` when grok help gives those spellings that meaning, `help <known subcommand>`, `<known subcommand> [path tokens] --help`/`-h`, and bare read-only subcommands such as `doctor`. `wrap` with any non-help token is tracked (`cli wrap echo hi --help`). Anything else is tracked, except an unconsumed router-owned option, which is rejected. A router-owned flag name cannot be passed through to a grok subcommand.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cli --raw-arg-string "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
