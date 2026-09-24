/**
 * OAuth 2.1 support for HTTP MCP servers.
 *
 * A single `McpOAuthProvider` (the SDK's `OAuthClientProvider` contract) is
 * cached per server. `auth-start` runs the SDK's `auth()` orchestrator, which
 * is what calls `redirectToAuthorization` — the ONLY place a browser is ever
 * opened. For a loopback redirect a 127.0.0.1 callback server completes the
 * code exchange automatically; for an HTTPS redirect URI the user pastes the
 * final callback URL/code into `auth-complete` instead.
 *
 * Normal `call` traffic never opens anything: the transport reads `tokens()`
 * per request and, on a 401, refreshes through the same `auth()` path.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  auth,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import type { CredentialStore } from "./store";
import type { OAuthServerConfig, ResolvedServerConfig, StoredOAuthState } from "./types";

export interface AuthStartResult {
  status: "redirect" | "authorized";
  server: string;
  authorizationUrl?: string;
  redirectUri?: string;
  manual?: boolean;
  browserOpened?: boolean;
  message: string;
}

export interface AuthCompleteResult {
  status: "authorized" | "pending" | "error";
  server: string;
  message: string;
  authorizationUrl?: string;
  error?: string;
}

interface PendingAuth {
  server: string;
  provider: McpOAuthProvider;
  serverUrl: string;
  manual: boolean;
}

interface CompletedAuth {
  status: "authorized" | "error";
  message: string;
  error?: string;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Open a URL in the user's browser without blocking or inheriting stdio. */
export function openBrowser(url: string): void {
  if (process.env.PI_MCP_NO_BROWSER === "1") return;
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // A missing opener must not break the auth flow; the URL is reported too.
  }
}

interface ResolvedRedirect {
  mode: "loopback" | "manual";
  /** Explicit loopback port to bind, when the redirect URI pinned one. */
  port?: number;
  /** Manual redirect URI (HTTPS or non-loopback). */
  uri?: string;
  /** Path to serve the callback on (loopback only). */
  path: string;
}

