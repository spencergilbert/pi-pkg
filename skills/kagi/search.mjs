#!/usr/bin/env node
/**
 * Kagi Universal Search API — POST https://kagi.com/api/v1/search
 *
 * Usage:
 *   node search.mjs <query> [-n <num>] [--time <period>]
 *
 * Options:
 *   -n <num>         Limit results (default: 10, max: 1024)
 *   --time <period>  Time filter: day | week | month
 *
 * The API serializes the response as markdown (format: "markdown"); we pass
 * it through to stdout as-is. JSON is only parsed for error responses.
 *
 * Environment:
 *   KAGI_API_KEY     Required. Kagi API token.
 *                    Get one at https://kagi.com/settings?p=api
 *
 * Examples:
 *   node search.mjs "javascript async await"
 *   node search.mjs "rust news" -n 5 --time week
 */

const args = process.argv.slice(2);

const API_URL = process.env.KAGI_API_URL ?? "https://kagi.com/api/v1/search";

function usage() {
	console.log(`Usage: search.mjs <query> [-n <num>] [--time <period>]

Options:
  -n <num>         Limit results (default: 10, max: 1024)
  --time <period>  Time filter: day | week | month

Environment:
  KAGI_API_KEY     Required. Kagi API token.
                   Get one at https://kagi.com/settings?p=api`);
}

function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

// --- argument parsing ---

const queryParts = [];
let limit = null;
let timeRelative = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-n") {
		const value = args[i + 1];
		if (value === undefined || value.startsWith("-")) fail("Error: expected a number after -n");
		limit = parseInt(value, 10);
		i++;
	} else if (a === "--time") {
		const value = args[i + 1];
		if (value === undefined || value.startsWith("-")) fail("Error: expected day, week, or month after --time");
		if (!["day", "week", "month"].includes(value)) fail(`Error: --time must be day, week, or month (got "${value}")`);
		timeRelative = value;
		i++;
	} else if (a.startsWith("-")) {
		fail(`Error: unknown flag ${a}\n\nRun without arguments to see usage.`);
	} else {
		queryParts.push(a);
	}
}

const query = queryParts.join(" ");
if (!query) {
	usage();
	process.exit(1);
}

const apiKey = process.env.KAGI_API_KEY;
if (!apiKey) {
	fail("Error: KAGI_API_KEY environment variable is required.\nGet your API token at: https://kagi.com/settings?p=api");
}

// --- call the API ---

const body = { query, format: "markdown" };
if (limit !== null) body.limit = limit;
if (timeRelative) body.lens = { time_relative: timeRelative };

const response = await fetch(API_URL, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	},
	body: JSON.stringify(body),
});

const text = await response.text();

if (!response.ok) {
	let detail = text;
	try {
		const err = JSON.parse(text);
		if (Array.isArray(err.error)) {
			detail = err.error
				.map((e) => `  ${e.code}: ${e.message ?? "(no message)"}${e.location ? ` @ ${e.location}` : ""}`)
				.join("\n");
		}
	} catch {
		// keep raw text
	}
	fail(`Error: HTTP ${response.status} ${response.statusText}\n${detail}`);
}

process.stdout.write(text);
