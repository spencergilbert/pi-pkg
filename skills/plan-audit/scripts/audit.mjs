#!/usr/bin/env node
/**
 * plan-audit — measure what flat-rate AI coding plans actually deliver.
 *
 * Reads Pi's own session logs (the only complete record of tokens you consumed),
 * prices them with the local model catalog, then reconciles against the quota
 * each provider reports. Two quota styles are understood:
 *
 *   allowance  OpenCode Go: one shared pool; each model's published monthly
 *              dollar limit is an exchange rate into it, so consumption is
 *              sum(spend / limit) with 20% per 5h and 50% per week sub-limits.
 *   credits    Qwen Token Plan: a Credit pool whose per-token rate is not
 *              published. Calibrated from a console reading (percent used) over
 *              the same window as the local usage, which yields Credits/Mtok.
 *
 * Config: ~/.config/pi/plan-audit.json (see --config, README.md).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(HOME, ".config", "pi");
const SESSION_DIR =
  process.env.PI_CODING_AGENT_SESSION_DIR || join(HOME, ".local", "state", "pi", "sessions");

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"];

// ---------------------------------------------------------------- cli

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: audit.mjs [options]

  --days <n>          window length in days, ending at --until (default 30)
  --since <iso>       start of window (default: latest record minus --days)
  --until <iso>       end of window (default: newest session record)
  --provider <id>     restrict to a provider (repeatable; default: those in the config)
  --all-providers     audit every provider seen, configured or not
  --model <id>        restrict to a model id (repeatable)
  --top <n>           projects to list per provider (default 8)
  --config <path>     plan config (default ~/.config/pi/plan-audit.json)
  --sessions <dir>    session directory (default $PI_CODING_AGENT_SESSION_DIR)
  --json              emit machine-readable JSON instead of markdown
  --out <file>        write to file instead of stdout (needs --force to overwrite)
  --force             allow --out to overwrite
  -h, --help          this text
`);
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
const opts = { providers: [], models: [], days: 30, top: 8, config: join(AGENT_DIR, "plan-audit.json"), sessions: SESSION_DIR };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) usage(`${a} needs a value`);
    return v;
  };
  switch (a) {
    case "--days": opts.days = Number(next()); break;
    case "--since": opts.since = next(); break;
    case "--until": opts.until = next(); break;
    case "--provider": opts.providers.push(next()); break;
    case "--all-providers": opts.allProviders = true; break;
    case "--model": opts.models.push(next()); break;
    case "--top": opts.top = Number(next()); break;
    case "--config": opts.config = next(); break;
    case "--sessions": opts.sessions = next(); break;
    case "--json": opts.json = true; break;
    case "--out": opts.out = next(); break;
    case "--force": opts.force = true; break;
    case "-h": case "--help": usage(); break;
    default: usage(`unknown argument: ${a}`);
  }
}

// ---------------------------------------------------------------- inputs

function readJSON(path, required) {
  if (!existsSync(path)) {
    if (required) {
      console.error(`error: ${path} not found`);
      process.exit(1);
    }
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`error: cannot parse ${path}: ${e.message}`);
    process.exit(1);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * Two layers, deliberately separate:
 *   references/providers.json  provider facts (metering style, allowance exchange
 *                              rates, peak/off-peak windows, PAYG reference prices,
 *                              intelligence scores). Ships with the skill, versioned,
 *                              reviewable, same on every machine.
 *   --config (default ~/.config/pi/plan-audit.json)  your account: fees, cycle
 *                              anchors, quota tier, and the last console reading.
 * Readings are mutable and machine-local on purpose — a stale `percentUsed` pulled
 * from a repo produces a confident wrong projection.
 */
const REF_PATH = fileURLToPath(new URL("../references/providers.json", import.meta.url));
const ref = readJSON(REF_PATH, true);
const personal = readJSON(opts.config, false) || {};
const catalog = readJSON(join(AGENT_DIR, "models-store.json"), false) || {};

const providersCfg = {};
for (const p of new Set([...Object.keys(ref.providers || {}), ...Object.keys(personal.providers || {})])) {
  providersCfg[p] = { ...(ref.providers?.[p] || {}), ...(personal.providers?.[p] || {}) };
}
const referencePrices = { ...(ref.referencePrices || {}), ...(personal.referencePrices || {}) };
const intelligence = ref.intelligence || {};

