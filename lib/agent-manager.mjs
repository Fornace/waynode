import { spawn } from "child_process";
import db from "./db.mjs";
import { config } from "./config.mjs";
import { buildPiEnv, readGoalStatus } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";

/**
 * AgentManager
 * ------------
 * Owns ONE long-lived `pi --mode rpc` subprocess per session.
 *
 * This is the fix for both "no token streaming" and "session dies when you
 * navigate away": the agent process lives HERE (in the manager), not in the
 * HTTP request. A client subscribes to its event stream via SSE; when the
 * client disconnects/navigates, only the subscriber is detached — the agent
 * keeps running and can be re-attached later.
 *
 * Protocol: JSON over stdin/stdout, one record per line (LF only — NOT
 * readline, which wrongly splits on U+2028/U+2029 inside JSON strings).
 */

const IDLE_REAP_MS = 30 * 60 * 1000; // kill idle agents after 30min

const agents = new Map(); // sessionId -> AgentHandle

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content || result.partialResult?.content || [];
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || !c.type))
      .map((c) => c.text || "")
      .join("");
  }
  return result.output || "";
}

class AgentHandle {
  constructor(session) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.title = session.title;
    this.proc = null;
    this.dead = false;

    this._reqSeq = 0;
    this._pending = new Map(); // reqId -> {resolve, reject}
    this._outBuf = Buffer.alloc(0);

    this.subscribers = new Set(); // fn(normalizedEvent)

    this.streaming = false;
    this.curMsgId = null;
    this.liveText = ""; // in-flight assistant text (for reconnect snapshot)
    this.liveTools = []; // in-flight tool calls
    this.lastUserPrompt = "";
    this._resolveTurn = null;

