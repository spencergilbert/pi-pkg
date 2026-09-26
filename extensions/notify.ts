/**
 * Notify extension
 *
 * Sends a native terminal notification via OSC 777 when Pi is done and
 * waiting for input. Works in Ghostty, iTerm2, WezTerm, and rxvt-unicode.
 *
 * Derived from [mitsuhiko/agent-stuff
 * `extensions/notify.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts)
 * (Apache-2.0) — simplified to OSC 777 only; also mirrored in pi's examples.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		process.stdout.write("\x1b]777;notify;Pi;Ready for input\x07");
	});
}
