/**
 * Tool Guidance extension - experimental
 *
 * Adds "prefer the dedicated tool over bash" guidelines for the grep, find,
 * and ls tools, mirroring the built-in read/write lines ("Use read to examine
 * files instead of cat or sed"). Those three ship with `guidelines: []`, so
 * without this nothing steers the model away from bash `grep`/`rg`,
 * `find`/`fd`, and `ls` - which is exactly the underuse surfaced by the
 * session review (grep 3.7x, ls 5.9x, find 7.5x more often via bash).
 *
 * This is an experimental local stopgap while the one-line additions are
 * proposed upstream for the built-in tool definitions.
 *
 * Implementation note: this patches the Guidelines section through the
 * mutable `systemPromptOptions` of `before_agent_start` instead of
 * re-registering the tools. Re-registering a tool with a built-in name
 * replaces its definition wholesale, which would clobber another extension's
 * `execute` (e.g. ssh's remote-routed grep/find/ls). Mutating prompt
 * metadata composes with those extensions.
 *
 * Guidelines are keyed by tool name and only rendered when the tool is in
 * the active selectedTools, so adding all three unconditionally is safe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDELINES: Record<string, string[]> = {
	grep: [
		"Use grep instead of bash grep or rg — it respects .gitignore and returns line numbers.",
	],
	find: ["Use find instead of bash find or fd — it respects .gitignore."],
	ls: ["Use ls instead of bash ls."],
};

export default function toolGuidanceExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const { toolGuidelines } = event.systemPromptOptions;
		for (const [name, lines] of Object.entries(GUIDELINES)) {
			toolGuidelines[name] = [...(toolGuidelines[name] ?? []), ...lines];
		}
	});
}
