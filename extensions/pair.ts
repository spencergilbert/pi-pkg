/**
 * Pair extension - pause-triggered pair-programming review loop
 *
 * Watches the working tree for changes while you drive, and once the tree
 * settles (a configurable pause with no further changes) proactively sends
 * the /pair prompt with a summary of what changed since the last review.
 * The persona lives entirely in prompts/pair.md - this extension is only the
 * trigger, the diff context, and the teach-only guardrails.
 *
 * Teach-only by construction: while pair watch is active, the write and edit
 * tools are removed from the active tool set and a system-prompt note keeps
 * bash read-only, so the agent can never mutate files and re-trigger itself.
 *
 * Usage:
 *   /pairwatch on            start watching (requires a git work tree, TUI mode)
 *   /pairwatch off           stop watching and restore write/edit tools
 *   /pairwatch pause <secs>  change the settle delay (default 30, range 1-3600)
 *   /pairwatch               show current state
 *
 * The manual /pair <focus> prompt still works as before; only the watcher is
 * new. State (active, pause) is appended to the session log and reconstructed
 * on reload/tree navigation - no external database.
 */

import { createHash } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pair";
const WRITE_TOOLS = new Set(["write", "edit"]);
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_PAUSE_MS = 30_000;
const MIN_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 3_600_000;
const MAX_SUMMARY_LINES = 60;

interface PairState {
	active: boolean;
	pauseMs: number;
}

function normalizePairState(value: unknown): PairState {
	const raw = (value ?? {}) as Partial<PairState>;
	const pauseMs = typeof raw.pauseMs === "number" && Number.isFinite(raw.pauseMs)
		? clampPauseMs(raw.pauseMs)
		: DEFAULT_PAUSE_MS;
	return {
		active: raw.active === true,
		pauseMs,
	};
}

function clampPauseMs(pauseMs: number): number {
	return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(pauseMs)));
}

function simpleHash(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function summarizeOutput(text: string, maxLines: number): string {
	const lines = text.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0);
	if (lines.length <= maxLines) return text.trimEnd();
	return `${lines.slice(0, maxLines).join("\n")}\n[...${lines.length - maxLines} more lines truncated]`;
}

const READ_ONLY_NOTICE = `Pair watch is active - you are the user's pair-programming partner and teacher while they drive. The write and edit tools are disabled on purpose. Run only read-only commands: git status/diff/log/show, ls, find, grep, read. Do not modify any files, stage, commit, or otherwise mutate the repository. Teach first, suggest second; never implement unless the user explicitly asks and clears pair mode.`;

