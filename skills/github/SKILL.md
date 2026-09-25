---
name: github
description: Interact with GitHub through the `gh` CLI — issues, pull requests, CI runs, releases, search, and raw API queries. Use for any github.com or api.github.com task; `gh` is authenticated, reaches private repos, and returns structured JSON.
compatibility: Requires the GitHub CLI (`gh`) installed and authenticated (`gh auth status`). Setup is documented in README.md in this directory.
---

# GitHub

Use `gh` for GitHub work, not `curl` against `api.github.com`. It authenticates every request, reads private repositories, and formats its own output.

```bash
gh issue ...  gh pr ...  gh run ...  gh release ...  gh search ...  gh api ...
```

Discover specifics from the CLI: `gh <command> --help` prints examples plus the subcommand's valid `--json` fields, and `gh help formatting` covers `--json`/`--jq`/`--template`.

## Habits that matter

- **Target the repo explicitly.** Inside a git checkout `gh` infers it; anywhere else pass `--repo owner/repo` on every command.
- **Project the output.** `--json number,title --jq '.[] | "#\(.number) \(.title)"'` plus `--limit`, so a listing or log fits the result budget.
- **Read CI with `--log-failed`**, which returns only the failed steps of a run.
- **Reach for `gh api` when a subcommand stops short**, using a relative path: `gh api repos/owner/repo/pulls/55 --jq '.state, .user.login'`. `--paginate` follows `Link` headers; `-f` sends strings, `-F` typed values.
- **Confirm before writing.** For comments, closes, merges, pushes, and reruns, state the exact target and body and get a yes first, especially on repositories the user does not own.
