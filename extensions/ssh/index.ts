/**
 * SSH Tools Extension
 *
 * When active, routes pi's standard tools (read/write/edit/bash/ls/find/grep)
 * to a remote host via SSH, and rewrites the agent's working directory so the
 * model simply works "on" the remote — no parallel tool namespace.
 *
 * The target is derived, not configured: --ssh routes tools to `desktop` at
 * the same cwd (local and remote machines mirror the same path structure).
 * No target state is stored; the activation is remembered in the process
 * environment so SSH mode survives session switches (/handoff, /resume,
 * /reload). Activation verifies the remote host and mirrored cwd with a
 * probe round trip at session start — like gondolin, the extension only
 * counts as "up" once the remote is reachable. Restarting pi without
 * --ssh runs tools locally again.
 *
 * Usage:
 *   pi -e extensions/ssh/index.ts --ssh   - Route tools to desktop:$CWD
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on the remote host
 *   - GNU find (for ls); rg or grep for search
 *
 * The local SSH agent is forwarded (`ssh -A`), so e.g. git commit signing
 * with ssh keys works on the remote using the local 1Password agent.
 *
 * Tip: Enable ControlMaster for lower latency on repeated tool calls:
 *   Host *
 *     ControlMaster auto
 *     ControlPath ~/.ssh/control-%r@%h:%p
 *     ControlPersist 10m
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { sshBackend, type RemoteTarget } from "./backend";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const STATUS_KEY = "ssh";

export default function sshExtension(pi: ExtensionAPI) {
  // Target is derived, not configured: tools run on this host at the same
  // cwd as the local machine (mirrored path structure), e.g. --ssh maps
  // ~/src/foo/bar here to ~/src/foo/bar on `desktop`.
  const REMOTE_HOST = "desktop";

  // pi does not carry CLI flags into new extension instances after a session
  // switch (handoff/new/resume/fork), so remember "SSH mode is on" in the
  // process environment. The target itself is stateless — re-derived from
  // process.cwd() on every session start.
  const ENV_SSH_ACTIVE = "PI_SSH_ACTIVE";

  pi.registerFlag("ssh", {
    description: `Route tools to ${REMOTE_HOST} at the same cwd`,
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();

  let activeTarget: RemoteTarget | null = null;

  const updateStatus = (
    ctx: ExtensionContext,
    target: RemoteTarget | null = activeTarget
  ) => {
    if (!target) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("accent", `SSH: ${target.label}:${target.cwd}`)
    );
  };

  const activate = async (ctx: ExtensionContext) => {
    const target: RemoteTarget = {
      id: `ssh:${REMOTE_HOST}`,
      label: REMOTE_HOST,
      cwd: localCwd,
    };
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("accent", `SSH: connecting ${target.label}…`)
    );
    try {
      // Treat the remote host like gondolin's VM: SSH mode only counts as
      // "up" once connectivity and the mirrored cwd are verified.
      const cwd = await sshBackend.probe(target);
      activeTarget = { ...target, cwd };
      process.env[ENV_SSH_ACTIVE] = "1";
      updateStatus(ctx);
      ctx.ui.notify(`SSH mode on: ${target.label} (${cwd})`, "info");
    } catch (err) {
      activeTarget = null;
      // Keep the env marker so a transient failure doesn't permanently kill
      // SSH mode: the next session start re-probes (mirroring gondolin's
      // ensureVm retry on the next tool/session start).
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("muted", `SSH: ${REMOTE_HOST} unreachable`)
      );
      ctx.ui.notify(
        `SSH failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  };

  // -----------------------------------------------------------------------
  // Route standard tools over SSH when active
  // -----------------------------------------------------------------------

  const readDef = createReadToolDefinition(localCwd);
  pi.registerTool({
    ...readDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createReadToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createReadOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return readDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const writeDef = createWriteToolDefinition(localCwd);
  pi.registerTool({
    ...writeDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createWriteToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createWriteOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return writeDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const editDef = createEditToolDefinition(localCwd);
  pi.registerTool({
    ...editDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createEditToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createEditOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return editDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const bashDef = createBashToolDefinition(localCwd);
  pi.registerTool({
    ...bashDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createBashToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createBashOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return bashDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const lsDef = createLsToolDefinition(localCwd);
  pi.registerTool({
    ...lsDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createLsToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createLsOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return lsDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const findDef = createFindToolDefinition(localCwd);
  pi.registerTool({
    ...findDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (activeTarget) {
        const def = createFindToolDefinition(activeTarget.cwd, {
          operations: sshBackend.createFindOps(activeTarget),
        });
        return def.execute(id, params, signal, onUpdate, ctx);
      }
      return findDef.execute(id, params, signal, onUpdate, ctx);
    },
  });

  const grepDef = createGrepToolDefinition(localCwd);
  pi.registerTool({
    ...grepDef,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!activeTarget) {
        return grepDef.execute(id, params, signal, onUpdate, ctx);
      }
      return sshBackend.runGrep(activeTarget, params, signal);
    },
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    activeTarget = null;
    updateStatus(ctx);

    // Activate when --ssh is passed at launch, or SSH mode is already active
    // in this process (preserves the mode across /handoff, /resume, /reload).
    const flagOn = pi.getFlag("ssh") === true;
    const carriedOn = process.env[ENV_SSH_ACTIVE] === "1";
    if (flagOn || carriedOn) {
      await activate(ctx);
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeTarget) return;

    const remoteLine =
      `Current working directory: ${activeTarget.cwd} ` +
      `(via SSH: ${activeTarget.label})`;
    const localLine = `Current working directory: ${localCwd}`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, remoteLine)
      : `${event.systemPrompt}\n\n${remoteLine}`;
    return { systemPrompt };
  });

  // Route user ! commands to the remote when active
  pi.on("user_bash", () => {
    if (!activeTarget) return;
    return { operations: sshBackend.createBashOps(activeTarget) };
  });
}
