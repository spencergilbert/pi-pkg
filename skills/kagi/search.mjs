#!/usr/bin/env node
/**
 * Kagi Search — POST /api/v1/search
 *
 * Usage:
 *   node search.mjs <query> [-n <num>] [--time <period>]
 *
 * Options:
 *   -n <num>         Limit results (1-1024, default: 10)
 *   --time <period>  Time filter: day | week | month
 *   -h, --help       Show this help
 */

import { fail, kagiFetch } from "./lib.mjs";

function usage() {
	console.log(`Usage: search.mjs <query> [-n <num>] [--time <period>]

Options:
  -n <num>         Limit results (1-1024, default: 10)
  --time <period>  Time filter: day | week | month
  -h, --help       Show this help`);
}

const args = process.argv.slice(2);

// --- argument parsing ---

const queryParts = [];
let limit = 10;
let timeRelative = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-h" || a === "--help") {
		usage();
		process.exit(0);
	} else if (a === "-n") {
		const value = args[++i];
		if (value === undefined) fail("Error: expected a number after -n");
		if (!/^\d+$/.test(value)) fail(`Error: -n must be a positive integer (got "${value}")`);
		const n = Number(value);
		if (n < 1 || n > 1024) fail(`Error: -n must be between 1 and 1024 (got ${n})`);
		limit = n;
	} else if (a === "--time") {
		const value = args[++i];
		if (value === undefined) fail("Error: expected day, week, or month after --time");
		if (!["day", "week", "month"].includes(value)) fail(`Error: --time must be day, week, or month (got "${value}")`);
		timeRelative = value;
	} else if (a.startsWith("-") && a !== "-") {
		fail(`Error: unknown flag ${a}\n\nRun with --help to see usage.`);
	} else {
		queryParts.push(a);
	}
}

const query = queryParts.join(" ");
if (!query) {
	usage();
	process.exit(1);
}

// --- call the API ---

const body = { query, limit, format: "markdown" };
if (timeRelative) {
	body.lens = { time_relative: timeRelative };
}

const text = await kagiFetch("/search", body, 30_000);
process.stdout.write(text);