    this._lastActive = Date.now();
  }

  _write(cmd) {
    if (!this.proc || this.dead) return;
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    } catch {}
  }

  _send(cmd) {
    const id = cmd.id || `req-${++this._reqSeq}`;
    const framed = { ...cmd, id };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._write(framed);
      // Safety: don't hang forever waiting for a response.
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve({ success: true, __timeout: true });
        }
      }, 10000);
    });
  }

  async start() {
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) throw new Error("Session not found");
    const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(this.spaceId);
    if (!space) throw new Error("Space not found");

    const model = session.model ? `fornace/${session.model}` : "fornace/fornace-fast";
    const args = [
      "--mode", "rpc",
      "--session-dir", session.pi_session_dir,
      "--model", model,
      "-n", session.title || "New Session",
    ];

    this.proc = spawn("pi", args, {
      cwd: space.local_path,
      env: buildPiEnv(this.spaceId),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // ── stdout: strict LF-only JSONL reader ──
    this.proc.stdout.on("data", (chunk) => {
      this._outBuf = Buffer.concat([this._outBuf, chunk]);
      while (true) {
        const idx = this._outBuf.indexOf(0x0a); // LF only
        if (idx === -1) break;
        const line = this._outBuf.subarray(0, idx);
        this._outBuf = this._outBuf.subarray(idx + 1);
        const str = line.toString("utf8");
        this._handleLine(str.endsWith("\r") ? str.slice(0, -1) : str);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      // Surface non-trivial stderr as a status event (but don't spam).
      if (text.trim()) console.error(`[agent:${this.sessionId}] stderr:`, text.trim().slice(0, 300));
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      this.streaming = false;
      this.broadcast({ type: "error", message: `Agent exited (code ${code})` });
      this._resolveTurn?.();
      agents.delete(this.sessionId);
    });
  }

  _handleLine(raw) {
    if (!raw.trim()) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }

    // Command responses (correlated by id)
    if (obj.type === "response") {
      const p = this._pending.get(obj.id);
      if (p) {
        this._pending.delete(obj.id);
        if (obj.success === false) p.reject(new Error(obj.error || "command failed"));
        else p.resolve(obj);
      }
      return;
    }

    // Extension UI dialog requests — auto-cancel so the agent never blocks.
    // (Waynode doesn't render extension dialogs yet.)
    if (obj.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(obj.method)) {
        this._write({ type: "extension_ui_response", id: obj.id, cancelled: true });
      }
      return;
    }

    this._normalize(obj);
  }

  _normalize(e) {
    this._lastActive = Date.now();
    switch (e.type) {
      case "agent_start":
        this.streaming = true;
        this.liveText = "";
        this.liveTools = [];
        this.broadcast({ type: "start" });
        return;

      case "turn_start":
        this.broadcast({ type: "turn_start" });
        return;

      case "message_start":
        if ((e.message?.role || "assistant") === "assistant") {
          this.curMsgId = e.message?.id || rid();
          this.broadcast({ type: "message_start", messageId: this.curMsgId });
        }
        return;

      case "message_update": {
        const d = e.assistantMessageEvent;
        if (!d) return;
        const mid = e.message?.id || this.curMsgId;
        if (d.type === "text_delta") {
          const delta = d.delta || "";
          this.liveText += delta;
          this.broadcast({ type: "text_delta", messageId: mid, delta });
        } else if (d.type === "thinking_delta") {
          const delta = d.textDelta || d.delta || d.reasoningDelta || "";
          this.broadcast({ type: "thinking_delta", messageId: mid, delta });
        }
        return;
      }

      case "message_end":
        this.broadcast({ type: "message_end", messageId: e.message?.id });
        return;

      case "tool_execution_start":
        this.broadcast({
          type: "tool_start",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        });
        return;

      case "tool_execution_update":
        this.broadcast({
          type: "tool_delta",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          text: extractText(e.partialResult),
        });
        return;

      case "tool_execution_end":
        this.broadcast({
          type: "tool_end",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          text: extractText(e.result),
          isError: !!e.isError,
        });
        return;

      case "turn_end":
        this.broadcast({ type: "turn_end" });
        return;

      case "agent_end":
        this._onAgentEnd();
        return;

      case "auto_retry_start":
        this.broadcast({ type: "status", text: `Retrying (${e.attempt}/${e.maxAttempts})…` });
        return;

      case "compaction_start":
        this.broadcast({ type: "status", text: "Compacting context…" });
        return;

      case "extension_error":
        this.broadcast({ type: "status", text: `Extension error: ${e.error || ""}` });
        return;
    }
  }

  _onAgentEnd() {
    this.streaming = false;
    this.broadcast({ type: "end" });
    this._maybeRename();
    const resolve = this._resolveTurn;
    this._resolveTurn = null;
    resolve?.();
  }

  async _maybeRename() {
    // Only rename once, and only if the user hasn't set a custom title.
    if (this._renamed) return;
    const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) return;
    const isDefault = !session.title || session.title === "New Session";
    if (!isDefault) {
      this._renamed = true; // user named it; never auto-rename
      return;
    }
    const title = await generateTitle(this.lastUserPrompt, this.liveText);
    if (!title) return;
    this._renamed = true;
    this.title = title;
    updateSession(this.sessionId, { title });
    // Mirror into pi's own session name for /resume consistency.
    this._send({ type: "set_session_name", name: title }).catch(() => {});
    this.broadcast({ type: "session_renamed", title });
  }

  // ── Public API ──

  /** Send a prompt; resolves when the resulting turn completes. */
  async sendPrompt(prompt, isGoal = false) {
    if (this.dead) throw new Error("Agent is dead");
    this.lastUserPrompt = prompt;
    this.streaming = true;
    this._renamed = this._renamed || false;
    const done = new Promise((resolve, reject) => {
      this._resolveTurn = resolve;
      this._rejectTurn = reject;
    });

    const full = isGoal
      ? `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: ${prompt}`
      : prompt;

    try {
      await this._send({ type: "prompt", message: full });
    } catch (err) {
      this.streaming = false;
      this.broadcast({ type: "error", message: err.message });
      throw err;
    }

    return done; // resolves on agent_end
  }

  async abort() {
    this._send({ type: "abort" }).catch(() => {});
  }

  /** Queue a follow-up prompt while a turn is running (fires after completion). */
  queueFollowUp(prompt) {
    this.streaming = true;
    this._send({ type: "follow_up", message: prompt }).catch((err) =>
      this.broadcast({ type: "error", message: err.message })
    );
  }

  /** Subscribe to normalized events. Returns an unsubscribe fn. */
  subscribe(fn) {
    this.subscribers.add(fn);
    // Replay current in-flight state so reconnecting clients catch up.
    if (this.streaming) {
      fn({ type: "sync", streaming: true, partialText: this.liveText, tools: this.liveTools });
    } else {
      fn({ type: "sync", streaming: false });
    }
    return () => this.subscribers.delete(fn);
  }

  broadcast(ev) {
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {}
    }
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}

// ── Module API ──

export async function getAgent(session) {
  let handle = agents.get(session.id);
  if (handle && !handle.dead) return handle;
  handle = new AgentHandle(session);
  agents.set(session.id, handle);
  await handle.start();
  return handle;
}

export function getAgentIfActive(sessionId) {
  const h = agents.get(sessionId);
  return h && !h.dead ? h : null;
}

export function listActiveAgents() {
  return [...agents.values()].filter((a) => !a.dead);
}

/**
 * Is any pi agent currently mid-turn for this space?
 * Used by the git sidebar to surface a "pi is working" banner. The user is
 * always the owner of the repo, so this is informational (soft-warn) — never
 * a hard permission gate on writes.
 */
export function isSpaceBusy(spaceId) {
  return listActiveAgents().some((a) => a.spaceId === spaceId && a.streaming);
}

// Periodically reap idle agents to free resources.
setInterval(() => {
  const now = Date.now();
  for (const [id, handle] of agents) {
    if (handle.dead) {
      agents.delete(id);
      continue;
    }
    if (!handle.streaming && now - handle._lastActive > IDLE_REAP_MS) {
      console.log(`[agent-manager] reaping idle agent ${id}`);
      try {
        handle.proc?.kill();
      } catch {}
      agents.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
