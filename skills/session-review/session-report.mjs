#!/usr/bin/env node
/**
 * session-report.mjs — normalize Pi session logs into a loose JSONL stream.
 *
 * Reads Pi's v3 session JSONL, joins each tool call with its result, and
 * prints one JSON object per tool call. It deliberately does no aggregation
 * beyond a few filters: pipe the output into `jq` (or anything else) to slice
 * it however the current question needs.
 *
 * Output fields (loose — extra fields may be added; ignore what you don't use):
 *   ts       ISO timestamp of the assistant message that requested the call
 *   session  session id
 *   project  working directory the session ran in
 *   tool     tool name
 *   ok       true | false | null (null = no result was recorded)
 *   bytes    byte length of the result content (null when there was no result)
 *   msg      per-file assistant-message index; calls sharing a msg ran together
 *   err      short error text, only when ok === false
 *   args     tool arguments, only with --args (long strings clipped)
 *   details  result details, only with --details (long strings clipped)
 *
 * It fails loudly rather than guessing: invalid JSON, a non-v3 header, a
 * malformed assistant message/tool call, or a result for an unknown call id
 * abort with a `file:line` message and a non-zero exit. Unknown entry types
 * and unknown fields are ignored.
 */

import { closeSync, createReadStream, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const SESSION_VERSION = 3;
const DEFAULT_ARG_BYTES = 200;
const ERR_MAX_CHARS = 200;

class Fail extends Error {}

const USAGE = `Usage: session-report.mjs [options]

Normalize Pi session logs into JSONL (one object per tool call). Filtering is
built in; aggregation is left to jq.

Options:
  --dir <path>        session directory (default: $PI_CODING_AGENT_SESSION_DIR,
                      else ~/.local/state/pi/sessions, else ~/.pi/agent/sessions)
  --since <when>      only calls at/after <when>: 30d, 12h, 2w, or an ISO date
  --tool <a,b>        only these tool names (comma-separated)
  --project <path>    only sessions in this directory or below it
  --session <id>      only this session id (exact or prefix)
  --errors-only       only calls whose result reported an error
  --args              include tool arguments (long strings clipped)
  --details           include result details (long strings clipped)
  --arg-bytes <n>     clip strings longer than n chars (default ${DEFAULT_ARG_BYTES})
  --allow-dangling    tolerate results whose call was never seen
  -h, --help          show this help
`;

function parseSince(value) {
  const relative = /^(\d+)([dhw])$/.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[relative[2]];
    return new Date(Date.now() - amount * unit);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Fail(`invalid --since value: ${value} (use 30d, 12h, 2w, or an ISO date)`);
  }
  return date;
}

