---
name: commit
description: Commit the current changes with a message that matches the repository's own conventions. Use when asked to commit, describe, or land changes, or when writing a commit message. Detects jj (Jujutsu) and git instead of assuming either.
compatibility: Needs the checkout's own VCS CLI on PATH, `git` or `jj`.
---

# Commit

Commit the current changes. Take the message format from the repository, not from a convention you already know.

## Find the tool

`jj root` succeeds → use `jj`, including in a colocated repository where `.jj` sits beside `.git` and jj owns the history; `git commit` there writes behind its back. Otherwise use `git`. If neither succeeds this is not a checkout: say so rather than running `git init` or `jj git init`.

## Find the style

Use the first source below that answers the question, and do not fall back on Conventional Commits or any other well-known convention when none of them does.

1. **The request** — anything stated, however it was phrased or invoked.
2. **Project guidance** — `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `git config --get commit.template`, or a `commit-msg` hook (`core.hooksPath`, else `.git/hooks/`).
3. **Observed history** — `git log --format=%s -n 50`, or `jj log -n 50 --no-pager -T 'description.first_line() ++ "\n"'`. Copy subject structure, capitalization, tense, scope or `[type/name]`-style prefixes, whether bodies appear and how they wrap, and which trailers appear.
4. **Nothing above answered it** — a fresh repository, or history with no descriptions: ask for guidance. Do not invent a convention.

## Make the commit

Read the change set first: `git status --short` with `git diff` (and `--cached`), or `jj status` with `jj diff`.

- **git** — stage by path (`git add <paths>`, not `-A`, which sweeps in files the change never meant), then `git commit -m "<subject>"`, one more `-m` per body paragraph.
- **jj** — the working copy already holds the change: `jj describe -m "<subject>"`, then `jj new` to leave it and start clean. There is no staging area; split with `jj split` or move part into another change with `jj squash`.
- **Always pass `-m`** — bare `git commit` and bare `jj describe` open `$EDITOR` / `ui.editor` and wait for you.
- **Then read back what you wrote** — `git log -1 --format=%B`, or `jj log --no-pager -r @ -T 'description'`.

## Defaults

The request overrides every one of these.

- Commit only: no push, publish, rebase, or pull request.
- Commit only the files this change is about. If a file's place in it is unclear, ask before including it.
- **Trailers and signatures follow the repository.** Copy `Signed-off-by`, `Change-Id`, or a breaking-change footer when its history or instructions have them, and add none it does not. Do not pass `-S`/`--gpg-sign` or run `jj sign` on your own initiative — `commit.gpgSign` and `format.signOff` in git, `signing.backend` in jj, decide whether a change is signed.