const warnings = [];
if (ref.asOf) {
  const age = (Date.now() - new Date(ref.asOf).getTime()) / 86400e3;
  if (age > 60) warnings.push(`reference data is ${age.toFixed(0)} days old (${ref.asOf}) — providers do reprice; re-check the sources in references/providers.json`);
}
for (const [p, c] of Object.entries(providersCfg)) {
  if (!c.reported?.at) continue;
  const age = (Date.now() - new Date(c.reported.at).getTime()) / 86400e3;
  const cycleDays = c.cycleDays ?? 30;
  if (age > cycleDays * 0.6) warnings.push(`${p}: console reading is ${age.toFixed(1)} days old — refresh providers.${p}.reported before trusting projections`);
}

if (!existsSync(opts.sessions)) {
  console.error(`error: session dir ${opts.sessions} not found (pass --sessions)`);
  process.exit(1);
}

/** Prices for one provider/model: own catalog, else reference table, else another provider's catalog. */
function priceFor(provider, model) {
  const own = catalog[provider]?.models?.find((m) => m.id === model)?.cost;
  if (own && (own.input || own.output || own.cacheRead || own.cacheWrite)) {
    return { rate: own, source: "catalog" };
  }
  const ref = referencePrices[model];
  if (ref) return { rate: ref, source: "reference" };
  for (const [p, v] of Object.entries(catalog)) {
    if (p === provider) continue;
    const m = v.models?.find((x) => x.id === model)?.cost;
    if (m && (m.input || m.output || m.cacheRead || m.cacheWrite)) return { rate: m, source: `cross:${p}` };
  }
  return { rate: null, source: "none" };
}

function inWindowHour(dt, peak) {
  if (!peak) return false;
  const days = peak.weekdays || [0, 1, 2, 3, 4];
  if (!days.includes(dt.getUTCDay())) return false;
  for (const [from, to] of peak.ranges) if (dt.getUTCHours() >= from && dt.getUTCHours() < to) return true;
  return false;
}

/**
 * Input-length tiers (OpenCode catalog `cost.tiers`, Anthropic/OpenAI-style):
 * when a request's total input clears `inputTokensAbove`, every token in that
 * request bills at the tier's rates. Pi's own cost engine does the same (it
 * fixed undercounting of long prompts in 1.x), so the audit must too — at this
 * account's median ~189K input tokens per request, Haiku 5.5 bills at its
 * >100K tier for most traffic.
 */
function applyTiers(rate, totalInput) {
  if (!rate || !rate.tiers) return rate;
  let out = rate;
  for (const t of [...rate.tiers].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)) {
    if (totalInput > (t.inputTokensAbove ?? Infinity)) out = { ...out, ...t };
  }
  return out;
}

function inOffPeakHour(dt, off) {
  if (!off) return false;
  const [from, to] = off.range;
  return from <= to ? dt.getUTCHours() >= from && dt.getUTCHours() < to : dt.getUTCHours() >= from || dt.getUTCHours() < to;
}

// ---------------------------------------------------------------- scan

// --- session-format helpers ----------------------------------------------
//
// Session entries vary across pi versions: provider/model/usage ride on the
// message wrapper in newer files and on the message object in current ones, and
// pi-ai's test provider ("faux") can emit synthetic token estimates.
//
// Usage blocks also vary: cost may be a number, a numeric string, or { total },
// and counters may use snake_case names. See README.md Credits for the source.

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function isFaux(o) {
  const api = String(o.api ?? "").trim().toLowerCase();
  if (api === "faux" || api.startsWith("faux:")) return true;
  if (String(o.provider ?? "").trim().toLowerCase() === "faux") return true;
  const m = String(o.model ?? o.modelId ?? "").trim().toLowerCase();
  return m === "faux" || m.startsWith("faux-");
}

