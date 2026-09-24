/**
 * The model-facing `mcp` proxy tool.
 *
 * A single tool with an `action` switch. `search` and `describe` answer purely
 * from the on-disk metadata cache, so they never open a connection. `connect`
 * opens one lazily and refreshes the cache. `call` connects if needed, invokes
 * the tool, and bounds the output. `auth-start`/`auth-complete` drive OAuth.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  computeServerHash,
  findCachedTools,
  getCachedTools,
  loadMetadataCache,
  parseToolRef,
  searchTools,
  summarizeCache,
} from "./cache";
import { loadMcpConfig, resolveServerConfig } from "./config";
import { guardMcpResult, type GuardedBlock } from "./output-guard";
import type { OAuthManager } from "./oauth";
import type { ServerManager } from "./servers";
import type { CredentialStore } from "./store";
import type { McpConfig } from "./types";

export const MCP_ACTIONS = [
  "status",
  "search",
  "describe",
  "call",
  "connect",
  "auth-start",
  "auth-complete",
] as const;

export type McpAction = (typeof MCP_ACTIONS)[number];

export const McpToolParams = Type.Object({
  action: Type.Optional(
    Type.Union(MCP_ACTIONS.map((action) => Type.Literal(action)), {
      description: "Action to perform. Defaults to 'status'.",
    }),
  ),
  server: Type.Optional(Type.String({ description: "MCP server name (filters search; required for connect/auth; selects a describe/call target)." })),
  tool: Type.Optional(Type.String({ description: "Tool name for describe/call, optionally as 'server:tool'." })),
  args: Type.Optional(
    Type.Union([Type.String({ description: "Tool arguments as a JSON string." }), Type.Object({}, { additionalProperties: true })]),
  ),
  query: Type.Optional(Type.String({ description: "Search query for the 'search' action." })),
  limit: Type.Optional(Type.Number({ description: "Maximum search results (default 12)." })),
  includeSchema: Type.Optional(Type.Boolean({ description: "Include input schemas in search/describe output (default true)." })),
  redirectUrl: Type.Optional(Type.String({ description: "Final OAuth callback URL for the 'auth-complete' action." })),
  code: Type.Optional(Type.String({ description: "Authorization code for the 'auth-complete' action." })),
});

export type McpToolInput = {
  action?: McpAction;
  server?: string;
  tool?: string;
  args?: string | Record<string, unknown>;
  query?: string;
  limit?: number;
  includeSchema?: boolean;
  redirectUrl?: string;
  code?: string;
};

export interface ProxyResult {
  content: GuardedBlock[];
  details: Record<string, unknown>;
}

export interface McpProxyOptions {
  agentDir: string;
  servers: ServerManager;
  getOAuth: () => Promise<OAuthManager>;
  getStore: () => Promise<CredentialStore>;
  log?: (message: string) => void;
}

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (args === undefined) return {};
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`"args" must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error('"args" must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function text(value: string, details: Record<string, unknown>): ProxyResult {
  return { content: [{ type: "text", text: value }], details };
}

function guardOptions(config: McpConfig): { enabled: boolean; maxBytes?: number; maxLines?: number } {
  const setting = config.settings.outputGuard;
  if (setting === false) return { enabled: false };
  if (setting && typeof setting === "object") {
    return {
      enabled: true,
      ...(typeof setting.maxBytes === "number" ? { maxBytes: setting.maxBytes } : {}),
      ...(typeof setting.maxLines === "number" ? { maxLines: setting.maxLines } : {}),
    };
  }
  return { enabled: true };
}

export class McpProxy {
  private readonly options: McpProxyOptions;

  constructor(options: McpProxyOptions) {
    this.options = options;
  }

  private loadConfig(cwd: string): McpConfig {
    return loadMcpConfig({ cwd });
  }

  private serverHash(config: McpConfig, name: string): string | undefined {
    try {
      return computeServerHash(resolveServerConfig(name, config));
    } catch {
      return undefined;
    }
  }

  async run(input: McpToolInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<ProxyResult> {
    const action = input.action ?? "status";
    const cwd = ctx.cwd;
    switch (action) {
      case "status":
        return this.status(cwd);
      case "search":
        return this.search(cwd, input);
      case "describe":
        return this.describe(cwd, input);
      case "connect":
        return this.connect(cwd, input);
      case "call":
        return this.call(cwd, input, signal);
      case "auth-start":
        return this.authStart(cwd, input);
      case "auth-complete":
        return this.authComplete(cwd, input);
      default: {
        const exhaustive: never = action;
        throw new Error(`Unknown MCP action: ${String(exhaustive)}`);
      }
    }
  }

  private async status(cwd: string): Promise<ProxyResult> {
    const config = this.loadConfig(cwd);
    const cache = await loadMetadataCache(this.options.agentDir);
    const statuses = this.options.servers.getStatus(config);
    const cacheSummary = summarizeCache(cache, config);
    const cacheByName = new Map(cacheSummary.map((entry) => [entry.server, entry]));
    const store = await this.options.getStore();

    const lines: string[] = [];
    const names = statuses.map((status) => status.name);
    if (names.length === 0) {
      lines.push("No MCP servers configured.");
    } else {
      lines.push(`MCP servers (${names.length}):`);
    }
    for (const status of statuses) {
      const cached = cacheByName.get(status.name);
      const hash = this.serverHash(config, status.name);
      const cachedEntry = cache.servers[status.name];
      const cacheState = cachedEntry === undefined
        ? "no cache"
        : hash !== undefined && cachedEntry.configHash === hash
          ? `cached: ${cached?.tools ?? 0} tools`
          : "cache stale";
      const state = status.connected ? `connected (${status.toolCount} tools)` : "not connected";
      lines.push(`- ${status.name} [${status.transport ?? "invalid"}] — ${state}; ${cacheState}`);
    }
    lines.push(`Config hash: ${config.hash.slice(0, 12)}; credentials: ${store.backendKind}.`);

    return text(lines.join("\n"), {
      action: "status",
      configHash: config.hash,
      sources: config.sources,
      servers: statuses,
      cache: cacheSummary,
      credentialBackend: store.backendKind,
      config: Object.fromEntries(
        Object.entries(config.mcpServers).map(([name, entry]) => [
          name,
          {
            transport: typeof entry.command === "string" ? "stdio" : typeof entry.url === "string" ? "http" : "invalid",
            disabled: entry.disabled === true,
            target: entry.command ?? entry.url ?? null,
          },
        ]),
      ),
    });
  }

  private async search(cwd: string, input: McpToolInput): Promise<ProxyResult> {
    const config = this.loadConfig(cwd);
    if (input.server && !(input.server in config.mcpServers)) {
      throw new Error(`Unknown MCP server "${input.server}"`);
    }
    const cache = await loadMetadataCache(this.options.agentDir);
    const query = input.query ?? "";
    const hits = searchTools(cache, query, {
      ...(input.server ? { server: input.server } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    if (hits.length === 0) {
      const connected = this.options.servers.getStatus(config).filter((status) => status.connected).map((status) => status.name);
      const hint = connected.length > 0
        ? `Connected servers: ${connected.join(", ")}. Run mcp({ action: "connect", server: "<name>" }) to refresh metadata.`
        : `No cached tools match. Run mcp({ action: "connect", server: "<name>" }) to fetch tool metadata.`;
      return text(`No tools found for "${query}". ${hint}`, { action: "search", query, results: [] });
    }
    const includeSchema = input.includeSchema !== false;
    const lines = hits.map((hit) => {
      const description = hit.tool.description ? ` — ${hit.tool.description}` : "";
      const schema = includeSchema ? `\n    input: ${JSON.stringify(hit.tool.inputSchema)}` : "";
      return `- ${hit.ref}${description}${schema}`;
    });
    return text(
      `Found ${hits.length} tool(s) for "${query}":\n${lines.join("\n")}\n\nDescribe with mcp({ action: "describe", tool: "<server>:<tool>" }).`,
      {
        action: "search",
        query,
        results: hits.map((hit) => ({
          ref: hit.ref,
          server: hit.server,
          name: hit.tool.name,
          description: hit.tool.description ?? null,
          ...(includeSchema ? { inputSchema: hit.tool.inputSchema } : {}),
        })),
      },
    );
  }

  private async describe(cwd: string, input: McpToolInput): Promise<ProxyResult> {
    let server = input.server;
    let tool = input.tool;
    if (!tool) throw new Error("'tool' is required for the describe action");
    if (!server && tool.includes(":")) {
      const parsed = parseToolRef(tool);
      if (parsed) {
        server = parsed.server;
        tool = parsed.tool;
      }
    }
    if (!tool) throw new Error(`Invalid tool reference "${input.tool}"`);
    const cache = await loadMetadataCache(this.options.agentDir);
    const matches = findCachedTools(cache, tool, server);
    if (matches.length === 0) {
      const target = server ? `"${server}:${tool}"` : `"${tool}"`;
      return text(
        `No cached metadata for ${target}. Run mcp({ action: "connect", server: "${server ?? "<name>"}" }) to fetch it.`,
        { action: "describe", server: server ?? null, tool, found: false },
      );
    }
    if (matches.length > 1 && !server) {
      const options = matches.map((match) => match.server).join(", ");
      return text(
        `Tool "${tool}" exists on multiple servers: ${options}. Pass "server" to disambiguate.`,
        { action: "describe", tool, candidates: matches.map((match) => `${match.server}:${match.tool.name}`), found: false },
      );
    }
    const match = matches[0];
    const entry = cache.servers[match.server];
    const lines = [
      `${match.server}:${match.tool.name}`,
      match.tool.description ? `\n${match.tool.description}` : "",
      `\nInput schema:\n${JSON.stringify(match.tool.inputSchema, null, 2)}`,
    ];
    if (match.tool.outputSchema) lines.push(`\nOutput schema:\n${JSON.stringify(match.tool.outputSchema, null, 2)}`);
    if (entry?.instructions) lines.push(`\nServer instructions:\n${entry.instructions}`);
    return text(lines.join("\n"), {
      action: "describe",
      server: match.server,
      tool: match.tool.name,
      found: true,
      inputSchema: match.tool.inputSchema,
      ...(match.tool.outputSchema ? { outputSchema: match.tool.outputSchema } : {}),
    });
  }

  private async connect(cwd: string, input: McpToolInput): Promise<ProxyResult> {
    const server = input.server;
    if (!server) throw new Error("'server' is required for the connect action");
    const config = this.loadConfig(cwd);
    if (!(server in config.mcpServers)) throw new Error(`Unknown MCP server "${server}"`);
    const result = await this.options.servers.connect(server);
    const lines = [
      `Connected "${server}" (${result.transport}). ${result.toolCount} tool(s) cached.`,
      ...(result.tools.length > 0 ? [result.tools.map((name) => `- ${server}:${name}`).join("\n")] : []),
    ];
    return text(lines.join("\n"), {
      action: "connect",
      server,
      transport: result.transport,
      toolCount: result.toolCount,
      tools: result.tools,
      serverInfo: result.serverName ? { name: result.serverName, version: result.serverVersion } : null,
    });
  }

  private async call(cwd: string, input: McpToolInput, signal?: AbortSignal): Promise<ProxyResult> {
    let server = input.server;
    let tool = input.tool;
    if (!tool) throw new Error("'tool' is required for the call action");
    if (!server && tool.includes(":")) {
      const parsed = parseToolRef(tool);
      if (parsed) {
        server = parsed.server;
        tool = parsed.tool;
      }
    }
    if (!server) throw new Error("'server' is required for the call action (or pass tool as 'server:tool')");
    const config = this.loadConfig(cwd);
    if (!(server in config.mcpServers)) throw new Error(`Unknown MCP server "${server}"`);
    const args = parseArgs(input.args);
    const result = await this.options.servers.call(server, tool, args, { ...(signal ? { signal } : {}) });
    const header = result.isError ? `[${server}:${tool}] returned an error` : `[${server}:${tool}]`;
    const guarded = await guardMcpResult(result.content, { ...guardOptions(config), rawText: header });
    return {
      content: guarded.content,
      details: {
        action: "call",
        server,
        tool,
        isError: result.isError === true,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(guarded.outputGuard ? { outputGuard: guarded.outputGuard } : {}),
      },
    };
  }

  private async authStart(cwd: string, input: McpToolInput): Promise<ProxyResult> {
    const server = input.server;
    if (!server) throw new Error("'server' is required for the auth-start action");
    const config = this.loadConfig(cwd);
    if (!(server in config.mcpServers)) throw new Error(`Unknown MCP server "${server}"`);
    const oauth = await this.options.getOAuth();
    const result = await oauth.startAuth(server);
    return text(result.message, { action: "auth-start", ...result });
  }

  private async authComplete(cwd: string, input: McpToolInput): Promise<ProxyResult> {
    const server = input.server;
    if (!server) throw new Error("'server' is required for the auth-complete action");
    const config = this.loadConfig(cwd);
    if (!(server in config.mcpServers)) throw new Error(`Unknown MCP server "${server}"`);
    const oauth = await this.options.getOAuth();
    const result = await oauth.completeAuth(server, {
      ...(input.code ? { code: input.code } : {}),
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
    });
    return text(result.message, { action: "auth-complete", ...result });
  }
}
