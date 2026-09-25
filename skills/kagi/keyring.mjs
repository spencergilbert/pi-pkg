/**
 * OS keyring access for the Kagi API key.
 *
 * Read-only. Storing the key is the user's responsibility — see README.md in
 * this directory for the per-platform setup commands.
 *
 *   Linux  secret-tool lookup service kagi key api_key   (libsecret)
 *   macOS  security find-generic-password -s kagi -a api_key -w
 *
 * Lookup coordinates are identical on both platforms: service "kagi",
 * account "api_key".
 */

import { execFileSync } from "node:child_process";

const SERVICE = "kagi";
const ACCOUNT = "api_key";
const TIMEOUT_MS = 10_000;

const SETUP_HINT =
	`Store the key in the OS keyring as service="${SERVICE}", account="${ACCOUNT}" — ` +
	"see README.md next to this script for the exact command on your platform.";

const BACKENDS = {
	linux: {
		command: "secret-tool",
		args: ["lookup", "service", SERVICE, "key", ACCOUNT],
		notFoundStatus: 1,
		provider: "libsecret is not available",
	},
	darwin: {
		command: "security",
		args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
		notFoundStatus: 44,
		provider: "the macOS Keychain is not available",
	},
};

/**
 * Read the Kagi API key from the OS keyring.
 * Throws an Error whose message is safe to print verbatim.
 */
export function keyringGet() {
	const backend = BACKENDS[process.platform];
	if (!backend) {
		throw new Error(
			`no OS keyring backend for platform "${process.platform}" (supported: linux, darwin).\n${SETUP_HINT}`,
		);
	}

	let stdout;
	try {
		stdout = execFileSync(backend.command, backend.args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: TIMEOUT_MS,
		});
	} catch (err) {
		throw new Error(describeFailure(err, backend));
	}

	const key = stdout.trim();
	if (!key) {
		throw new Error(`the keyring entry is empty.\n${SETUP_HINT}`);
	}
	return key;
}

function describeFailure(err, backend) {
	if (err.code === "ENOENT") {
		return `${backend.command} was not found on PATH — ${backend.provider}.\n${SETUP_HINT}`;
	}

	const stderr = String(err.stderr ?? "").trim();

	if (err.killed || err.signal) {
		const promptHint =
			process.platform === "darwin"
				? "\nOn macOS a Keychain access prompt may be waiting — approve it once with \"Always Allow\"."
				: "\nThe login keyring is probably locked, and no unlock prompt is reachable from this process.";
		return (
			`timed out after ${TIMEOUT_MS / 1000}s reading from ${backend.command}.${promptHint}\n` +
			"See the Troubleshooting section of README.md next to this script."
		);
	}

	if (/dbus|autolaunch|display|could not connect|cannot connect/i.test(stderr)) {
		return (
			"could not reach the OS keyring session bus — expected over SSH, in a container, or without a desktop session.\n" +
			"See the Troubleshooting section of README.md next to this script."
		);
	}

	if (err.status === backend.notFoundStatus && !stderr) {
		return `no Kagi API key in the OS keyring.\n${SETUP_HINT}`;
	}

	const detail = stderr ? `\n  ${stderr.split("\n").join("\n  ")}` : "";
	return (
		`failed to read from the OS keyring (${backend.command} exited ${err.status ?? "?"}).${detail}\n` +
		SETUP_HINT
	);
}