function normalizeUsage(u) {
  const t = {
    input: num(u.input ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens),
    output: num(u.output ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens),
    cacheRead: num(u.cacheRead ?? u.cached_tokens ?? u.prompt_cache_hit_tokens),
    cacheWrite: num(u.cacheWrite ?? u.cache_creation_tokens),
    reasoning: num(u.reasoning ?? u.reasoning_tokens),
    totalTokens: num(u.totalTokens ?? u.total_tokens),
  };
  if (!t.totalTokens) t.totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const c = u.cost;
  t.cost = c == null || typeof c === "object" ? num(c?.total) : num(c);
  return t;
}

const seen = new Set();
const records = [];
const entryTimes = new Map(); // entry id -> timestamp, to pair a reply with its real parent
for (const file of walk(opts.sessions)) {
  const text = readFileSync(file, "utf8");
  let cwd = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session") { cwd = o.cwd; continue; }
    const m = o.message;
    if (o.id && o.timestamp) entryTimes.set(o.id, new Date(o.timestamp));
    if (isFaux({ api: o.api ?? m?.api, provider: o.provider ?? m?.provider, model: o.model ?? m?.model, modelId: o.modelId ?? m?.modelId })) continue;
    // Assistant generations (wrapper or message placement), plus compaction
    // bookkeeping entries that carry a billable usage block with provider/model.
    let provider, model, usage;
    if (m && m.role === "assistant" && m.usage) {
      provider = o.provider ?? m.provider; model = o.model ?? m.model; usage = m.usage;
    } else if ((o.type === "compaction" || o.type === "message") && o.usage && (o.provider || o.model)) {
      provider = o.provider; model = o.model; usage = o.usage;
    } else {
      continue;
    }
    if (!provider && !model) continue;
    if (!o.id || seen.has(o.id)) continue; // forks copy history; count each request once
    seen.add(o.id);
    const ts = o.timestamp ? new Date(o.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;
    records.push({ ts, parentId: o.parentId, provider: String(provider || "?").trim(), model: String(model || "?").trim(), usage: normalizeUsage(usage), cwd: cwd || "(unknown)", file });
  }
}
records.sort((a, b) => a.ts - b.ts);
if (!records.length) { console.error("error: no usage records found"); process.exit(1); }

const until = opts.until ? new Date(opts.until) : records[records.length - 1].ts;
const since = opts.since ? new Date(opts.since) : new Date(until.getTime() - opts.days * 86400e3);
// Only providers with a config entry are audited by default: the rest are local
// servers and one-off keys with no plan to reconcile. --provider overrides,
// --all-providers includes everything seen.
const wanted = opts.providers.length ? opts.providers
  : opts.allProviders ? [...new Set(records.map((r) => r.provider))]
  : [...new Set(records.map((r) => r.provider))].filter((x) => providersCfg[x]);
const scoped = records.filter((r) => r.ts >= since && r.ts <= until &&
  wanted.includes(r.provider) &&
  (!opts.models.length || opts.models.includes(r.model)));
if (!scoped.length) { console.error("error: no records in window"); process.exit(1); }

// ---------------------------------------------------------------- aggregate

const priced = scoped.map((r) => {
  const cfg = providersCfg[r.provider] || {};
  const { rate, source } = priceFor(r.provider, r.model);
  let list = 0;
  if (rate) {
    const u = r.usage;
    const priced = applyTiers(rate, (u.input || 0) + (u.cacheRead || 0));
    list = (u.input * priced.input + u.output * priced.output + (u.cacheRead || 0) * priced.cacheRead + (u.cacheWrite || 0) * priced.cacheWrite) / 1e6;
    const peak = cfg.peak;
    if (peak && (peak.models || []).some((p) => r.model.startsWith(p)) && inWindowHour(r.ts, peak)) list *= peak.multiplier ?? 2;
  } else {
    list = r.usage.cost || 0; // fall back to whatever Pi recorded in-session (usage is already normalized)
  }
  // Qwen bills Credits, and its night window (22:00-08:00 UTC+8) discounts them; track that
  // separately from list value so credit attribution uses the discounted weight.
  let creditList = list;
  const off = cfg.offPeak;
  if (off && (off.models || []).some((m) => r.model.startsWith(m)) && inOffPeakHour(r.ts, off)) creditList *= off.multiplier ?? 0.4;
  return { ...r, list, creditList, priceSource: source };
});

