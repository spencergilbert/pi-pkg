#!/usr/bin/env node
/**
 * Kagi Extract — POST /api/v1/extract
 *
 * Extracts readable markdown content from up to 10 HTTPS URLs in a single call.
 *
 * Usage:
 *   node extract.mjs <url> [<url> ...] [--out <file>] [--force]
 *
 * Options:
 *   --out <file>  Write extracted markdown to a file
 *   --force       Overwrite the output file if it already exists
 *   -h, --help    Show this help
 *
 * Environment:
 *   KAGI_API_KEY_REF  1Password reference, e.g. op://My 1Password/Kagi API/api_key
 */

import { existsSync, writeFileSync } from "node:fs";
import { fail, kagiFetch } from "./lib.mjs";

const MAX_URLS = 10;

function usage() {
	console.log(`Usage: extract.mjs <url> [<url> ...] [--out <file>] [--force]

Options:
  --out <file>  Write extracted markdown to a file
  --force       Overwrite the output file if it already exists
  -h, --help    Show this help

Environment:
  KAGI_API_KEY_REF  1Password reference, e.g. op://My 1Password/Kagi API/api_key`);
}

const args = process.argv.slice(2);

// --- argument parsing ---

const urls = [];
let outFile = null;
let force = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-h" || a === "--help") {
		usage();
		process.exit(0);
	} else if (a === "--out") {
		const value = args[++i];
		if (value === undefined || value.startsWith("--")) fail("Error: expected a value after --out");
		outFile = value;
	} else if (a === "--force") {
		force = true;
	} else if (a.startsWith("-") && a !== "-") {
		fail(`Error: unknown flag ${a}\n\nRun with --help to see usage.`);
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

// --- validate URLs ---

for (const url of urls) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		fail(`Error: invalid URL: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		fail(`Error: URL must use HTTPS (got ${parsed.protocol}): ${url}`);
	}
	if (parsed.username || parsed.password) {
		fail(`Error: URLs must not contain embedded credentials: ${url}`);
	}
}

// --- overwrite protection ---

if (outFile && existsSync(outFile) && !force) {
	fail(`Error: ${outFile} already exists. Use --force to overwrite.`);
}

// --- call the API ---

const text = await kagiFetch("/extract", {
	pages: urls.map((url) => ({ url })),
	format: "markdown",
}, 60_000);

if (outFile) {
	writeFileSync(outFile, text, "utf-8");
	process.stderr.write(`[Saved to ${outFile}]\n`);
}
process.stdout.write(text);
