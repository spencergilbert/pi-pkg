---
name: session-review
description: Review Pi session logs for real usage patterns and propose evidence-backed improvements to the agent harness, prompts, skills, and tools. Use when asked to analyze how the agent has been working, find repeated failures or friction, audit tool usage, look for large/repeated calls, or trend tokens and cost. Explicit invocation only.
disable-model-invocation: true
---

# Session review

Analyze past Pi sessions and turn them into concrete, evidence-backed improvements. `scripts/session-report.mjs` normalizes Pi's v3 session JSONL into a loose JSONL stream; it does no aggregation, so you do the interpreting and any grouping with `jq`.

**Choose the record type before you start.** Default rows are one per **tool call** — friction questions: errors, output sizes, fan-out, repeats. With `--usage`, rows are one per **model-attributed usage event** — money questions: tokens, cost by model or project, aborts, truncations, compaction. For anything in the second group, read [`references/usage-records.md`](references/usage-records.md) first; it has that schema, its recipes, and its own gotchas. The two streams join on `session`.

Run scripts relative to this skill directory.

## Run it

```bash
scripts/session-report.mjs --since 30d              # one row per tool call
scripts/session-report.mjs --since 30d --usage      # one row per usage event
scripts/session-report.mjs --since 30d --args       # include tool arguments (clipped)
scripts/session-report.mjs --since 30d --stats      # stderr: files read/skipped, rows, ms
```

Options: `--dir <path>`, `--since <30d|12h|2w|ISO>`, `--tool <a,b>`, `--project <path>`, `--session <id|prefix>`, `--errors-only`, `--args`, `--details`, `--arg-bytes <n>`, `--allow-dangling`, `--usage`, `--stats`.

The script **fails loudly** (exit 2, `file:line`) on invalid JSON, a non-v3 header, a malformed assistant message or tool call, a result whose call was never seen, or a `usage` entry with no `usage` object. Unknown entry types and fields are ignored. `--usage` rejects the tool-call-only flags rather than silently ignoring them. If it reports an incomplete trailing line, a session is still being written — narrow the window or re-run later.

### Long history

Pi never prunes. Two months of ordinary use here is ~220 files / ~120 MB, growing ~2 MB/day, and those files are the corpus, so the analyzer stays cheap without holding state:

- **`--since` skips whole files unread.** A session file is append-only, so no entry can be newer than the file's last write; if mtime predates the cutoff, nothing inside can match. A 24 h slack absorbs clock changes, and copied or restored files get a fresh mtime, so they are always read — the skip never hides a recent record. `--stats` shows what was skipped.
- **`--usage` streams** each record as it parses, so memory stays flat instead of holding a file's records.
- **Prefer `reduce inputs` to `jq -s`** on long windows: ~1 KB of RSS per row slurped (measured 187 MB at 169k rows, vs 4 MB for the same answer streamed). `-s` is still fine for a 30-day slice.

Full history is ~0.7 s either way, so scan it when the question needs the whole corpus; the savings matter on the windows you re-run.

## Fields: tool-call records

Loose and intentionally small; extra fields may be added later, so ignore what you don't use.

| field | meaning |
|---|---|
| `ts` | ISO timestamp of the assistant message that requested the call |
| `session` | session id |
| `project` | working directory the session ran in |
| `tool` | tool name |
| `ok` | `true` / `false` / `null` (no result was recorded) |
| `bytes` | byte length of the result content (`null` when there was no result) |
| `msg` | per-file assistant-message index; calls sharing a `msg` ran together |
| `err` | short error text, only when `ok === false` |
| `args` | tool arguments, only with `--args` |
| `details` | result details, only with `--details` |

## jq recipes: tool calls

Stream with `reduce inputs` — constant memory, same answers as slurping:

```bash
# most-used tools
scripts/session-report.mjs --since 30d | jq -r .tool | sort | uniq -c | sort -rn | head

# error rate per tool
scripts/session-report.mjs --since 30d | jq -n '
  reduce inputs as $r ({n:0,e:0}; .n += 1 | if $r.ok == false then .e += 1 else . end)
  | {calls: .n, errors: .e, rate: (.e / .n * 100 | round)}'

# error rate per tool, worst first
scripts/session-report.mjs --since 30d | jq -n '
  reduce inputs as $r ({}; .[$r.tool] = (.[$r.tool] // {n:0,e:0}) | .[$r.tool].n += 1
    | if $r.ok == false then .[$r.tool].e += 1 else . end)
  | to_entries | map({tool: .key, n: .value.n, errors: .value.e}) | sort_by(-.errors)'

# largest outputs (context pressure), streamed: keeps a top-20, no slurp
scripts/session-report.mjs --since 30d | jq -n '
  reduce inputs as $r ([]; if $r.bytes == null then . else (. + [$r] | sort_by(-.bytes) | .[0:20]) end)
  | map({bytes, tool, ts, session})'

# fan-out: how many tool calls share one assistant message
scripts/session-report.mjs --since 30d | jq -s '
  group_by([.session, .msg]) | map(length) | group_by(.) | map({calls: .[0], n: length})'

# repeated identical calls (needs --args)
scripts/session-report.mjs --since 30d --args | jq -s '
  group_by([.tool, (.args | tostring)]) | map(select(length > 1))
  | map({tool: .[0].tool, n: length, args: .[0].args}) | sort_by(-.n) | .[0:20]'

# failure text
scripts/session-report.mjs --since 30d --errors-only | jq -r '[.tool, .err] | @tsv'
```

