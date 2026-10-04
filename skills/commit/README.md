# commit — setup

`SKILL.md` in this directory is the whole skill: instructions, no scripts. It replaces the always-loaded "match the repository's commit style" rule in `AGENTS.md` with text Pi reads only when it is about to commit something, and it handles `jj` as well as `git`.

## Requirements

Only the version-control CLI the checkout already uses has to be on `PATH`:

```bash
command -v git jj        # whichever your repositories use
```

Nothing to install, authenticate, or configure for the skill itself — it runs read-only inspection commands and one commit command. A machine with neither CLI simply never triggers it.

## Use

Ask for a commit in ordinary words — "let's commit this work" — and Pi loads the skill from its description. `/skill:commit` forces the load when it doesn't. Anything you say alongside the request outranks everything the skill contains, including which files belong in the commit.

## Setting a repo's style

The skill has no message format of its own. It reads, in order: the request, project guidance (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `git config --get commit.template`, or a `commit-msg` hook under `core.hooksPath`), the last 50 subjects in history. With nothing to read — a fresh repository, or history whose changes carry no descriptions — it asks rather than guessing.

To pin the style, add this section to the `AGENTS.md` at the root of that repository — the same file Pi already loads as project instructions, so the skill reads it with no further setup:

```markdown
## Commit format

Use `[type/name] Message`, the artifact path as the scope:
`[extensions/goal] Add a token budget to goal continuation`.
```

A colocated repository (`.jj` beside `.git`) is committed with `jj describe`, not `git commit`, because jj owns that history. To use git there anyway, say so in the request or put the stanza above in the project's `AGENTS.md` — both outrank detection.

## Troubleshooting

- **`name "commit" collision` under `[Skill conflicts]` in Pi's startup diagnostics** — two skills claim the name and the first discovered wins; rename or remove one source.
- **`skill path does not exist`** — a `pi.skills` entry points somewhere that isn't there. Relative paths resolve from the settings file that declares them.
- **`/skill:commit` is absent from the command list** — skill commands need `enableSkillCommands` in settings; typing it still works. Run `/reload` after editing a skill.
- **`(no email set)` in `jj log`** — jj does not read git's `user.name`/`user.email`; set it once with `jj config set --user user.name "Spencer Gilbert"` and the matching `user.email`, or jj warns `Name and email not configured` on every describe.
- **Commit came out unsigned where its history is signed** — the skill never passes `-S`/`--gpg-sign` or runs `jj sign`, so signing is whatever the configuration says: `git config --get commit.gpgSign`, `jj config get signing.backend`. Fix it there, or ask for the signature in the request. The same goes for a missing `Signed-off-by` (git's `format.signOff`, a DCO line rather than a signature) and for `Change-Id` and other trailers, which the skill adds only to repositories whose history already carries them.
- **Subject style ignored in a jj repository** — `jj log` hides abandoned and orphaned changes from its default revset, so the sample read may be thinner than the history. Check what is reachable with `jj log -r 'all()' --no-pager -T 'description.first_line() ++ "\n"'`.

## Credits

Inspired by [mitsuhiko/agent-stuff `skills/commit/SKILL.md`](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/commit/SKILL.md) (Apache-2.0) — keeps the read-the-repo-then-commit shape; drops the prescribed Conventional Commits format in favour of project instructions and observed history, handles `jj` as well as `git`, and leaves signing and trailers to repository configuration.
