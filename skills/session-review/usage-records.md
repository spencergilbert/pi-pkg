---
title: session-review — usage records
description: Schema, recipes, and gotchas for `session-report.mjs --usage`. Read this before answering token, cost, model, abort, truncation, or compaction questions about Pi sessions.
---

# Usage records

`./session-report.mjs --usage` emits one row per model-attributed usage event instead of one row per tool call: every assistant message, every `usage` entry (`type: "usage"`, e.g. cache warming), and every `compaction` that carries `usage`. Rows stream out as they parse, so memory stays flat.

`--usage` rejects `--tool`, `--errors-only`, `--args`, `--details`, `--arg-bytes`, and `--allow-dangling`: they select on tool-call fields these rows don't have. Ask for one record type at a time. Run from this skill's directory, or use the absolute script path.

## Fields

Absent numbers stay absent rather than becoming `0`, so a missing key never looks like a free turn.

| field | meaning |
|---|---|
| `ts`, `session`, `project` | as in tool-call records |
| `kind` | `assistant` / `usage` / `compaction` |
| `model`, `provider`, `api` | pi stamps these on assistant and `usage` entries but not on `compaction`, so a compaction row inherits the last model seen in that file |
| `input`, `output`, `cacheRead`, `cacheWrite` | token counts, verbatim from `message.usage` |
| `reasoning` | **already included in `output`** — do not add it again |
| `cacheWrite1h` | subset of `cacheWrite` written with 1 h retention — do not add it either |
| `total` | `usage.totalTokens` |
| `cost` | `usage.cost.total`, catalog-priced when the message was written |
| `calls` | tool calls requested by this message (assistant rows only); `0` means a turn that answered instead of acting |
| `stop` | `stopReason`: `stop` / `toolUse` / `aborted` / `error` / `length` |
| `err` | `errorMessage`, only when the turn errored or was aborted |
| `op` | the `kind` of a `usage` entry, e.g. `cache_warm` |
| `tokensBefore` | compaction rows: context size that got summarized |

These rows sum to the file's full token total, because they include the `compaction` and `usage`-entry turns a raw `role == "assistant"` grep drops — only ~0.2% of tokens in a two-month corpus, but they are the difference between agreeing with pi's accounting and quietly undercounting it.

## jq recipes

```bash
# tokens and notional cost by model, most-used first
./session-report.mjs --usage | jq -n '
  reduce inputs as $u ({}; .[$u.model // "?"] = (.[$u.model // "?"] // {n:0,tok:0,cost:0})
    | .[$u.model // "?"].n += 1
    | .[$u.model // "?"].tok += ($u.total // 0)
    | .[$u.model // "?"].cost += ($u.cost // 0))
  | to_entries | map(.value + {model: .key}) | sort_by(-.n)'

# monthly trend: did a shipped change move cost or friction? (the question --usage exists for)
# [0:7] buckets by month; [0:10] by day, [0:4] by quarter
./session-report.mjs --usage | jq -n '
  reduce inputs as $u ({}; (($u.ts // "")[0:7]) as $m
    | .[$m] = (.[$m] // {turns:0,tok:0,cost:0,aborted:0})
    | .[$m].turns += 1 | .[$m].tok += ($u.total // 0) | .[$m].cost += ($u.cost // 0)
    | if ($u.stop == "aborted" or $u.stop == "error") then .[$m].aborted += 1 else . end)
  | to_entries | map(.value + {month: .key}) | sort_by(.month)'

# turns that ended without acting, per model (giving-up / confusion signal)
./session-report.mjs --usage | jq -n '
  reduce inputs as $u ({}; .[$u.model // "?"] = (.[$u.model // "?"] // {n:0,noCall:0})
    | .[$u.model // "?"].n += 1 | if $u.calls == 0 then .[$u.model // "?"].noCall += 1 else . end)
  | to_entries | map(.value + {model: .key}) | sort_by(-.noCall)'

# truncations and aborts, with the text pi recorded
./session-report.mjs --usage | jq -r 'select(.stop == "length" or .stop == "aborted" or .stop == "error")
  | [.ts, .model, .stop, (.err // "")] | @tsv'

# context pressure: where compaction actually fired
./session-report.mjs --usage | jq -r 'select(.kind == "compaction") | [.ts, .session, .tokensBefore] | @tsv'

# cost by project
./session-report.mjs --usage | jq -n '
  reduce inputs as $u ({}; .[$u.project // "?"] = ((.[$u.project // "?"] // 0) + ($u.cost // 0)))
  | to_entries | map({project: .key, usd: ((.value * 100 | round) / 100)}) | sort_by(-.usd)'
```

To join the two record types, aggregate each side and join on `session` — e.g. which models burn many tokens *and* many tool errors. Do it per session, not per row: a raw row-level join on 20k × 20k is the wrong tool.

```bash
# tokens per session, then error rate per session, lined up by session id
# note: this is an inner join — sessions with no tool calls drop out
./session-report.mjs --usage | jq -sr '
  group_by(.session) | map({session: .[0].session, tok: (map(.total // 0) | add)})' > /tmp/tok.json
./session-report.mjs | jq -sr '
  group_by(.session) | map({session: .[0].session, calls: length,
    err: (map(select(.ok == false)) | length)})' > /tmp/err.json
jq -n --slurpfile t /tmp/tok.json --slurpfile e /tmp/err.json '
  [$t[0][] as $a | ($e[0][] | select(.session == $a.session)) | {session, tok: $a.tok, calls, err}]
  | sort_by(-.err) | .[0:15]'
```

## Gotchas

- **`reasoning` is inside `output`, and `cacheWrite1h` is inside `cacheWrite`.** Adding them double-counts.
- **`cost` is priced from the catalog at write time**, is `0` for subscription providers, and moves if the catalog changes. Tokens are the stable unit for trend lines.
- **A compaction row's model is inherited**, not stamped. Counting cost by model is therefore approximate by the compaction share (~0.2% of tokens measured here).
- **Off-branch turns are counted** — see the tree gotcha in `SKILL.md`. Aborted and retried turns still cost what they cost, which is usually what you want for money, and usually *not* what you want for "how did the agent behave".
- **`calls: 0` on an `aborted` turn is not a refusal.** It is usually an abort before the model got anywhere; check `err` before reading it as the agent giving up.

## Interpret

Signals worth checking in usage records:

- **`stop: "length"`** → output truncated at the cap; a silent quality cliff worth sizing against the model's limit.
- **`aborted` / `error` concentrated on one model or provider** → flaky provider, or a prompt that outruns it.
- **`calls: 0` turns rising while tool errors rise** → the agent giving up instead of acting.
- **Frequent `compaction` at low `tokensBefore`** → context burning on oversized results rather than on real work.
- **Cost per session climbing while tool calls per session stay flat** → context is growing, not the work.
