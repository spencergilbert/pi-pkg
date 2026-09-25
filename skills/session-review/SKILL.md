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
