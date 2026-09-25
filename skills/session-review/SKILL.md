---
name: session-review
description: Review Pi session logs for real usage patterns and propose evidence-backed improvements to the agent harness, prompts, skills, and tools. Use when asked to analyze how the agent has been working, find repeated failures or friction, audit tool usage, or look for large/repeated calls. Explicit invocation only.
disable-model-invocation: true
---

# Session review

Analyze past Pi sessions and turn them into concrete, evidence-backed improvements. The analyzer is `{baseDir}/session-report.mjs`; it normalizes Pi's v3 session JSONL into one JSON object per tool call, and you do the interpreting (and any aggregation) with `jq`.

## Run it

```bash
{baseDir}/session-report.mjs --since 30d            # JSONL on stdout
{baseDir}/session-report.mjs --since 30d --args     # include tool arguments (clipped)
```

Options: `--dir <path>`, `--since <30d|12h|2w|ISO>`, `--tool <a,b>`, `--project <path>`, `--session <id|prefix>`, `--errors-only`, `--args`, `--details`, `--arg-bytes <n>`, `--allow-dangling`.

The script **fails loudly** (exit 2, `file:line`) on invalid JSON, a non-v3 header, a malformed assistant message or tool call, or a result whose call was never seen. Unknown entry types and fields are ignored. If it reports an incomplete trailing line, a session is still being written — narrow the window or re-run later.

## Fields

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

## jq recipes

```bash
# most-used tools
{baseDir}/session-report.mjs --since 30d | jq -r .tool | sort | uniq -c | sort -rn | head

# error rate per tool
{baseDir}/session-report.mjs --since 30d | jq -s '
  group_by(.tool) | map({tool: .[0].tool, n: length, errors: (map(select(.ok == false)) | length)})
  | sort_by(-.n)'

# largest outputs (context pressure)
{baseDir}/session-report.mjs --since 30d | jq -s 'map(select(.bytes != null)) | sort_by(-.bytes) | .[0:20]'

# fan-out: how many tool calls share one assistant message
{baseDir}/session-report.mjs --since 30d | jq -s '
  group_by([.session, .msg]) | map(length) | group_by(.) | map({calls: .[0], n: length})'

# repeated identical calls (needs --args)
{baseDir}/session-report.mjs --since 30d --args | jq -s '
  group_by([.tool, (.args | tostring)]) | map(select(length > 1))
  | map({tool: .[0].tool, n: length, args: .[0].args}) | sort_by(-.n) | .[0:20]'

# failure text
{baseDir}/session-report.mjs --since 30d --errors-only | jq -r '[.tool, .err] | @tsv'
```

## Beyond tool calls

The script emits tool calls only. For tokens, cost, model attribution, or what
the prompt actually contained, read the session JSONL directly — one JSON object
per line, in `$PI_CODING_AGENT_SESSION_DIR` (default `~/.local/state/pi/sessions`).

| path | meaning |
|---|---|
| `message.role` | `user` / `assistant` / `system` / `toolResult` |
| `message.model`, `message.provider`, `message.api` | set on assistant messages; use to attribute calls or tokens to a model |
| `message.usage.{input,output,cacheRead,cacheWrite,totalTokens}` | token counts |
| `message.usage.cost.total` | cost, priced from the catalog when the message was written |
| `message.stopReason` | `stop` / `toolUse` / `aborted` / `error`; `message.errorMessage` carries text on the last two |
| `message.timestamp` | **epoch ms** — the entry's own `timestamp` is ISO |
| `message.sections.{preamble,tools,rules,docs,project_context,skills,cwd}` | the system prompt, on `role: "system"` messages |

```bash
# tokens and notional cost by model, most-used first
jq -r 'select(.type=="message" and .message.role=="assistant" and .message.usage)
  | [.message.model, (.message.usage.input//0), (.message.usage.output//0),
     (.message.usage.cacheRead//0), (.message.usage.totalTokens//0),
     (.message.usage.cost.total//0)] | @tsv' \
  ~/.local/state/pi/sessions/*.jsonl \
| awk -F'\t' '{c[$1]++; i[$1]+=$2; o[$1]+=$3; r[$1]+=$4; n[$1]+=$5; t[$1]+=$6}
    END{for (m in c) printf "%-28s %6d %10d %9d %12d %12d  $%8.2f\n",
      m, c[m], i[m], o[m], r[m], n[m], t[m]}' \
| sort -k6 -rn

# did a given guideline / extension line actually reach this session?
jq -r 'select(.type=="message" and .message.role=="system")
  | .message.sections.rules // ""' <file>.jsonl | grep -c "Use grep instead of bash"
```

Gotchas:

- **A session has several system messages** — one per agent start, model change,
  or reload (1–4 observed). To decide "was X active", check all of them, and note
  the prompt can change mid-session.
- **`usage` keys are not fixed.** Three shapes observed: with `reasoning`,
  without it, and with `cacheWrite1h`. Read keys defensively instead of summing a
  hardcoded set.
- **`usage.cost.total` is priced from the catalog at write time**, is `0` for
  subscription providers, and moves if the catalog changes. Tokens are the stable
  unit.
- **`--since 30d` is a rolling now-minus-30d cutoff**, not a calendar date, so a
  hand-rolled cutoff will differ by a session or two.
- **`--args` clips strings at 200 chars** (`--arg-bytes` to raise). First-token
  analysis is unaffected; long-command analysis is not.
- Entry types besides `message`: `session`, `model_change`,
  `thinking_level_change`, `custom`, `custom_message`, `compaction`.

## Interpret

Read the numbers, then propose **3–5 ordered, evidence-backed** improvements. Cite counts, examples, and timestamps; prefer changes the data supports and say what you ruled out.

Signals worth checking:

- **High error rate for a tool** → argument/naming friction; look at `err` text and repeated retries.
- **Large `bytes`** → context pressure; consider result projection, limits, or spill-aware reads.
- **High fan-out (`msg`)** → repeated parallel call patterns; consider batching or a composite operation.
- **Repeated identical calls** → retries, or a missing bulk operation.
- **Many calls with few successes** → a workflow or prompt that isn't landing.
- **Tool usage concentrated in one provider or project** → where guidance would pay off.

Do not propose a new engine or abstraction when the counts are small — say so explicitly if the data doesn't justify it.
