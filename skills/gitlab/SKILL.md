---
name: gitlab
description: Interact with GitLab through the `glab` CLI — issues, merge requests, CI/CD pipelines, releases, to-dos, and raw API queries. Use for any gitlab.com or self-hosted GitLab task; `glab` is authenticated, reads private projects, and returns structured JSON.
compatibility: Requires the GitLab CLI (`glab`) installed and authenticated (`glab auth status`). Setup is documented in README.md in this directory.
---

# GitLab

Use `glab` for GitLab work, not `curl` against `gitlab.com/api/v4`. It authenticates every request, resolves the host and project from your git remotes, and formats its own output.

```bash
glab issue ...  glab mr ...  glab ci ...  glab release ...  glab repo ...  glab api ...
```

Commands are noun-first (`glab ci list`, `glab mr create`), and `glab <command> --help` prints examples plus that subcommand's flags. For anything beyond the everyday commands, `glab skills get glab` prints GitLab's own bundled agent reference — discussions, `glab api` content types, stacked diffs — read it before inventing a flag.

## Habits that matter

- **Project the output.** `-F json --jq '<expr>'` on list and view commands, `-P/--per-page` to bound a listing. Two exceptions: `glab issue list` takes `-O json` for the format and `-F ids|urls|details` for the shape; `glab api` has no `--jq`, so pipe to `jq` and use `--paginate` for paging.
- **There is no `@me`.** Resolve the login once — `glab api user | jq -r .username`, or read it off `glab auth status` — and pass literal usernames to `--assignee`, `--author`, `--reviewer`. `glab todo list` is the "what needs my attention" queue (`-a approval_required`, `-t MergeRequest`).
- **Target the project explicitly.** Inside a checkout `glab` infers host and project from the remotes; anywhere else pass `-R group/subgroup/project` (a full URL works too), `-g group` for group-level listings, and `--hostname` to pick an instance.
- **Say it GitLab's way.** Merge request, not pull request; `--description`, not `--body`; `iid` is project-scoped, so pair it with `-R` when the project is not the current one. Commands taking an MR or issue identifier accept the iid, the source branch name, or the full URL.
- **Never let `glab` open an editor, a pager, or a browser.** That means: always `-m` on note commands, always an explicit `--description`/`--description-file`/`--title` instead of `-` (which opens `$EDITOR`), never `--web`, and add `-y/--yes` to commands that confirm. If a command stalls, it is prompting — cancel and supply the missing flag (`GLAB_NO_PROMPT=1` is the last resort, since it also removes the confirmation you may have wanted).
- **Confirm before writing.** For issue and MR creation, comments, closes, approvals, merges, reruns, and pushes, state the exact target and body and get a yes first, especially on projects the user does not own.

## Comments and discussions

`glab mr note` root flags (`-m`, `--unique`, `--resolve`) are deprecated; use the subcommands.

```bash
glab mr note create <iid> -m "text"                       # short body
glab mr note create <iid> < /tmp/body.md                   # long body: stdin, or a quoted heredoc
glab mr note create <iid> -m "investigating" --internal    # private note, no noise for watchers
glab mr note create <iid> --reply <discussion-id> -m "agreed"
glab mr note create <iid> --file main.go --line 42 -m "needs a test"   # --line 10:15, --old-line 7, or no line for the file
glab mr note create <iid> -m "LGTM" --unique              # idempotent
glab mr note resolve <iid> <discussion-id>                # 8+ char prefix, or a note id
glab issue note <iid> -m "text"                           # root-level comment only
```

- `glab issue note` and `glab incident note` cannot reply inside a thread. For that, fall back to the API: read `projects/:id/issues/<iid>/discussions` for the discussion id, then `glab api projects/:id/issues/<iid>/discussions/<did>/notes -F body=@/tmp/reply.md`.
- Build rich bodies in a file or a quoted heredoc (`<< 'EOF'`): backticks, `$`, and `\` survive, and a body that begins with `@` must go through `-f body="..."` or an inline heredoc, never `-F body=@...`, which reads `@` as a filename.
- Write full URLs (`https://gitlab.com/group/project/-/issues/123`) in bodies, not `#123` or `!456`: short refs do not expand on group-level items.

