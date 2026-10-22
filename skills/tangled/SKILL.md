---
name: tangled
description: Interact with Tangled through the `tg` CLI — repositories, issues, pull requests, CI pipelines, SSH keys, and strings. Use for any tangled.org task; `tg` is authenticated, resolves the repository from `origin` or an explicit handle, and returns structured JSON.
compatibility: Requires the `tg` CLI installed and logged in (`tg auth status`). Setup is documented in README.md in this directory.
---

# Tangled

Use `tg` for Tangled work, not `curl` against `api.tangled.org`. It holds your atproto session, resolves the repository from `origin` or an explicit `handle/repo`, and renders its own output.

```bash
tg repo ...  tg issue ...  tg pr ...  tg pipeline ...  tg ssh-key ...  tg string ...
```

`tg <command> --help` is the source of truth for flags, and the Nix package also installs per-command man pages (`man tg-pr-create`). Read them instead of guessing.

Tangled is not GitHub on another domain: a repository belongs to an atproto account whose handle is a domain (`alice.example.com`), lives on a host called a *knot*, and is addressed as `handle/repo`. Nothing has a short numeric number.

## Habits that matter

- **Name the repository on every command.** Commands whose usage line reads `[handle/repo]` take it positionally; ones acting on a record take `-R/--repo handle/repo`. Inference from `origin` is unreliable — the `git@tangled.org:did:plc:...` remote that `tg` itself writes for new clones currently fails to resolve — so passing the repository and skipping the failure mode is cheaper than debugging it.
- **Address issues and PRs by record key.** The key is the last segment of the `at://` URI (`.../sh.tangled.repo.pull/3myiljypb3k22`) and is the `RKEY` column of `tg pr list`. There is no `#123`.
- **Project the output.** `--json` turns lists into `{"items": [...]}` and single records into the domain object (`rkey`, `title`, `state`, `body`, `author.handle`, `sourceBranch`, `targetBranch`). Bound listings with `--limit`, filter with `--state open|closed|merged` on PRs and `--state open|closed` on issues, plus `--author` and `--order asc|desc`.
- **Never let `tg` open an editor.** Without `--body`/`--body-file` — or without a title, for `issue create` — it launches `$EDITOR` and waits, which in an agent session means a hidden editor or a hung command. Always pass the text.
- **`--body-file` takes a path, not stdin.** `--body-file -` reads a file literally named `-`. Only `tg string create` treats `-` as standard input.
- **Use a full handle.** Bare names fail (`handle syntax didn't validate via regex`): handles are domains, so `tg repo list alice` errors where `tg repo list alice.example.com` works.
- **Confirm before writing.** Issue and PR creation, comments, closes, merges, `repo create --push`, `repo delete --yes`, and SSH-key changes publish or destroy under the user's account; state the exact target and get a yes first, especially on repositories the user does not own.

## Auth

```bash
tg auth status --json       # {"authenticated":true,"status":"active","handle":...}
tg auth list                # every stored account and how it logged in
tg auth switch <handle>     # change the default
tg auth login <handle>      # OAuth in a browser, or an app password for headless use
```

Pass `--account <handle-or-did>` (or `TG_ACCOUNT`) to use a non-default account for one command without switching the default. Never print `tg auth token`.

## Issues

```bash
tg issue list spencergilbert.dev/website --state open --json
tg issue view <key> -R spencergilbert.dev/website --json
```

`tg issue create '<title>' --body-file /tmp/issue.md -R handle/repo` takes the title as a positional argument; comments, edits, closes, and reopens take the key first. `issue edit`, `pr edit`, and `pr update` act on the selected account's own records and accept no `-R`.

## Pull requests are patches, not branches

`tg pr create` snapshots the diff from the base branch to the source branch in your local checkout, uploads it as a patch blob, and writes the pull record. The source branch is never pushed, so nothing outside your checkout has to know it exists.

```bash
git fetch origin                                    # base defaults to origin/<default branch>
git switch -c fix-clone-failure
git commit -am "Fix clone failure"
tg pr create -t 'Fix clone failure' -F /tmp/pr.md    # title always; body flag is one of -b/-F
```

