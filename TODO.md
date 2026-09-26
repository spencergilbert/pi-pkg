# TODO — Pi built-in tool improvements

Possible improvements surfaced by the `session-review` skill, with context and
upstream status so any of these can be picked up cold.

## How this list was produced

30-day session review (2026-08-26 → 2026-09-25): **12,895 tool calls / 74
sessions / 7 projects**, 651 errors (5.0%). Analyzer + recipes live in
[`skills/session-review/`](skills/session-review/).

```bash
skills/session-review/session-report.mjs --since 30d > /tmp/sr2.jsonl
skills/session-review/session-report.mjs --since 30d --args > /tmp/sr2-args.jsonl

jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length,
  err: (map(select(.ok==false))|length)}) | sort_by(-.n)' /tmp/sr2.jsonl
```

| tool | calls | errors | rate | notes |
|---|---:|---:|---:|---|
| bash | 10,128 | 529 | 5.2% | 78.6% of all calls |
| **edit** | 1,399 | 100 | **7.1%** | worst rate |
| read | 948 | 19 | 2.0% | 13/19 are `{}` args |
| write | 310 | 0 | 0% | clean |
| grep | 48 | 1 | 2.1% | underused |
| ls | 28 | 0 | 0% | underused |
| find | 4 | 0 | 0% | barely used |

Tool implementations for reference (installed 0.87.1):
`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{edit,edit-diff,bash,read,grep,truncate}.js`.
Upstream repo: `earendil-works/pi`.

**Important:** pi auto-closes all issues from new contributors
(`CONTRIBUTING.md`); "CLOSED" usually means "not triaged", not "fixed".
Maintainers reopen worthwhile ones daily. Verified against `main` where noted.

---

## 1. edit tool — recovery hints + leading-whitespace fuzzy matching

**Priority: highest. Biggest error class; the fix exists upstream but never landed.**

### Evidence
- 100/1,399 errors (7.1%): **75 "oldText not found"**, 13 non-unique, 6 overlap,
  3 malformed args, 2 no-op, 1 ENOENT.
- **42/100** errors are followed by a bash `sed -n` / `grep -n` inspection of the
  same file, then a retry. **72/100** recover on the very next edit.
  ~2 extra calls each → ~200 calls/month.
- Concentrated in large files: `BENCHMARKS.md`, `PLAN.md`, `.pi/checkpoint.md`,
  `ds4_server.c`, `ds4.c`, `ds4_rocm_*.cuh`, `model.zig`.
- The model uses `sed -n`/`grep -n` (not `read`) because the not-found error
  carries **no line numbers**, and `read` output has **no line numbers** either.

### Root cause (in `dist/core/tools/edit-diff.js`)
- `normalizeForFuzzyMatch` only does `.map((line) => line.trimEnd())` + Unicode
  quote/dash/space folding. **Leading indentation and interior whitespace runs
  are not normalized**, so tab↔space and `a    b` ↔ `a b` fail.
- `getNotFoundError` is bare — no nearest-match, no line numbers.
- `getDuplicateError` gives a count but no occurrence locations.

### Upstream
- [#8654](https://github.com/earendil-works/pi/issues/8654) — "edit tool
  mismatch errors lack recovery guidance, causing retry loops" (our exact
  finding). Auto-closed.
