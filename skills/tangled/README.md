# tangled — setup

The `tangled` skill has no scripts of its own; it points the agent at [`tg`](https://github.com/alyraffauf/tg), a command-line client for [Tangled](https://tangled.org), the git forge built on atproto. This file covers installing, logging in, and the two configuration knobs worth knowing; the skill assumes it already works.

## Install

```bash
mise use -g "go:github.com/alyraffauf/tg/cmd/tg@latest"

# or, without a Go toolchain
brew tap alyraffauf/tap && brew trust alyraffauf/tap && brew install alyraffauf/tap/tg
nix profile add github:alyraffauf/tg

type -P tg && tg --version
```

mise resolves this through its Go backend (`go:github.com/alyraffauf/tg/cmd/tg`), so it builds from source and needs no tap. If a fresh shell cannot find `tg`, check that mise's activation runs there (`mise doctor`, or source `~/.bashrc`).

## Log in

```bash
tg auth login spencergilbert.dev    # OAuth: browser, loopback callback on 127.0.0.1
tg auth status                      # handle, DID, and session state
tg auth list                        # every stored account, with its login method
```

`tg auth login` authenticates against the account's atproto PDS, not Tangled itself. OAuth is the default and binds a loopback callback (RFC 8252), so it needs a browser on the same machine as the command.

## Headless and remote hosts

```bash
# App password on stdin keeps it out of the process list and out of shell history
op read 'op://Private/Pi/tangled-app-password' | tg auth login spencergilbert.dev --password-stdin

# No keyring at all: --insecure stores one account in plaintext
tg auth login spencergilbert.dev xxxx-xxxx-xxxx-xxxx --insecure
```

Sessions live in the OS keyring — macOS Keychain, Secret Service (GNOME Keyring or KWallet) on Linux — and are read lazily, so a broken keyring only shows up on the first command that needs a session.

- **Install and log in on the machine where `tg` runs.** A login made locally is invisible to pi on a remote host, in a container, or on a runner; without a browser there, log in with an app password.
- **No D-Bus session bus** (containers, CI runners): start `gnome-keyring-daemon` or `kwalletd`, or point at the running bus with `export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"`. Otherwise use `--insecure`.
- **`--insecure` requires an app password** — it does not support OAuth — and stores a single account at `~/.local/share/tg/credentials.json` (`0700` directory, `0600` file), overwritten by the next login.
- Create the app password in the PDS account settings (for Bluesky-hosted accounts: Settings → App Passwords), not on Tangled.

## Multiple accounts

Logging in adds or replaces that account and makes it the default.

```bash
tg auth switch other.example.com              # change the default
tg issue create ... --account other.example.com   # one-command override (or TG_ACCOUNT)
tg auth logout                                # removes the selected account; --all removes every one
```

Only the account that opened an issue or PR can edit its title and body, which is why `issue edit`, `pr edit`, and `pr update` take no `-R`: they reach only the selected account's own records.

## Configuration

`~/.config/tg/config.toml` (`--config` or `TG_CONFIG` relocates it), with `TG_`-prefixed environment variables and then flags layered on top. The file is optional; defaults are shown.

```toml
appview = "https://api.tangled.org"   # read API (Bobbin)
ssh-port = 22                         # port for an explicitly pinned knot's direct remotes
protocol = "ssh"                      # clone URL scheme: ssh or https
# account = "spencergilbert.dev"
# knot = "knot1.tangled.sh"           # pin repo creation instead of verified discovery
```

| Key | Environment | Flag |
| --- | --- | --- |
| `appview` | `TG_APPVIEW` | `--appview` |
| `account` | `TG_ACCOUNT` | `--account` |
| `knot` | `TG_KNOT` | `tg repo create --knot` |
| `ssh-port` | `TG_SSH_PORT` | — |
| `protocol` | `TG_PROTOCOL` | — |

Leave `knot` unset unless discovery is ambiguous: with no `knot`, `tg repo create` reads the account's knot registrations, verifies them, and needs exactly one to succeed. It errors and lists the candidates when several verify.

## Remotes

`tg repo clone` writes a remote that survives handle changes, renames, and transfers: the repository DID behind the `tangled.org` proxy (`git@tangled.org:did:plc:...`), or a direct remote on an explicitly pinned knot.

An `origin` in `handle/repo` form lets `tg` resolve the repository automatically. The DID form does not resolve in `tg` 0.7.0, so either name the repository on every command or rewrite the remote:

```bash
git remote set-url origin git@tangled.org:spencergilbert.dev/pi-pkg
```

HTTPS pushes use `tg` as a credential helper, which mints a short-lived knot token per push and stores nothing:

```bash
git config --global credential."https://tangled.org".helper "!tg auth git-credential"
git remote set-url origin https://tangled.org/<repo-did>
```

## Troubleshooting

- **`no Git remote matches a Tangled repository record: did:plc:...: repository DID service endpoint must be an HTTPS Knot URL, got "https://knot1.tangled.sh/repo/..."`** — remote inference on a DID-form `origin` fails. Pass the repository explicitly (`tg pr list handle/repo`, or `-R handle/repo`), or set the remote to the handle form as above.
- **`Error: accepts 1 arg(s), received 2`** — the repository is a flag on that subcommand, not a second positional. Record commands (`pr view|diff|comment|checkout|merge`, `issue view|comment|close`) take `-R`.
- **`fatal: not a git repository`** — `tg` shells out to `git` to infer the repository. Run it inside a checkout, or name the repository.
- **A command that never returns** — it is waiting on `$EDITOR` or streaming logs. Pass `--body`/`--body-file`/`--title`, or bound `tg pipeline logs` with `timeout`.
- **`handle syntax didn't validate via regex`** — handles are domains (`alice.example.com`), never bare names.
- **Keyring error, or a hang mentioning D-Bus** — no session bus in that shell; see [Headless and remote hosts](#headless-and-remote-hosts).
- **`authenticated: false`, or writes landing on the wrong account** — `tg auth status` and `tg auth list` in the same shell; log in there, or pass `--account`.
- **`tg repo delete` refuses to run** — it requires `--yes`, which is the prompt's job to ask for, not the agent's.

## Credits

Inspired by [alyraffauf/tg `SKILL.md`](https://github.com/alyraffauf/tg/blob/main/SKILL.md) (GPL-3.0) — its command recipes and patch-and-round PR model carried over; rewritten in this package's house style with explicit repository targeting, record-key addressing, non-interactive and output-projection habits, the DID-remote inference failure, and approval before writes.
