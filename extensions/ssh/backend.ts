import { spawn } from "node:child_process";
import path from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepToolDetails,
  GrepToolInput,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
/** Identifies a remote target. */
export interface RemoteTarget {
  /** Unique identifier for this target. */
  id: string;
  /** Human-readable label for status display. */
  label: string;
  /** Working directory on the remote host. */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * op-ssh-sign (1Password's git ssh signer) only uses the forwarded SSH agent
 * socket when BOTH SSH_AUTH_SOCK and SSH_TTY are set. sshd only sets SSH_TTY
 * when a pty is allocated; our tool calls never allocate one, so export a
 * placeholder. (Preserves a real SSH_TTY if one exists.)
 */
const SSH_TTY_SETUP = "export SSH_TTY=${SSH_TTY:-/dev/pts/0}; ";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Reject host strings that look like ssh option flags. */
function assertSafeRemote(remote: string): void {
  if (remote.startsWith("-")) {
    throw new Error(
      `Refusing ambiguous SSH target "${remote}" (looks like an option flag).`
    );
  }
}

function sshExec(
  host: string,
  command: string,
  options?: {
    stdin?: string | Buffer;
    signal?: AbortSignal;
    onData?: (data: Buffer) => void;
    timeoutSeconds?: number;
  }
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  assertSafeRemote(host);

  return new Promise((resolve, reject) => {
    // Forward the local SSH agent (-A) so git commit signing works on the
    // remote using the local agent (e.g. 1Password running on the laptop).
    const sshArgs = ["-A", host, `${SSH_TTY_SETUP}${command}`];
    const child = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer =
      typeof options?.timeoutSeconds === "number" && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // Escalate to SIGKILL if the process doesn't exit promptly
            setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 3000);
          }, options.timeoutSeconds * 1000)
        : undefined;

    const onAbort = () => child.kill();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
      options?.onData?.(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
      options?.onData?.(data);
    });
    child.on("error", (err) => {
      settle(() => {
        cleanup();
        reject(err);
      });
    });
    child.on("close", (code) => {
      settle(() => {
        cleanup();
        if (options?.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${options?.timeoutSeconds}`));
          return;
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      });
    });

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Swallow EPIPE if the remote side closes stdin early (exit code /
    // stderr will still surface the real error).
    child.stdin.on("error", () => {});
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function sshOk(
  host: string,
  command: string,
  options?: {
    stdin?: string | Buffer;
    signal?: AbortSignal;
    timeoutSeconds?: number;
  }
): Promise<Buffer> {
  const { stdout, stderr, exitCode } = await sshExec(host, command, options);
  if (exitCode !== 0) {
    const errText =
      stderr.toString("utf8").trim() ||
      stdout.toString("utf8").trim() ||
      "unknown ssh error";
    throw new Error(`SSH failed (${exitCode}): ${errText}`);
  }
  return stdout;
}

function inferImageMimeType(p: string): string | null {
  const ext = p.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "tiff":
      return "image/tiff";
    default:
      return null;
  }
}

/** GNU find is required for -printf. */
function listDirCommand(dir: string): string {
  return `find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

/** Match a glob against a relative path (mirrors pi/gondolin find semantics). */
function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = toPosix(pattern);
  if (normalized.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalized) ||
      path.posix.matchesGlob(relativePath, `**/${normalized}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalized);
}

/** Resolve a possibly-relative remote path against the remote cwd. */
function resolveRemotePath(cwd: string, inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return cwd;
  return path.posix.isAbsolute(trimmed)
    ? trimmed
    : path.posix.join(cwd, trimmed);
}

// ---------------------------------------------------------------------------
// Grep execution (single remote rg/grep invocation)
// ---------------------------------------------------------------------------

const GREP_DEFAULT_LIMIT = 100;

type GrepResult = {
  content: Array<{ type: "text"; text: string }>;
  details: GrepToolDetails | undefined;
};

/**
 * Run pi's grep tool over SSH in one round trip: prefer ripgrep on the
 * remote, fall back to GNU grep. Output is capped remotely by line count to
 * bound transfer, then parsed and truncated exactly like pi's local grep.
 */
async function runGrep(
  target: RemoteTarget,
  params: GrepToolInput,
  signal?: AbortSignal
): Promise<GrepResult> {
  const host = target.id.slice(4);
  const root = resolveRemotePath(target.cwd, params.path ?? ".");
  const effectiveLimit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
  const context = params.context && params.context > 0 ? params.context : 0;

  // Enough remote lines for `limit` matches plus their context, with slack.
  const cap = effectiveLimit * (1 + 2 * context) + effectiveLimit;

  const flags = ["--line-number", "--color=never"];
  if (params.ignoreCase) flags.push("--ignore-case");
  if (params.literal) flags.push("--fixed-strings");
  if (context > 0) flags.push("-C", String(context));

  const rgLine = [
    `rg ${flags.join(" ")} --hidden`,
    params.glob ? `--glob ${shellQuote(params.glob)}` : "",
    `-- ${shellQuote(params.pattern)} "$tgt" 2>/dev/null | head -n ${cap}`,
  ]
    .filter(Boolean)
    .join(" ");

  const grepLine = [
    `grep -R -n -I --color=never --binary-files=without-match --exclude-dir=.git`,
    params.ignoreCase ? "-i" : "",
    params.literal ? "-F" : "",
    context > 0 ? `-C ${context}` : "",
    params.glob ? `--include=${shellQuote(params.glob)}` : "",
    `-e ${shellQuote(params.pattern)} "$tgt" 2>/dev/null | head -n ${cap}`,
  ]
    .filter(Boolean)
    .join(" ");

  const script = [
    `if [ ! -e ${shellQuote(root)} ]; then echo 'SSH_GREP_NOT_FOUND' >&2; exit 1; fi`,
    `if [ -d ${shellQuote(root)} ]; then`,
    `  echo '__SSH_GREP_DIR__'`,
    `  cd ${shellQuote(root)} && tgt=.`,
    `else`,
    `  echo '__SSH_GREP_FILE__'`,
    `  tgt=${shellQuote(root)}`,
    `fi`,
    `if command -v rg >/dev/null 2>&1; then`,
    `  ${rgLine}`,
    `elif command -v grep >/dev/null 2>&1; then`,
    `  ${grepLine}`,
    `else`,
    `  echo 'SSH_GREP_UNAVAILABLE' >&2; exit 1`,
    `fi`,
  ].join("\n");

  const { stdout, stderr, exitCode } = await sshExec(host, "exec bash -se", {
    stdin: script,
    signal,
  });

  if (exitCode !== 0) {
    const errText = stderr.toString("utf8").trim();
    if (errText.includes("SSH_GREP_NOT_FOUND")) {
      throw new Error(`Path not found: ${root}`);
    }
    if (errText.includes("SSH_GREP_UNAVAILABLE")) {
      throw new Error("Neither rg nor grep is available on the remote host");
    }
    throw new Error(`SSH grep failed (${exitCode}): ${errText}`);
  }

  const lines = stdout.toString("utf8").split("\n");
  const marker = lines.shift()?.trim();
  const isDir = marker === "__SSH_GREP_DIR__";

  const outputLines: string[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  for (const raw of lines) {
    if (!raw || raw === "--") continue; // block separator from grep/rg
    // Match lines: path:LINE:text ; context lines: path-LINE-text
    const match = /^(.+?):(\d+):(.*)$/.exec(raw);
    const contextMatch = match ? undefined : /^(.+?)-(\d+)-(.*)$/.exec(raw);
    if (!match && !contextMatch) continue;
    const filePath = (match ?? contextMatch)![1];
    const lineNumber = (match ?? contextMatch)![2];
    const text = (match ?? contextMatch)![3].replace(/\r/g, "");
    if (match) {
      if (matchCount >= effectiveLimit) {
        matchLimitReached = true;
        continue;
      }
      matchCount++;
    }

    const relativePath = isDir
      ? toPosix(filePath).replace(/^\.\//, "")
      : path.posix.basename(toPosix(filePath));
    const { text: truncatedText, wasTruncated } = truncateLine(text);
    if (wasTruncated) linesTruncated = true;
    const sep = match ? ":" : "-";
    outputLines.push(
      `${relativePath}${sep}${lineNumber}${sep} ${truncatedText}`
    );
  }

  if (outputLines.length === 0) {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };
  }

  const joined = outputLines.join("\n");
  const truncation = truncateHead(joined, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const notices: string[] = [];
  let output = truncation.content;
  const details: GrepToolDetails = {};

  if (matchLimitReached) {
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
    );
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(
      `Some lines truncated to 500 chars. Use read tool to see full lines`
    );
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

// ---------------------------------------------------------------------------
// SSH Backend
// ---------------------------------------------------------------------------

export const sshBackend = {
  /**
   * Verify the remote host is reachable and the (mirrored) cwd exists.
   * One round trip, bounded by a timeout so an unreachable host cannot hang
   * startup. Throws on failure so callers surface a clear error instead of
   * failing on the first tool call. Returns the verified cwd.
   */
  async probe(target: RemoteTarget): Promise<string> {
    const host = target.id.slice(4);
    const out = await sshOk(
      host,
      `if [ -d ${shellQuote(target.cwd)} ]; then echo SSH_PROBE_OK; else echo SSH_PROBE_MISSING; fi`,
      { timeoutSeconds: 10 }
    );
    if (out.toString("utf8").trim() !== "SSH_PROBE_OK") {
      throw new Error(`remote cwd does not exist on ${host}: ${target.cwd}`);
    }
    return target.cwd;
  },

  createReadOps(target: RemoteTarget): ReadOperations {
    const host = target.id.slice(4);
    return {
      readFile: (absolutePath) => sshOk(host, `cat ${shellQuote(absolutePath)}`),
      access: (absolutePath) =>
        sshOk(host, `test -r ${shellQuote(absolutePath)}`).then(() => {}),
      detectImageMimeType: async (absolutePath) =>
        // Try `file` first, fall back to extension-based inference
        sshOk(host, `file --mime-type -b ${shellQuote(absolutePath)}`)
          .then((r) => {
            const mime = r.toString().trim();
            return [
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "image/svg+xml",
              "image/avif",
              "image/tiff",
            ].includes(mime)
              ? mime
              : null;
          })
          .catch(() => inferImageMimeType(absolutePath)),
    };
  },

  createWriteOps(target: RemoteTarget): WriteOperations {
    const host = target.id.slice(4);
    return {
      writeFile: async (absolutePath, content) => {
        // Atomic write: write to temp file then mv into place
        const tmp = `${absolutePath}.pi-remote-tmp.${process.pid}`;
        await sshOk(
          host,
          `cat > ${shellQuote(tmp)} && mv -f ${shellQuote(tmp)} ${shellQuote(absolutePath)}`,
          { stdin: content }
        );
      },
      mkdir: (dir) => sshOk(host, `mkdir -p ${shellQuote(dir)}`).then(() => {}),
    };
  },

  createEditOps(target: RemoteTarget): EditOperations {
    const r = this.createReadOps(target);
    const w = this.createWriteOps(target);
    return {
      readFile: r.readFile,
      writeFile: w.writeFile,
      access: r.access,
    };
  },

  createBashOps(target: RemoteTarget): BashOperations {
    const host = target.id.slice(4);
    return {
      exec: (command, cwd, { onData, signal, timeout }) =>
        new Promise((resolve, reject) => {
          // cwd is always an absolute path by this point (activation probed
          // and verified the remote cwd).
          const script = `cd ${shellQuote(cwd)}\n${command}\n`;
          sshExec(host, "exec bash -se", {
            stdin: script,
            signal,
            timeoutSeconds: timeout,
            onData,
          })
            .then(({ exitCode }) => resolve({ exitCode }))
            .catch(reject);
        }),
    };
  },

  createLsOps(target: RemoteTarget): LsOperations {
    const host = target.id.slice(4);
    return {
      exists: async (absolutePath) => {
        try {
          await sshOk(host, `test -e ${shellQuote(absolutePath)}`);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (absolutePath) => {
        const kind = (
          await sshOk(
            host,
            `if [ -d ${shellQuote(absolutePath)} ]; then echo dir; elif [ -e ${shellQuote(absolutePath)} ]; then echo file; else exit 1; fi`
          )
        )
          .toString("utf8")
          .trim();
        return { isDirectory: () => kind === "dir" };
      },
      readdir: async (absolutePath) => {
        const out = await sshOk(host, listDirCommand(absolutePath));
        return out
          .toString("utf8")
          .split("\0")
          .filter((e) => e.length > 0);
      },
    };
  },

  createFindOps(target: RemoteTarget): FindOperations {
    const host = target.id.slice(4);
    return {
      exists: async (absolutePath) => {
        try {
          await sshOk(host, `test -e ${shellQuote(absolutePath)}`);
          return true;
        } catch {
          return false;
        }
      },
      glob: async (pattern, searchPath, { ignore, limit }) => {
        const ignoreArgs = [...ignore, "**/node_modules/**", "**/.git/**"]
          .map((g) => `-g '!${g}'`)
          .join(" ");
        // Prefer ripgrep (gitignore-aware, globs incl. **). Fall back to find
        // + JS-side glob matching when rg is missing.
        const script = [
          `cd ${shellQuote(searchPath)} || exit 1`,
          `if command -v rg >/dev/null 2>&1; then`,
          `  rg --files --hidden ${ignoreArgs} -g ${shellQuote(pattern)} | head -n ${limit}`,
          `else`,
          `  find . -type f -not -path './.git/*' -not -path './node_modules/*' | head -n 50000`,
          `fi`,
        ].join("\n");
        const out = await sshOk(host, "exec bash -se", { stdin: script });
        const lines = out
          .toString("utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const results: string[] = [];
        for (const rel of lines) {
          if (results.length >= limit) break;
          const clean = toPosix(rel).replace(/^\.\//, "");
          if (ignore.some((g) => matchesGlob(clean, g))) continue;
          if (!matchesGlob(clean, pattern)) continue;
          results.push(path.posix.join(toPosix(searchPath), clean));
        }
        return results;
      },
    };
  },

  runGrep,
};
