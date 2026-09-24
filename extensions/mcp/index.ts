/**
 * MCP extension — thin, proxy-only MCP client.
 *
 * Exposes one `mcp` tool whose `action` selects status, search, describe,
 * call, connect, auth-start, or auth-complete. Tool metadata is cached on disk
 * and validated against a config hash, so `search`/`describe` never open a
 * connection. Connections are created lazily on `connect`/`call`, closed after
 * an idle timeout, and reaped on session shutdown.
 *
 * No MCP server process is started and no OAuth callback server is bound at
 * startup. `auth-start` is the only action that can open a browser, and only
 * from inside the SDK's `redirectToAuthorization` callback.
 *
 * Configuration is merged from (lowest to highest precedence):
 *   ~/.config/mcp/mcp.json
 *   <PI_CODING_AGENT_DIR>/mcp.json
 *   <project>/.mcp.json
 *   <project>/.pi/mcp.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadMcpConfig, resolveAgentDir, resolveServerConfig } from "./config";
import { OAuthManager } from "./oauth";
import { McpProxy, McpToolParams, type McpToolInput } from "./proxy";
import { ServerManager } from "./servers";
import { CredentialStore } from "./store";

const TOOL_DESCRIPTION = [
  "Proxy MCP (Model Context Protocol) servers configured for this project.",
  'Actions: "status" (default) lists servers; "search" and "describe" answer from cached tool metadata without connecting;',
  '"connect" opens a server lazily and refreshes its cached tools; "call" invokes a tool and returns its result;',
  '"auth-start"/"auth-complete" drive OAuth for HTTP servers.',
  'Call a tool with mcp({ action: "call", server: "<server>", tool: "<tool>", args: { ... } }), or pass tool as "<server>:<tool>".',
  "Oversized output is truncated and the full text is saved to a temp file whose path is returned.",
].join(" ");

export default function mcpExtension(pi: ExtensionAPI) {
  const agentDir = resolveAgentDir();
  let currentCwd = process.cwd();

  let storePromise: Promise<CredentialStore> | undefined;
  const getStore = (): Promise<CredentialStore> => {
    storePromise ??= (async () =>
      CredentialStore.create({
        agentDir,
        keyring: loadMcpConfig({ cwd: currentCwd }).settings.keyring,
        env: process.env,
      }))();
    return storePromise;
  };

  let oauthPromise: Promise<OAuthManager> | undefined;
  const getOAuth = (): Promise<OAuthManager> => {
    oauthPromise ??= (async () =>
      new OAuthManager({
        store: await getStore(),
        resolveServer: (name) => resolveServerConfig(name, loadMcpConfig({ cwd: currentCwd })),
      }))();
    return oauthPromise;
  };

  const servers = new ServerManager({
    agentDir,
    getConfig: () => loadMcpConfig({ cwd: currentCwd }),
    getStore,
    getOAuth,
  });

  const proxy = new McpProxy({
    agentDir,
    servers,
    getOAuth,
    getStore,
    log: (message) => {
      // Warnings only; Pi surfaces tool errors to the model.
      process.emitWarning(message);
    },
  });

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: TOOL_DESCRIPTION,
    promptSnippet: "MCP gateway — status, search, describe, call, connect, auth-start, auth-complete",
    promptGuidelines: [
      'Use mcp({ action: "search", query: "..." }) to find MCP tools; search and describe do not start a server.',
      'Use mcp({ action: "call", server, tool, args }) to invoke a tool; the server is connected lazily.',
    ],
    parameters: McpToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      currentCwd = ctx.cwd;
      const result = await proxy.run(params as McpToolInput, ctx, signal);
      return {
        content: result.content,
        details: result.details,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
  });

  pi.on("session_shutdown", async () => {
    await servers.shutdown();
    if (oauthPromise) {
      const oauth = await oauthPromise;
      await oauth.close();
    }
  });
}
