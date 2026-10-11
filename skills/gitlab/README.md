# gitlab — setup

The `gitlab` skill has no scripts of its own; it points the agent at the [GitLab CLI](https://docs.gitlab.com/cli/), `glab`, maintained in [`gitlab-org/cli`](https://gitlab.com/gitlab-org/cli). This file covers installing and authenticating `glab`, including self-hosted instances; the skill assumes it already works.

## Install

```bash
mise use -g glab@latest       # or: brew install glab | sudo dnf install glab
type -P glab && glab --version
```

mise resolves `glab` from GitLab's own release pages (`gitlab:gitlab-org/cli`), so no extra repo or tap is needed. The dotfiles install it on Linux only (`mise.linux.toml`). If a fresh shell cannot find `glab`, check that mise's activation runs there (`mise doctor`, or source `~/.bashrc`).

## Authenticate

```bash
glab auth login               # choose gitlab.com (or your instance) → SSH for git → token or web
glab auth status              # active account, resolved hostname, and where the token lives
glab auth status --all        # every instance you are signed into
```

Two ways in, either is fine:

- **Web / OAuth** — `glab auth login --web` opens a browser and asks for an application secret on GitLab.com; the resulting token carries `openid`, `profile`, `read_user`, `write_repository`, `api`.
- **Personal access token** — create one with the `api` and `write_repository` scopes at [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens/legacy/new?scopes=api,write_repository), then paste it or pipe it in. Those scopes cover everything the skill does.

`glab` stores the token in the OS keyring when a backend is available (`use_keyring = true` per host); with no keyring, or with `--insecure-storage`, it writes plaintext into `~/.config/glab-cli/config.yml` and warns. `glab auth status` says which, and nudges you to migrate; re-run `glab auth login --hostname <HOST>` to move an existing plaintext token into the keyring.

## Multiple instances

`glab` supports several authenticated hosts and picks one from the git remotes in the current checkout. Log in per instance rather than exporting host variables, because environment variables are global, not per-host:

```bash
glab auth login --hostname gitlab.example.com --git-protocol ssh
glab issue list -R group/subgroup/project           # target a project explicitly
```

For instances behind a subfolder or with a separate SSH endpoint, answer the `subfolder` and `ssh_host` prompts at login (they are stored per host in `config.yml`), and point at a private CA with `ca_cert` there. Self-signed test instances: prefer a real CA entry over `GLAB_SKIP_TLS_VERIFY=1`.

## Headless and remote hosts

Over SSH, in a container, or on a runner there is no browser, and often no keyring daemon to unlock:

```bash
# Device flow: print a URL + code, open it on any device (needs GitLab 17.9+)
glab auth login --device --hostname gitlab.com

# Or pipe a personal access token in, which keeps it out of the process arguments
op read 'op://Developer/Pi/gitlab-pat' | glab auth login --hostname gitlab.com --stdin

# Or skip storage entirely: GITLAB_TOKEN beats the keyring and config.yml
export GITLAB_TOKEN="$(op read 'op://Developer/Pi/gitlab-pat')"
```

Install and authenticate `glab` **on the machine where the commands run** — pi launched over SSH, in a container, or on a CI runner will not see a login made elsewhere. In GitLab CI itself, prefer `glab auth login --job-token "$CI_JOB_TOKEN" --hostname "$CI_SERVER_FQDN"` (or `GLAB_ENABLE_CI_AUTOLOGIN=true`) and never set `GITLAB_TOKEN=$CI_JOB_TOKEN`: job tokens are not accepted in the `PRIVATE-TOKEN` header that `GITLAB_TOKEN` uses.

## Optional configuration

Everything lives in `~/.config/glab-cli/config.yml` (`GLAB_CONFIG_DIR` relocates it; `glab config set <key> <value>` edits it). Worth setting on a machine where an agent runs `glab`:

```bash
glab config set check_update false        # no update notices in command output
glab config set telemetry false           # or GLAB_SEND_TELEMETRY=false
glab config set --key remote_alias --value origin   # when several remotes exist (see below)
```

A repository with remotes on several forges (a GitHub mirror, a Tangled remote) may leave `glab` unable to infer the project from the current directory. Set `remote_alias` to the GitLab remote's name, or pass `-R group/project` on every command — the skill does the latter by default.

## Troubleshooting

- **`401 Unauthorized` / "No token found (checked config file, keyring, and environment variables)"** — no credential visible in that shell. Run `glab auth status` there, then log in or export `GITLAB_TOKEN`.
- **A keyring error mentioning D-Bus, or a hang on an unlock prompt** — a session bus exists only inside a graphical login. Reuse the running one (`export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"`), or log in with `--insecure-storage`, or use `GITLAB_TOKEN`.
- **`404` from a project you can open in a browser** — the token lacks the `api` scope, or the path needed URL-encoding: `projects/group%2Fproject/issues`.
- **A command that never returns** — `glab` is prompting for input, or running a TUI (`glab ci view`, `glab mr view` on a pager, `--web`). Supply the flag it wants (`-m`, `--title`, `--description`, `-y`) or set `GLAB_NO_PROMPT=1` for that one call.
- **`git: ... fatal` from a `glab` command that clones or pushes** — `glab` shells out to `git`; check `git remote -v` and that the SSH host is reachable.
- **Wrong account or hostname** — `glab auth status --all` lists every instance; log out of the stale one with `glab auth logout --hostname <HOST>`.

## Credits

Derived from [gitlab-org/cli `internal/commands/skills/bundled/assets/glab/SKILL.md`](https://gitlab.com/gitlab-org/cli/-/blob/main/internal/commands/skills/bundled/assets/glab/SKILL.md) (MIT, Copyright (c) 2022-present GitLab Inc.) — restructured as a Pi skill in this package's house style: keeps the discussion, `glab api`, and non-interactive guidance in condensed form, drops the quick-reference and stacked-diff detail in favour of reading `glab skills get glab` at runtime, and adds the identity (`glab` has no `@me`), output-projection, approval, and reviewed-SHA-merge habits.
