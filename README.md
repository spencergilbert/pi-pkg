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

## Skills

### kagi

Web search and page-content extraction via the [Kagi API](https://kagi.com/api/docs) (v1). Pure Node.js, no browser or npm dependencies. Requires the `KAGI_API_KEY` environment variable (create a key at https://kagi.com/settings?p=api).

```bash
skills/kagi/search.mjs "query" -n 5 --time week
skills/kagi/extract.mjs https://example.com/article
```

See [skills/kagi/SKILL.md](skills/kagi/SKILL.md) for full usage.

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