export function resolveRedirect(config: OAuthServerConfig | false | undefined): ResolvedRedirect {
  const redirectUri = config ? config.redirectUri : undefined;
  if (!redirectUri) return { mode: "loopback", path: "/callback" };
  let parsed: URL;
  try {
    parsed = new URL(redirectUri.replace("{port}", "0"));
  } catch {
    return { mode: "loopback", path: "/callback" };
  }
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    const pinned = redirectUri.includes("{port}") ? undefined : Number.parseInt(parsed.port, 10) || undefined;
    return { mode: "loopback", port: pinned, path: parsed.pathname || "/callback" };
  }
  return { mode: "manual", uri: redirectUri, path: parsed.pathname || "/callback" };
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly oauthConfig: OAuthServerConfig | false | undefined;
  clientMetadataUrl?: string;

  private readonly store: CredentialStore;
  private readonly onRedirect?: (url: string) => void;
  private readonly redirectResolver: () => string | undefined;
  private readonly onStateGenerated?: (state: string) => void;
  private stateCache?: StoredOAuthState;
  private chain: Promise<unknown> = Promise.resolve();
  /** Browser/redirect is only permitted while the `auth-start` action is running. */
  private interactive = false;
  /** True while redeeming an authorization code, which legitimately skips the redirect. */
  private authorizationCodeFlow = false;

  constructor(options: {
    serverName: string;
    serverUrl: string;
    config: OAuthServerConfig | false | undefined;
    store: CredentialStore;
    redirectUrl: () => string | undefined;
    onRedirect?: (url: string) => void;
    onStateGenerated?: (state: string) => void;
  }) {
    this.serverName = options.serverName;
    this.serverUrl = options.serverUrl;
    this.oauthConfig = options.config;
    this.store = options.store;
    this.redirectResolver = options.redirectUrl;
    this.onRedirect = options.onRedirect;
    this.onStateGenerated = options.onStateGenerated;
    if (options.config && options.config.clientMetadataUrl) {
      this.clientMetadataUrl = options.config.clientMetadataUrl;
    }
  }

  private get grantType(): "authorization_code" | "client_credentials" {
    return this.oauthConfig && this.oauthConfig.grantType === "client_credentials"
      ? "client_credentials"
      : "authorization_code";
  }

  get redirectUrl(): string | undefined {
    if (this.grantType === "client_credentials") return undefined;
    return this.redirectResolver();
  }

  get clientMetadata(): OAuthClientMetadata {
    const config = this.oauthConfig ? this.oauthConfig : undefined;
    const redirect = this.redirectUrl;
    const metadata: OAuthClientMetadata = {
      redirect_uris: redirect ? [redirect] : [],
      grant_types: this.grantType === "client_credentials" ? ["client_credentials"] : ["authorization_code", "refresh_token"],
      response_types: this.grantType === "client_credentials" ? undefined : ["code"],
      client_name: config?.clientName ?? "Pi MCP Client",
      scope: config?.scope,
      client_uri: config?.clientUri,
      logo_uri: config?.logoUri,
    };
    return metadata;
  }

  private async read(): Promise<StoredOAuthState> {
    if (this.stateCache) return this.stateCache;
    const loaded = (await this.store.load(this.serverName, this.serverUrl)) ?? {};
    this.stateCache = loaded;
    return loaded;
  }

  private update(mutator: (state: StoredOAuthState) => void): Promise<void> {
    this.chain = this.chain.then(async () => {
      const current = (await this.read()) ?? {};
      mutator(current);
      this.stateCache = current;
      await this.store.save(this.serverName, current, this.serverUrl);
    });
    return this.chain as Promise<void>;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const config = this.oauthConfig ? this.oauthConfig : undefined;
    if (config?.clientId) {
      return {
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
      } as StoredOAuthClientInformation;
    }
    const state = await this.read();
    return state.clientInformation as StoredOAuthClientInformation | undefined;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.update((state) => {
      state.clientInformation = { ...clientInformation } as Record<string, unknown>;
      if (clientInformation.issuer) state.issuer = clientInformation.issuer;
      else if (ctx?.issuer) state.issuer = ctx.issuer;
    });
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const state = await this.read();
    if (!state.access_token) return undefined;
    if (ctx?.issuer && state.issuer && ctx.issuer !== state.issuer) return undefined;
    return {
      access_token: state.access_token,
      token_type: state.token_type ?? "Bearer",
      ...(typeof state.expires_in === "number" ? { expires_in: state.expires_in } : {}),
      ...(state.scope ? { scope: state.scope } : {}),
      ...(state.refresh_token ? { refresh_token: state.refresh_token } : {}),
      ...(state.issuer ? { issuer: state.issuer } : {}),
    } as StoredOAuthTokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.update((state) => {
      state.access_token = tokens.access_token;
      state.token_type = tokens.token_type ?? "Bearer";
      state.refresh_token = tokens.refresh_token;
      state.scope = tokens.scope;
      state.expires_in = typeof tokens.expires_in === "number" ? tokens.expires_in : undefined;
      state.expires_at = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
      state.issuer = tokens.issuer ?? ctx?.issuer ?? state.issuer;
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update((state) => {
      state.codeVerifier = codeVerifier;
    });
  }

  async codeVerifier(): Promise<string> {
    const state = await this.read();
    if (!state.codeVerifier) throw new Error(`No PKCE code verifier stored for MCP server "${this.serverName}"`);
    return state.codeVerifier;
  }

  async state(): Promise<string> {
    const state = randomBytes(16).toString("hex");
    await this.update((value) => {
      value.state = state;
    });
    this.onStateGenerated?.(state);
    return state;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.update((state) => {
      state.authorizationUrl = authorizationUrl.toString();
    });
    if (!this.interactive) {
      throw new Error(
        `OAuth authorization for MCP server "${this.serverName}" requires the auth-start action. Run mcp({ action: "auth-start", server: "${this.serverName}" }) first.`,
      );
    }
    this.onRedirect?.(authorizationUrl.toString());
  }

  /** Enable the one-time interactive redirect. Only `auth-start` should do this. */
  setInteractive(value: boolean): void {
    this.interactive = value;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.update((value) => {
      value.discoveryState = state as unknown as Record<string, unknown>;
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await this.read();
    return state.discoveryState as OAuthDiscoveryState | undefined;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.update((state) => {
      if (scope === "all" || scope === "client") delete state.clientInformation;
      if (scope === "all" || scope === "tokens") {
        delete state.access_token;
        delete state.refresh_token;
        delete state.token_type;
        delete state.scope;
        delete state.expires_in;
        delete state.expires_at;
      }
      if (scope === "all" || scope === "verifier") delete state.codeVerifier;
      if (scope === "all" || scope === "discovery") delete state.discoveryState;
    });
  }

  async prepareTokenRequest(scope?: string): Promise<URLSearchParams | undefined> {
    if (this.grantType === "client_credentials") {
      const params = new URLSearchParams({ grant_type: "client_credentials" });
      if (scope) params.set("scope", scope);
      return params;
    }
    if (this.authorizationCodeFlow) return undefined;
    throw new Error(
      `OAuth authorization for MCP server "${this.serverName}" requires the auth-start action. Run mcp({ action: "auth-start", server: "${this.serverName}" }) first.`,
    );
  }

  async currentState(): Promise<StoredOAuthState> {
    return this.read();
  }

  /** Mark that the next `auth()` call is redeeming an authorization code. */
  setAuthorizationCodeFlow(value: boolean): void {
    this.authorizationCodeFlow = value;
  }

  async clear(): Promise<void> {
    this.stateCache = {};
    await this.store.clear(this.serverName);
  }
}

export interface OAuthManagerOptions {
  store: CredentialStore;
  resolveServer: (name: string) => ResolvedServerConfig;
  openBrowser?: (url: string) => void;
}

export class OAuthManager {
  private readonly store: CredentialStore;
  private readonly resolveServer: (name: string) => ResolvedServerConfig;
  private readonly open: (url: string) => void;
  private readonly providers = new Map<string, McpOAuthProvider>();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly completed = new Map<string, CompletedAuth>();
  private server: Server | undefined;
  private serverBase: string | undefined;
  private serverPath = "/callback";
  private startPromise: Promise<string> | undefined;

  constructor(options: OAuthManagerOptions) {
    this.store = options.store;
    this.resolveServer = options.resolveServer;
    this.open = options.openBrowser ?? openBrowser;
  }

  private getProvider(resolved: ResolvedServerConfig, manualRedirectUri?: string): McpOAuthProvider {
    const serverUrl = resolved.config.url ?? "";
    const existing = this.providers.get(resolved.name);
    if (existing && existing.serverUrl === serverUrl) return existing;
    if (existing) this.providers.delete(resolved.name);
    const provider = new McpOAuthProvider({
      serverName: resolved.name,
      serverUrl,
      config: resolved.oauth,
      store: this.store,
      redirectUrl: () => {
        if (manualRedirectUri) return manualRedirectUri;
        return this.serverBase ? `${this.serverBase}${this.serverPath}` : undefined;
      },
      onRedirect: (url) => this.open(url),
      onStateGenerated: (state) => {
        this.pending.set(state, {
          server: resolved.name,
          provider,
          serverUrl,
          manual: manualRedirectUri !== undefined,
        });
      },
    });
    this.providers.set(resolved.name, provider);
    return provider;
  }

  /**
   * Provider used by a live transport. Interactive redirects stay disabled, so
   * a 401 that cannot be refreshed reports an auth-required error instead of
   * opening a browser during a tool call.
   */
  providerFor(resolved: ResolvedServerConfig): McpOAuthProvider {
    const redirect = resolveRedirect(resolved.oauth);
    return this.getProvider(resolved, redirect.mode === "manual" ? redirect.uri : undefined);
  }

  private async ensureCallbackServer(port?: number, path = "/callback"): Promise<string> {
    if (this.server && this.serverBase) return `${this.serverBase}${this.serverPath}`;
    if (this.startPromise) return this.startPromise;
    this.serverPath = path || "/callback";
    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleCallback(req, res);
      });
      server.on("error", (error) => {
        this.startPromise = undefined;
        reject(error);
      });
      server.listen(port ?? 0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine MCP OAuth callback port"));
          return;
        }
        this.server = server;
        this.serverBase = `http://127.0.0.1:${address.port}`;
        resolve(`${this.serverBase}${this.serverPath}`);
      });
    });
    return this.startPromise;
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    const errorDescription = url.searchParams.get("error_description") ?? undefined;
    const code = url.searchParams.get("code") ?? undefined;
    const iss = url.searchParams.get("iss") ?? undefined;

    if (error) {
      const pending = state ? this.pending.get(state) : undefined;
      if (pending) {
        this.completed.set(pending.server, { status: "error", message: errorDescription ?? error, error });
        this.pending.delete(state!);
      }
      respondHtml(res, 400, "Authorization failed", `${errorDescription ?? error}`);
      return;
    }
    if (!code || !state) {
      respondHtml(res, 400, "Authorization failed", "The callback is missing a code or state parameter.");
      return;
    }
    const pending = this.pending.get(state);
    if (!pending) {
      respondHtml(res, 400, "Authorization failed", "This authorization request is no longer pending. Start it again with mcp auth-start.");
      return;
    }
    try {
      pending.provider.setAuthorizationCodeFlow(true);
      await auth(pending.provider, { serverUrl: pending.serverUrl, authorizationCode: code, iss });
      this.completed.set(pending.server, { status: "authorized", message: "Authorization complete. Tokens stored." });
      respondHtml(res, 200, "Authorization complete", "You can close this window and return to Pi.");
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : String(authError);
      this.completed.set(pending.server, { status: "error", message, error: message });
      respondHtml(res, 400, "Authorization failed", message);
    } finally {
      pending.provider.setAuthorizationCodeFlow(false);
      this.pending.delete(state);
    }
  }

  async startAuth(serverName: string): Promise<AuthStartResult> {
    const resolved = this.resolveServer(serverName);
    if (resolved.transport !== "http" || !resolved.config.url) {
      throw new Error(`MCP server "${serverName}" is not an HTTP server; OAuth requires a "url"`);
    }
    if (resolved.oauth === false) {
      throw new Error(`OAuth is disabled for MCP server "${serverName}"`);
    }
    if (resolved.config.auth === "bearer" || resolved.bearerToken) {
      throw new Error(`MCP server "${serverName}" uses a bearer token; OAuth is not applicable`);
    }

    const redirect = resolveRedirect(resolved.oauth);
    const clientCredentials = Boolean(resolved.oauth && resolved.oauth.grantType === "client_credentials");
    let manualRedirectUri: string | undefined;
    if (clientCredentials) {
      // Non-interactive: no browser and no loopback callback server needed.
      manualRedirectUri = undefined;
    } else if (redirect.mode === "loopback") {
      await this.ensureCallbackServer(redirect.port, redirect.path);
    } else {
      manualRedirectUri = redirect.uri;
    }

    const provider = this.getProvider(resolved, manualRedirectUri);
    this.completed.delete(serverName);
    provider.setInteractive(true);
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, { serverUrl: resolved.config.url });
    } finally {
      provider.setInteractive(false);
    }
    if (result === "AUTHORIZED") {
      return { status: "authorized", server: serverName, message: `Authorized "${serverName}" without an interactive redirect (existing refresh token or client-credentials flow).` };
    }
    const stored = await provider.currentState();
    const authorizationUrl = stored.authorizationUrl;
    const isManual = manualRedirectUri !== undefined;
    return {
      status: "redirect",
      server: serverName,
      authorizationUrl,
      redirectUri: isManual ? manualRedirectUri : provider.redirectUrl,
      manual: isManual,
      // The browser is opened from inside redirectToAuthorization for both
      // loopback and manual flows; manual differs only in how the code returns.
      browserOpened: true,
      message: isManual
        ? `Open the authorization URL, then finish with mcp({ action: "auth-complete", server: "${serverName}", redirectUrl: "<final callback URL>" }).`
        : `Browser opened for "${serverName}". The 127.0.0.1 callback stores tokens automatically; use mcp({ action: "auth-complete", server: "${serverName}" }) to confirm.`,
    };
  }

  async completeAuth(serverName: string, options: { code?: string; redirectUrl?: string } = {}): Promise<AuthCompleteResult> {
    const resolved = this.resolveServer(serverName);
    if (resolved.transport !== "http" || !resolved.config.url) {
      throw new Error(`MCP server "${serverName}" is not an HTTP server; OAuth requires a "url"`);
    }
    const redirect = resolveRedirect(resolved.oauth);
    const manualRedirectUri = redirect.mode === "manual" ? redirect.uri : undefined;
    const provider = this.getProvider(resolved, manualRedirectUri);

    let code = options.code;
    let state: string | undefined;
    let iss: string | undefined;
    if (options.redirectUrl) {
      let parsed: URL;
      try {
        parsed = new URL(options.redirectUrl);
      } catch {
        throw new Error(`Invalid redirect URL for "${serverName}": ${options.redirectUrl}`);
      }
      code = parsed.searchParams.get("code") ?? code;
      state = parsed.searchParams.get("state") ?? undefined;
      iss = parsed.searchParams.get("iss") ?? undefined;
      const error = parsed.searchParams.get("error");
      if (error) {
        const message = parsed.searchParams.get("error_description") ?? error;
        return { status: "error", server: serverName, message, error };
      }
    }

    if (!code) {
      const already = this.completed.get(serverName);
      if (already) {
        if (already.status === "authorized") return { status: "authorized", server: serverName, message: already.message };
        return { status: "error", server: serverName, message: already.message, error: already.error };
      }
      const pendingForServer = [...this.pending.values()].find((entry) => entry.server === serverName);
      const stored = await provider.currentState();
      return {
        status: "pending",
        server: serverName,
        message: pendingForServer
          ? `Authorization for "${serverName}" is still pending. Complete it in the browser; the loopback callback will finish automatically, or pass the final redirectUrl/code.`
          : `No pending authorization for "${serverName}". Start one with mcp({ action: "auth-start", server: "${serverName}" }).`,
        authorizationUrl: stored.authorizationUrl,
      };
    }

    if (state) {
      const pending = this.pending.get(state);
      if (!pending) {
        throw new Error(`Authorization state for "${serverName}" is unknown or expired; run auth-start again`);
      }
      this.pending.delete(state);
    }

    try {
      provider.setAuthorizationCodeFlow(true);
      await auth(provider, { serverUrl: resolved.config.url, authorizationCode: code, iss });
      const message = `Authorization complete for "${serverName}". Tokens stored.`;
      this.completed.set(serverName, { status: "authorized", message });
      return { status: "authorized", server: serverName, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.completed.set(serverName, { status: "error", message, error: message });
      return { status: "error", server: serverName, message, error: message };
    } finally {
      provider.setAuthorizationCodeFlow(false);
    }
  }

  /** Drop any cached provider so a config change is picked up. */
  invalidateProvider(serverName: string): void {
    this.providers.delete(serverName);
    this.completed.delete(serverName);
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.completed.clear();
    this.providers.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      this.serverBase = undefined;
      this.startPromise = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function respondHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family: system-ui, sans-serif; padding: 2rem;"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