function parseArgs(argv) {
  const opts = {
    dir: undefined,
    since: undefined,
    tools: undefined,
    project: undefined,
    session: undefined,
    errorsOnly: false,
    includeArgs: false,
    includeDetails: false,
    argBytes: DEFAULT_ARG_BYTES,
    allowDangling: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Fail(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "--dir": opts.dir = value(); break;
      case "--since": opts.since = parseSince(value()); break;
      case "--tool": opts.tools = new Set(value().split(",").map((name) => name.trim()).filter(Boolean)); break;
      case "--project": opts.project = resolve(value()); break;
      case "--session": opts.session = value(); break;
      case "--errors-only": opts.errorsOnly = true; break;
      case "--args": opts.includeArgs = true; break;
      case "--details": opts.includeDetails = true; break;
      case "--arg-bytes": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0) throw new Fail("--arg-bytes must be a non-negative number");
        opts.argBytes = Math.floor(n);
        break;
      }
      case "--allow-dangling": opts.allowDangling = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Fail(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function resolveSessionDir(explicit) {
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Fail(`session dir not found: ${path}`);
    return path;
  }
  const candidates = [
    process.env.PI_CODING_AGENT_SESSION_DIR,
    join(homedir(), ".local/state/pi/sessions"),
    join(homedir(), ".pi/agent/sessions"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Fail(`no session dir found (tried ${candidates.join(", ")}); pass --dir`);
}

/** Whether the file ends in a newline — a partial trailing line means a live writer. */
function endsWithNewline(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buffer = Buffer.alloc(1);
    readSync(fd, buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Recursively clip long strings so args/details stay bounded without changing shape. */
function clipStrings(value, max) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((item) => clipStrings(item, max));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clipStrings(item, max);
    return out;
  }
  return value;
}

function passes(record, opts) {
  if (opts.tools && !opts.tools.has(record.tool)) return false;
  if (opts.errorsOnly && record.ok !== false) return false;
  if (opts.session) {
    const session = record.session ?? "";
    if (session !== opts.session && !session.startsWith(opts.session)) return false;
  }
  if (opts.project) {
    const project = record.project ?? "";
    if (project !== opts.project && !project.startsWith(opts.project + sep)) return false;
  }
  if (opts.since) {
    if (!record.ts || new Date(record.ts).getTime() < opts.since.getTime()) return false;
  }
  return true;
}

async function processFile(file, opts, out) {
  const trailingComplete = endsWithNewline(file);
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });

  let lineNo = 0;
  let headerSeen = false;
  let sessionId;
  let project;
  let msgIndex = 0;
  const seenCalls = new Set();
  const calls = new Map();
  const order = [];

  for await (const line of lines) {
    lineNo += 1;
    if (line.trim() === "") continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      const hint = trailingComplete ? "" : " (file does not end with a newline; a session may still be writing it)";
      throw new Fail(`${file}:${lineNo}: invalid JSON: ${error.message}${hint}`);
    }

    if (!headerSeen) {
      if (entry?.type !== "session") {
        throw new Fail(`${file}:${lineNo}: expected a session header first, got type "${entry?.type}"`);
      }
      if (entry.version !== SESSION_VERSION) {
        throw new Fail(`${file}:${lineNo}: unsupported session version ${entry.version} (expected ${SESSION_VERSION})`);
      }
      sessionId = typeof entry.id === "string" ? entry.id : basename(file);
      project = typeof entry.cwd === "string" ? entry.cwd : undefined;
      headerSeen = true;
      continue;
    }

    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        throw new Fail(`${file}:${lineNo}: assistant message content is not an array`);
      }
      msgIndex += 1;
      const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      for (const block of message.content) {
        if (!block || block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          throw new Fail(`${file}:${lineNo}: malformed toolCall (missing string id or name)`);
        }
        if (seenCalls.has(block.id)) {
          throw new Fail(`${file}:${lineNo}: duplicate toolCall id ${block.id}`);
        }
        seenCalls.add(block.id);
        const record = {
          ...(ts !== undefined ? { ts } : {}),
          session: sessionId,
          project,
          tool: block.name,
          ok: null,
          bytes: null,
          msg: msgIndex,
        };
        if (opts.includeArgs && block.arguments !== undefined) {
          record.args = clipStrings(block.arguments, opts.argBytes);
        }
        calls.set(block.id, record);
        order.push(record);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string") {
        throw new Fail(`${file}:${lineNo}: toolResult is missing a string toolCallId`);
      }
      if (!seenCalls.has(id)) {
        if (opts.allowDangling) continue;
        throw new Fail(`${file}:${lineNo}: toolResult references unknown toolCallId ${id}`);
      }
      const record = calls.get(id);
      record.ok = message.isError === true ? false : true;
      record.bytes = Buffer.byteLength(JSON.stringify(message.content ?? []), "utf8");
      if (record.ok === false && Array.isArray(message.content)) {
        const text = message.content.find((block) => block && block.type === "text")?.text;
        if (typeof text === "string" && text.trim()) {
          record.err = text.replace(/\s+/g, " ").trim().slice(0, ERR_MAX_CHARS);
        }
      }
      if (opts.includeDetails && message.details !== undefined) {
        record.details = clipStrings(message.details, opts.argBytes);
      }
    }
  }

  if (!headerSeen) throw new Fail(`${file}: missing session header`);

  for (const record of order) {
    if (passes(record, opts)) out.write(`${JSON.stringify(record)}\n`);
  }
}

async function main() {
  // Piping into `head`/`jq` closes stdout early; that is a normal exit, not a crash.
  process.stdout.on("error", (error) => {
    if (error && error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const dir = resolveSessionDir(opts.dir);
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  if (files.length === 0) throw new Fail(`no .jsonl session files in ${dir}`);
  for (const file of files) {
    await processFile(join(dir, file), opts, process.stdout);
  }
}

main().catch((error) => {
  process.stderr.write(`session-report: ${error instanceof Fail ? error.message : (error?.stack ?? String(error))}\n`);
  process.exit(2);
});
