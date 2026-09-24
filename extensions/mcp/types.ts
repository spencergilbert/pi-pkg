/**
 * Shared types for the thin MCP client extension.
 *
 * The config surface intentionally mirrors the standard `mcpServers` shape so
 * existing files written for the previous adapter keep working. Only the
 * fields this thin proxy actually honours are declared.
 */

export type TransportKind = "stdio" | "http";

/** Per-server OAuth overrides. `undefined` means "auto-detect for HTTP". */
export interface OAuthServerConfig {
  grantType?: "authorization_code" | "client_credentials";
  /** Pre-registered client ID. When absent, dynamic client registration is used. */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** HTTPS URL of a Client ID Metadata Document (SEP-991). */
  clientMetadataUrl?: string;
  /** Requested scopes. */
  scope?: string;
  /** Authorization-code redirect URI. A loopback URI may use `{port}`. */
  redirectUri?: string;
  /** Client display name for dynamic registration. */
  clientName?: string;
  /** Client homepage URI for dynamic registration. */
  clientUri?: string;
  /** Client logo URL for dynamic registration. */
  logoUri?: string;
  /** HTTPS URL of an authorization-server metadata document. */
  authServerMetadataUrl?: string;
  /** Security-weakening escape hatch for misconfigured authorization servers. */
  skipIssuerMetadataValidation?: boolean;
  /** Extra authorization URL parameters for provider-specific extensions. */
  authorizationParams?: Record<string, string>;
}

/** A single entry in the `mcpServers` map. */
export interface McpServerConfig {
  /** stdio transport: executable to spawn. */
  command?: string;
  /** stdio transport: arguments passed to `command`. */
  args?: string[];
  /** stdio transport: extra environment variables overlaid on the process env. */
  env?: Record<string, string>;
  /** stdio transport: working directory for the child process. */
  cwd?: string;
  /** HTTP transport: MCP endpoint URL. */
  url?: string;
  /** HTTP transport: static request headers. */
  headers?: Record<string, string>;
  /** Authentication mode. Defaults to OAuth for HTTP URLs with no custom headers. */
  auth?: "oauth" | "bearer" | false;
  /** Static bearer token (prefer `bearerTokenEnv`). */
  bearerToken?: string;
  /** Name of an environment variable holding the bearer token. */
  bearerTokenEnv?: string;
  /** OAuth overrides, or `false` to disable OAuth. */
  oauth?: OAuthServerConfig | false;
  /** Idle timeout in milliseconds before the connection is closed. `0` disables. */
  idleTimeoutMs?: number;
  /** Idle timeout in minutes (adapter-compatible alias for `idleTimeoutMs`). */
  idleTimeout?: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Disable this server without deleting its config. */
  disabled?: boolean;
  /** Forward the child's stderr to this process (stdio only). */
  debug?: boolean;
}

/** Global settings, shallow-merged across config sources. */
export interface McpSettings {
  /** Default idle timeout in milliseconds before a connection is closed. `0` disables. */
  idleTimeoutMs?: number;
  /** Default idle timeout in minutes (adapter-compatible alias for `idleTimeoutMs`). */
  idleTimeout?: number;
  /** Default per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Bound oversized tool output. `false` disables truncation. */
  outputGuard?: boolean | { maxBytes?: number; maxLines?: number };
  /** Credential backend. `auto` uses an OS keyring CLI when available. */
  keyring?: boolean | "auto" | "file";
}

export interface McpConfigSource {
  id: string;
  path: string;
  exists: boolean;
  serverCount: number;
}

/** Effective, interpolated configuration plus its identity hash. */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
  settings: McpSettings;
  sources: McpConfigSource[];
  hash: string;
}

/** A server config after transport resolution. */
export interface ResolvedServerConfig {
  name: string;
  transport: TransportKind;
  config: McpServerConfig;
  /** Effective OAuth settings (`undefined` = auto, `false` = disabled). */
  oauth: OAuthServerConfig | false | undefined;
  /** Effective bearer token, if any. */
  bearerToken?: string;
  /** Resolved idle timeout in milliseconds (`0` disables). */
  idleTimeoutMs: number;
  /** Resolved request timeout in milliseconds. */
  requestTimeoutMs: number;
}

export interface CachedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface ServerCacheEntry {
  /** Config identity hash the entry was fetched under. */
  configHash: string;
  /** Endpoint URL the entry is bound to, when the server is HTTP. */
  serverUrl?: string;
  fetchedAt: number;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools: CachedTool[];
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

/** Persisted OAuth material for one server. */
export interface StoredOAuthState {
  /** Endpoint URL the credentials are bound to. */
  serverUrl?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  /** Absolute expiry timestamp (ms), derived from `expires_in` at save time. */
  expires_at?: number;
  issuer?: string;
  clientInformation?: Record<string, unknown>;
  codeVerifier?: string;
  discoveryState?: Record<string, unknown>;
  /** Expected OAuth `state` parameter for a pending authorization. */
  state?: string;
  authorizationUrl?: string;
}

export type JsonObject = Record<string, unknown>;
