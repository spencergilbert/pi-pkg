# pi-pkg

Personal [Pi](https://pi.dev) package — extensions, skills, prompts, and themes.

## Extensions

### ssh

Routes pi's standard tools (`read`/`write`/`edit`/`bash`/`ls`/`find`/`grep`) to a remote host via SSH. While active, the agent's working directory is rewritten to the remote, so the model simply works "on" the remote — no separate tool namespace.

The target is derived, not configured: with `--ssh`, tools run on `desktop` at the *same* cwd (local and remote machines mirror the same path structure, e.g. `~/src/<forge>/<user>/<project>`). No target state is stored — SSH mode is re-established on every session start, including after `/handoff`, `/resume`, and `/reload`. Each activation probes the remote first (reachability + mirrored cwd existence); if the probe fails, SSH mode stays off with a clear error and tools fall back to local. Just start pi without `--ssh` to work locally.

**Requirements:**
- `ssh` in `$PATH`
- Key-based auth (no password prompts)
- `bash` on the remote host
- GNU `find` (for `ls`); `rg` or `grep` for search

**Usage:**
```text
pi -e extensions/ssh/index.ts --ssh   # Route tools to desktop:$CWD
```

The local SSH agent is forwarded (`ssh -A`), so e.g. git commit signing with ssh keys works on the remote using the local 1Password agent. User `!` commands also route through the active remote.

**Performance tip:** Enable SSH connection multiplexing to avoid the latency of a new TCP/TLS handshake on every tool call:

```
Host *
  ControlMaster auto
  ControlPath ~/.ssh/control-%r@%h:%p
  ControlPersist 10m
```

### mcp

A thin, proxy-only [MCP](https://modelcontextprotocol.io) client. It exposes exactly one model tool, `mcp`, which proxies every configured server — no per-server tools are registered and no namespace proxies are generated.

The tool's `action` selects what happens:

| action | behavior |
|---|---|
| `status` (default) | list configured servers, connection state, cache state, and the effective config hash |
| `search` | rank cached tools by name (exact > prefix > tokens) then description; **never connects** |
| `describe` | return a cached tool's input/output schema and its server instructions; **never connects** |
| `connect` | lazily connect one server and refresh its cached tool metadata |
| `call` | connect if needed, invoke a tool, and return its result |
| `auth-start` | begin OAuth for an HTTP server (the only action that can open a browser) |
| `auth-complete` | finish OAuth from a pasted redirect URL/code, or confirm a completed loopback callback |

Tool metadata is cached under `<PI_CODING_AGENT_DIR>/mcp-cache.json`, keyed by server and invalidated by a per-server config hash, so `search`/`describe` keep working offline. Connections use the MCP SDK's stdio or Streamable HTTP transport, start lazily on first use, and close after an idle timeout (default 10 minutes) or at session shutdown. Nothing is spawned or dialed at startup.

Oversized tool output is bounded to Pi's standard 50 KiB / 2000-line limit; when truncated, the full text is spilled to a temp file and its path is returned for `read`/`grep`.

**Configuration** — `mcpServers` (and a shallow-merged `settings` object) are merged from, in increasing precedence:

```text
~/.config/mcp/mcp.json
<PI_CODING_AGENT_DIR>/mcp.json
<project>/.mcp.json
<project>/.pi/mcp.json
```

String values support `${VAR}` (and `${VAR:-default}`) environment interpolation. A server entry is either stdio (`command`, `args`, `env`, `cwd`) or HTTP (`url`, `headers`). When a higher-precedence source repoints an existing server at a different URL, inherited auth material is dropped so credentials are never replayed against the new endpoint.

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "linear": { "url": "https://mcp.linear.app/mcp" }
  }
}
```

**OAuth** — HTTP servers authenticate via OAuth 2.1 with dynamic client registration. `auth-start` runs discovery and, for a loopback redirect, spins up a `127.0.0.1` callback server that stores tokens automatically; an HTTPS redirect URI instead requires pasting the final callback URL into `auth-complete`. Tokens are stored in `<PI_CODING_AGENT_DIR>/mcp-auth.json` (mode `0600`, atomic temp-file + fsync + rename, per-entry lock, bound to the server URL). A later `401` refreshes silently through the transport and never opens a browser. Set `settings.keyring: true` (or `PI_MCP_KEYRING=1`) to use an OS keyring CLI (`secret-tool`, `security`) instead of the file.

**Usage:**
```text
mcp({})                                                 # status
mcp({ action: "search", query: "create issue" })
mcp({ action: "describe", tool: "linear:create_issue" })
mcp({ action: "connect", server: "linear" })
mcp({ action: "call", server: "linear", tool: "create_issue", args: { title: "…" } })
mcp({ action: "auth-start", server: "linear" })
mcp({ action: "auth-complete", server: "linear", redirectUrl: "http://127.0.0.1:…/callback?code=…" })
```

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

Always on; no usage or flags. It patches prompt metadata via `before_agent_start` rather than re-registering the tools, so it composes with execution-overriding extensions such as `ssh`. The snippet swap is guarded on pi's exact built-in text: if upstream rewords it, the extension reports the mismatch as an extension error once per session instead of going silently out of date.

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
skills/session-review/session-report.mjs --since 30d --tool mcp,fetch | jq -r .tool | sort | uniq -c
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

## Follow-ups

- **Orchestration spike.** The original adapter also offered trusted MCP-only JavaScript orchestration (`mcpScript`) so one tool call could loop, filter, and chain several MCP calls. It was intentionally left out of this thin client. Revisit as a separate, opt-in extension once the proxy surface has settled.

## Credits

Inspired by, and partially derived from, [mitsuhiko's agent-stuff](https://github.com/mitsuhiko/agent-stuff) and pi's extension examples. Licensed under Apache-2.0; derived portions retain their original licenses — see [NOTICE](NOTICE).
