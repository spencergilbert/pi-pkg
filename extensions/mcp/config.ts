/**
 * Configuration loading for the thin MCP client.
 *
 * Four sources are merged in increasing precedence:
 *
 *   1. ~/.config/mcp/mcp.json              (shared, machine-wide)
 *   2. <PI_CODING_AGENT_DIR>/mcp.json      (Pi-specific global)
 *   3. <project>/.mcp.json                 (shared, project)
 *   4. <project>/.pi/mcp.json              (Pi-specific project)
 *
 * Server entries are shallow-merged by field. `settings` objects are
 * shallow-merged too. String values support `${VAR}` (and `${VAR:-default}`)
 * environment interpolation. The effective config is hashed so metadata caches
 * can be invalidated when a server definition changes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type {
  McpConfig,
  McpConfigSource,
  McpServerConfig,
  McpSettings,
  ResolvedServerConfig,
} from "./types";

export const CONFIG_FILE_NAME = "mcp.json";
export const PROJECT_CONFIG_FILE_NAME = ".mcp.json";
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface ConfigSourceSpec {
  id: string;
  path: string;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(expandHome(configured));
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pi");
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function getConfigSourceSpecs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigSourceSpec[] {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [
    { id: "shared-global", path: join(configHome, "mcp", CONFIG_FILE_NAME) },
    { id: "pi-global", path: join(resolveAgentDir(env), CONFIG_FILE_NAME) },
    { id: "shared-project", path: join(cwd, PROJECT_CONFIG_FILE_NAME) },
    { id: "pi-project", path: join(cwd, ".pi", CONFIG_FILE_NAME) },
  ];
}

/** Strip `//` and `/* *\/` comments outside of strings. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonConfig(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function interpolateEnvString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(VAR_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    return fallback ?? "";
  });
}

function interpolateValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return interpolateEnvString(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, env));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolateValue(item, env);
    return out;
  }
  return value;
}

function normalizeSettings(value: unknown): McpSettings {
  if (!isRecord(value)) return {};
  const settings: McpSettings = {};
  const idleTimeoutMs = value.idleTimeoutMs;
  const idleTimeout = value.idleTimeout;
  const requestTimeoutMs = value.requestTimeoutMs;
  if (typeof idleTimeoutMs === "number" && Number.isFinite(idleTimeoutMs)) settings.idleTimeoutMs = idleTimeoutMs;
  if (typeof idleTimeout === "number" && Number.isFinite(idleTimeout)) settings.idleTimeout = idleTimeout;
  if (typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs)) settings.requestTimeoutMs = requestTimeoutMs;
  const outputGuard = value.outputGuard;
  if (outputGuard === false || outputGuard === true) settings.outputGuard = outputGuard;
  else if (isRecord(outputGuard)) {
    const guard: { maxBytes?: number; maxLines?: number } = {};
    if (typeof outputGuard.maxBytes === "number") guard.maxBytes = outputGuard.maxBytes;
    if (typeof outputGuard.maxLines === "number") guard.maxLines = outputGuard.maxLines;
    settings.outputGuard = guard;
  }
  const keyring = value.keyring;
  if (keyring === true || keyring === false || keyring === "auto" || keyring === "file") settings.keyring = keyring;
  return settings;
}

function normalizeServer(value: unknown): McpServerConfig | undefined {
  if (!isRecord(value)) return undefined;
  const server: McpServerConfig = {};
  const strings: (keyof McpServerConfig)[] = ["command", "cwd", "url", "auth", "bearerToken", "bearerTokenEnv"];
  for (const key of strings) {
    const raw = value[key];
    if (typeof raw === "string") (server as Record<string, unknown>)[key] = raw;
  }
  if (typeof value.args === "string") server.args = [value.args];
  else if (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")) server.args = value.args;
  if (isRecord(value.env)) {
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.env)) if (typeof item === "string") env[key] = item;
    server.env = env;
  }
  if (isRecord(value.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.headers)) if (typeof item === "string") headers[key] = item;
    server.headers = headers;
  }
  if (value.oauth === false) server.oauth = false;
  else if (isRecord(value.oauth)) {
    const oauth: Record<string, unknown> = {};
    const oauthStrings = [
      "grantType",
      "clientId",
      "clientSecret",
      "clientMetadataUrl",
      "scope",
      "redirectUri",
      "clientName",
      "clientUri",
      "logoUri",
      "authServerMetadataUrl",
    ] as const;
    for (const key of oauthStrings) if (typeof value.oauth[key] === "string") oauth[key] = value.oauth[key];
    if (value.oauth.skipIssuerMetadataValidation === true) oauth.skipIssuerMetadataValidation = true;
    if (isRecord(value.oauth.authorizationParams)) {
      const params: Record<string, string> = {};
      for (const [key, item] of Object.entries(value.oauth.authorizationParams)) if (typeof item === "string") params[key] = item;
      oauth.authorizationParams = params;
    }
    server.oauth = oauth as McpServerConfig["oauth"];
  }
  for (const key of ["idleTimeoutMs", "idleTimeout", "requestTimeoutMs"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) server[key] = raw;
  }
  if (value.disabled === true) server.disabled = true;
  if (value.debug === true) server.debug = true;
  return server;
}

function readConfigSource(
  path: string,
  env: NodeJS.ProcessEnv,
): { servers: Record<string, McpServerConfig>; settings: McpSettings } | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonConfig(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return undefined;
  const interpolated = interpolateValue(parsed, env) as Record<string, unknown>;
  const rawServers = interpolated.mcpServers ?? interpolated["mcp-servers"];
  const servers: Record<string, McpServerConfig> = {};
  if (isRecord(rawServers)) {
    for (const [name, value] of Object.entries(rawServers)) {
      const server = normalizeServer(value);
      if (server) servers[name] = server;
    }
  }
  return { servers, settings: normalizeSettings(interpolated.settings) };
}

/**
 * Merge a higher-precedence server entry over a lower-precedence one.
 * Credential fields are bound to the transport they were configured for: a
 * transport switch or a URL change drops inherited auth material so secrets
 * are never replayed against a different endpoint.
 */