## `glab api`

Auto-prepends `/api/v4`, so pass relative paths: `glab api projects/:id/merge_requests`, not `/api/v4/...`.

- Placeholders `:id :fullpath :group :namespace :repo :branch` resolve from the current checkout, and `:user :username` anywhere. Outside a checkout add `-R group/project` for the placeholders to expand, spell the path with `%2F` (`projects/group%2Fproject/issues`), or use a numeric project ID. Anything else that starts with a colon is sent verbatim and fails server-side.
- `-f/--raw-field` sends literal strings; `-F/--field` infers type, parses `[`/`{` as JSON (so arrays and nested objects go inline), and reads `@file` as text; `--form` is multipart and required for real file uploads (`glab api projects/:id/uploads --form file=@shot.png`) and cannot mix with `-f`, `-F`, or `--input`; `--input body.json` needs `-H "Content-Type: application/json"` or the endpoint returns 415.
- Default method is GET with no fields, POST with them; override with `-X`.

## Presenting issues and MRs before submitting

`glab issue create` and `glab mr create` publish under the user's name the moment they run, so neither is part of "just do it" — they follow the same approval as a merge.

1. **Draft it, show it, wait.** Present the payload formatted for reading: title on its own line, body as rendered markdown (fenced only if the body itself contains fences), then one line each for labels, assignee, reviewer, and target branch. Stop there; run the create command only after an explicit yes, applying edits first.
2. **Check the project's own templates** — `.gitlab/issue_templates/` and `.gitlab/merge_request_templates/` — and offer `--template <name>` rather than a blank body.
3. **Create MRs as drafts.** Default to `glab mr create --draft`, which lets the user review the MR before anyone is pinged; request reviewers when it goes ready (`glab mr update <iid> -r`, which also flips draft off), never at creation. Make sure the branch exists on the remote — `--push` pushes it for you, and `-f/--fill` takes title and body from the commits and pushes too.

## CI

- `glab ci lint .gitlab-ci.yml` before pushing pipeline changes.
- `glab ci status -b <branch>` / `glab ci get --merge-request <iid> --with-job-details -F json` for state. **`glab ci view` is a blocking TUI and `glab ci trace` streams until the job ends** — for a finished log use `glab api projects/:id/jobs/<job-id>/trace`.
- `glab ci retry` takes a **job** id or name. To retry a whole pipeline: `glab api projects/:id/pipelines/<id>/retry -X POST`. Start one with `glab ci run -b <branch>` (`--mr` for an MR pipeline).

## Merging and rewriting history

```bash
# Before merging: approvals, conflicts, and threads a reviewer left open
glab mr view <iid> -F json --jq '{draft, approved, approvals_before_merge, has_conflicts}'
glab mr note list <iid> --state unresolved --type general
glab mr approvers <iid>
```

`--jq` on a key glab does not emit yields `null` rather than failing, so read `--jq 'keys'` once when a field name is a guess.

- **Merge with `--sha`.** `glab mr merge <iid> --sha <reviewed-head>` aborts if the source branch moved since the commits were read — the guard a plain merge lacks. Prefer the platform's own merge or squash (`-s`, `--squash-before-merge`) over rewriting the branch locally, and use `--auto-merge` instead of babysitting pipelines.
- **Once a human has reviewed, add commits instead of rewriting.** If discussions or approvals exist, push follow-up commits so anchored comments survive. Rebasing or amending an unreviewed MR of your own is fair game; when reviews exist but someone asked for a rewrite, ask.
- **`glab mr rebase <iid>` rebases server-side** and is the safer way to move an unreviewed branch onto its target than a local force push.
- **When you do force push, `git push --force-with-lease`**, never plain `--force`.