const newAgg = () => ({ n: 0, tokens: 0, generated: 0, cache: 0, list: 0, models: new Set(), hours: new Map(), poolHours: new Map(), days: new Set(), files: new Set(), modelList: new Map(), modelCreditList: new Map() });

const add = (a, r, limit) => {
  a.n++; a.tokens += r.usage.totalTokens || 0; a.cache += r.usage.cacheRead || 0;
  a.generated += (r.usage.output || 0) + (r.usage.reasoning || 0);
  a.list += r.list; a.models.add(r.model); a.days.add(r.ts.toISOString().slice(0, 10)); a.files.add(r.file);
  a.modelList.set(r.model, (a.modelList.get(r.model) || 0) + r.list);
  a.modelCreditList.set(r.model, (a.modelCreditList.get(r.model) || 0) + r.creditList);
  const h = new Date(Date.UTC(r.ts.getUTCFullYear(), r.ts.getUTCMonth(), r.ts.getUTCDate(), r.ts.getUTCHours()));
  a.hours.set(h.getTime(), (a.hours.get(h.getTime()) || 0) + r.list);
  if (limit) a.poolHours.set(h.getTime(), (a.poolHours.get(h.getTime()) || 0) + r.list / limit);
};

const by = (keyFn) => {
  const map = new Map();
  for (const r of priced) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, newAgg());
    const pcfg = providersCfg[r.provider] || {};
    add(map.get(k), r, (pcfg.limits || {})[r.model] ?? pcfg.defaultLimit ?? null);
  }
  return map;
};

const perProvider = by((r) => r.provider);
const perModel = by((r) => `${r.provider}\u0000${r.model}`);
const perProject = by((r) => `${r.provider}\u0000${r.cwd}`);

/** 30-day cycle start anchored on the provider's configured anchor, walking backwards. */
function cycleOf(provider, ts) {
  const anchor = providersCfg[provider]?.cycleAnchor;
  if (!anchor) return "(no anchor)";
  const length = (providersCfg[provider]?.cycleDays ?? 30) * 86400e3;
  let a = new Date(anchor).getTime();
  while (a - length > ts.getTime()) a -= length;
  while (a <= ts.getTime()) a += length;
  return new Date(a - length).toISOString();
}

function slidingMax(hoursMap, spanHours) {
  const entries = [...hoursMap.entries()].sort((a, b) => a[0] - b[0]);
  let best = 0; let at = null;
  for (const [h] of entries) {
    let sum = 0;
    for (const [k, v] of entries) if (k >= h && k <= h + spanHours * 3600e3) sum += v;
    if (sum > best) { best = sum; at = h; }
  }
  return { value: best, at: at === null ? null : new Date(at).toISOString() };
}

