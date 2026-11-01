# Changelog

All notable changes to pi-pkg are documented here. Versions match the Git tags.

## Unreleased

* Added the `review-loop` extension: `/review-loop` runs a review-feedback loop over the changes since a baseline, hands actionable findings to the coding agent, and re-reviews the delta until the readiness gate holds, a decision is owed, or the round budget is spent. Reviewers report findings through a tool call, so findings carry ids across rounds; `--model` and `--thinking` review under a different model that is restored when the round ends; project guidance is read from the nearest `REVIEW.md`.

## 0.1.1

* Releases are staged for approval with provenance instead of published directly. Package contents are unchanged from 0.1.0.

## 0.1.0

* Added the `goal` extension for long-running objective mode with automatic continuation.
* Added the `notify` extension for OSC 777 terminal notifications when Pi is waiting for input.
* Added the `plan` prompt for lightweight discussion and planning before doing work.
* Added the `commit`, `github`, `gitlab`, `kagi`, `plan-audit`, and `tangled` skills.
