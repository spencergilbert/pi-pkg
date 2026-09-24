/**
 * Persistent MCP tool-metadata cache.
 *
 * Tool metadata is keyed by server name and validated against the server's
 * config hash, so `search` and `describe` can answer without opening a
 * connection. `connect` refreshes the cache.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { stableStringify } from "./config";
import type { CachedTool, McpConfig, MetadataCache, ResolvedServerConfig, ServerCacheEntry } from "./types";

const CACHE_VERSION = 1;
const CACHE_FILE_NAME = "mcp-cache.json";

export function getMetadataCachePath(agentDir: string): string {
  return join(agentDir, CACHE_FILE_NAME);
}

function emptyCache(): MetadataCache {
  return { version: CACHE_VERSION, servers: {} };
}

export async function loadMetadataCache(agentDir: string): Promise<MetadataCache> {
  try {
    const text = await fs.readFile(getMetadataCachePath(agentDir), "utf8");
    const parsed = JSON.parse(text) as Partial<MetadataCache>;
    if (parsed && parsed.version === CACHE_VERSION && parsed.servers && typeof parsed.servers === "object") {
      return { version: CACHE_VERSION, servers: parsed.servers as Record<string, ServerCacheEntry> };
    }
  } catch {
    // Missing or unreadable cache is simply empty.
  }
  return emptyCache();
}

export async function saveMetadataCache(agentDir: string, cache: MetadataCache): Promise<void> {
  const path = getMetadataCachePath(agentDir);
  await fs.mkdir(agentDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, path);
}

export async function saveServerCache(
  agentDir: string,
  serverName: string,
  entry: ServerCacheEntry,
): Promise<void> {
  const cache = await loadMetadataCache(agentDir);
  cache.version = CACHE_VERSION;
  cache.servers = { ...cache.servers, [serverName]: entry };
  await saveMetadataCache(agentDir, cache);
}

export async function clearServerCache(agentDir: string, serverName: string): Promise<void> {
  const cache = await loadMetadataCache(agentDir);
  if (!(serverName in cache.servers)) return;
  delete cache.servers[serverName];
  await saveMetadataCache(agentDir, cache);
}

/**
 * Identity hash for a server definition. Only fields that can change which
 * tools an endpoint exposes are included; timeouts, debug flags, and secret
 * values are excluded so token rotation does not invalidate cached metadata.
 */
export function computeServerHash(resolved: ResolvedServerConfig): string {
  const { config, oauth } = resolved;
  const identity = {
    transport: resolved.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    url: config.url,
    headers: config.headers,
    auth: config.auth,
    oauth: oauth === false ? false : oauth ? {
      grantType: oauth.grantType,
      clientId: oauth.clientId,
      scope: oauth.scope,
      redirectUri: oauth.redirectUri,
      authServerMetadataUrl: oauth.authServerMetadataUrl,
    } : undefined,
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function isServerCacheValid(entry: ServerCacheEntry | undefined, hash: string): boolean {
  return entry !== undefined && entry.configHash === hash;
}

export function getCachedTools(cache: MetadataCache, serverName: string, hash: string): CachedTool[] | undefined {
  const entry = cache.servers[serverName];
  if (!entry || entry.configHash !== hash) return undefined;
  return entry.tools;
}

export interface SearchHit {
  server: string;
  tool: CachedTool;
  score: number;
  ref: string;
}

export function formatToolRef(server: string, toolName: string): string {
  return `${server}:${toolName}`;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Rank a tool against a query.
 *
 * Ordering: exact name match > name prefix > all query tokens in the name >
 * name token prefixes > description substring > description tokens.
 * Returns `null` when nothing matches.
 */
export function scoreTool(tool: CachedTool, query: string): number | null {
  const name = tool.name.toLowerCase();
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;
  if (name === normalized) return 1000;
  if (name.startsWith(normalized)) return 800 + Math.min(99, normalized.length);

  const queryTokens = tokenize(normalized);
  const nameTokens = tokenize(name);
  if (queryTokens.length > 0) {
    if (queryTokens.every((token) => nameTokens.includes(token))) return 600 + queryTokens.length;
    if (queryTokens.every((token) => nameTokens.some((nameToken) => nameToken.startsWith(token)))) return 500 + queryTokens.length;
  }

  const description = (tool.description ?? "").toLowerCase();
  if (description) {
    if (description.includes(normalized)) return 300;
    if (queryTokens.length > 0 && queryTokens.every((token) => description.includes(token))) return 200 + queryTokens.length;
  }
  return null;
}

export function searchTools(
  cache: MetadataCache,
  query: string,
  options: { server?: string; limit?: number } = {},
): SearchHit[] {
  const limit = options.limit && options.limit > 0 ? options.limit : 12;
  const hits: SearchHit[] = [];
  for (const [server, entry] of Object.entries(cache.servers)) {
    if (options.server && server !== options.server) continue;
    for (const tool of entry.tools) {
      const score = scoreTool(tool, query);
      if (score === null) continue;
      hits.push({ server, tool, score, ref: formatToolRef(server, tool.name) });
    }
  }
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.server !== right.server) return left.server.localeCompare(right.server);
    return left.tool.name.localeCompare(right.tool.name);
  });
  return hits.slice(0, limit);
}

export function findCachedTools(
  cache: MetadataCache,
  toolName: string,
  server?: string,
): Array<{ server: string; tool: CachedTool }> {
  const matches: Array<{ server: string; tool: CachedTool }> = [];
  for (const [name, entry] of Object.entries(cache.servers)) {
    if (server && name !== server) continue;
    for (const tool of entry.tools) {
      if (tool.name === toolName) matches.push({ server: name, tool });
    }
  }
  return matches;
}

/** Split a `server:tool` reference. Returns `undefined` when there is no separator. */
export function parseToolRef(ref: string): { server: string; tool: string } | undefined {
  const index = ref.indexOf(":");
  if (index <= 0 || index === ref.length - 1) return undefined;
  return { server: ref.slice(0, index), tool: ref.slice(index + 1) };
}

export function summarizeCache(cache: MetadataCache, config: McpConfig): Array<{ server: string; cached: boolean; tools: number }> {
  return Object.keys(config.mcpServers)
    .sort((a, b) => a.localeCompare(b))
    .map((server) => {
      const entry = cache.servers[server];
      return { server, cached: entry !== undefined, tools: entry?.tools.length ?? 0 };
    });
}
