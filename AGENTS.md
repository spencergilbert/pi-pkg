# pi-pkg

## Commit format

Use `[type/name] Message` format for commits:

- `[extensions/goal] Add a token budget to goal continuation`
- `[skills/shell] Add shell skill`
- `[themes/catppuccin] Tweak accent color`

## README

When adding, changing, or removing anything user-facing (extension, skill, prompt, theme), update `README.md` in the same commit. The root README is an **index, not a manual**: one bullet per artifact —

```markdown
- [name](./path) - one clause on what it does.
```

— and nothing else. Usage, flags, configuration, examples, troubleshooting, and credits belong in the artifact's own docs, never in the root index.

Where those docs live:

- **Skills** — `skills/<name>/README.md` for human-facing setup, configuration, invocation, and troubleshooting (every skill gets one, because the root entry links it). `SKILL.md` stays agent-facing usage only: no setup instructions, no credits.
- **Everything else** — the source file, whose header comment carries usage and attribution; add an item-local `README.md` when the artifact needs more prose than a docstring should hold, and point the root entry at it instead.

Every layer a change touches updates in the same commit.

## Project-local artifacts

`.pi/` holds artifacts that are deliberately **not** part of the package — unvetted
work in progress, loaded by Pi from this project only (`.pi/skills/`,
`.pi/extensions/`, `.pi/prompts/`, `.pi/themes/`). They get no `package.json` entry,
no root README entry, and no item README requirement until they are promoted into
`extensions/`, `skills/`, `prompts/`, or `themes/`.

## Credits

Every derived or adapted artifact carries one credit sentence, in one fixed format, plus a matching `NOTICE` entry. The sentence is always:

```text
<Verb> from [<owner>/<project> `<path/in/project>`](<url>) (<license>) — <what we changed>.
```

- **Verb.** `Copied from` — used verbatim. `Derived from` — substantial original code or prose retained. `Inspired by` — structure or idea only.
- **Label.** `<owner>/<project>` plus the backticked path of the file it came from. Never a description of the source ("mitsuhiko's github skill") in place of the path.
- **Link.** A blob/permalink to the original file. Docs sites and repo roots are not acceptable substitutes when a file link exists.
- **License.** The upstream license id, with the copyright line for MIT-style licenses: `(MIT, Copyright (c) 2026 Madeleine Ostoja)`.
- **Modification clause.** Em-dash, then what we changed; omit the clause entirely when nothing changed. Keep it to the substantive deltas, not a changelog.

Placement — exactly one human-facing home per artifact:

| Artifact | Where the sentence goes |
| --- | --- |
| A single file (extension `.ts`, prompt `.md`) | Final paragraph of the file's header comment |
| Has an item-local `README.md` (skills; extensions that grow one) | Final `## Credits` section there |
| Cannot carry a comment (JSON themes) | `NOTICE` only |

A single-file extension needs no README just to hold a credit — the header comment is the normal home, and it already carries the usage the root index no longer repeats. Grow an item `README.md` when the artifact needs setup, configuration, or troubleshooting prose; move the credit there at that point and leave a pointer in the header.

In a `README.md` (`## Credits` is the last section, the sentence is its whole body):

```markdown
## Credits

Inspired by [badlogic/pi-skills `brave-search/search.js`](https://github.com/badlogic/pi-skills/blob/main/brave-search/search.js) (MIT, Copyright (c) 2024 Mario Zechner) — same single-file CLI shape, rewritten against the Kagi API with OS-keyring key lookup.
```

In a file header comment (same sentence, Markdown kept, hard-wrapped with ` * `):

```ts
 * Derived from [mitsuhiko/agent-stuff
 * `extensions/goal.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/goal.ts)
 * (Apache-2.0) — session-log-backed state instead of an external database.
 */
```

`NOTICE` is the legal record and lists every derived file regardless of where the human-facing sentence sits. Its shape is fixed — artifact path, then a `<Verb> from <owner>/<project> (<license>):` line, then the URL on its own line, then `Modified:`:

```text
extensions/goal.ts
  Derived from mitsuhiko/agent-stuff (Apache-2.0):
  https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/goal.ts
  Modified: session-log-backed state; optional token budget; stricter audits.
```

Update the credit sentence and its `NOTICE` entry in the same commit as the artifact they describe.

## Pi documentation

Before customizing or extending Pi itself — extensions, skills, prompt templates, themes, TUI components, keybindings, packages, the SDK — read Pi's docs instead of working from memory or guessing at APIs. Pages are hosted at `https://pi.dev/docs/latest/<page>` (e.g. `.../latest/skills` for skill creation) and ship bundled with the installed binary: resolve `docs/<page>.md` and `examples/` under Pi's install directory, found via `dirname "$(readlink -f "$(command -v pi)")"`. Follow a page's cross-references before implementing, and treat upstream docs as authoritative over the conventions here.
