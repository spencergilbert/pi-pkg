/**
 * Review loop - iterate agentic changes until they are ready for a human
 *
 * Reviews the change set between a baseline ref and the current working tree,
 * hands actionable findings to the coding agent, then re-reviews the delta and
 * every still-open finding. The loop stops when the readiness gate holds, when
 * only human decisions remain, when the round budget is spent, or when a
 * finding refuses to die and is escalated instead of chased.
 *
 * The extension owns the gate; the reviewer only reports findings. Reviewers
 * submit through the report_review_findings tool, active only while a round is
 * running, so findings are structured data rather than prose to be re-parsed.
 *
 * Requires an interactive session: the loop runs across several agent turns.
 *
 * Usage:
 *   /review-loop [ref]              start a loop (baseline: merge-base with the
 *                                   default branch, falling back to HEAD)
 *   /review-loop --model <spec>     review with a different model, per
 *                                   invocation only; the session model is
 *                                   restored when the round ends
 *   /review-loop --thinking <level> reviewer thinking level
 *   /review-loop brief              print the latest review brief
 *   /review-loop status             rounds, findings, gate state
 *   /review-loop stop               end the loop and restore the session model
 *
 * Gate (ready for human review, not "mergeable"):
 *   - no open P0/P1 findings
 *   - no open P2 finding with disposition "fix"
 *   - no human decision still outstanding
 *   - the tree still matches the reviewed state
 *
 * Priority is impact, disposition is what the loop does with it:
 *   P0 broken · P1 blocking · P2 actionable · P3 optional
 *   fix (agent acts) · ask (human decides) · note (documented only)
 *
 * Project guidance is read from the nearest REVIEW.md walking up from the
 * working directory, stopping at the repository root.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi thinking levels. Re-declared here because the coding-agent package does not re-export the type. */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
import type { Static } from "typebox";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const STATE_TYPE = "review-loop";
const UI_MESSAGE_TYPE = "review-loop-ui";
const FINDINGS_TOOL = "report_review_findings";
const STATUS_KEY = "review-loop";

const MAX_ROUNDS = 3;
/** A finding seen this many rounds in a row is escalated to the human. */
const STUCK_ROUNDS = 2;
/** Diffs larger than this are summarized and left for the reviewer to read. */
const MAX_INLINE_DIFF_BYTES = 120_000;
/** Above this many changed files, per-file deltas are not inlined. */
const MAX_TRACKED_FILES = 200;

type Priority = "P0" | "P1" | "P2" | "P3";
type Disposition = "fix" | "ask" | "note";
type FindingStatus = "open" | "fixed";
type LoopPhase = "reviewing" | "awaiting-fix" | "ready" | "stopped";

interface Finding {
	id: string;
	priority: Priority;
	disposition: Disposition;
	title: string;
	file?: string;
	line?: string;
	trigger: string;
	impact: string;
	fix?: string;
	confidence: number;
	status: FindingStatus;
	firstRound: number;
	lastRound: number;
	roundsSeen: number;
}

interface Baseline {
	ref: string;
	sha: string;
	source: "explicit" | "merge-base" | "head";
}

interface LoopState {
	version: 1;
	phase: LoopPhase;
	round: number;
	baseline: Baseline;
	/** Content hash per changed path, to tell what moved between rounds. */
	fingerprints: Record<string, string>;
	/** Paths changed since the previous round's snapshot. */
	delta: string[];
	findings: Finding[];
	/** Session model to restore after a reviewer ran under another model. */
	restore?: { provider: string; id: string; thinking?: ThinkingLevel };
	/** Requested reviewer, kept so later rounds in this loop reuse it. */
	reviewerSpec?: string;
	reviewerThinking?: ThinkingLevel;
	reviewer?: string;
	stopReason?: string;
	updatedAt: number;
}

interface PersistedLoopState {
	version: 1;
	state: LoopState | null;
}

const FindingInput = Type.Object({
	priority: StringEnum(["P0", "P1", "P2", "P3"] as const, {
		description: "P0 broken, P1 blocking, P2 actionable, P3 optional",
	}),
	disposition: StringEnum(["fix", "ask", "note"] as const, {
		description: "fix: the coding agent acts; ask: a human decides; note: documented only",
	}),
	title: Type.String({ description: "One-line statement of the problem" }),
	file: Type.Optional(Type.String({ description: "Repository-relative path" })),
	line: Type.Optional(Type.String({ description: "Line or short range, e.g. 42 or 40-44" })),
	trigger: Type.String({
		description: "The concrete condition that makes it fire: input, call path, or configuration",
	}),
	impact: Type.String({ description: "What happens when it fires" }),
	fix: Type.Optional(Type.String({ description: "Specific direction for the fix" })),
	confidence: Type.Number({
		description: "0-1. How sure you are the defect is real in this code, not how bad it would be",
	}),
});

const FindingsParams = Type.Object({
	findings: Type.Array(FindingInput, {
		description: "Every finding that clears the bar. An empty array when the change set is clean.",
	}),
	summary: Type.String({ description: "Two or three sentences on what was reviewed and the overall read." }),
	verification: Type.Optional(
		Type.String({ description: "Checks you actually ran, with results. Empty when you ran none." }),
	),
});

type FindingInputStatic = Static<typeof FindingInput>;

