/**
 * Shared helpers for Kagi API scripts.
 *
 * Environment:
 *   KAGI_API_KEY  Kagi API key (required), from https://kagi.com/settings?p=api
 *   KAGI_API_URL  Override the API base URL (for testing)
 */

const API_BASE = process.env.KAGI_API_URL ?? "https://kagi.com/api/v1";

export function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

/**
 * Read the Kagi API key from the environment.
 */
export function resolveApiKey() {
	const key = process.env.KAGI_API_KEY;
	if (!key) {
		fail(
			"Error: KAGI_API_KEY environment variable is required.\n" +
			"Create a key at https://kagi.com/settings?p=api, then: \"export KAGI_API_KEY=...\"",
		);
	}
	return key;
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
