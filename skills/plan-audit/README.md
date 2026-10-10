# plan-audit

Measures what flat-rate AI coding subscriptions actually deliver, from Pi's own session logs — the only complete
record of the tokens you consumed. It prices every request, reconstructs each plan's billing window, and reconciles
against the quota the provider reports, so each fee can be compared to the pay-as-you-go list value of the same
traffic.

Lightweight — no browser, no npm dependencies, just Node.js 18+.

## Use

Run from the skill directory, or prefix with the skill path:

```bash
scripts/audit.mjs                                # last 30 days, configured providers
scripts/audit.mjs --days 60                      # longer window
scripts/audit.mjs --provider qwen-token-plan     # one provider
scripts/audit.mjs --out report.md --force        # write the markdown report to a file
scripts/audit.mjs --json                         # machine-readable output
scripts/audit.mjs --all-providers                # include local servers and unconfigured keys
scripts/audit.mjs -h                             # all options
```

## Setup

Two config layers. Provider facts (metering style, allowance exchange rates, peak/off-peak windows, pay-as-you-go
reference prices, intelligence scores) ship in `references/providers.json` — review them when a provider reprices
(see `asOf` and `reviewWhen` in that file; `audit.mjs` warns past 60 days). Your account state lives at
`~/.config/pi/plan-audit.json` and is deliberately **not** in version control: it holds the current console reading,
which a second machine would otherwise `git pull` stale and project from confidently and wrongly.

```json
{
  "providers": {
    "opencode-go": {
      "fee": 10,
      "cycleAnchor": "2026-10-09T20:55:00Z",
      "reported": { "at": "2026-10-09T23:43:00Z", "percentUsed": 0 }
    },
    "qwen-token-plan": {
      "fee": 10,
      "cycleAnchor": "2026-09-25T15:30:00Z",
      "quota": 25500,
      "reported": { "at": "2026-10-09T23:43:00Z", "percentUsed": 78.3 }
    }
  }
}
```

Anchors are the 30-day billing window's rollover instant in UTC. Where each reading comes from:

| provider | reading | location |
|---|---|---|
| OpenCode Go | monthly/weekly/rolling % used | opencode.ai console usage bars, or `GET https://opencode.ai/zen/go/v1/usage` with the Go key |
| Qwen Token Plan Individual | % remaining, plan quota, expiry | console → Token Plan → My Subscriptions (home.qwencloud.com/analytics/token-plan/individual) |

Refresh the reading once per cycle — or whenever the anchor moves — and the projections (`days to cap`, `projected cycle`,
`value multiple`) recalibrate. The script warns when a reading is older than 60% of the cycle.

## Interpreting the report

- **Allowance pool** (OpenCode Go): `% of allowance` is Σ(spend ÷ that model's published monthly limit), not
  per-model headroom — the listed $15/$30/$60 figures are exchange rates into one shared pool. The `worst 5h` and
  `worst week` columns are rolling maxima against the 20% and 50% sub-limits.
- **Credits** (Qwen Token Plan): the observed Credits-per-Mtok rate is derived from your console reading over your
  usage window, so `whole quota at your mix` is the plan's list-price worth *for your token mix*, and the per-model
  attribution weights by (off-peak-discounted) list value, not by tokens.
- **What your volume would cost** reprices the provider's whole catalog at *your observed* cache ratio. The usual
  3:1 input:output charts badly understate cheap-cache models for a cache-heavy account.
- `price source` tells you how each model was priced: `catalog` (the provider's own rate), `reference` (the skill's
  PAYG table, used when the provider publishes $0), `cross:<provider>` (same model id from another catalog), `none`
  (delisted model — falls back to the cost Pi recorded in-session).
- `data` flags models whose discount is paid for in prompts: OpenCode Go publishes a per-model privacy table
  (see `references/providers.json` → `dataUse`) and only the Muse Spark *Contributor* SKUs train (`Yes`,
  retention `Not ZDR`) — OpenCode gates them behind an explicit "allow endpoints that train on request data"
  opt-in, which Pi does not surface, so the audit is the only place the exposure shows up. Qwen Token Plan
  Personal content is train-eligible unless you opt out at privacy@qwen.com; only Team guarantees no training.

## Troubleshooting

- **Console says 0% but usage is real.** Check the window first: a rollover leaves a correct 0% when the new window
  is genuinely empty. `audit.mjs` prints a cross-check (computed vs reported) on the cycle the reading belongs to —
  a large gap means the pool model in `references/providers.json` is wrong, not that the provider is mis-metering.
- **Stub cycles.** A one-day cycle with a handful of requests means records predate `cycleAnchor`; nudge the anchor
  to the first record (expiry displays often round to the hour).
- **Peak pricing.** Pi's catalog stores OpenCode's off-peak DeepSeek rates. The script applies the 2x peak
  multiplier (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) from `references/providers.json`, so its DeepSeek numbers
  run higher than Pi's in-session cost — that is the allowance the pool actually charges.
- **`--all-providers` shows costs for local models.** Local servers (`llama.cpp`, `gufo`) price at $0 in every
  catalog, so they contribute tokens and latency but no list value. That is the point: they are the free tier.

## Credits

Inspired by [mitsuhiko/agent-stuff `extensions/session-breakdown.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/session-breakdown.ts) (Apache-2.0) — the version-tolerant usage readers and the test-provider filter; the audit engine, allowance/credit reconciliation, cycle anchoring, peak and off-peak windows, mix economics, and latency tables are original.
