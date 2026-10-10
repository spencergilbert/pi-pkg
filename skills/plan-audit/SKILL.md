---
name: plan-audit
description: Audit flat-rate AI coding subscriptions against Pi's own session logs. Use when comparing coding-plan value, checking quota or Credit burn, deciding which models to favor on a flat plan, or after changing which models a plan is allowed to serve.
compatibility: Requires Node.js 18+. No npm dependencies.
---

# Plan audit

Run scripts relative to this skill directory.

`scripts/audit.mjs` scans the session directory (`$PI_CODING_AGENT_SESSION_DIR`, else `~/.local/state/pi/sessions`),
dedupes requests by session-entry id (forks copy history), and prices every assistant reply from the local
`models-store.json` catalog. Provider facts that the catalog does not carry — allowance exchange rates, peak and
off-peak windows, pay-as-you-go reference prices, intelligence scores — live in `references/providers.json` and are
merged with your account config at `~/.config/pi/plan-audit.json` (fees, cycle anchors, quota tier, last console
reading). See README.md in this directory for the config schema and where each reading comes from.

Two quota styles are reconciled:

- **allowance** (shared pool, e.g. OpenCode Go): each published per-model dollar limit is an exchange rate into one
  allowance, so consumption is Σ(spend ÷ limit), with 20%-per-5h and 50%-per-week sub-limits checked as rolling
  maxima. The per-model figure is not a separate bucket.
- **credits** (e.g. Qwen Token Plan): Credit rates are unpublished, so the script calibrates Credits-per-Mtok from a
  console reading over the same window as the local usage, then projects burn, allowance, days-to-cap, and
  full-cycle consumption. Only ever calibrate on the cycle the reading belongs to.

```bash
scripts/audit.mjs                          # last 30 days, configured providers
scripts/audit.mjs --days 60                # longer window
scripts/audit.mjs --provider qwen-token-plan --days 14
scripts/audit.mjs --json                   # machine-readable output
scripts/audit.mjs --out report.md          # write to file (needs --force to overwrite)
scripts/audit.mjs --all-providers          # include local servers and unconfigured keys
```

Options: `--since/--until <iso>`, `--model <id>` (repeatable), `--top <n>`, `--config <path>`,
`--sessions <dir>`, `-h/--help`.

Rules for the numbers:

- All session timestamps are UTC; pass anchors the same way (e.g. `2026-10-09T20:55:00Z`).
- Never invent a console reading. If `providers.<id>.reported` is missing, say which page the number lives on
  (README.md lists them) and mark projections as uncalibrated.
- Treat a provider-reported 0% at face value first: verify against the window (rollover leaves a correct 0% when
  the new window is genuinely empty) before theorizing about unattributed traffic.
- Re-run after any change to `enabledModels` or the default model — the mix table is what shows whether a new
  model is cheaper *at this account's* cache ratio, which is usually nothing like the chart's 3:1.
- Fail over, don't duplicate, across plans. When the Go allowance passes ~80% of pool (or a sub-limit multiple
  passes 1x) and the same model id exists on `qwen-token-plan`, move overflow sessions to the Qwen copy, preferably
  off-peak (10:00–20:00 EDT, when both Qwen credits and DeepSeek list rates discount). The reverse move
  (Qwen → Go) applies when Qwen projects over quota: the Qwen copy of a model is a relief valve, not a second home.
- Surface the script's staleness warnings (old console reading, old reference data) in the summary, not the appendix.
