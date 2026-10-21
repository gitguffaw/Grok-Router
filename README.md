# Grok Router

Claude Code and Codex call Grok through a companion. You pick a mode. The companion builds `grok -p`. The chat agent does not invent flags, and it does not spawn ten inner agents.

This replaces the old markdown skill named `Grok` (`grok -p` recipes in `SKILL.md`). If `~/.claude/skills/Grok` or `~/.codex/skills/Grok` still exists, remove it after you install the plugin. Do not install this plugin into Grok TUI.

Needs Node 18.18+ and `grok` on `PATH`. Sign in with `grok login` or `XAI_API_KEY`.

## Install

Claude Code:

```
/plugin marketplace add gitguffaw/Grok-Skill
/plugin install grok-router@grok-router
/reload-plugins
/grok-router:setup
/grok-router:models
```

From a local clone, marketplace-add the checkout path instead of the GitHub slug.

Codex: install the same plugin and use the `grok_router_*` MCP tools. Same companion. Do not shell out to raw `grok -p` unless the user asked for the `grok-cli` skill.

## Commands

| Want | Command | Writes |
| --- | --- | --- |
| Facts, diagnosis | `/grok-router:analyze` | No |
| A bounded change | `/grok-router:exec` | Yes |
| Bugs in the current diff | `/grok-router:review` | No |
| Challenge the design | `/grok-router:adversarial-review` | No |
| Hand Grok a problem | `/grok-router:rescue` | Fix yes, diagnosis no |
| What this binary can do | `:models` `:surface` `:help` | No |
| Jobs | `:status` `:result` `:cancel` | Cancel only |
| Unmodeled `grok` argv | `:cli` | Depends |

Foreground is the default. Job ID and progress print on stderr as soon as the job is queued. stdout is the finished result. `--background` returns a job id on stdout. `--wait` is only valid on `status`.

```
/grok-router:analyze --best --effort xhigh map the auth flow
/grok-router:exec --best fix the race and run the focused tests
/grok-router:review --base main
/grok-router:review --panel
/grok-router:review --lanes correctness,errors,tests
/grok-router:cli clone --help
```

`--panel` and `--lanes` start N `grok -p --no-subagents` processes. The companion merges findings and prints one report. Full leaf text is `result <id> --lane 0`. Do not `spawn_subagent` for that work.

`--model` and `--effort` are whatever this `grok` accepts today. `--best` is the live default from `grok models`. Do not reuse ids from memory.

`--lean` is a router flag, not a Grok flag. Opt in. It shortens the default system prompt and strips MCP meta-tools. House `~/.grok/Agents.md` can still land in prompt context.

## How it stays current

Grok changes models and flags without a Router release. The companion reads `grok --help`, `grok models`, and `grok inspect --json` on this machine. New flags show up on `:surface`. Unclassified subcommands go through `:cli` (prompt and session-resume `cli` runs are tracked as router jobs, recording `write: "unknown"` when `--tools` is omitted). Untracked `cli` is an allow-list: bare `--help`/`-h`, `<known subcommand> --help`, and bare read-only subcommands such as `models`. Anything else is tracked.

## Policy

analyze and review pass `--tools "read_file,grep,list_dir"`. exec passes `--always-approve`. Review embeds `git diff`. There is no `grok review` command.

## Grok TUI

`/grok-router:setup` (or `node plugins/grok-router/scripts/grok-companion.mjs setup`) copies two scripts into `~/.grok/workflows/`. They show up next to Grok's bundled `deep-research` and `learn-traces`. In Grok, type:

```
/workflow grok-router-review
/workflow grok-router-adversarial-review
```

That uses Grok's own workflow engine. The chat agent does not spawn subagents. Do not load the Claude plugin inside Grok.

## grok-cli

The marketplace also has `grok-cli`: a skill that drives `grok` with no job store. Use it only when you want the raw binary. If `grok-router` is installed, defer to it.

## License

[Apache License 2.0](LICENSE)
