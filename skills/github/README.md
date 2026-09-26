# github — setup

The `github` skill has no scripts of its own; it points the agent at the [GitHub CLI](https://cli.github.com), `gh`. This file covers installing and authenticating `gh`; the skill assumes it already works.

## Install

```bash
mise use -g gh@latest        # or: brew install gh | sudo dnf install gh
type -P gh && gh --version
```

If a fresh shell cannot find `gh`, check that mise's activation runs there (`mise doctor`, or source `~/.bashrc`).

## Authenticate

```bash
gh auth login                # GitHub.com → SSH for git → web browser
gh auth status               # shows the active account and its token scopes
gh auth refresh -s repo      # add scopes later, without a fresh login
```

`gh`'s default scopes (`repo`, `read:org`, `gist`) cover everything the skill does. Credentials are stored per host in `~/.config/gh/hosts.yml`, or in the OS keyring when a helper is configured; `--insecure-storage` forces the plain file on hosts with no keyring at all.

## Headless and remote hosts

Over SSH, in a container, or on a runner there is no browser, and often no keyring daemon to unlock:

```bash
# Device flow through a tty: open the printed URL on any device you like
ssh -t desktop gh auth login --git-protocol ssh --web

# Or pipe a personal access token in, which keeps it out of the process arguments
op read 'op://Private/Pi/github-pat' | gh auth login --with-token

# Or skip storage entirely: GH_TOKEN beats GITHUB_TOKEN, which beats hosts.yml
export GH_TOKEN="$(op read 'op://Private/Pi/github-pat')"
```

Install and authenticate `gh` **on the remote** whenever your commands run there — pi launched over SSH, in a container, or on a runner. They will not see a local login.

## Troubleshooting

- **`gh: not logged in`** — no credential visible in that shell. Run `gh auth status` in the same shell, then either log in there or export `GH_TOKEN`.
- **A keyring prompt that never appears, or a hang** — a session bus exists only inside a graphical login. Point at the running one (`export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"`), or use one of the headless routes above.
- **`404` from a repository you can open in a browser** — the token is missing the `repo` scope: `gh auth refresh -s repo`.
- **`API rate limit exceeded`** — check the budget with `gh api rate_limit`; something in the path is talking to `api.github.com` without credentials.
- **`error: some commands require git`** — install `git`; `gh` shells out for clone, push, and branch operations.

## Credits

Derived from [mitsuhiko/agent-stuff `skills/github/SKILL.md`](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/github/SKILL.md) (Apache-2.0) — states the auth rationale and the repo-targeting, output-projection, CI-log, `gh api`, and write-confirmation habits; defers details to `gh --help`.
