/**
 * Tool Guidance extension - experimental
 *
 * Steers file work to the dedicated tools at both surfaces of the system
 * prompt that describe tools, rather than only adding rules:
 *
 *   1. `toolSnippets.bash` - the built-in one-liner reads "Execute bash
 *      commands (ls, grep, find, etc.)", which advertises exactly the three
 *      operations that have dedicated tools. Replaced (guarded, loudly) with
 *      the shell's actual lane.
 *   2. `toolGuidelines` - a positive routing rule on `bash` and `powershell`,
 *      plus the missing preference lines for grep/find/ls.
 *
 * The dedicated tools ship `guidelines: []` for grep/find/ls while `read`
 * carries "Use read to examine files instead of cat or sed"; without the
 * preference lines nothing steers the model away from bash equivalents
 * (session review: grep 34.7x, ls 12.1x, find 13.8x more often via bash).
 *
 * This is an experimental local stopgap while the equivalent one-line changes
 * are proposed upstream for the built-in tool definitions and prompt.
 *
 * Implementation note: this patches prompt metadata through the mutable
 * `systemPromptOptions` of `before_agent_start` instead of re-registering the
 * tools. Re-registering a tool with a built-in name replaces its definition
 * wholesale, which would clobber another extension's `execute` (e.g. an
 * extension routing grep/find/ls to a remote host). Mutating prompt metadata
 * composes with those extensions. `normalizeBuildSystemPromptOptions` rebuilds
 * both maps per `before_agent_start`, so neither can accumulate across turns.
 *
 * Guidelines and snippets are keyed by tool name and only rendered when the
 * tool is in the active selectedTools, so contributing all five lines
 * unconditionally is safe. `powershell`'s built-in snippet carries no
 * ls/find/grep lure, so only its guideline is contributed, never its snippet.
 *
 * Drift is loud on purpose: the snippet swap is guarded by an exact match
 * against the built-in text, is idempotent when the swap is already present,
 * and throws on anything else, so the overlay cannot rot into a silent no-op.
 * Guidelines are applied first, then the error is raised - pi reports handler
 * errors and continues, so the prompt still builds with everything except the
 * snippet swap.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Built-in `bash` snippet text, verbatim (pi 0.87.1). Guards the overlay. */
const BASH_SNIPPET_BUILT_IN = "Execute bash commands (ls, grep, find, etc.)";

const BASH_SNIPPET_REPLACEMENT = "Execute bash commands (git, npm, builds, etc.)";

const GUIDELINES: Record<string, string[]> = {
	grep: [
		"Use grep instead of bash grep or rg — it respects .gitignore and returns line numbers.",
	],
	find: ["Use find instead of bash find or fd — it respects .gitignore."],
	ls: ["Use ls instead of bash ls."],
	bash: [
		"Use bash for git, builds, installs, and shell pipelines; for file work (reading, listing, searching, changing files) call the dedicated tools as their own tool calls.",
	],
	powershell: [
		"Use PowerShell for git, builds, installs, and shell pipelines; for file work (reading, listing, searching, changing files) call the dedicated tools as their own tool calls.",
	],
};

export default function toolGuidanceExtension(pi: ExtensionAPI) {
	// One report per process: before_agent_start runs every turn, and an error
	// on each of them is noise that trains the reader to ignore it. /reload
	// re-runs extension setup and re-arms the report.
	let driftReported = false;

	pi.on("before_agent_start", (event) => {
		const { toolSnippets, toolGuidelines } = event.systemPromptOptions;

		for (const [name, lines] of Object.entries(GUIDELINES)) {
			toolGuidelines[name] = [...(toolGuidelines[name] ?? []), ...lines];
		}

		const current = toolSnippets.bash;
		if (current === BASH_SNIPPET_BUILT_IN) {
			toolSnippets.bash = BASH_SNIPPET_REPLACEMENT;
			return;
		}
		// Idempotent: another copy of this overlay already applied (two loaded
		// checkouts of pi-pkg, or a re-registered handler) is not drift.
		if (current === BASH_SNIPPET_REPLACEMENT) return;

		if (!driftReported) {
			driftReported = true;
			throw new Error(
				`tool-guidance: built-in bash snippet is not the expected text (expected ${JSON.stringify(
					BASH_SNIPPET_BUILT_IN,
				)}, found ${
					current === undefined ? "no snippet for 'bash'" : JSON.stringify(current)
				}); snippet overlay skipped - update extensions/tool-guidance.ts`,
			);
		}
	});
}