## Prompt content: read the raw log

Neither record type carries the system prompt or message text. For those, read the JSONL directly — one JSON object per line, in `$PI_CODING_AGENT_SESSION_DIR` (default `~/.local/state/pi/sessions`):

| path | meaning |
|---|---|
| `message.sections.{preamble,tools,rules,docs,project_context,skills,cwd}` | the system prompt, on `role: "system"` messages |
| `message.content` | the actual text / tool calls |
| `message.timestamp` | **epoch ms** — the entry's own `timestamp` is ISO |
| `id` / `parentId` | the session tree (see Gotchas) |

```bash
# did a given guideline / extension line actually reach this session?
jq -r 'select(.type=="message" and .message.role=="system")
  | .message.sections.rules // ""' <file>.jsonl | grep -c "Use grep instead of bash"
```

Entry types besides `message`: `session`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `compaction`, `usage`, `context_edit`, `branch_summary`, `label`, `session_info`.

## Gotchas

- **A session has several system messages** — one per agent start, model change, or reload (1–4 observed). To decide "was X active", check all of them, and note the prompt can change mid-session.
- **Sessions are trees, and both record modes read the raw file linearly.** `/tree` and `/fork` leave abandoned branches in the same file: 1.3% of assistant turns in a two-month corpus are off the active path (one session had 121). Counts are *records written*, not *context pi actually saw*. Say which you mean.
- **`--since 30d` is a rolling now-minus-30d cutoff**, not a calendar date, so a hand-rolled cutoff will differ by a session or two.
- **`--args` clips strings at 200 chars** (`--arg-bytes` to raise). First-token analysis is unaffected; long-command analysis is not.
- Usage-record gotchas (token double-counting, cost pricing, model attribution on compaction) are in `references/usage-records.md`.

## Interpret: clip, then check, then propose

Do it in this order. Code produces the counts; you only narrate what code produced.

**1. Clip — top 3 clusters, nothing else.** Run the recipes above first and keep at most three clusters (an error text, a repeated call, a large-`bytes` source, a fan-out pattern). Rank by `errors × sessions affected`, not by how interesting it reads. If nothing clears ~5+ occurrences across 2+ sessions, stop and say so — that is the result.

**2. Check — rule one alternative out.** Before proposing, stratify once: is it one bad session, one model/provider, one project, or off-branch turns (see Gotchas)? Re-run the same query grouped by `session`, by `project`, or against `--usage` (`aborted`/`error` by model) as needed. State what you checked and what you ruled out. If you did not check, say so.

**3. Propose — at most 3–5, ordered, each with receipts.** Every proposal needs all five, no exceptions:

- **Observation:** count + denominator + window (`34/210 bash calls (16%), --since 30d`).
- **Examples:** at least two `session` ids with `ts` (timestamps are part of the evidence).
- **Ruled out:** one alternative you checked in step 2.
- **Falsifier:** what you expect to move and the exact re-check query (`Expected: bash ENOENT 22 → <10 per 30d. Re-check: <query>`). If it doesn't move in two weeks, revert.
- **Smallest change:** prefer a doc line, flag, limit, or projection over a new engine or abstraction.

Signals worth clipping (candidates, not conclusions):

- **High error rate for a tool** → argument/naming friction; look at `err` text and repeated retries.
- **Large `bytes`** → context pressure; consider result projection, limits, or spill-aware reads.
- **High fan-out (`msg`)** → repeated parallel call patterns; consider batching or a composite operation.
- **Repeated identical calls** → retries, or a missing bulk operation.
- **Many calls with few successes** → a workflow or prompt that isn't landing.
- **Usage concentrated in one provider or project** → where guidance would pay off.

Do not propose a new engine or abstraction when the counts are small — say so explicitly if the data doesn't justify it. Never propose from a single session, a single `err` string with no denominator, or a pattern you did not re-query. Put the falsifier and re-check query in the commit message when the change ships, so the next review can verify it.
