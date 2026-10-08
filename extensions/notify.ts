/**
 * Notify extension
 *
 * Sends a native terminal notification via OSC 777 when Pi is done and
 * waiting for input. Works in Ghostty, iTerm2, WezTerm, and rxvt-unicode.
 *
 * Pi's own OSC 7501 program status (1.1.0+) reports state to terminals that
 * support that protocol; Ghostty does not, so this stays the only thing that
 * raises a notification here.
 *
 * Derived from [mitsuhiko/agent-stuff
 * `extensions/notify.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts)
 * (Apache-2.0) — simplified to OSC 777 only; also mirrored in pi's examples.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// `agent_end` fires after each low-level run, so it can notify while Pi is
	// still retrying, compacting, or working through queued follow-ups.
	// `agent_settled` is the final, notification-only boundary.
	pi.on("agent_settled", async () => {
		process.stdout.write("\x1b]777;notify;Pi;Ready for input\x07");
	});
}