const results = [];
for (const [provider, agg] of perProvider) {
  const cfg = providersCfg[provider] || {};
  const days = Math.max(1, agg.days.size);
  const elapsedMs = Math.min(until, priced.filter((r) => r.provider === provider).at(-1).ts) -
    Math.max(since, priced.filter((r) => r.provider === provider)[0].ts);
  const elapsedDays = Math.max(1, elapsedMs / 86400e3);
  const entry = {
    provider,
    requests: agg.n,
    tokens: agg.tokens,
    generated: agg.generated,
    cacheShare: agg.tokens ? agg.cache / agg.tokens : 0,
    listValue: agg.list,
    listPerDay: agg.list / elapsedDays,
    perMtok: agg.tokens ? (agg.list / agg.tokens) * 1e6 : 0,
    activeDays: agg.days.size,
    sessions: agg.files.size,
    metering: cfg.metering || "none",
    cycles: [],
  };

  // group into cycles
  const cyc = new Map();
  for (const r of priced.filter((x) => x.provider === provider)) {
    const k = cycleOf(provider, r.ts);
    if (!cyc.has(k)) cyc.set(k, newAgg());
    add(cyc.get(k), r, (cfg.limits || {})[r.model] ?? cfg.defaultLimit ?? null);
  }

  const cycleAgg = new Map();
  for (const [start, a] of [...cyc].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
    cycleAgg.set(start, a);
    const span = Math.max(1, a.days.size);
    const c = { cycleStart: start, requests: a.n, tokens: a.tokens, generated: a.generated, listValue: a.list,
      activeDays: a.days.size, cacheShare: a.tokens ? a.cache / a.tokens : 0 };
    // elapsed days inside this cycle: from cycle start to the later of its last record / window end
    const lastInCycle = priced.filter((x) => x.provider === provider && cycleOf(provider, x.ts) === start).at(-1).ts;
    const cycleElapsed = Math.min(Math.max(1, (Math.min(until, lastInCycle) - new Date(start)) / 86400e3), cfg.cycleDays ?? 30);
    c.elapsedDays = cycleElapsed;
    if (cfg.metering === "allowance") {
      const limits = cfg.limits || {};
      const fallback = cfg.defaultLimit ?? null;
      let pool = 0; const parts = [];
      for (const [model, spend] of a.modelList) {
        const limit = limits[model] ?? fallback;
        if (!limit) continue;
        pool += spend / limit;
        parts.push({ model, spend, limit, share: spend / limit });
      }
      c.poolUsed = pool;
      c.poolParts = parts.sort((x, y) => y.share - x.share);
      if (cfg.reported?.percentUsed != null && cycleOf(provider, new Date(cfg.reported.at)) === start) {
        c.reportedPercent = cfg.reported.percentUsed;
        c.reportedDelta = c.poolUsed * 100 - cfg.reported.percentUsed;
      }
      c.per100Pct = pool ? a.list / pool : null;
      // sub-limits are fractions of the same allowance, so compare pool fraction, not dollars
      c.fiveHourMultiple = slidingMax(a.poolHours, 4).value / (cfg.fiveHourFraction ?? 0.2);
      c.weeklyMultiple = slidingMax(a.poolHours, 168).value / (cfg.weeklyFraction ?? 0.5);
    }
    entry.cycles.push(c);
  }
  // Credits: calibrate on the cycle the console reading belongs to, not the newest one.
  if (cfg.metering === "credits" && cfg.quota && cfg.reported?.percentUsed != null) {
    const key = cfg.reported.at ? cycleOf(provider, new Date(cfg.reported.at)) : entry.cycles.at(-1)?.cycleStart;
    const c = entry.cycles.find((x) => x.cycleStart === key) || entry.cycles.at(-1);
    const a = cycleAgg.get(c?.cycleStart);
    if (c && a && a.tokens && a.list) {
      const used = cfg.quota * (cfg.reported.percentUsed / 100);
      const last = priced.filter((x) => x.provider === provider && cycleOf(provider, x.ts) === c.cycleStart).at(-1).ts;
      const elapsed = Math.min(Math.max(1, (Math.min(until, last) - new Date(c.cycleStart)) / 86400e3), cfg.cycleDays ?? 30);
      const creditBase = [...(a.modelCreditList || new Map()).values()].reduce((x, y) => x + y, 0) || a.list;
      const burn = used / elapsed;
      Object.assign(c, {
        calibrated: true, elapsedDays: elapsed, creditsUsed: used,
        creditsPerMtok: used / (a.tokens / 1e6),
        dollarsPerCredit: a.list / used,
        quotaValueAtList: cfg.quota * (a.list / used),
        valueMultiple: cfg.fee ? cfg.quota * (a.list / used) / cfg.fee : null,
        burnPerDay: burn,
        allowancePerDay: (cfg.quota - used) / Math.max(0.1, (cfg.cycleDays ?? 30) - elapsed),
        projectedCycle: burn * (cfg.cycleDays ?? 30),
        daysToCap: (cfg.quota - used) / burn,
        offPeakShare: a.list ? 1 - creditBase / a.list : 0,
        reportedAt: cfg.reported.at || null,
        modelCredits: [...(a.modelCreditList || new Map())].map(([model, cl]) => ({
          model, spend: a.modelList.get(model) || 0,
          tokens: perModel.get(`${provider}\u0000${model}`)?.tokens ?? 0,
          share: creditBase ? cl / creditBase : 0, credits: used * (creditBase ? cl / creditBase : 0),
        })).sort((x, y) => y.credits - x.credits),
      });
      c.projectedOverQuota = c.projectedCycle / cfg.quota;
      entry.calibratedCycle = c.cycleStart;
    }
  }
  results.push(entry);
}

// ---------------------------------------------------------------- latency

