import {
  computeSessionTokenTotal,
  enforceHostedSandbox,
  enforceTerminalAvailability,
  isSandboxAvailable,
  runPiTerminal,
} from "./pi-runner.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { getSpace } from "./spaces.mjs";
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
  chat.shutdown();
  agents.delete(sessionId);
}

function meterTerminal(session) {
  const space = getSpace(session.space_id);
  if (!space?.org_id) return;
  recordSessionTokenTotal(session.id, space.org_id, computeSessionTokenTotal(session.pi_session_dir));
}

export async function getAgent(session) {
  teardownTerminal(session.id);

  let handle = agents.get(session.id);
  if (handle && !handle.dead) {
    await handle.ready;
    handle.isReady = true;
    return handle;
  }

  const sandboxAvailable = await isSandboxAvailable();
  enforceHostedSandbox(sandboxAvailable);
  if (sandboxAvailable) {
    handle = new SandboxedAgentHandle(session);
    handle.ready = Promise.resolve();
    handle.isReady = true;
    agents.set(session.id, handle);
    return handle;
  }

  handle = new AgentHandle(session, () => agents.delete(session.id));
  handle.isReady = false;
  agents.set(session.id, handle);
  handle.ready = handle.start();
  try {
    await handle.ready;
    handle.isReady = true;
    return handle;
  } catch (error) {
    if (agents.get(session.id) === handle) agents.delete(session.id);
    try { handle.proc?.kill(); } catch {}
    throw error;
  }
}

/**
 * Acquire or reattach to a server-owned terminal. A busy chat agent is never
 * killed; callers receive AgentBusyError and can surface a clean rejection.
 */
export async function getTerminal(session, spawnPty = runPiTerminal) {
  enforceTerminalAvailability();
  await reclaimChat(session.id);

  let handle = terminals.get(session.id);
  if (handle && !handle.dead) return handle;

  const pty = await spawnPty({ session });
  handle = new TerminalHandle(session, pty, () => terminals.delete(session.id), () => meterTerminal(session));
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

/**
 * Fully tear down a session's server-side agent state: kill the chat agent
 * (marking the kill intentional so the exit path does not broadcast a crash),
 * tear down any terminal handle, and settle metering from disk BEFORE the
 * caller deletes the session row. Safe to call when no handle exists.
 */
export function stopAgent(sessionId, session) {
  const handle = agents.get(sessionId);
  if (handle && !handle.dead) {
    // shutdown() also stops a sandboxed handle's running microVM — before,
    // deleting a session left the VM running against a vanished session row.
    handle.shutdown();
  }
  agents.delete(sessionId);
  teardownTerminal(sessionId);
  // Settle the final token total from on-disk JSONL before the row disappears.
  if (session) {
    try { meterTerminal(session); } catch {}
  }
}

/** Test-only injection of a stub handle into the agents map. */
export function __injectAgentForTest(sessionId, handle) {
  agents.set(sessionId, handle);
}

export function getAgentIfActive(sessionId) {
  const handle = agents.get(sessionId);
  return handle && !handle.dead && handle.isReady ? handle : null;
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
      handle.shutdown();
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