export default function reviewLoopExtension(pi: ExtensionAPI) {
	let state: LoopState | null = null;
	/** Findings captured from the tool call of the round currently running. */
	let submitted: FindingInputStatic[] | null = null;
	/** Whether the current round has already been prodded to use the tool. */
	let nudgedThisRound = false;
	/** Active tool set to restore when the findings tool is stood down. */
	let toolsBeforeReview: string[] | null = null;
	/** The registry is reachable only through a context; keep the newest. */
	let lastCtx: ExtensionContext | undefined;

	// ---------------------------------------------------------------- git ----

	async function gitRoot(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], {});
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** Run git at the repository root so reported paths are repo-relative. */
	async function git(ctx: ExtensionContext, args: string[]): Promise<string | undefined> {
		const cwd = await gitRoot(ctx);
		if (!cwd) return undefined;
		try {
			const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
			return stdout;
		} catch {
			return undefined;
		}
	}

	/** Git output trimmed of trailing whitespace, or undefined when it failed or was empty. */
	async function gitText(ctx: ExtensionContext, args: string[]): Promise<string | undefined> {
		const out = await git(ctx, args);
		const trimmed = out?.trim();
		return trimmed ? trimmed : undefined;
	}

	async function resolveBaseline(ctx: ExtensionContext, explicit?: string): Promise<Baseline | string> {
		if (explicit) {
			const sha = await gitText(ctx, ["rev-parse", "--verify", `${explicit}^{commit}`]);
			if (!sha) return `Unknown revision "${explicit}".`;
			return { ref: explicit, sha, source: "explicit" };
		}

		const head = await gitText(ctx, ["rev-parse", "HEAD"]);
		if (!head) return "This is not a git repository with a commit yet, so there is nothing to review against.";

		const defaultBranch =
			(await gitText(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
				?.replace(/^origin\//, "") ??
			((await gitText(ctx, ["rev-parse", "--verify", "refs/heads/main"])) && "main") ??
			((await gitText(ctx, ["rev-parse", "--verify", "refs/heads/master"])) && "master");

		if (defaultBranch) {
			const mergeBase = await gitText(ctx, ["merge-base", "HEAD", defaultBranch]);
			if (mergeBase) return { ref: defaultBranch, sha: mergeBase, source: "merge-base" };
		}
		return { ref: "HEAD", sha: head, source: "head" };
	}

	/** Changed paths relative to the repo root, tracked and untracked, excluding ignored files. */
	/**
	 * Every path the change set touches: tracked modifications against the
	 * baseline (committed or not), plus untracked files. Ignored files stay out.
	 */
	async function changedPaths(ctx: ExtensionContext, baseline: Baseline): Promise<string[]> {
		const tracked =
			(await gitText(ctx, ["diff", "--name-only", "--find-renames", baseline.sha]))?.split("\n").filter(Boolean) ??
			[];
		const untracked =
			(await gitText(ctx, ["ls-files", "--others", "--exclude-standard"]))?.split("\n").filter(Boolean) ?? [];
		return [...new Set([...tracked, ...untracked])].sort();
	}

	/**
	 * Digest every changed file so the next round can tell what the fix pass
	 * actually moved. Deleted or unreadable files digest as "deleted", which is
	 * itself a change worth re-reviewing.
	 */
	async function snapshot(ctx: ExtensionContext, paths: string[]): Promise<Record<string, string>> {
		const root = await gitRoot(ctx);
		const out: Record<string, string> = {};
		for (const rel of paths.slice(0, MAX_TRACKED_FILES)) {
			const bytes = await fs.readFile(root ? path.join(root, rel) : rel).catch(() => null);
			out[rel] = bytes ? createHash("sha256").update(bytes).digest("hex") : "deleted";
		}
		return out;
	}

	function changedSince(before: Record<string, string>, after: Record<string, string>): string[] {
		const names = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...names].filter((name) => before[name] !== after[name]).sort();
	}

	async function collectChangeSet(ctx: ExtensionContext, baseline: Baseline): Promise<string> {
		const log = (await gitText(ctx, ["log", "--oneline", "--no-decorate", `${baseline.sha}..HEAD`])) ?? "";
		const diff = (await git(ctx, ["diff", "--no-ext-diff", "--find-renames", baseline.sha])) ?? "";
		const untracked = (await gitText(ctx, ["ls-files", "--others", "--exclude-standard"]))
			?.split("\n")
			.filter(Boolean);

		const parts: string[] = [];
		parts.push(`### Commits since \`${baseline.ref}\`\n\n${log || "(none — the change set is uncommitted)"}`);

		if (Buffer.byteLength(diff) > MAX_INLINE_DIFF_BYTES) {
			const stat = (await gitText(ctx, ["diff", "--no-ext-diff", "--stat", baseline.sha])) ?? "";
			parts.push(
				`### Tracked changes\n\nThe diff is ${Buffer.byteLength(diff)} bytes and is not inlined. Read it with \`git diff ${baseline.sha}\`.\n\n${stat}`,
			);
		} else {
			parts.push(`### Tracked changes\n\n\`\`\`diff\n${diff || "(none)"}\n\`\`\``);
		}

		if (untracked?.length) {
			parts.push(
				`### Untracked files (${untracked.length})\n\n${untracked
					.slice(0, 40)
					.map((f) => `- ${f}`)
					.join("\n")}${untracked.length > 40 ? `\n- … ${untracked.length - 40} more` : ""}\n\nRead any that matter before judging the change set — untracked code is part of the change.`,
			);
		}
		return parts.join("\n\n");
	}

	async function fileDiffs(ctx: ExtensionContext, baseline: Baseline, paths: string[]): Promise<string> {
		const chunks: string[] = [];
		for (const rel of paths.slice(0, 20)) {
			const diff = await gitText(ctx, ["diff", "--no-ext-diff", "--find-renames", baseline.sha, "--", rel]);
			if (diff) chunks.push(`\`\`\`diff\n${diff}\n\`\`\``);
			else {
				const exists = await fs.readFile(path.join((await gitRoot(ctx)) ?? ctx.cwd, rel), "utf8").catch(() => null);
				chunks.push(
					exists === null
						? `_${rel}: no tracked diff and no readable file — it may have been added and removed, or is untracked._`
						: `_${rel}: new or untracked file. Read it directly._`,
				);
			}
		}
		return chunks.join("\n\n");
	}

	// ----------------------------------------------------------- guidance ----

	/** Nearest REVIEW.md walking up from the working directory, stopping at the repo root. */
	async function loadGuidelines(ctx: ExtensionContext): Promise<string | null> {
		const root = await gitRoot(ctx);
		const stopAt = root ? path.resolve(root) : path.resolve(ctx.cwd);
		let current = path.resolve(ctx.cwd);

		while (true) {
			const text = await fs.readFile(path.join(current, "REVIEW.md"), "utf8").catch(() => null);
			if (text?.trim()) return text.trim();
			if (current === stopAt) return null;
			const parent = path.dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}

	// -------------------------------------------------------------- prompt ----

	interface PromptInput {
		state: LoopState;
		changeSet: string;
		guidelines: string | null;
		open: Finding[];
		delta: string | null;
	}

	function reviewPrompt({ state, changeSet, guidelines, open, delta }: PromptInput): string {
		const opening =
			state.round === 1 || !delta
				? `Round ${state.round}. Review the whole change set.`
				: `Round ${state.round} of a review loop. Since the last round only the delta below was written. Re-check every open finding against the current code, then review the delta for defects and for regressions the fix pass introduced.`;

		const openSection = open.length
			? `### Open findings you owe a verdict on\n\n${open
					.map((f) => `- **${f.id}** [${f.priority}/${f.disposition}] ${f.title}${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""}`)
					.join("\n")}\n\nFor each: fixed, still open, or false positive. Report a still-open one again with the same id and the same title. Omit a fixed or withdrawn one; anything you omit is closed.`
			: "### Open findings\n\nNone from earlier rounds.";

		const deltaSection = delta
			? `### Delta since round ${state.round - 1}\n\nFiles the fix pass touched:\n${state.delta.map((f) => `- ${f}`).join("\n") || "(none reported)"}\n\n${delta}\n\nSpot-check these files for regressions even if the diff looks unrelated.`
			: "";

		return `${opening}

You are reviewing this change set for a human who will read it next. Find what is wrong. Do not summarize what is there.

## Change set

Baseline: \`${state.baseline.ref}\` (${state.baseline.sha.slice(0, 8)}), resolved by ${state.baseline.source}.

${changeSet}

${deltaSection}

${openSection}

## What to look for

Correctness and state handling. Concurrency and resource lifetime. Trust boundaries and unvalidated input. Performance at realistic scale, not theoretical. API and contract compatibility. Verification gaps — behavior that changed with nothing covering it.

Then the cross-boundary check, which is where integration bugs live and where a diff tells you nothing: when the change introduces or alters a type, variant, enum, error, or signature, find every consumer that dispatches on it and confirm each handles the new case.

Read whatever surrounding code you need. The diff is your mandate, not your boundary.

## What clears the bar

Only report a finding when all four hold:

- **Introduced here.** Not pre-existing, not an improvement you would have made anyway.
- **You can name the trigger.** The input, call path, or configuration that makes it fire. "This might break under load" is not a finding.
- **The author would fix it.** Given the trigger and the impact, they would change the code.
- **Real in this code, not in general.** Not a pattern you dislike, not a violation of a contract you have not read.

When unsure whether something clears the bar, do not report it. Silence beats noise: a reviewer that cries wolf trains the human to skim. A clean change set gets zero findings and one line saying so.

## Priority and disposition

Priority is impact. Disposition is what happens next.

- **P0 broken** — build or test failure, guaranteed crash, data loss, security hole, committed secret. Always \`fix\`.
- **P1 blocking** — high-confidence regression, a contract broken for a real caller, a race on a realistic path, changed behavior with no verification. Always \`fix\`. If you believe it cannot be fixed without a human call, mark it \`ask\` and name the decision.
- **P2 actionable** — a real defect on a narrower path or with smaller blast radius, a meaningful edge-case gap, local error handling that swallows failure. \`fix\` only when the fix is local, behavior-preserving, and unambiguous. Anything that changes behavior, API shape, architecture, or product scope is \`ask\`.
- **P3 optional** — naming, comments, refactors you would prefer, speculative performance worries. Always \`note\`.

Confidence is how sure you are the defect is real, not how bad it would be.

Your final action must be a single ${FINDINGS_TOOL} tool call carrying every finding, or an empty findings array when the change set is clean. Prose is not a report: findings written as text are discarded and the round is wasted.

${guidelines ? `## Project review guidance\n\nFrom the nearest \`REVIEW.md\`. Apply on top of the above; these do not relax the bar.\n\n${guidelines}\n` : ""}`;
	}

	function fixPrompt(findings: Finding[]): string {
		const items = findings.map((f) => {
			const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "not localized";
			return `- [${f.priority}] ${f.id}: ${f.title}\n  Where: ${where}\n  Trigger: ${f.trigger}\n  Impact: ${f.impact}${
				f.fix ? `\n  Direction: ${f.fix}` : ""
			}`;
		});

		return `Fix these findings from the review round on the current change set. Treat them as a checklist.

${items.join("\n")}

1. P0 first, then P1, then P2.
2. Check each finding against the code before fixing it. If it is wrong, already handled, or genuinely out of scope, say so in one line and move on. Do not perform a fix you do not believe in.
3. Stay inside the scope of these findings. Do not refactor adjacent code or settle style arguments while you are here.
4. Do not add fallbacks, retries, or catch-and-continue paths to soften a failure the finding asked you to make loud.
5. Run the checks that cover what you touched and report exactly which commands you ran and what they printed. If a check cannot be run, say why — this extension does not know this repository's build or test command, so your report is the evidence.
6. If a fix needs a decision you cannot make from the code alone — behavior change, API shape, product scope — stop on that finding and flag it instead of guessing.

End with: fixed, rejected with reason, deferred awaiting a decision, and the verification you ran.`;
	}

	// ----------------------------------------------------------- findings ----

	/** Carry findings forward across rounds, keyed by id hint, else by priority+title. */
	function mergeFindings(inputs: FindingInputStatic[], prior: Finding[], round: number): Finding[] {
		const byId = new Map(prior.map((f) => [f.id, f]));
		const byKey = new Map(prior.map((f) => [`${f.priority}|${f.title.toLowerCase()}`, f]));
		const seen = new Set<string>();
		const merged: Finding[] = [];

		inputs.forEach((input, index) => {
			const hinted = input.title.match(/^\s*\[?([A-Za-z]+-?\d+)\]?\s*[:\-]/)?.[1];
			const byHint = hinted ? byId.get(hinted) : undefined;
			const byTitle = byKey.get(`${input.priority}|${input.title.trim().toLowerCase()}`);
			const carried = [byHint, byTitle].find((c) => c && !seen.has(c.id));

			const id = carried?.id ?? `R${round}F${index + 1}`;
			seen.add(id);
			merged.push({
				id,
				priority: input.priority,
				disposition: input.disposition,
				title: input.title.trim(),
				file: input.file,
				line: input.line,
				trigger: input.trigger,
				impact: input.impact,
				fix: input.fix,
				confidence: clamp01(input.confidence),
				status: "open",
				firstRound: carried?.firstRound ?? round,
				lastRound: round,
				roundsSeen: (carried?.roundsSeen ?? 0) + 1,
			});
		});
		return merged;
	}

	function clamp01(n: number): number {
		if (!Number.isFinite(n)) return 0;
		return Math.min(1, Math.max(0, n));
	}

	const openFindings = (findings: Finding[]) => findings.filter((f) => f.status === "open");
	const actionable = (findings: Finding[]) => openFindings(findings).filter((f) => f.disposition === "fix");
	const stuckIn = (findings: Finding[]) => openFindings(findings).filter((f) => f.roundsSeen >= STUCK_ROUNDS);

	function summarize(open: Finding[]): string {
		return (["P0", "P1", "P2", "P3"] as const)
			.map((p) => [p, open.filter((f) => f.priority === p).length] as const)
			.filter(([, n]) => n > 0)
			.map(([p, n]) => `${p}:${n}`)
			.join(" ");
	}

	// ---------------------------------------------------------------- gate ----

	interface Gate {
		ready: boolean;
		reasons: string[];
	}

	/**
	 * Readiness for human review — not "mergeable", but "worth your time now".
	 * `drifted` means the tree moved after the last round reviewed it, which
	 * voids the verdict: nothing has reviewed what is on disk now.
	 */
	function evaluateGate(s: LoopState, drifted: boolean, includePhase = true): Gate {
		const reasons: string[] = [];
		const open = openFindings(s.findings);
		const blocking = open.filter((f) => f.priority === "P0" || f.priority === "P1");
		const pendingFix = open.filter((f) => f.priority === "P2" && f.disposition === "fix");
		const decisions = open.filter((f) => f.disposition === "ask");

		if (blocking.length) {
			reasons.push(`${blocking.length} blocking finding(s) open: ${blocking.map((f) => f.id).join(", ")}`);
		}
		if (pendingFix.length) {
			reasons.push(`${pendingFix.length} P2 finding(s) awaiting a fix: ${pendingFix.map((f) => f.id).join(", ")}`);
		}
		if (decisions.length) {
			reasons.push(`${decisions.length} finding(s) need a human decision: ${decisions.map((f) => f.id).join(", ")}`);
		}
		if (drifted) reasons.push("the tree changed after the last round reviewed it");
		if (includePhase && s.phase !== "ready") reasons.push(`the loop is ${s.phase}, not ready`);

		return { ready: reasons.length === 0, reasons };
	}

	// ------------------------------------------------------------- state ----

	function persist(): void {
		pi.appendEntry<PersistedLoopState>(STATE_TYPE, {
			version: 1,
			state: state ? structuredClone(state) : null,
		});
	}

	function reconstruct(ctx: ExtensionContext): void {
		state = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as PersistedLoopState | undefined;
			state = data?.state ? structuredClone(data.state) : null;
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!state) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const counts = summarize(openFindings(state.findings));
		const suffix = counts ? ` · ${counts}` : "";
		switch (state.phase) {
			case "reviewing":
				ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `reviewing r${state.round}${suffix}`));
				break;
			case "ready":
				ctx.ui.setStatus(STATUS_KEY, theme.fg("success", `review ready${suffix}`));
				break;
			case "awaiting-fix":
				ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `awaiting fix r${state.round}${suffix}`));
				break;
			case "stopped":
				ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", `review stopped r${state.round}${suffix}`));
				break;
		}
	}

	/**
	 * Render a loop message in the transcript. Print mode renders neither custom
	 * messages nor notifications, so fall back to stdout there — otherwise a
	 * guarded command would fail silently.
	 */
	function showMessage(content: string): void {
		if (lastCtx?.hasUI) {
			pi.sendMessage({ customType: UI_MESSAGE_TYPE, content, display: true }, { triggerTurn: false });
			return;
		}
		console.log(content);
	}

	// -------------------------------------------------------------- model ----

	function authedModels(): Model<any>[] {
		if (!lastCtx) return [];
		return lastCtx.modelRegistry.getAll().filter((m) => lastCtx?.modelRegistry.hasConfiguredAuth(m));
	}

	/** `provider/id`, an exact id, or an id fragment matching exactly one model. */
	function parseModelSpec(spec: string): Model<any> | undefined {
		const needle = spec.trim().toLowerCase();
		const pool = authedModels();
		return (
			pool.find((m) => `${m.provider}/${m.id}`.toLowerCase() === needle) ??
			unique(pool.filter((m) => m.id.toLowerCase() === needle)) ??
			unique(pool.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(needle)))
		);
	}

	function unique<T>(items: T[]): T | undefined {
		return items.length === 1 ? items[0] : undefined;
	}

	/**
	 * Switch the session to the reviewer for this round; the session's own model
	 * is restored when the round ends. A loop keeps its reviewer spec, so round 2
	 * and 3 review with the same model the user asked for at the start.
	 */
	async function applyReviewer(): Promise<string | undefined> {
		if (!state) return "internal: no loop state";
		const spec = state.reviewerSpec;
		const thinking = state.reviewerThinking;
		if (!spec && !thinking) return undefined;

		if (spec) {
			const current = lastCtx?.model;
			if (current && `${current.provider}/${current.id}`.toLowerCase() === spec.toLowerCase()) {
				state.reviewer = spec;
				return undefined;
			}
			const model = parseModelSpec(spec);
			if (!model) {
				return `No model with configured auth matched "${spec}". Use \`provider/id\`, or omit --model to review with the session model.`;
			}
			if (!(await pi.setModel(model))) return `No configured auth for ${model.provider}/${model.id}.`;
			state.restore = {
				provider: current?.provider ?? model.provider,
				id: current?.id ?? model.id,
				thinking: lastCtx?.thinkingLevel,
			};
			state.reviewer = `${model.provider}/${model.id}`;
		}
		if (thinking) pi.setThinkingLevel(thinking);
		return undefined;
	}

	/** Put the session's own model back for the fix pass and between rounds. */
	async function restoreSessionModel(): Promise<void> {
		const restore = state?.restore;
		if (state) state.restore = undefined;
		if (!restore || !lastCtx) return;
		const model = lastCtx.modelRegistry.find(restore.provider, restore.id);
		if (model) await pi.setModel(model);
		if (restore.thinking) pi.setThinkingLevel(restore.thinking);
	}

	// ---------------------------------------------------------- tool gating ----

	function activateFindingsTool(): void {
		if (toolsBeforeReview) return;
		const current = pi.getActiveTools();
		if (current.includes(FINDINGS_TOOL)) return;
		toolsBeforeReview = current;
		pi.setActiveTools([...current, FINDINGS_TOOL]);
	}

	function deactivateFindingsTool(): void {
		if (!toolsBeforeReview) return;
		pi.setActiveTools(toolsBeforeReview);
		toolsBeforeReview = null;
	}

	// ----------------------------------------------------------------- run ----

	interface StartOptions {
		baselineRef?: string;
		model?: string;
		thinking?: ThinkingLevel;
		/** Restart the round counter while keeping the findings of a finished loop. */
		newBudget?: boolean;
	}

	async function startRound(ctx: ExtensionContext, options: StartOptions): Promise<void> {
		// The loop spans several agent turns. Print mode hands back a stale context
		// once its first turn settles, so round 2 would crash instead of review.
		if (!ctx.hasUI) {
			showMessage(
				"The review loop needs an interactive session: it runs across several turns and restores your model when they settle. Start pi without `-p` to use it.",
			);
			return;
		}

		if (state?.phase === "reviewing") {
			showMessage("A review round is already running. Wait for it, or `/review-loop stop`.");
			return;
		}

		const baseline = await resolveBaseline(ctx, options.baselineRef ?? state?.baseline.ref);
		if (typeof baseline === "string") {
			showMessage(baseline);
			return;
		}

		const paths = await changedPaths(ctx, baseline);
		const startedFresh = state === null;
		if (!state) {
			state = {
				version: 1,
				phase: "reviewing",
				round: 1,
				baseline,
				fingerprints: await snapshot(ctx, paths),
				delta: [],
				findings: [],
				updatedAt: Date.now(),
			};
		} else {
			// Continuing a loop that ended (ready or stopped) buys a fresh round
			// budget but keeps its findings, so earlier verdicts and the
			// seen-N-rounds escalation still carry, matched by id or title.
			const next = await snapshot(ctx, paths);
			state.delta = changedSince(state.fingerprints, next);
			state.fingerprints = next;
			state.baseline = baseline;
			state.phase = "reviewing";
			state.round = options.newBudget ? 1 : state.round + 1;
			state.stopReason = undefined;
			state.updatedAt = Date.now();
		}
		if (!state) return;

		if (options.model !== undefined) state.reviewerSpec = options.model;
		if (options.thinking !== undefined) state.reviewerThinking = options.thinking;

		const modelError = await applyReviewer();
		if (modelError) {
			// A round that never started must not be left looking in-flight.
			if (startedFresh) state = null;
			else if (state) {
				state.phase = "stopped";
				state.stopReason = `the requested reviewer could not be started: ${modelError}`;
				persist();
			}
			showMessage(modelError);
			updateStatus(ctx);
			return;
		}

		persist();
		updateStatus(ctx);
		activateFindingsTool();

		const delta = state.round > 1 && state.delta.length > 0
			? await fileDiffs(ctx, state.baseline, state.delta)
			: null;

		submitted = null;
		nudgedThisRound = false;
		pi.sendUserMessage(
			reviewPrompt({
				state,
				changeSet: await collectChangeSet(ctx, state.baseline),
				guidelines: await loadGuidelines(ctx),
				open: openFindings(state.findings),
				delta,
			}),
			{ deliverAs: "followUp" },
		);
	}

	/** True when this settle should nudge the model into using the findings tool. */
	function needsNudge(): boolean {
		return submitted === null && !nudgedThisRound && state?.phase === "reviewing";
	}

	async function finishRound(ctx: ExtensionContext, aborted: boolean): Promise<void> {
		if (!state || state.phase !== "reviewing") return;
		// The findings tool stays live while a nudge is outstanding: the round is
		// not over until the model reports or the nudge is spent.
		if (!needsNudge()) deactivateFindingsTool();

		if (aborted) {
			state.phase = "stopped";
			state.stopReason = "the review round was aborted";
			persist();
			await restoreSessionModel();
			updateStatus(ctx);
			showMessage(`Review round ${state.round} was aborted. Nothing was recorded.`);
			return;
		}

		if (!submitted) {
			// Weak models narrate findings instead of calling the tool. One nudge
			// recovers the round; a second failure stops rather than nagging.
			if (!nudgedThisRound) {
				nudgedThisRound = true;
				updateStatus(ctx);
				pi.sendUserMessage(
					`You described findings in prose but never called ${FINDINGS_TOOL}, so the loop recorded nothing. Call ${FINDINGS_TOOL} now with exactly what you reported — same findings, same priorities — or an empty findings array if you concluded the change set is clean. Do not restate them in text.`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			state.phase = "stopped";
			state.stopReason = "the review round ended without calling the findings tool";
			persist();
			await restoreSessionModel();
			updateStatus(ctx);
			showMessage(
				`Round ${state.round} ended twice without a findings report, so nothing was recorded. Read the transcript for what it found, or re-run \`/review-loop\` with a stronger reviewer.`,
			);
			return;
		}

		const merged = mergeFindings(submitted, openFindings(state.findings), state.round);
		const reported = new Set(merged.map((f) => f.id));
		for (const finding of state.findings) {
			if (finding.status === "open" && !reported.has(finding.id)) finding.status = "fixed";
		}
		state.findings = merged;

		// A finding that has survived a fix pass twice is a disagreement, not a task.
		for (const finding of stuckIn(state.findings)) {
			if (finding.disposition === "fix") {
				finding.disposition = "ask";
				finding.trigger = `${finding.trigger} — reported in ${finding.roundsSeen} rounds and still open`;
			}
		}

		const fixes = actionable(state.findings);

		if (fixes.length > 0 && state.round < MAX_ROUNDS) {
			state.phase = "awaiting-fix";
			persist();
			await restoreSessionModel();
			updateStatus(ctx);
			showMessage(renderBrief(state, `${fixes.length} finding(s) to fix. Handing them to the coding agent now.`));
			pi.sendUserMessage(fixPrompt(fixes), { deliverAs: "followUp" });
			return;
		}

		// Work the loop still owes is never "ready". An unfixed finding, or one
		// waiting on a human decision, is a stop with a reason, not a green light.
		const undecided = openFindings(state.findings).filter((f) => f.disposition === "ask");
		if (fixes.length > 0) {
			state.phase = "stopped";
			state.stopReason = `round budget (${MAX_ROUNDS}) spent with ${fixes.length} finding(s) unfixed`;
		} else if (undecided.length > 0) {
			state.phase = "stopped";
			state.stopReason = `${undecided.length} finding(s) need a human decision before this is ready`;
		} else {
			state.phase = "ready";
			state.stopReason = openFindings(state.findings).length > 0 ? "only notes remain" : undefined;
		}

		persist();
		await restoreSessionModel();
		updateStatus(ctx);
		showMessage(
			renderBrief(
				state,
				state.phase === "ready" ? "Nothing blocks human review." : `Not ready: ${state.stopReason}.`,
				false,
			),
		);
	}

	// ---------------------------------------------------------------- view ----

	/** True when the tree no longer matches what the last round reviewed. */
	async function hasDrifted(ctx: ExtensionContext, s: LoopState): Promise<boolean> {
		const paths = await changedPaths(ctx, s.baseline);
		const now = await snapshot(ctx, paths);
		return changedSince(s.fingerprints, now).length > 0;
	}

	function renderBrief(s: LoopState, verdict: string, drifted = false): string {
		const open = openFindings(s.findings);
		// The brief already narrates why it stopped, so the gate line reports the
		// substantive reasons rather than restating the phase.
		const gate = evaluateGate(s, drifted, false);

		const section = (title: string, items: Finding[]) =>
			items.length === 0
				? ""
				: `## ${title}\n\n${items
						.map(
							(f) =>
								`- **${f.id}** [${f.priority}/${f.disposition}] ${f.title}${
									f.file ? `\n  \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""
								}\n  ${f.trigger} → ${f.impact}${f.fix ? `\n  _Direction:_ ${f.fix}` : ""}`,
						)
						.join("\n")}`;

		const resolved = s.findings.filter((f) => f.status !== "open");

		return [
			`# Review brief — round ${s.round}`,
			verdict,
			[
				`Baseline \`${s.baseline.ref}\` (${s.baseline.sha.slice(0, 8)} via ${s.baseline.source}).`,
				s.reviewer ? `Reviewer \`${s.reviewer}\`.` : "",
				`Gate: ${gate.ready ? "**ready**" : `**not ready** — ${gate.reasons.join("; ")}`}.`,
			]
				.filter(Boolean)
				.join(" "),
			section("Fix required", open.filter((f) => f.disposition === "fix")),
			section("Your decision", open.filter((f) => f.disposition === "ask")),
			section("Noted, no action", open.filter((f) => f.disposition === "note")),
			section("Resolved this loop", resolved),
			s.stopReason ? `## Why it stopped\n\n${s.stopReason}` : "",
			`## Next\n\n${nextStep(s)}`,
		]
			.filter(Boolean)
			.join("\n\n");
	}

	function nextStep(s: LoopState): string {
		const open = openFindings(s.findings);
		const fixes = open.filter((f) => f.disposition === "fix");
		const decisions = open.filter((f) => f.disposition === "ask");
		const notes = open.filter((f) => f.disposition === "note");

		if (s.phase === "ready") {
			return notes.length > 0
				? `Send it to a human, and mention the ${notes.length} note(s) above in the description so nobody is surprised by them.`
				: "Send it to a human. Nothing here blocks review.";
		}
		if (fixes.length > 0) {
			return `Run \`/review-loop\` to fix these and re-review, or fix them by hand and run \`/review-loop status\` to re-check the gate.`;
		}
		if (decisions.length > 0) {
			return `Answer the ${decisions.length} finding(s) above in the editor, then run \`/review-loop\`. Or accept them as out of scope and hand over with a note.`;
		}
		return `Run \`/review-loop\` to review again from \`${s.baseline.ref}\`.`;
	}

	function statusText(s: LoopState, drifted = false): string {
		const open = openFindings(s.findings);
		const gate = evaluateGate(s, drifted);
		return [
			`# Review loop`,
			[
				`Phase **${s.phase}** · round ${s.round} of ${MAX_ROUNDS}`,
				`Baseline \`${s.baseline.ref}\` (${s.baseline.sha.slice(0, 8)})`,
				s.reviewer ? `Reviewer \`${s.reviewer}\`` : "",
			]
				.filter(Boolean)
				.join(" · "),
			`Open ${summarize(open) || "none"} · Gate ${gate.ready ? "ready" : `not ready (${gate.reasons.join("; ")})`}`,
			s.findings.length
				? `## All findings\n\n${s.findings
						.map(
							(f) =>
								`- ${f.id} [${f.priority}/${f.disposition}] **${f.status}** — ${f.title}${f.file ? ` (\`${f.file}\`)` : ""}${
									f.roundsSeen > 1 ? ` · seen ${f.roundsSeen} rounds` : ""
								}`,
						)
						.join("\n")}`
				: "No findings recorded yet.",
		].join("\n\n");
	}

	// -------------------------------------------------------------- wiring ----

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		reconstruct(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		lastCtx = ctx;
		reconstruct(ctx);
	});

	pi.on("session_shutdown", async () => {
		deactivateFindingsTool();
	});

	// One settle boundary drives two distinct transitions: a finished review round
	// is collected, and a finished fix pass immediately starts the next round.
	// That is the loop — the user asked for it to run without a manual push.
	let settling = false;

	pi.on("agent_settled", async (event, ctx) => {
		// Checked before caching the context: after a print-mode turn settles, the
		// context is stale and any read on it throws.
		if (!state || settling) return;
		lastCtx = ctx;
		if (state.phase !== "reviewing" && state.phase !== "awaiting-fix") return;

		settling = true;
		try {
			if (state.phase === "reviewing") {
				await finishRound(ctx, event.aborted);
				return;
			}
			if (event.aborted) {
				state.phase = "stopped";
				state.stopReason = "the fix pass was aborted";
				persist();
				updateStatus(ctx);
				showMessage("Fix pass aborted. Run `/review-loop` to review the tree as it now stands.");
				return;
			}
			if (state.round >= MAX_ROUNDS) {
				state.phase = "stopped";
				state.stopReason = `round budget (${MAX_ROUNDS}) spent after the fix pass`;
				persist();
				updateStatus(ctx);
				showMessage(
					`Round budget (${MAX_ROUNDS}) spent. Run \`/review-loop\` to buy another round with the same findings, or \`/review-loop brief\` to see what is left.`,
				);
				return;
			}
			await startRound(ctx, {});
		} catch (err) {
			// A state recovered into a non-interactive session carries a context that
			// is dead by now. Stop cleanly instead of throwing on every settle.
			if (state) {
				state.phase = "stopped";
				state.stopReason = `the loop could not continue: ${err instanceof Error ? err.message : String(err)}`;
				persist();
			}
			showMessage("The review loop stopped instead of continuing. Run `/review-loop status` for the state it kept.");
		} finally {
			settling = false;
		}
	});

	pi.registerTool({
		name: FINDINGS_TOOL,
		label: "Review Findings",
		description:
			"Report the outcome of the active review round. Call it exactly once, at the end of the review, with every finding that clears the bar, or an empty findings array when the change set is clean.",
		promptSnippet: "Submit structured findings for the active review loop round",
		parameters: FindingsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!state || state.phase !== "reviewing") {
				throw new Error("no review round is running; start one with /review-loop");
			}
			if (submitted) throw new Error("findings already submitted for this round; report once per round");
			submitted = params.findings;
			return {
				content: [
					{
						type: "text",
						text:
							params.findings.length === 0
								? `Recorded a clean review: no findings. Say so in one line and stop.`
								: `Recorded ${params.findings.length} finding(s). Do not also write them up as prose; the loop will render them.`,
					},
				],
				details: params,
			};
		},
	});

	pi.registerCommand("review-loop", {
		description: "Iterate on agentic changes until they are ready for a human review",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "brief", label: "brief", description: "print the latest review brief" },
				{ value: "status", label: "status", description: "rounds, findings, and gate state" },
				{ value: "stop", label: "stop", description: "end the loop and restore the session model" },
				{ value: "--model", label: "--model", description: "review with another model" },
				{ value: "--thinking", label: "--thinking", description: "reviewer thinking level" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trimStart()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const trimmed = args.trim();
			const verb = (trimmed.match(/^\S+/)?.[0] ?? "").toLowerCase();

			if (verb === "stop") {
				if (!state) {
					showMessage("No review loop is active.");
					return;
				}
				deactivateFindingsTool();
				if (!state) {
					showMessage("Nothing to stop.");
					return;
				}
				state.phase = "stopped";
				state.stopReason = "stopped by you";
				persist();
				await restoreSessionModel();
				updateStatus(ctx);
				showMessage(renderBrief(state, "Loop stopped.", await hasDrifted(ctx, state)));
				return;
			}

			if (verb === "status" || verb === "brief") {
				if (!state) {
					showMessage("No review loop is active. Start one with `/review-loop`.");
					return;
				}
				const drifted = await hasDrifted(ctx, state);
				showMessage(
					verb === "brief"
						? renderBrief(state, state.stopReason ?? "Current state.", drifted)
						: statusText(state, drifted),
				);
				return;
			}

			const flags = parseFlags(trimmed);
			if (flags.error) {
				showMessage(flags.error);
				return;
			}
			if (state?.phase === "awaiting-fix") {
				showMessage(
					"A fix pass is running and the loop will review again when it lands. Use `/review-loop stop` to end the loop instead.",
				);
				return;
			}
			await startRound(ctx, {
				baselineRef: flags.positional[0],
				model: flags.model,
				thinking: flags.thinking,
				newBudget: state !== null && (state.phase === "stopped" || state.phase === "ready"),
			});
		},
	});
}

interface ParsedFlags {
	positional: string[];
	model?: string;
	thinking?: ThinkingLevel;
	error?: string;
}

function parseFlags(input: string): ParsedFlags {
	const tokens = input.split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--model" || token === "--thinking") {
			const value = tokens[++i];
			if (!value) {
				return {
					positional,
					error: `${token} needs a value${
						token === "--thinking" ? " (off, minimal, low, medium, high)" : " (provider/id)"
					}.`,
				};
			}
			if (token === "--model") model = value;
			else {
				const level = THINKING_LEVELS.find((l) => l === value.toLowerCase());
				if (!level) {
					return { positional, error: `"${value}" is not a thinking level: ${THINKING_LEVELS.join(", ")}.` };
				}
				thinking = level;
			}
			continue;
		}
		if (token.startsWith("-")) return { positional, error: `Unknown option "${token}".` };
		positional.push(token);
	}
	return { positional, model, thinking };
}
