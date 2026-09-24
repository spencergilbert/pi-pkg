/**
 * Credential storage for OAuth material.
 *
 * Two backends:
 *   - file:    `<agentDir>/mcp-auth.json`, mode 0600, written with
 *              temp-file + fsync + rename and guarded by a per-entry lock.
 *   - keyring: an OS CLI (`secret-tool` on Linux, `security` on macOS).
 *
 * Both backends stamp each entry with the `serverUrl` it was created for.
 * Credentials whose bound URL no longer matches are ignored, so a config
 * change that repoints a server at a different endpoint cannot replay the
 * previous endpoint's tokens.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { StoredOAuthState } from "./types";

const FILE_VERSION = 1;
const FILE_NAME = "mcp-auth.json";
const KEYRING_SERVICE = "pi-mcp";
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export type KeyringPreference = boolean | "auto" | "file";

export interface CredentialBackend {
  readonly kind: "file" | "keyring";
  load(serverName: string): Promise<StoredOAuthState | undefined>;
  save(serverName: string, value: StoredOAuthState): Promise<void>;
  clear(serverName: string): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "wx", mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // `open` mode is masked by umask; force the intended mode before publish.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, path);
    try {
      const dirHandle = await fs.open(dir, "r");
      await dirHandle.sync();
      await dirHandle.close();
    } catch {
      // Directory fsync is best-effort (unsupported on some filesystems).
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await fs.chmod(path, mode).catch(() => undefined);
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: fs.FileHandle | undefined;
  for (;;) {
    try {
      handle = await fs.open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished; retry immediately.
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring MCP credential lock: ${lockPath}`);
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

interface FileShape {
  version: number;
  entries: Record<string, StoredOAuthState>;
}

export class FileCredentialBackend implements CredentialBackend {
  readonly kind = "file" as const;
  private readonly path: string;

  constructor(agentDir: string) {
    this.path = join(agentDir, FILE_NAME);
  }

  private lockPath(serverName: string): string {
    const safe = serverName.replace(/[^A-Za-z0-9._-]/g, "_");
    return `${this.path}.${safe}.lock`;
  }

  private async readFile(): Promise<FileShape> {
    try {
      const text = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as Partial<FileShape>;
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return { version: FILE_VERSION, entries: parsed.entries as Record<string, StoredOAuthState> };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return { version: FILE_VERSION, entries: {} };
  }

  async load(serverName: string): Promise<StoredOAuthState | undefined> {
    const file = await this.readFile();
    return file.entries[serverName];
  }

  async save(serverName: string, value: StoredOAuthState): Promise<void> {
    await withFileLock(this.lockPath(serverName), async () => {
      const file = await this.readFile();
      file.entries[serverName] = value;
      await writeFileAtomic(this.path, JSON.stringify(file, null, 2), 0o600);
    });
  }

  async clear(serverName: string): Promise<void> {
    await withFileLock(this.lockPath(serverName), async () => {
      const file = await this.readFile();
      if (!(serverName in file.entries)) return;
      delete file.entries[serverName];
      await writeFileAtomic(this.path, JSON.stringify(file, null, 2), 0o600);
    });
  }
}

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await run("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

interface KeyringCli {
  tool: "secret-tool" | "security";
}

export class KeyringCredentialBackend implements CredentialBackend {
  readonly kind = "keyring" as const;
  private readonly cli: KeyringCli;

  constructor(cli: KeyringCli) {
    this.cli = cli;
  }

  static async detect(): Promise<KeyringCredentialBackend | undefined> {
    if (process.platform === "darwin" && (await commandExists("security"))) {
      return new KeyringCredentialBackend({ tool: "security" });
    }
    if (process.platform === "linux" && (await commandExists("secret-tool"))) {
      return new KeyringCredentialBackend({ tool: "secret-tool" });
    }
    return undefined;
  }

  async load(serverName: string): Promise<StoredOAuthState | undefined> {
    try {
      const output = this.cli.tool === "secret-tool"
        ? await run("secret-tool", ["lookup", "service", KEYRING_SERVICE, "account", serverName])
        : await run("security", ["find-generic-password", "-a", serverName, "-s", KEYRING_SERVICE, "-w"]);
      const trimmed = output.trim();
      if (!trimmed) return undefined;
      return JSON.parse(trimmed) as StoredOAuthState;
    } catch {
      return undefined;
    }
  }

  async save(serverName: string, value: StoredOAuthState): Promise<void> {
    const payload = JSON.stringify(value);
    if (this.cli.tool === "secret-tool") {
      await run("secret-tool", ["store", "--label", `${KEYRING_SERVICE}:${serverName}`, "service", KEYRING_SERVICE, "account", serverName], payload);
    } else {
      await run("security", ["add-generic-password", "-U", "-a", serverName, "-s", KEYRING_SERVICE, "-w", payload]);
    }
  }

  async clear(serverName: string): Promise<void> {
    try {
      if (this.cli.tool === "secret-tool") {
        await run("secret-tool", ["clear", "service", KEYRING_SERVICE, "account", serverName]);
      } else {
        await run("security", ["delete-generic-password", "-a", serverName, "-s", KEYRING_SERVICE]);
      }
    } catch {
      // Absent entry is not an error.
    }
  }
}

export class CredentialStore {
  private constructor(private readonly backend: CredentialBackend) {}

  static async create(options: {
    agentDir: string;
    keyring?: KeyringPreference;
    env?: NodeJS.ProcessEnv;
  }): Promise<CredentialStore> {
    const env = options.env ?? process.env;
    // The 0600 file backend is the default; the OS keyring CLI is opt-in via
    // settings.keyring or PI_MCP_KEYRING.
    const preference: KeyringPreference = parseKeyringPreference(env.PI_MCP_KEYRING) ?? options.keyring ?? "file";
    if (preference !== "file" && preference !== false) {
      const keyring = await KeyringCredentialBackend.detect();
      if (keyring) return new CredentialStore(keyring);
    }
    return new CredentialStore(new FileCredentialBackend(options.agentDir));
  }

  get backendKind(): "file" | "keyring" {
    return this.backend.kind;
  }

  async load(serverName: string, serverUrl?: string): Promise<StoredOAuthState | undefined> {
    const value = await this.backend.load(serverName);
    if (!value) return undefined;
    if (serverUrl !== undefined && value.serverUrl !== undefined && value.serverUrl !== serverUrl) {
      return undefined;
    }
    return value;
  }

  async save(serverName: string, value: StoredOAuthState, serverUrl?: string): Promise<void> {
    const next = serverUrl !== undefined ? { ...value, serverUrl } : value;
    await this.backend.save(serverName, next);
  }

  async clear(serverName: string): Promise<void> {
    await this.backend.clear(serverName);
  }
}

function parseKeyringPreference(value: string | undefined): KeyringPreference | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "auto") return "auto";
  if (normalized === "0" || normalized === "false" || normalized === "file") return "file";
  return undefined;
}