function mergeServerEntries(base: McpServerConfig, next: McpServerConfig): McpServerConfig {
  const merged: McpServerConfig = { ...base, ...next };
  const switchesToStdio = typeof next.command === "string" && next.url === undefined && typeof base.url === "string";
  if (switchesToStdio) {
    delete merged.url;
    delete merged.headers;
    delete merged.oauth;
    delete merged.bearerToken;
    delete merged.bearerTokenEnv;
  }
  const switchesToHttp = typeof next.url === "string" && next.command === undefined && typeof base.command === "string";
  if (switchesToHttp) {
    delete merged.command;
    delete merged.args;
    delete merged.env;
    delete merged.cwd;
  }
  if (typeof next.url === "string" && next.url !== base.url) {
    delete merged.headers;
    delete merged.oauth;
    delete merged.bearerToken;
  }
  return merged;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function computeConfigHash(
  servers: Record<string, McpServerConfig>,
  settings: McpSettings,
): string {
  const { outputGuard: _outputGuard, keyring: _keyring, ...cacheableSettings } = settings;
  return createHash("sha256")
    .update(stableStringify({ servers, settings: cacheableSettings }))
    .digest("hex");
}

export function loadMcpConfig(options: { cwd: string; env?: NodeJS.ProcessEnv }): McpConfig {
  const env = options.env ?? process.env;
  const specs = getConfigSourceSpecs(options.cwd, env);
  const mcpServers: Record<string, McpServerConfig> = {};
  let settings: McpSettings = {};
  const sources: McpConfigSource[] = [];

  for (const spec of specs) {
    let loaded: { servers: Record<string, McpServerConfig>; settings: McpSettings } | undefined;
    try {
      loaded = readConfigSource(spec.path, env);
    } catch (error) {
      // A broken optional source must not take down every other server.
      sources.push({ id: spec.id, path: spec.path, exists: true, serverCount: 0 });
      void error;
      continue;
    }
    sources.push({
      id: spec.id,
      path: spec.path,
      exists: loaded !== undefined,
      serverCount: loaded ? Object.keys(loaded.servers).length : 0,
    });
    if (!loaded) continue;
    for (const [name, entry] of Object.entries(loaded.servers)) {
      mcpServers[name] = mcpServers[name] ? mergeServerEntries(mcpServers[name], entry) : entry;
    }
    settings = { ...settings, ...loaded.settings };
  }

  return {
    mcpServers,
    settings,
    sources,
    hash: computeConfigHash(mcpServers, settings),
  };
}

export function resolveServerConfig(
  name: string,
  config: McpConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ResolvedServerConfig {
  const env = options.env ?? process.env;
  const entry = config.mcpServers[name];
  if (!entry) throw new Error(`Unknown MCP server "${name}"`);
  if (entry.disabled) throw new Error(`MCP server "${name}" is disabled`);

  const transport = typeof entry.command === "string" && entry.command.trim().length > 0 ? "stdio" : typeof entry.url === "string" && entry.url.trim().length > 0 ? "http" : undefined;
  if (!transport) throw new Error(`MCP server "${name}" has neither "command" nor "url"`);

  let bearerToken = entry.bearerToken;
  if (!bearerToken && entry.bearerTokenEnv) bearerToken = env[entry.bearerTokenEnv];

  const idleMinutes = entry.idleTimeout ?? config.settings.idleTimeout;
  const idleTimeoutMs = entry.idleTimeoutMs ?? (typeof idleMinutes === "number" ? idleMinutes * 60_000 : undefined) ?? config.settings.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const requestTimeoutMs = entry.requestTimeoutMs ?? config.settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    name,
    transport,
    config: entry,
    oauth: entry.oauth === false ? false : entry.oauth,
    bearerToken,
    idleTimeoutMs: idleTimeoutMs > 0 ? idleTimeoutMs : 0,
    requestTimeoutMs: requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export function listServerNames(config: McpConfig): string[] {
  return Object.keys(config.mcpServers).sort((a, b) => a.localeCompare(b));
}
