# pi-pkg

## Commit format

Use `[type/name] Message` format for commits:

- `[extensions/ssh] Fix tilde expansion in remote cwd`
- `[skills/shell] Add shell skill`
- `[prompts/commit] Add commit message prompt`
- `[themes/catppuccin] Tweak accent color`

## README in lockstep

When adding, changing, or removing anything user-facing (extension, skill, prompt, theme), update the matching section of `README.md` in the same commit. Each item gets a short entry: what it does and how to invoke it. Never leave a new artifact undocumented.
