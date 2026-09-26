# pi-pkg

## Commit format

Use `[type/name] Message` format for commits:

- `[extensions/goal] Add a token budget to goal continuation`
- `[skills/shell] Add shell skill`
- `[prompts/commit] Add commit message prompt`
- `[themes/catppuccin] Tweak accent color`

## README in lockstep

When adding, changing, or removing anything user-facing (extension, skill, prompt, theme), update the matching section of `README.md` in the same commit. Each item gets a short entry: what it does and how to invoke it. Never leave a new artifact undocumented.

## Docs

Three layers, each with one job:

- **Root `README.md`** — the user-facing index. Every artifact gets a short entry: what it does, how to invoke it, and a link to its own docs when it has them. It is not the only home for setup detail.
- **Item-local `README.md`** (e.g. `skills/kagi/README.md`) — human-facing setup, configuration, and troubleshooting for that artifact. Not agent context; safe to keep long.
- **`SKILL.md`** — agent-facing usage only. No human setup instructions.

Update every layer the change touches in the same commit. New artifacts get a root README entry and, if they need setup, an item-local README.

## Skill paths

In `SKILL.md`, refer to bundled scripts by paths relative to the skill's own directory
(`./search.mjs`), following Pi's skill docs. Pi advertises each skill's location and performs
no `{baseDir}`-style substitution, so do not reintroduce that placeholder.
