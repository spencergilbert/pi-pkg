---
name: commit
description: Commit the current changes with a message that matches the repository's own conventions. Use when asked to commit, describe, or land changes, or when writing a commit message.
compatibility: Needs `git` on PATH.
---

# Commit

Commit the current changes. Take the message format from the repository, not from a convention you already know.

## Find the tool

`git rev-parse --is-inside-work-tree` succeeds → use `git`. If it fails this is not a checkout: say so rather than running `git init`.

## Find the style

Use the first source below that answers the question, and do not fall back on Conventional Commits or any other well-known convention when none of them does.

1. **The request** — anything stated, however it was phrased or invoked.
2. **Project guidance** — `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `git config --get commit.template`, or a `commit-msg` hook (`core.hooksPath`, else `.git/hooks/`).
3. **Observed history** — `git log --format=%s -n 50`. Copy subject structure, capitalization, tense, scope or `[type/name]`-style prefixes, whether bodies appear and how they wrap, and which trailers appear.
4. **Nothing above answered it** — a fresh repository, or history with no descriptions: ask for guidance. Do not invent a convention.

## Make the commit

Read the change set first: `git status --short` with `git diff` (and `--cached`).

- **Stage by path** — `git add <paths>`, not `-A`, which sweeps in files the change never meant.
- **Commit** — `git commit -m "<subject>"`, one more `-m` per body paragraph.
- **Always pass `-m`** — bare `git commit` opens `$EDITOR` and waits for you.
- **Then read back what you wrote** — `git log -1 --format=%B`.

## Defaults

The request overrides every one of these.

- Commit only: no push, publish, rebase, or pull request.
- Commit only the files this change is about. If a file's place in it is unclear, ask before including it.
- **Trailers and signatures follow the repository.** Copy `Signed-off-by`, `Change-Id`, or a breaking-change footer when its history or instructions have them, and add none it does not. Do not pass `-S`/`--gpg-sign` on your own initiative — `commit.gpgSign` and `format.signOff` decide whether a change is signed.
