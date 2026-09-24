/**
 * Lazy MCP server connections.
 *
 * Nothing is spawned or dialed at extension load or session start: a
 * connection is created only when `connect` or `call` first needs one. Each
 * connection carries an idle timer that closes it after the configured idle
 * timeout, and `shutdown()` tears everything down idempotently.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { computeServerHash, saveServerCache } from "./cache";
import { resolveServerConfig } from "./config";
import type { OAuthManager, McpOAuthProvider } from "./oauth";
import type { CredentialStore } from "./store";
import type {
  CachedTool,
  McpConfig,
  ResolvedServerConfig,
  ServerCacheEntry,
  TransportKind,
} from "./types";

export interface ServerStatus {
  name: string;
  transport: TransportKind | undefined;
  configured: boolean;
  connected: boolean;
  toolCount: number;
  serverName?: string;
  serverVersion?: string;
  error?: string;
}

export interface ConnectResult {
  name: string;
  transport: TransportKind;
  toolCount: number;
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Connection {
  name: string;
  resolved: ResolvedServerConfig;
  hash: string;
  client: Client;
  transport: Transport;
  serverUrl?: string;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools: CachedTool[];
  connected: boolean;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  /** Recent child stderr, for diagnostics on connect failure. */
  stderr: string[];
  closing: boolean;
}

export interface ServerManagerOptions {
  agentDir: string;
  getConfig: () => McpConfig;
  getStore: () => Promise<CredentialStore>;
  getOAuth: () => Promise<OAuthManager>;
  log?: (message: string) => void;
}

function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function describeError(error: unknown, stderr: string[]): string {
  const base = error instanceof Error ? error.message : String(error);
  const tail = stderr.slice(-5).join("").trim();
  return tail ? `${base}\nServer stderr:\n${tail}` : base;
}

function isAuthError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unauthorized|401|auth-start|re-authenticate|authorization required/i.test(message);
}

function mapTool(tool: Tool): CachedTool {
  const record = tool as unknown as {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  };
  return {
    name: record.name,
    ...(record.title ? { title: record.title } : {}),
    ...(record.description ? { description: record.description } : {}),
    inputSchema: record.inputSchema ?? { type: "object", properties: {} },
    ...(record.outputSchema ? { outputSchema: record.outputSchema } : {}),
  };
}

export class ServerManager {
  private readonly options: ServerManagerOptions;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();

  constructor(options: ServerManagerOptions) {
    this.options = options;
  }

  isConnected(name: string): boolean {
    return this.connections.get(name)?.connected === true;
  }

