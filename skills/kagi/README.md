# kagi — setup

The `kagi` scripts read the Kagi API key from the OS keyring at call time. Nothing is read from the environment, so there is no key sitting in the environment of every shell and every process.

Lookup coordinates are identical on both platforms:

| Field | Value |
| --- | --- |
| service | `kagi` |
| account | `api_key` |

## Store the key

The key comes from https://kagi.com/settings?p=api — here shown being read back out of 1Password.

### Linux — libsecret (GNOME Keyring, KWallet)

```bash
op read 'op://Private/Pi/kagi' | secret-tool store --label='Kagi API key' service kagi key api_key
```

Verify it round-trips (expect a non-zero count):

```bash
secret-tool lookup service kagi key api_key | wc -c
```

`secret-tool` ships in `libsecret-tools` (Debian/Ubuntu), `libsecret` (Fedora, Arch).

### macOS — login Keychain

```bash
security add-generic-password -s kagi -a api_key -U -w "$(op read 'op://Private/Pi/kagi')"
```

Verify it round-trips:

```bash
security find-generic-password -s kagi -a api_key -w | wc -c
```

Two caveats:

- `-w <value>` puts the key in the process arguments briefly, where `ps` can see it. To avoid that, drop `-w` and let `security` prompt — but it cannot read from a pipe, so you type or paste the key twice.
- The first read from a new caller may raise a Keychain access prompt. Approve it once with **Always Allow**; otherwise script reads hang until the 10 second timeout.

## Rotate or remove

Rotate by re-running the store command above: on Linux the identical attributes overwrite the existing entry, on macOS `-U` updates it in place. The scripts pick up the new value on the next call.

Remove:

```bash
secret-tool clear service kagi key api_key          # Linux
security delete-generic-password -s kagi -a api_key # macOS
```

## Troubleshooting

**`no Kagi API key in the OS keyring`** — the entry is missing. Run the store command for your platform above.

**`could not reach the OS keyring session bus`** — expected over SSH, in a container, or without a desktop session. There is no way to unlock a running keyring from another session; your options are:

- **Linux, with a graphical session for the same user running** — reuse its session bus while it stays logged in:

  ```bash
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  secret-tool lookup service kagi key api_key
  ```

  This works only while the login keyring is unlocked, which it normally is for the whole graphical session.

- **macOS** — unlock the login keychain explicitly:

  ```bash
  security unlock-keychain ~/Library/Keychains/login.keychain-db
  ```

  It prompts on the tty and stays unlocked until sleep or lock; tune that with `security set-keychain-settings -t <seconds>`.

**`timed out ...`** — the keyring is locked and an unlock prompt is waiting somewhere you cannot see, or no prompt is reachable at all. Unlock it in a graphical session (or per the macOS command above), then retry.

## How it works

`keyring.mjs` owns the platform dispatch and is read-only; `lib.mjs` calls it from `resolveApiKey()`. Setup is deliberately not something the scripts do for you.
