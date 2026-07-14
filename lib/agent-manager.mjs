import { config } from "./config.mjs";
import { isSandboxAvailable, runPiTerminal } from "./pi-runner.mjs";
import { AgentHandle } from "./agent-rpc-handle.mjs";
import { SandboxedAgentHandle } from "./sandboxed-agent-handle.mjs";
import { AgentBusyError, TerminalHandle } from "./agent-terminal-handle.mjs";

/**
 * Owns server-side agent processes independently of HTTP and WebSocket
 * clients. Client disconnects only detach subscribers; work keeps running.
 */

const IDLE_REAP_MS = 30 * 60 * 1000;
const agents = new Map();
const terminals = new Map();

async function reclaimChat(sessionId) {
  const chat = agents.get(sessionId);
  if (!chat || chat.dead) return;
  if (chat.streaming) throw new AgentBusyError(sessionId);
  chat._intentionalKill = true;
  try { chat.proc?.kill(); } catch {}
  agents.delete(sessionId);
}

export async function getAgent(session) {
  teardownTerminal(session.id);

  let handle = agents.get(session.id);
  if (handle && !handle.dead) return handle;

  if (await isSandboxAvailable()) {
    handle = new SandboxedAgentHandle(session);
    agents.set(session.id, handle);
    return handle;
  }

  handle = new AgentHandle(session, () => agents.delete(session.id));
  agents.set(session.id, handle);
  await handle.start();
  return handle;
}

/**
 * Acquire or reattach to a server-owned terminal. A busy chat agent is never
 * killed; callers receive AgentBusyError and can surface a clean rejection.
 */
export async function getTerminal(session, spawnPty = runPiTerminal) {
  // Microsandbox currently exposes interactive attach only through the
  // caller's stdio, not as a programmatic PTY channel. Running the terminal on
  // the host would bypass isolation, so trusted hosts must opt in explicitly.
  if ((await isSandboxAvailable()) && !config.allowHostTerminal) {
    const error = new Error(
      "Terminal is unavailable in sandboxed mode. Agent chat runs in an isolated microVM; " +
      "interactive terminal support is pending microsandbox SDK support for programmatic pty channels."
    );
    error.terminalDisabled = true;
    throw error;
  }

  await reclaimChat(session.id);

  let handle = terminals.get(session.id);
  if (handle && !handle.dead) return handle;

  const pty = await spawnPty({ session });
  handle = new TerminalHandle(session, pty, () => terminals.delete(session.id));
  terminals.set(session.id, handle);
  return handle;
}

export function getTerminalIfActive(sessionId) {
  const handle = terminals.get(sessionId);
  return handle && !handle.dead ? handle : null;
}

export function teardownTerminal(sessionId) {
  const handle = terminals.get(sessionId);
  if (handle && !handle.dead) {
    try { handle.pty.kill(); } catch {}
  }
  terminals.delete(sessionId);
}

export function getAgentIfActive(sessionId) {
  const handle = agents.get(sessionId);
  return handle && !handle.dead ? handle : null;
}

export function listActiveAgents() {
  return [...agents.values()].filter((agent) => !agent.dead);
}

export function isSpaceBusy(spaceId) {
  return (
    listActiveAgents().some((agent) => agent.spaceId === spaceId && agent.streaming) ||
    [...terminals.values()].some((terminal) => !terminal.dead && terminal.spaceId === spaceId)
  );
}

setInterval(() => {
  const now = Date.now();
  for (const [id, handle] of agents) {
    if (handle.dead) {
      agents.delete(id);
    } else if (!handle.streaming && now - handle._lastActive > IDLE_REAP_MS) {
      console.log(`[agent-manager] reaping idle agent ${id}`);
      handle._intentionalKill = true;
      try { handle.proc?.kill(); } catch {}
      agents.delete(id);
    }
  }
  for (const [id, handle] of terminals) {
    if (handle.dead) {
      terminals.delete(id);
    } else if (now - handle._lastActive > IDLE_REAP_MS) {
      console.log(`[agent-manager] reaping idle terminal ${id}`);
      try { handle.pty.kill(); } catch {}
      terminals.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
