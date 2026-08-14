#!/usr/bin/env node
/**
 * Kagi Extract API — POST https://kagi.com/api/v1/extract
 *
 * Extracts readable markdown content from up to 10 HTTPS URLs in a single call.
 *
 * Usage:
 *   node extract.mjs <url> [<url> ...] [--out <file>]
 *
 * Options:
 *   --out <file>  Write extracted markdown to a file
 *
 * The API serializes the response as markdown (format: "markdown"); we pass
 * it through to stdout as-is. JSON is only parsed for error responses.
 *
 * Environment:
 *   KAGI_API_KEY  Required. Kagi API token.
 *                 Get one at https://kagi.com/settings?p=api
 *
 * Examples:
 *   node extract.mjs https://example.com/article
 *   node extract.mjs https://a.com https://b.com
 *   node extract.mjs https://a.com --out article.md
 */

const args = process.argv.slice(2);

const API_URL = process.env.KAGI_API_URL ?? "https://kagi.com/api/v1/extract";
const MAX_URLS = 10;

function usage() {
	console.log(`Usage: extract.mjs <url> [<url> ...] [--out <file>]

Options:
  --out <file>  Write extracted markdown to a file

Environment:
  KAGI_API_KEY  Required. Kagi API token.
                Get one at https://kagi.com/settings?p=api`);
}

function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

// --- argument parsing ---

const urls = [];
let outFile = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--out") {
		const value = args[i + 1];
		if (value === undefined || value.startsWith("--")) fail("Error: expected a value after --out");
		outFile = value;
		i++;
	} else if (a.startsWith("--")) {
		fail(`Error: unknown flag ${a}\n\nRun without arguments to see usage.`);
	} else {
		urls.push(a);
	}
}

if (urls.length === 0) {
	usage();
	process.exit(1);
}

if (urls.length > MAX_URLS) {
	fail(`Error: at most ${MAX_URLS} URLs per request, got ${urls.length}.`);
}

for (const url of urls) {
	if (!/^https:\/\//i.test(url)) {
		fail(`Error: URL must be a valid HTTPS URL: ${url}`);
	}
}

const apiKey = process.env.KAGI_API_KEY;
if (!apiKey) {
	fail("Error: KAGI_API_KEY environment variable is required.\nGet your API token at: https://kagi.com/settings?p=api");
}

// --- call the API ---

const response = await fetch(API_URL, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	},
	body: JSON.stringify({
		pages: urls.map((url) => ({ url })),
		format: "markdown",
	}),
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

if (outFile) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(outFile, text, "utf-8");
	process.stdout.write(text);
	console.log(`\n[Saved to ${outFile}]`);
} else {
	process.stdout.write(text);
}
