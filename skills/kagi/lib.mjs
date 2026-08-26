/**
 * Shared helpers for Kagi API scripts.
 *
 * Environment:
 *   KAGI_API_KEY_REF  1Password reference for the API key,
 *                     e.g. op://My 1Password/Kagi API/api_key
 *   KAGI_API_URL      Override the API base URL (for testing)
 */

import { execFileSync } from "node:child_process";

const API_BASE = process.env.KAGI_API_URL ?? "https://kagi.com/api/v1";

export function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

/**
 * Resolve the Kagi API key from a 1Password reference.
 * KAGI_API_KEY_REF must be set to an op:// reference.
 */
export function resolveApiKey() {
	const ref = process.env.KAGI_API_KEY_REF;
	if (!ref) {
		fail(
			"Error: KAGI_API_KEY_REF environment variable is required.\n" +
			"Set it to a 1Password reference, e.g.:\n" +
			"  export KAGI_API_KEY_REF='op://My 1Password/Kagi API/api_key'",
		);
	}

	try {
		const key = execFileSync("op", ["read", ref], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
		if (!key) {
			fail("Error: op read returned an empty value");
		}
		return key;
	} catch (err) {
		if (err.code === "ENOENT") {
			fail("Error: 'op' not found on PATH. Install 1Password CLI: https://developer.1password.com/docs/cli/");
		}
		if (err.killed) {
			fail("Error: timed out waiting for 'op read' (is 1Password signed in? try 'op account status')");
		}
		fail(`Error: failed to resolve API key from 1Password:\n  ${err.stderr?.trim() ?? err.message}`);
	}
}

/**
 * POST to a Kagi API endpoint with auth, timeout, and error handling.
 * Returns the response body as a string (markdown).
 */
export async function kagiFetch(path, body, timeoutMs = 30_000) {
	const apiKey = resolveApiKey();
	const url = `${API_BASE}${path}`;

	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (err.name === "TimeoutError" || err.name === "AbortError") {
			fail(`Error: request timed out after ${timeoutMs / 1000}s`);
		}
		fail(`Error: network failure: ${err.message}`);
	}

	const text = await response.text();

	if (!response.ok) {
		let detail = text;
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed.error)) {
				detail = parsed.error
					.map((e) => `  ${e.code}: ${e.message ?? "(no message)"}${e.location ? ` @ ${e.location}` : ""}`)
					.join("\n");
			}
		} catch {
			// not JSON — keep raw text
		}
		fail(`Error: HTTP ${response.status} ${response.statusText}\n${detail}`);
	}

	return text;
}