const lat = new Map();
for (const r of records.filter((x) => wanted.includes(x.provider))) {
  if (r.ts < since || r.ts > until) continue;
  const prev = entryTimes.get(r.parentId);
  if (!prev) continue;
  const secs = (r.ts - prev) / 1000;
  if (secs <= 0 || secs > 900) continue;
  const gen = (r.usage.output || 0) + (r.usage.reasoning || 0);
  if (!lat.has(r.provider)) lat.set(r.provider, { lat: [], tput: [] });
  lat.get(r.provider).lat.push(secs);
  if (gen > 200) lat.get(r.provider).tput.push(gen / secs);
}
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// ---------------------------------------------------------------- mix economics

/** $/Mtok for every catalogued model of a provider, priced at the observed token mix. */
function mixEconomics(provider) {
  const agg = perProvider.get(provider);
  if (!agg || !agg.tokens) return [];
  const cacheShare = agg.cache / agg.tokens;
  const outShare = agg.generated / agg.tokens;
  const missShare = Math.max(0, 1 - cacheShare - outShare);
  const models = catalog[provider]?.models || [];
  const limits = providersCfg[provider]?.limits || {};
  const trains = new Set(ref.dataUse?.trainsOnData || []);
  // Input-length tier for the hypothetical: this account's median request input.
  const inputs = scoped.filter((r) => r.provider === provider)
    .map((r) => (r.usage.input || 0) + (r.usage.cacheRead || 0)).sort((a, b) => a - b);
  const medianInput = inputs.length ? inputs[Math.floor(inputs.length / 2)] : 0;
  const rows = models.map((m) => {
    const c = m.cost || {};
    if (!c.input && !c.output && !c.cacheRead) return null;
    const priced = applyTiers(c, medianInput);
    const tiered = priced !== c;
    const perMtok = cacheShare * (priced.cacheRead || 0) + missShare * (priced.input || 0) + outShare * (priced.output || 0);
    return {
      model: m.id, perMtok,
      monthForYourVolume: (perMtok * agg.tokens) / 1e6,
      limit: limits[m.id] ?? null,
      intelligence: intelligence[m.id] ?? null,
      used: agg.models.has(m.id),
      trains: trains.has(m.id),
      tier: tiered ? `>${((priced.tiers || []).find((t) => priced.input === t.input) || {}).inputTokensAbove ?? "?"}` : null,
    };
  }).filter(Boolean).sort((a, b) => a.perMtok - b.perMtok);
  rows.medianInput = medianInput;
  return rows;
}

// ---------------------------------------------------------------- output

const fmt = (n, d = 0) => n == null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (n, d = 2) => n == null ? "-" : `$${fmt(n, d)}`;
const usd = (n) => n == null ? "-" : `$${n.toFixed(4)}`;
const L = [];
const w = (s = "") => L.push(s);

if (opts.json) {
  console.log(JSON.stringify({
    window: { since: since.toISOString(), until: until.toISOString(), records: priced.length },
    providers: results,
    latency: [...lat].map(([p, v]) => ({ provider: p, medianS: pct(v.lat, 0.5), p90S: pct(v.lat, 0.9), medianOutTokS: pct(v.tput, 0.5) })),
  }, null, 2));
  process.exit(0);
}

w(`# Coding-plan audit — ${since.toISOString().slice(0, 16)} → ${until.toISOString().slice(0, 16)} (UTC)`);
w();
w(`Source: ${records.length.toLocaleString()} deduplicated assistant usage records under \`${opts.sessions}\`.`);
w(`Prices: \`models-store.json\` where the provider publishes them; otherwise the reference table or a sibling`);
w(`provider's catalog for the same model id (marked in the model table).`);
w();

