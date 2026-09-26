# pi-pkg

Personal [Pi](https://pi.dev) package — extensions, skills, prompts, and themes.

## Extensions

### notify

Sends a native terminal notification (OSC 777) when Pi finishes and is waiting for input. Works in Ghostty, iTerm2, WezTerm, and rxvt-unicode.

### handoff

Transfers context to a new focused session. `/handoff <goal>` summarizes the current conversation (decisions, key findings, relevant files) into a self-contained prompt, then creates a new session with the prompt as a draft in the editor for review before submitting — a lossless alternative to compaction.

Taken from pi's handoff example (examples/extensions/handoff.ts).

**Usage:**
```text
/handoff <goal for new thread>
```

### goal

Long-running objective mode. `/goal <objective>` sets a persistent goal for the session; after every agent turn a continuation is automatically queued, so the agent keeps working autonomously until the objective is verifiably complete, genuinely blocked, or paused. Goal state lives in the session log (surviving `/reload`, `/resume`, and tree navigation) — no external database. Time and token usage are tracked and shown in the footer, with an optional token budget that stops automatic continuation when reached.

The agent manages the goal itself via three tools: `get_goal` (status and budgets), `create_goal` (only on explicit user request), and `update_goal` (mark `complete` after a strict verification audit, or `blocked` only after the same blocker repeats across three consecutive goal turns).

**Usage:**
```text
/goal <objective>   set and start pursuing a goal
/goal               show the current goal
/goal edit          edit the current objective
/goal pause         pause automatic continuation
/goal resume        resume a paused/blocked goal
/goal clear         clear the current goal
```

Derived from [mitsuhiko's goal extension](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/goal.ts).

### tool-guidance (experimental)

Steers file work to the dedicated tools at both places the model reads before it picks a tool.

The built-in `bash` snippet in the prompt's tool list reads "Execute bash commands (ls, grep, find, etc.)" — it advertises precisely the three operations that `ls`, `find`, and `grep` do better, and a description at selection time beats a rule 100 lines earlier. It is replaced with the shell's actual lane (`git, npm, builds, etc.`). A routing guideline on `bash` and `powershell` then states the same thing positively — shell for git, builds, installs, pipelines; file work as its own tool call — which also covers mutating files via `edit`/`write` rather than `sed -i` or `cat >`.

It also adds the missing preference lines for `grep`, `find`, and `ls`, the same way `read` already says "Use read to examine files instead of cat or sed". Those three built-ins ship with no guidelines, so nothing steers the model away from bash `grep`/`rg`, `find`/`fd`, and `ls` — the dedicated tools respect `.gitignore` and `grep` returns line numbers.

Always on; no usage or flags. It patches prompt metadata via `before_agent_start` rather than re-registering the tools, so it composes with extensions that override a built-in tool's `execute`. The snippet swap is guarded on pi's exact built-in text: if upstream rewords it, the extension reports the mismatch as an extension error once per session instead of going silently out of date.

Still experimental — a local stopgap while the equivalent one-line changes are proposed upstream.

## Skills

### github

Routes GitHub work — issues, PRs, CI runs, releases, search, API queries — through the [`gh`](https://cli.github.com) CLI instead of `curl https://api.github.com/... | python3`, which is unauthenticated (60/hour versus 5000), blind to private repos, and re-implements the `--json`/`--jq` the CLI already ships. It states the few habits that change agent behaviour — explicit `--repo`, projected output, `--log-failed`, `gh api` for the gaps, confirmation before writes — and leaves the details to `gh <command> --help`. Auto-loaded for github.com tasks, or `/skill:github`.

See [skills/github/SKILL.md](skills/github/SKILL.md) and [skills/github/README.md](skills/github/README.md) for `gh` install/auth setup, including headless and remote hosts.

Derived from [mitsuhiko's agent-stuff `skills/github`](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/github/SKILL.md), expanded with the issue/PR/CI/search/release/API recipes above.

### kagi

Web search and page-content extraction via the [Kagi API](https://kagi.com/api/docs) (v1). Pure Node.js, no browser or npm dependencies. The API key is read from the OS keyring at call time — GNOME Keyring via `secret-tool`, or the macOS Keychain.

```bash
skills/kagi/search.mjs "query" -n 5 --time week
skills/kagi/extract.mjs https://example.com/article
```

See [skills/kagi/SKILL.md](skills/kagi/SKILL.md) for full usage, and [skills/kagi/README.md](skills/kagi/README.md) for keyring setup and troubleshooting (including over SSH).

### session-review

Reviews past Pi session logs and turns them into evidence-backed improvements. `session-report.mjs` reads Pi's v3 session JSONL and prints one loose JSON object per tool call (`ts`, `session`, `project`, `tool`, `ok`, `bytes`, `msg`, plus opt-in `args`/`details`/`err`), or — with `--usage` — one object per model-attributed usage event (`kind`, `model`, `provider`, token counts, `cost`, `calls`, `stop`), which is how you trend tokens, cost, aborts, and compaction instead of hand-rolling jq over the raw log. Then you slice it with `jq` — counts, error rates, large outputs, fan-out, repeated calls, monthly cost. It does no aggregation and no domain-specific analysis, and it fails loudly with `file:line` on invalid JSON, a non-v3 header, malformed entries, or a result for an unknown call.

Pi never prunes sessions, so the analyzer assumes a growing corpus: `--since` skips whole session files whose mtime predates the cutoff (append-only logs make mtime a sound upper bound), `--usage` streams records as they parse so memory stays flat, and `--stats` reports files read, files skipped, rows, and elapsed time. Full history is under a second either way. Explicit invocation only: run the script directly, or ask an agent via `/skill:session-review`.

```bash
skills/session-review/session-report.mjs --since 30d
skills/session-review/session-report.mjs --since 30d --tool bash,read | jq -r .tool | sort | uniq -c
skills/session-review/session-report.mjs --since 7d --errors-only --args
skills/session-review/session-report.mjs --usage --stats          # one row per billed turn
skills/session-review/session-report.mjs --since 30d --usage \
  | jq -n 'reduce inputs as $u ({}; .[$u.model // "?"] = ((.[$u.model // "?"] // 0) + ($u.total // 0))) | to_entries'
```

Docs are layered so an agent only pays for what the question needs: [SKILL.md](skills/session-review/SKILL.md) covers tool-call records — fields, `jq` recipes, long-history behavior, reading the raw log for prompt content, and how to interpret results — and [usage-records.md](skills/session-review/usage-records.md) holds the `--usage` schema, its recipes, and its gotchas for token/cost/model questions. Both layers, and this entry, are meant to change together.

## Prompts

### plan

A lightweight discussion/planning mode for when you want to explore a problem space and narrow down an approach before any implementation. Enters a read-only thinking-partner stance: grounds the discussion in the codebase, asks only decision-relevant questions, sketches alternatives with trade-offs, and ends with a short concrete plan plus an explicit approval gate before any code is written.

**Usage:**
```text
/plan <problem or idea>   start exploring a specific problem
/plan                     ask what to explore
```

Other prompts live in `prompts/` — see [Pi prompts docs](https://pi.dev/docs/prompts).

## Themes

### catppuccin-frappe

A soft, muted [Catppuccin](https://catppuccin.com) Frappé theme for the TUI, adapted from [pi-catppuccin](https://github.com/madeleineostoja/pi-catppuccin) with mauve as the accent, quiet surface/overlay chrome, and a gentle thinking gradient.

Select it via `/settings` or:

```json
{
  "theme": "catppuccin-frappe"
}
```

## Credits

Inspired by, and partially derived from, [mitsuhiko's agent-stuff](https://github.com/mitsuhiko/agent-stuff) and pi's extension examples. Licensed under Apache-2.0; derived portions retain their original licenses — see [NOTICE](NOTICE).