- [#7836](https://github.com/earendil-works/pi/issues/7836) — fuzzy match misses
  whitespace-length differences. Closed "COMPLETED"; commenters confirm still
  present on `main` (`cd6852a`).
- [#5899](https://github.com/earendil-works/pi/issues/5899) — aggressive fuzzy
  rewriting caused silent whole-file data loss. **Caution for any fix.**
- [#8628](https://github.com/earendil-works/pi/issues/8628) false non-unique from
  curly quotes; [#9697](https://github.com/earendil-works/pi/issues/9697)
  ambiguous overlapping targets; [#9545](https://github.com/earendil-works/pi/issues/9545)
  batch uniqueness (open).
- PR [#10027](https://github.com/earendil-works/pi/pull/10027) (2026-09-25,
  closed, **unmerged**) — contains the fix: "bounded, line-numbered ground truth
  near the best match … actionable recovery hints in edit and grep errors."
- PR [#6520](https://github.com/earendil-works/pi/pull/6520) file-context in
  not-found error (closed); PRs [#8099](https://github.com/earendil-works/pi/pull/8099),
  [#7962](https://github.com/earendil-works/pi/pull/7962),
  [#7978](https://github.com/earendil-works/pi/pull/7978),
  [#6144](https://github.com/earendil-works/pi/pull/6144) whitespace collapsing
  (all closed).
- Verified current `main` `packages/coding-agent/src/core/tools/edit-diff.ts`:
  still `trimEnd()`-only and the bare error. **Not fixed today.**

### Options
- **A. Build a pi-pkg `edit` wrapper** (re-register via
  `createEditToolDefinition`):
  on not-found, append nearest-match context with line numbers; extend fuzzy
  matching to leading whitespace. Medium effort, stays in our repo.
- **B. Adopt a known-good replacement:**
  - [mitsuhiko/agent-stuff `unified-edit.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/unified-edit.ts)
    (pi owner) — row-script/patch payload, **same fuzzy core inlined + whole-line
    matching**, line-numbered ops (`@INS.PRE N`, `@DEL N-M`), preflight
    validation.
  - [`@lucascardozo/pi-edit-guard`](https://pi.dev/packages/@lucascardozo/pi-edit-guard)
    — silently fixes uniform leading-space shift, consolidates batch errors.
  - [`pi-edit-guard`](https://pi.dev/packages/pi-edit-guard) — repair pipeline +
    14-pass match chain.
  - [`edit-o-matic`](https://pi.dev/packages/edit-o-matic) — whitespace-tolerant
    fallback (pre-1.0.5 could corrupt indent-sensitive files).
  - [`@d3ara1n/pi-hashline-edit`](https://pi.dev/packages/@d3ara1n/pi-hashline-edit)
    — edit by `LINE#HASH` reference ("no string-not-found loops").
  - `pi-better-edit`, `@kreeger/pi-edit-split` (diff preview only).
- **C. Contribute upstream** — likely futile while #10027 sits unmerged; could
  reopen #8654/#7836 with our session evidence first.

---

## 2. bash tool — no `cwd` parameter; redundant `cd` on >half of calls

**Priority: medium. Upstream will not fix; treat as guidance + optional pkg.**

### Evidence
- **5,616 / 10,128 (55%)** of bash calls start with `cd <session-project> &&`
  — cd to the tool's own cwd. 6,734 commands start with `cd … &&/;`; **83% of
  those target the session's own project**.
- 1,118 cd elsewhere (`/tmp`, other repos), all encoded in the command string.

### Upstream
- [#7241](https://github.com/earendil-works/pi/issues/7241) "Expose cwd
  parameter to bash tool" — **closed NOT_PLANNED** (same rationale: agents
  prepend `cd … &&`).
- [#5904](https://github.com/earendil-works/pi/issues/5904) "cwd parameter is
  silently dropped" — **closed NOT_PLANNED**.
- [#2992](https://github.com/earendil-works/pi/issues/2992) "Allow session CWD
  to be changed" (open).
- PR [#8627](https://github.com/earendil-works/pi/pull/8627) (merged) fixed tools
  ignoring `ctx.cwd`; did not add a param.
- Packages: `@piotr-oles/pi-cwd`, `@harms-haus/pi-cwd`, `@cad0p/pi-bash-timeout`.

### Options
- Add a pi-pkg prompt/AGENTS.md line: the cwd is already the session project, so
  don't prefix `cd <project> &&` (removes ~5.6k redundant cds and their quoting
  risk).
- Adopt a `pi-cwd` package if a real per-call cwd is wanted.

---

## 3. Output truncation / context pressure

**Priority: medium. Truncation is hardcoded; upstream marked config NOT_PLANNED.**

### Evidence
- bash: p50 533 B, p90 2,940 B, **p99 9,929 B**; 98 results >10 KB, 36 >20 KB;
  max 83,329 B serialized (≈50 KB text cap; session-review measures JSON, so
  backslash escaping inflates it).
- `read` total 4.77 MB; repeated whole-file reads: `ds4.c` **55×/188 KB**,
  `qwen4exp.zig` 37×/163 KB, `nvim/init.lua` 32×/184 KB.
- Offenders: `find`/`ls` walking `node_modules`, `cat` of multiple files,
  `journalctl` dumps, `gh release view` bodies.

### Current behavior (`dist/core/tools/truncate.js`)
- `DEFAULT_MAX_BYTES = 50 * 1024`, `DEFAULT_MAX_LINES = 2000`; hardcoded.
- bash uses **tail** truncation (+ temp-file spill); read uses **head**.
  Tail is right for errors, wrong for listings (head is what you want).

### Upstream
- [#6254](https://github.com/earendil-works/pi/issues/6254) "Make tool output
  truncation limits configurable" — **closed NOT_PLANNED** (rationale matches
  ours: 50 KB ≈ 10–15k tokens).
- [#5935](https://github.com/earendil-works/pi/issues/5935) override truncation
  limit — **closed NOT_PLANNED**.
- [#134](https://github.com/earendil-works/pi/issues/134) old truncation issue;
  PR [#10037](https://github.com/earendil-works/pi/pull/10037) collapse
  historical tool output (closed).
- Package: `pi-output-limits`.

### Options
- pi-pkg prompt hygiene: prefer `rg` with `--glob '!node_modules'`, pipe broad
  output through `head`, read windows after edits rather than whole files.
- Adopt `pi-output-limits` for a tighter cap than 50 KB.
- Upstream: head-truncate listing tools (find/ls/grep) instead of tail.

---

## 4. read tool — directory errors, no line numbers

**Priority: low–medium.**

### Evidence
- 19/948 errors: 13 are `{}` args, **all in one session** (`01a03f50`, local
  `llama.cpp`/`ds4`/`opencode-go`) → local-model quirk, not a tool bug. Others:
  `EISDIR`, `ENOENT`, ssh `cat` of a directory.
- No line numbers in output, which forces bash `sed -n`/`grep -n` recovery for
  edits (see §1).

### Upstream
- [#4430](https://github.com/earendil-works/pi/issues/4430) "A lot of errors
  (write, edit, read) during long sessions" — includes the same `read {}`
  validation errors on local models.
- [#7971](https://github.com/earendil-works/pi/issues/7971) grep tool doesn't
  dedupe with `context` (closed).
- [#9887](https://github.com/earendil-works/pi/issues/9887)/[#9989](https://github.com/earendil-works/pi/issues/9989)
  are TUI-renderer line-number issues only.

### Options
- Optional line numbers on `read` results (wrapper), or make the edit not-found
  error carry line numbers (see §1) so a bare `read` is enough.
- Friendlier "that's a directory — use ls" error.

---

## 5. grep / find / ls — underused; the prompt steers to bash

**Priority: high leverage for the effort. Genuinely unclaimed upstream.**

### Evidence
Measured 2026-09-25 over the 30d window with the recipe under Status:
- grep tool 48 vs bash leading `grep` **1,665** (~34.7×). `rg` never leads a
  bash call.
- ls tool 31 vs bash leading `ls` **375** (~12.1×).
- find tool 4 vs bash leading `find` **55** (~13.8×). `fd` never leads a bash
  call.
- `dist/core/tools/{grep,find,ls}.js` have `guidelines: []`; only `read`
  ("Use read instead of cat or sed") and `write` carry any.
- **The prompt invites the behaviour it never corrects.** `bash.js:31` renders
  as `- bash: Execute bash commands (ls, grep, find, etc.)` in the `<tools>`
  list — the three dedicated tools named as shell examples. `buildRules`
  (`system-prompt.js:30-56`, steer added at :53) hardcodes a route to bash when
  grep/find/ls are *not* selected and adds nothing when they are:
  one-directional by design. `powershell`'s snippet carries no such lure
  (`Execute PowerShell commands`).
- **Correction:** the first pass recorded 177/164/30 for the bash-leading
  counts. Re-running the same recipe on the same window gives 1,665/375/55, so
  the underuse is ~4-9× worse than first recorded.

### Upstream
- No issue found about adding preference guidelines for these tools. Related
  system-prompt issues ([#4893](https://github.com/earendil-works/pi/issues/4893),
  [#4789](https://github.com/earendil-works/pi/issues/4789),
  [#5049](https://github.com/earendil-works/pi/issues/5049)) are about
  overriding sections, not tool steering. **Genuine gap.**

### Options
- Upstream: reword `bash`'s snippet to drop `ls, grep, find` (the highest-
  leverage single change — it removes a live contradiction at the surface the
  model reads when choosing a tool), and add the symmetric `buildRules` branch
  for when those tools *are* selected.
- pi-pkg prompt / global AGENTS.md guidance mirroring the `read` line:
  use `grep` instead of bash `grep`/`rg`, `find` instead of bash `find`/`fd`,
  `ls` instead of bash `ls`. `grep`/`find` respect `.gitignore` (avoids
  `node_modules` blowups), `grep` returns line numbers, and all three
  head-truncate with an actionable limit notice.
- Upstream PR to add the same one-liners to the built-in tool definitions.

### Status
- **Reachable from an extension (corrects an earlier assumption).**
  `normalizeBuildSystemPromptOptions` (`system-prompt.js:9-23`) shallow-copies
  `toolSnippets` and array-copies `toolGuidelines`/`promptGuidelines`, and
  `emitBeforeAgentStart` (`runner.js:1017`) hands every handler the same object
  before the prompt is built (`agent-session.js:1318`). So both the `<tools>`
  snippet line and the Guidelines list are patchable — still not the tool
  *schema description* (`bash.js:153`), which would need a re-register and
  would clobber another extension's `execute`.
- **Stopgap widened 2026-09-26** to patch both surfaces (the guidelines-only
  version shipped in `bfa9a50`): `toolSnippets.bash`
  lure removed, one positive routing rule added on `bash`/`powershell`
  (covering `edit`/`write` versus `sed -i`/`cat >`), and the three original
  guideline lines kept verbatim so they stay diffable against the upstream PR.
  Still prompt-only — the `tool_call` guard idea was explicitly rejected.
- **Drift fails loudly, not silently.** The snippet swap is guarded on pi's
  exact built-in text and throws on anything unexpected; `runner.js:1047-1055`
  catches per-handler, reports via `emitError`, and continues, so the throw
  costs only the snippet swap (guidelines are applied first). Once per process
  — `before_agent_start` runs every turn and repeated errors are noise; the
  flag re-arms on `/reload`. `docs/extensions.md:201`: "Pi reports handler
  errors and continues where possible."
- **Rendered-prompt check (no model call)**: import `buildSystemPrompt` +
  `normalizeBuildSystemPromptOptions` from
  `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js` by
  absolute path (the `exports` map blocks the bare subpath), feed it pi's real
  built-in snippets, run the handler, and grep the output. Verified: lure gone
  from `<tools>`, each rule present exactly once, guidelines survive the drift
  throw, and double-applying the handler stays idempotent (`buildRules` dedupes
  on trimmed text) so two loaded copies of pi-pkg cannot false-alarm or spam.
- **Verify later with the `session-review` skill.** Baseline over the 30d to
  2026-09-25: grep 48 vs bash-leading `grep` 1,665, ls 31 vs 375, find 4 vs 55.
  Re-run after a couple of weeks and look for the dedicated counts rising while
  the bash-leading counts fall and grep/find/ls error rates stay flat.
  **Both layers changed on 2026-09-26**, so coverage restarts; also add
  bash-leading `cat`/`sed` as a measure of the `edit`/`write` half.
- **No duplicate-guidelines bug** (checked 2026-09-25): an earlier pass thought
  each line rendered twice, but that was an artifact of `--mode json` emitting
  the system prompt as both `message_start` and `message_end`. Session logs show
  exactly one occurrence per system message, and
  `normalizeBuildSystemPromptOptions` rebuilds `toolGuidelines` as a fresh array
  on every `before_agent_start`, so the handler cannot accumulate. No guard
  needed, and nothing grows with session length.
- **Coverage as of 2026-09-25 is too thin to read.** Only 5 sessions carry the
  guideline in the system prompt, and in 4 of them it arrived mid-session (model
  change/reload) rather than at the start. Those 5 are also bash-heavy
  `qwen3.8-flash` sessions (689 of 881 tool calls were bash), so they are not a
  representative sample. No verdict yet.

  ```bash
  # dedicated-tool calls
  skills/session-review/session-report.mjs --since 30d --tool grep,find,ls \
    | jq -r .tool | sort | uniq -c

  # bash calls by leading verb (strips any leading `cd … &&` chain)
  skills/session-review/session-report.mjs --since 30d --args --tool bash \
    | jq -r '.args.command // ""' \
    | sed -E 's/^[[:space:]]*(cd[^&;]*[&;]+[[:space:]]*)*//' \
    | awk '{print $1}' | sed 's#.*/##' | sort | uniq -c | sort -rn | head -20
  ```

---

## 6. Provider-native (server-side) tools — upstream NOT_PLANNED; extension is the only route

**Priority: low. Blocked upstream by design; the sanctioned path is an extension.**

### What
Providers increasingly ship server-executed tools declared in the request's
`tools` array — QwenCloud `{"type":"web_search"}` / `code_interpreter` /
`web_extractor` (Responses API only), Anthropic `web_search_20250305`, DeepSeek
V4 Flash `web_search`, GLM coding-plan search via the Responses proxy. pi cannot
reach any of them: `registerTool` has no provider-native option
(`ToolDefinition` exposes only `constrainedSampling`, `renderShell`,
`prepareArguments`, execution mode), and the transports emit only
`type:"function"` tools.

### Evidence (our runs, 2026-09-25)
- `opencode-go` Responses API (`POST https://opencode.ai/zen/go/v1/responses`)
  with `tools:[{"type":"web_search"}]`: `deepseek-v4.1-flash` → HTTP 200 but
  **no search executed** (`output_types: ["reasoning","message"]`, no
  `search_results`, no annotations); `qwen3.8-flash` and `kimi-k2.6` → 503
  "Endpoint is unavailable". [#8661](https://github.com/earendil-works/pi/issues/8661)
  reports a real `search_results` item with `grok-4.5`, so it is model/upstream
  dependent — verify per model before building anything.
- pi's Responses adapter hardcodes `annotations: []` on outgoing items and never
  reads incoming ones; no `web_search_call` / `code_interpreter_call` handling.
- `before_provider_request` **is** wired into the coding agent as
  `onPayload: transformProviderPayload`, and a handler returning a payload
  replaces the request body — that is the injection point.

### Upstream
- [#7704](https://github.com/earendil-works/pi/issues/7704) "support server-side
  builtin tools in OpenAI Responses compat" — **closed NOT_PLANNED**. Maintainer:
  *"server side tools are not transferable between providers, and also generate
  transcript entries that can not be interpreted by other providers. not planned."*
- Also closed: [#1324](https://github.com/earendil-works/pi/issues/1324),
  [#1740](https://github.com/earendil-works/pi/issues/1740),
  [#4955](https://github.com/earendil-works/pi/issues/4955),
  [#6365](https://github.com/earendil-works/pi/issues/6365),
  [#9560](https://github.com/earendil-works/pi/issues/9560) (serverTools proposal;
  auto-closed PR #9556 — author runs it as an extension instead),
  [#8661](https://github.com/earendil-works/pi/issues/8661) (`web_search` function
  name is reserved on the Responses API),
  [#9784](https://github.com/earendil-works/pi/issues/9784) (meta-issue:
  vendor-specific response fields). **Do not re-file.**

### Options
- pi-pkg extension: wrap the transport and append raw tool entries via
  `before_provider_request` — the same approach #9560's author runs. Only worth
  it where the provider actually executes the tool (see evidence above).
- Config-only partial: `samplingParams: {"enable_search": true}` on an
  `openai-completions` model enables Qwen web search with no code, but the
  compatible-mode endpoint returns no sources.
- Otherwise use pi's own tooling (kagi skill, MCP search): visible tool calls,
  approvals, citations, provider-agnostic.

---

## Done / already handled

- **Remote env (dotfiles)** — `~/.dotfiles` commit `e97a388`:
  `bashrc.d/10-mise.sh` (`eval "$(mise activate bash --shims)"`) and
  `bashrc.d/20-rocm.sh` (ROCM_PATH/HIP_PATH/PATH, guarded on `/opt/rocm/bin`),
  mapped in `mise.toml` as `"~/.bashrc.d/" = { source = "bashrc.d/", mode =
  "symlink-each" }`. Verified on `laptop` and `desktop`: plain `ssh desktop`
  and extension-style `bash -se` both resolve `hipcc`, `rg`, `zig`, `ROCM_PATH`.
  Removes the per-command PATH preamble seen in 1,590 amferd bash calls.
- **1Password git-signing failures** — root cause was the agent's 1Password
  auto-lock; user raised the lock timeout to 8 h. Optional fallback (not added):
  a short global `AGENTS.md` rule to not retry `failed to fill whole buffer`.

## Ruled out (no action)

- `...` tool (2 calls, "Tool ... not found") and `mcp`/`mcpScript` (2 calls
  total): insufficient signal.
- `write`: 310 calls, 0 errors.
- **`extensions/ssh` removed 2026-09-26.** A 90-day scan of the session logs
  found no runtime activation record at all: every `SSH mode on` and
  `PI_SSH_ACTIVE` hit was source code being edited (pikit, then pi-pkg), never
  this extension running. Its derived-target premise also no longer holds —
  only 3 of 5 local repos exist at the same path on `desktop`, so `--ssh` from
  here fails its own probe and silently falls back to local. The remote
  `grep`/`find` parity work was verified good against pi's built-in tools on
  `amferd`, but nothing depends on it. If remote execution comes back, decide
  the trigger first (builds on the GPU box?) and start from upstream's
  `examples/extensions/ssh.ts` or running pi on the host over tmux.