for (const r of results) {
  const cfg = providersCfg[r.provider] || {};
  w(`## ${r.provider}${cfg.fee ? ` — ${money(cfg.fee)}/${cfg.cycleDays ?? 30}d` : ""}`);
  w();
  w(`| window | days | reqs | tokens | generated | cache share | list value | $/Mtok |`);
  w(`|---|---|---|---|---|---|---|---|`);
  w(`| **all** | ${r.activeDays} | ${fmt(r.requests)} | ${fmt(r.tokens)} | ${fmt(r.generated)} | ${(r.cacheShare * 100).toFixed(1)}% | ${money(r.listValue)} | ${usd(r.perMtok)} |`);
  for (const c of r.cycles) {
    w(`| ${c.cycleStart.slice(0, 16)}Z | ${c.activeDays} | ${fmt(c.requests)} | ${fmt(c.tokens)} | ${fmt(c.generated)} | ${(c.cacheShare * 100).toFixed(1)}% | ${money(c.listValue)} | ${usd(c.tokens ? c.listValue / c.tokens * 1e6 : null)} |`);
  }
  w();

  if (r.metering === "allowance") {
    w(`**Allowance pool** — consumption = Σ(spend ÷ that model's published monthly limit); sub-limits 20% per 5h, 50% per week.`);
    w();
    w(`| cycle | list value | % of allowance | list $ per 100% | fee multiple | worst 5h | worst week |`);
    w(`|---|---|---|---|---|---|---|`);
    for (const c of r.cycles) {
      if (c.poolUsed == null) continue;
      w(`| ${c.cycleStart.slice(0, 16)}Z | ${money(c.listValue)} | **${(c.poolUsed * 100).toFixed(1)}%** | ${money(c.per100Pct)} | ${cfg.fee ? (c.per100Pct / cfg.fee).toFixed(1) + "x" : "-"} | ${(c.fiveHourMultiple ?? 0).toFixed(2)}x | ${(c.weeklyMultiple ?? 0).toFixed(2)}x |`);
    }
    w();
    const cross = r.cycles.find((c) => c.reportedPercent != null);
    if (cross) {
      w(`Cross-check against the console reading of ${cross.reportedPercent}% (window ${cross.reportedAt || "?"}):`);
      w(`computed ${(cross.poolUsed * 100).toFixed(1)}%, delta ${cross.reportedDelta >= 0 ? "+" : ""}${cross.reportedDelta.toFixed(1)} points.`);
      w(`A large gap means the pool model in \`references/providers.json\` is wrong or the meter does not`);
      w(`attribute this client's traffic.`);
      w();
    }
    const last = r.cycles.find((c) => c.reportedPercent != null) || [...r.cycles].sort((a, b) => b.listValue - a.listValue)[0];
    if (last?.poolParts?.length) {
      w(`Drain by model, ${last.cycleStart.slice(0, 16)}Z cycle:`);
      w();
      for (const p of last.poolParts.slice(0, 8)) {
        w(`- \`${p.model}\` — ${money(p.spend)} of a ${money(p.limit)} limit = ${(p.share * 100).toFixed(1)}% of the pool`);
      }
      w();
    }
  }

  if (r.metering === "credits") {
    const last = r.cycles.find((c) => c.calibrated) || {};
    if (last.creditsUsed == null) {
      w(`**Credits** — set \`providers.${r.provider}.reported.percentUsed\` in the config to calibrate.`);
      w();
    } else {
      w(`**Credits**, calibrated on the console reading${last.reportedAt ? ` of ${last.reportedAt}` : ""}:`);
      if (ref.dataUse?.qwenTokenPlanPersonal) w(`Data: ${ref.dataUse.qwenTokenPlanPersonal}.`);
      w();
      w(`| quantity | value |`);
      w(`|---|---|`);
      w(`| quota | ${fmt(cfg.quota)} Credits (${money(cfg.fee)}/cycle) |`);
      w(`| reported used | ${fmt(last.creditsUsed)} (${(cfg.reported.percentUsed).toFixed(1)}%) |`);
      w(`| observed rate | **${fmt(last.creditsPerMtok, 1)} Credits per Mtok** |`);
      w(`| list value per Credit | ${usd(last.dollarsPerCredit)} |`);
      w(`| whole quota at your mix | **${money(last.quotaValueAtList)}** = ${last.valueMultiple ? last.valueMultiple.toFixed(1) + "x the fee" : "-"} |`);
      w(`| burn vs allowance | ${fmt(last.burnPerDay)}/day vs ${fmt(last.allowancePerDay)}/day |`);
      w(`| projected cycle | ${fmt(last.projectedCycle)} = **${(last.projectedOverQuota * 100).toFixed(0)}% of quota** |`);
      w(`| days to cap at current burn | ${last.daysToCap == null ? "-" : last.daysToCap.toFixed(1)} |`);
      w(`| off-peak share of list value | ${(last.offPeakShare * 100).toFixed(1)}% (discounted window) |`);
      w();
      if (last.modelCredits?.length) {
        w(`Credit attribution by list-price weight (Credits track model price, not tokens):`);
        w();
        w(`| model | tokens | list value | share | ≈ Credits |`);
        w(`|---|---|---|---|---|`);
        for (const m of last.modelCredits) {
          const tok = [...perModel].find(([k]) => k.startsWith(`${r.provider}\u0000`) && k.endsWith(`\u0000${m.model}`))?.[1];
          w(`| \`${m.model}\` | ${fmt(tok?.tokens)} | ${money(m.spend)} | ${(m.share * 100).toFixed(1)}% | ${fmt(m.credits)} |`);
        }
        w();
      }
    }
  }

  const mix = mixEconomics(r.provider);
  if (mix.length) {
    w(`**What your volume would cost on each model of this catalog** (priced at your observed mix, not the usual 3:1):`);
    w();
    w(`| model | $/Mtok at your mix | your month | % of allowance | intelligence | data | used? |`);
    w(`|---|---|---|---|---|---|---|`);
    for (const m of mix.slice(0, 14)) {
      w(`| \`${m.model}\` | ${usd(m.perMtok)} | ${money(m.monthForYourVolume)} | ${m.limit ? ((m.monthForYourVolume / m.limit) * 100).toFixed(0) + "%" : "-"} | ${m.intelligence ?? "-"} | ${m.trains ? "**TRAINS**" : "no-train"} | ${m.used ? "yes" : ""} |`);
    }
    w();
  }

  w(`**Models** (${r.provider}):`);
  w();
  const projects = [...perModel].filter(([k]) => k.startsWith(`${r.provider}\u0000`))
    .map(([k, v]) => ({ model: k.split("\u0000")[1], ...v })).sort((a, b) => b.tokens - a.tokens);
  w(`| model | reqs | tokens | generated | list value | price source |`);
  w(`|---|---|---|---|---|---|`);
  const srcFor = (model) => priced.find((p) => p.provider === r.provider && p.model === model)?.priceSource || "-";
  for (const m of projects.slice(0, 10)) {
    w(`| \`${m.model}\` | ${fmt(m.n)} | ${fmt(m.tokens)} | ${fmt(m.generated)} | ${money(m.list)} | ${srcFor(m.model)} |`);
  }
  w();
  w(`**Projects** (${r.provider}, top ${opts.top} by tokens):`);
  w();
  const tops = [...perProject].filter(([k]) => k.startsWith(`${r.provider}\u0000`))
    .map(([k, v]) => ({ cwd: k.split("\u0000")[1], ...v })).sort((a, b) => b.tokens - a.tokens).slice(0, opts.top);
  for (const p of tops) w(`- \`${p.cwd}\` — ${fmt(p.tokens)} tok, ${money(p.list)}, ${fmt(p.n)} reqs`);
  w();
}

w(`## Latency (session timestamps, requests under 15 min)`);
w();
w(`| provider | requests | median s | p90 s | median out tok/s |`);
w(`|---|---|---|---|---|`);
for (const [p, v] of [...lat].sort((a, b) => b[1].lat.length - a[1].lat.length)) {
  w(`| ${p} | ${fmt(v.lat.length)} | ${fmt(pct(v.lat, 0.5), 1)} | ${fmt(pct(v.lat, 0.9), 1)} | ${fmt(pct(v.tput, 0.5), 1)} |`);
}
w();
w(`Provider-reported quota is read from the config, not the API: \`${opts.config}\`. Reference data: `);
w(`\`${REF_PATH}\` (as of ${ref.asOf || "unknown"}).`);
for (const msg of warnings) w(``);
for (const msg of warnings) w(`> **warning:** ${msg}`);

const text = L.join("\n") + "\n";
if (opts.out) {
  if (existsSync(opts.out) && !opts.force) { console.error(`refusing to overwrite ${opts.out} (pass --force)`); process.exit(1); }
  writeFileSync(opts.out, text);
  console.log(opts.out);
} else {
  process.stdout.write(text);
}