- **Keep the source branch until the PR merges.** `tg pr update <key>` regenerates the patch from the PR's recorded source branch against `origin/<target branch>` and appends it as a new round, so the branch must still exist locally with the new commits.
- **Rounds replace force pushing.** Each round is an immutable patch, so amending or rebasing locally is harmless — but review written against an earlier round stops lining up, so once someone has read the PR, add commits instead of rewriting.
- **Read before touching.** `tg pr view <key> -R ... --json` gives state, body, and the branch pair; `tg pr diff <key> -R ...` prints the latest round as a Unix patch. Neither shows comments: `tg` has no comment listing and no review or approval commands, so read the discussion with `tg browse handle/repo` and add to it with `tg pr comment <key> -b '...' -R ...`.
- **Check out a PR's latest round** with `tg pr checkout <key> -R ...`. It applies the patch onto `pr-<key>` (`-b <name>` to rename, `-f` to reset an existing branch) and needs no access to the author's branch.
- **Merge with `tg pr merge <key> -R ...`.** The knot applies the latest patch and uses the PR title as the commit message and the body as the commit body. There is no squash or rebase choice, and nothing to force-push.
- **Fork PRs set three flags:** `-R` for the target, `--source-repo` for the fork, and `-B/--base` for the target's remote-tracking branch, which has to be fetched first.

## Presenting issues and PRs before submitting

`tg issue create` and `tg pr create` publish under the user's name the moment they run, so neither is part of "just do it" — they follow the same approval as a merge.

1. **Draft it, show it, wait.** Present the payload formatted for reading: the title on its own line, the body as rendered markdown (a fenced block only if the body itself contains fences), then one line each for the target repository and, for a PR, the `source → target` branches. Stop there; run the create command only after an explicit yes, applying edits first.
2. **Write the body to a temp file** and pass `--body-file`, which keeps fences, backticks, and long text out of the shell quoting.
3. **Know what Tangled does not have.** No assignees, no issue or PR labels (labels exist on repositories, via `tg repo edit --add-label`), no milestones, no review requests, no draft flag, no approvals — rendering a GitHub-shaped template into a Tangled issue is worse than a plain title and body.

## CI

Tangled runs CI from `.tangled/workflows/*.yml` on a *spindle*; a pipeline is one commit's set of workflow runs.

```bash
tg repo view handle/repo --json          # repo record folded with the latest pipeline
tg pipeline list handle/repo             # ID, commit, trigger, status per pipeline
tg pipeline status handle/repo --json    # latest default-branch pipeline, with workflows[]
tg pipeline view <id> -R handle/repo     # one pipeline; shows the failure error per workflow
```

- **`tg pipeline logs <id> -R handle/repo` streams until the pipeline finishes.** With `--json` it emits one event per line (`{"type":"control",...}` / `{"type":"data",...}`), not a single document, and it exits non-zero when a workflow failed. Run it under a timeout, and use `tg pipeline view` first to see which workflows exist (`-w <workflow>` selects them).
- `tg pipeline trigger <revision> -R handle/repo` takes a branch or a full commit SHA — a SHA works outside a checkout — and `tg pipeline cancel <id>` stops pending and running workflows.

## Repositories and strings

```bash
tg repo list [handle]                                # omit the handle for your own account
tg repo search '<query>' -n 20                       # public repositories across knots
tg repo view handle/repo
tg repo create <name> --push . --description '...'   # push an existing checkout; sets its branch as default
tg repo clone handle/repo [directory]                # a bare name means your own account, and needs login
tg repo fork handle/repo [name]
tg repo edit [handle/repo] --description ... --website ... --spindle ... --add-label ...
tg repo set-default-branch <branch> [handle/repo]
tg repo delete [handle/repo] --yes                   # irreversible
```

`tg string` is Tangled's file and snippet store: `tg string create <file>` (or `-` for stdin, with `--filename`), then `tg string list`, `tg string view <key>`, `tg string delete <key>`. `tg ssh-key list|add|delete` manages the account's keys, and `tg browse [handle/repo]` opens any of it in the browser.