export default function (pi: ExtensionAPI) {
	let state: PairState = { active: false, pauseMs: DEFAULT_PAUSE_MS };
	let toolsBeforePair: string[] | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let polling = false;
	let cwd = process.cwd();
	let ctxRef: ExtensionContext | null = null;
	// Git-state hashes. On activation both are baselined to the current tree so
	// pre-existing dirt never triggers; only genuinely new changes fire.
	let lastSeenHash: string | null = null;
	let lastSentHash: string | null = null;
	let lastChangeAt = 0;

	function persist(): void {
		pi.appendEntry(STATE_TYPE, { ...state });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!state.active) {
			ctx.ui.setStatus("pair", undefined);
			return;
		}
		ctx.ui.setStatus("pair", ctx.ui.theme.fg("accent", `Pair watch on (${state.pauseMs / 1000}s pause)`));
	}

	function armTimer(): void {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			void poll();
		}, POLL_INTERVAL_MS);
		timer.unref();
	}

	function disarmTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function applyReadOnlyTools(): void {
		const current = pi.getActiveTools();
		toolsBeforePair = [...current];
		pi.setActiveTools(current.filter((name) => !WRITE_TOOLS.has(name)));
	}

	function restoreTools(): void {
		if (toolsBeforePair) {
			pi.setActiveTools(toolsBeforePair);
			toolsBeforePair = null;
		}
	}

	/** Git working-tree summary: status lines plus diffstats. */
	async function gitOutput(): Promise<{ ok: boolean; text: string }> {
		try {
			const status = await pi.exec("git", ["status", "--short"], { cwd });
			if (status.code !== 0) return { ok: false, text: status.stderr };
			const diff = await pi.exec("git", ["diff", "--stat"], { cwd });
			const cached = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd });
			const parts = [status.stdout.trimEnd()];
			for (const result of [diff, cached]) {
				if (result.code === 0 && result.stdout.trim()) {
					parts.push(result.stdout.trimEnd());
				}
			}
			return { ok: true, text: parts.join("\n\n") };
		} catch (err) {
			return { ok: false, text: err instanceof Error ? err.message : String(err) };
		}
	}

	async function poll(): Promise<void> {
		if (polling || !state.active || !ctxRef) return;
		polling = true;
		try {
			const { ok, text } = await gitOutput();
			if (!ok) return;
			const hash = simpleHash(text);
			if (hash !== lastSeenHash) {
				lastSeenHash = hash;
				lastChangeAt = Date.now();
			}
			// Nothing new to review, or not settled yet.
			if (hash === lastSentHash) return;
			if (Date.now() - lastChangeAt < state.pauseMs) return;
			// Never interleave with an active, queued, or in-progress turn.
			if (!ctxRef.isIdle()) return;
			if (ctxRef.hasPendingMessages()) return;
			if (ctxRef.hasUI && ctxRef.ui.getEditorText().trim().length > 0) return;

			const summary = [
				"Changes since the last review (from the pair watcher):",
				"",
				"```text",
				summarizeOutput(text, MAX_SUMMARY_LINES),
				"```",
			].join("\n");

			try {
				pi.sendUserMessage(`/pair ${summary}`, { expandPromptTemplates: true });
				lastSentHash = hash;
				ctxRef.ui.notify("Pair review triggered", "info");
			} catch (err) {
				ctxRef.ui.notify(`Pair trigger failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		} finally {
			polling = false;
		}
	}

	async function setActive(active: boolean, ctx: ExtensionContext): Promise<boolean> {
		if (active === state.active) {
			ctx.ui.notify(state.active ? `Pair watch already on (${state.pauseMs / 1000}s pause)` : "Pair watch is off", "info");
			return state.active;
		}

		if (active) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Pair watch requires interactive (TUI) mode", "error");
				return false;
			}
			const git = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
			if (git.code !== 0 || git.stdout.trim() !== "true") {
				ctx.ui.notify("Not a git work tree - pair watch needs git. Use /pair manually instead.", "error");
				return false;
			}
			const { ok, text } = await gitOutput();
			if (!ok) {
				ctx.ui.notify("Failed to read git state; pair watch not started", "error");
				return false;
			}
			const hash = simpleHash(text);
			lastSeenHash = hash;
			lastSentHash = hash;
			lastChangeAt = Date.now();
			state.active = true;
			persist();
			applyReadOnlyTools();
			armTimer();
			updateStatus(ctx);
			ctx.ui.notify(`Pair watch on - reviews after ${state.pauseMs / 1000}s without changes. Writes are off (/pairwatch off to restore).`, "info");
			return true;
		}

		state.active = false;
		lastSeenHash = null;
		lastSentHash = null;
		persist();
		restoreTools();
		disarmTimer();
		updateStatus(ctx);
		ctx.ui.notify("Pair watch off - write/edit tools restored", "info");
		return false;
	}

	async function reconstruct(ctx: ExtensionContext): Promise<void> {
		cwd = ctx.cwd;
		ctxRef = ctx;
		state = { active: false, pauseMs: DEFAULT_PAUSE_MS };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				state = normalizePairState(entry.data);
			}
		}

		if (!state.active) {
			updateStatus(ctx);
			return;
		}

		// Re-arm after reload/resume: baseline to the current tree so existing
		// dirt does not immediately re-trigger a review, and re-apply the
		// read-only tool set for this fresh session.
		const { ok, text } = await gitOutput();
		if (!ok) {
			state.active = false;
			updateStatus(ctx);
			return;
		}
		const hash = simpleHash(text);
		lastSeenHash = hash;
		lastSentHash = hash;
		lastChangeAt = Date.now();
		applyReadOnlyTools();
		armTimer();
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await reconstruct(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reconstruct(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${READ_ONLY_NOTICE}`,
		};
	});

	pi.on("session_shutdown", async () => {
		disarmTimer();
		restoreTools();
	});

	pi.registerCommand("pairwatch", {
		description: "Watch the working tree and send /pair reviews after a pause (teach-only: write/edit disabled)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "on", label: "on", description: "start watching with a 30s settle pause" },
				{ value: "off", label: "off", description: "stop watching and restore write/edit tools" },
				{ value: "pause", label: "pause", description: "set the settle delay, e.g. /pairwatch pause 45" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trimStart()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [word, rest] = (() => {
				const parts = trimmed.split(/\s+/);
				return [parts[0] ?? "", parts.slice(1).join(" ")];
			})();

			switch (word.toLowerCase()) {
				case "on":
					await setActive(true, ctx);
					return;
				case "off":
					await setActive(false, ctx);
					return;
				case "pause": {
					const seconds = Number.parseInt(rest, 10);
					if (!Number.isFinite(seconds) || seconds < 1) {
						ctx.ui.notify("Usage: /pairwatch pause <secs> (1-3600)", "warning");
						return;
					}
					state.pauseMs = clampPauseMs(seconds * 1000);
					persist();
					updateStatus(ctx);
					ctx.ui.notify(`Pair watch pause set to ${state.pauseMs / 1000}s`, "info");
					return;
				}
				case "":
					ctx.ui.notify(
						state.active
							? `Pair watch on (${state.pauseMs / 1000}s pause). Commands: /pairwatch off, /pairwatch pause <secs>`
							: "Pair watch off. Commands: /pairwatch on, /pairwatch pause <secs> (default 30)",
						"info",
					);
					return;
				default:
					ctx.ui.notify("Usage: /pairwatch on | off | pause <secs>", "warning");
					return;
			}
		},
	});
}