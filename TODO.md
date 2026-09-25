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
  `createEditToolDefinition`, as `extensions/ssh` already does for all tools):
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

## 5. grep / find / ls — underused; no prompt guidance

**Priority: high leverage for the effort. Genuinely unclaimed upstream.**

### Evidence
- grep tool 48 vs bash leading `rg`/`grep` 177 (~3.7×).
- ls tool 28 vs bash leading `ls` 164 (~5.9×).
- find tool 4 vs bash leading `find`/`fd` 30 (~7.5×).
- `dist/core/tools/{grep,find,ls}.js` have `guidelines: []`; only `read`
  ("Use read instead of cat or sed") and `write` carry any.

### Upstream
- No issue found about adding preference guidelines for these tools. Related
  system-prompt issues ([#4893](https://github.com/earendil-works/pi/issues/4893),
  [#4789](https://github.com/earendil-works/pi/issues/4789),
  [#5049](https://github.com/earendil-works/pi/issues/5049)) are about
  overriding sections, not tool steering. **Genuine gap.**

### Options
- pi-pkg prompt / global AGENTS.md guidance mirroring the `read` line:
  use `grep` instead of bash `grep`/`rg`, `find` instead of bash `find`/`fd`,
  `ls` instead of bash `ls`. The dedicated tools respect `.gitignore` (avoids
  `node_modules` blowups) and `grep` returns line numbers.
- Upstream PR to add the same one-liners to the built-in tool definitions.

### Status
- **Experimental local stopgap shipped**: `extensions/tool-guidance.ts` adds
  the three guidelines via the mutable `systemPromptOptions.toolGuidelines` of
  `before_agent_start` (not by re-registering tools, which would clobber
  `ssh`'s remote-routed `execute`). Being tested ahead of the upstream PR.

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