  getStatus(config: McpConfig): ServerStatus[] {
    return Object.keys(config.mcpServers)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const entry = config.mcpServers[name];
        const connection = this.connections.get(name);
        const transport: TransportKind | undefined =
          typeof entry.command === "string" ? "stdio" : typeof entry.url === "string" ? "http" : undefined;
        return {
          name,
          transport,
          configured: true,
          connected: connection?.connected === true,
          toolCount: connection?.tools.length ?? 0,
          ...(connection?.serverName ? { serverName: connection.serverName } : {}),
          ...(connection?.serverVersion ? { serverVersion: connection.serverVersion } : {}),
        };
      });
  }

  async connect(name: string): Promise<ConnectResult> {
    const connection = await this.ensureConnection(name);
    await this.refreshCache(connection);
    return {
      name,
      transport: connection.resolved.transport,
      toolCount: connection.tools.length,
      tools: connection.tools.map((tool) => tool.name),
      ...(connection.serverName ? { serverName: connection.serverName } : {}),
      ...(connection.serverVersion ? { serverVersion: connection.serverVersion } : {}),
      ...(connection.instructions ? { instructions: connection.instructions } : {}),
    };
  }

  async call(name: string, toolName: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    const connection = await this.ensureConnection(name);
    this.touch(connection);
    try {
      return await connection.client.callTool(
        { name: toolName, arguments: args },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : connection.resolved.requestTimeoutMs,
        },
      );
    } catch (error) {
      if (isAuthError(error)) {
        throw new Error(`MCP server "${name}" requires OAuth authorization. Run mcp({ action: "auth-start", server: "${name}" }) first.`);
      }
      throw error;
    } finally {
      this.touch(connection);
    }
  }

  async refreshCache(connection: Connection): Promise<void> {
    const result = await connection.client.listTools();
    connection.tools = result.tools.map(mapTool);
    const entry: ServerCacheEntry = {
      configHash: connection.hash,
      ...(connection.serverUrl ? { serverUrl: connection.serverUrl } : {}),
      fetchedAt: Date.now(),
      ...(connection.serverName ? { serverName: connection.serverName } : {}),
      ...(connection.serverVersion ? { serverVersion: connection.serverVersion } : {}),
      ...(connection.instructions ? { instructions: connection.instructions } : {}),
      tools: connection.tools,
    };
    await saveServerCache(this.options.agentDir, connection.name, entry);
  }

  private touch(connection: Connection): void {
    connection.lastUsedAt = Date.now();
    this.scheduleIdle(connection);
  }

  private scheduleIdle(connection: Connection): void {
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    const timeout = connection.resolved.idleTimeoutMs;
    if (timeout <= 0) return;
    const timer = setTimeout(() => {
      void this.closeConnection(connection.name);
    }, timeout);
    timer.unref?.();
    connection.idleTimer = timer;
  }

  private async ensureConnection(name: string): Promise<Connection> {
    const resolved = this.resolve(name);
    const hash = computeServerHash(resolved);
    const existing = this.connections.get(name);
    if (existing && existing.hash === hash && existing.connected && !existing.closing) {
      this.touch(existing);
      return existing;
    }
    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;
    const promise = (async () => {
      if (existing) await this.closeConnection(name);
      const connection = await this.createConnection(resolved, hash);
      this.connections.set(name, connection);
      return connection;
    })();
    this.connecting.set(name, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(name);
    }
  }

  private resolve(name: string): ResolvedServerConfig {
    const config = this.options.getConfig();
    const entry = config.mcpServers[name];
    if (!entry) throw new Error(`Unknown MCP server "${name}"`);
    if (entry.disabled) throw new Error(`MCP server "${name}" is disabled`);
    return resolveServerConfig(name, config);
  }

  private async createConnection(resolved: ResolvedServerConfig, hash: string): Promise<Connection> {
    const { name, config } = resolved;
    const stderr: string[] = [];
    let transport: Transport;
    let serverUrl: string | undefined;

    if (resolved.transport === "stdio") {
      const stdio = new StdioClientTransport({
        command: config.command as string,
        args: config.args ?? [],
        env: { ...stringifyEnv(process.env), ...(config.env ?? {}) },
        ...(config.cwd ? { cwd: config.cwd } : {}),
        stderr: config.debug ? "inherit" : "pipe",
      });
      if (config.debug !== true) {
        stdio.stderr?.on("data", (chunk: unknown) => {
          stderr.push(String(chunk));
          if (stderr.length > 20) stderr.shift();
        });
      }
      transport = stdio;
    } else {
      serverUrl = config.url;
      const headers = config.headers ?? {};
      let authProvider: McpOAuthProvider | { token: () => Promise<string | undefined> } | undefined;
      if (resolved.bearerToken) {
        const token = resolved.bearerToken;
        authProvider = { token: async () => token };
      } else if (resolved.oauth !== false && config.auth !== "bearer") {
        const oauth = await this.options.getOAuth();
        authProvider = oauth.providerFor(resolved);
      }
      transport = new StreamableHTTPClientTransport(new URL(serverUrl as string), {
        ...(authProvider ? { authProvider } : {}),
        ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
      });
    }

    const client = new Client({ name: "pi-mcp", version: "1.0.0" });
    client.onerror = (error) => {
      this.options.log?.(`[mcp] ${name}: ${error.message}`);
    };

    const connection: Connection = {
      name,
      resolved,
      hash,
      client,
      transport,
      ...(serverUrl ? { serverUrl } : {}),
      tools: [],
      connected: false,
      lastUsedAt: Date.now(),
      stderr,
      closing: false,
    };

    transport.onclose = () => {
      if (connection.closing) return;
      connection.connected = false;
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      this.connections.delete(name);
    };

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (isAuthError(error)) {
        throw new Error(`MCP server "${name}" requires OAuth authorization. Run mcp({ action: "auth-start", server: "${name}" }) first.`);
      }
      throw new Error(`Failed to connect to MCP server "${name}": ${describeError(error, stderr)}`);
    }

    connection.connected = true;
    const version = client.getServerVersion();
    if (version) {
      connection.serverName = version.name;
      connection.serverVersion = version.version;
    }
    const instructions = client.getInstructions();
    if (instructions) connection.instructions = instructions;
    this.scheduleIdle(connection);
    return connection;
  }

  async closeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    connection.closing = true;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    this.connections.delete(name);
    await connection.client.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((name) => this.closeConnection(name)));
  }
}
