/**
 * Shared helpers for Kagi API scripts.
 *
 * The API key is read from the OS keyring (service "kagi", account "api_key").
 * It must already be stored by the user.
 *
 * Environment:
 *   KAGI_API_URL  Override the API base URL (for testing)
 */

import { keyringGet } from "./keyring.mjs";

const API_BASE = process.env.KAGI_API_URL ?? "https://kagi.com/api/v1";

export function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

/**
 * Resolve the Kagi API key from the OS keyring.
 */
export function resolveApiKey() {
	try {
		return keyringGet();
	} catch (err) {
		fail(`Error: ${err.message}`);
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
