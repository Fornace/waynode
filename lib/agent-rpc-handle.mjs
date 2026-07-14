import { spawn } from "child_process";
import db from "./db.mjs";
import { buildPiEnv, readGoalStatus } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { normalizeAgentEvent } from "./agent-rpc-events.mjs";

/** One long-lived `pi --mode rpc` subprocess and its SSE subscribers. */
export class AgentHandle {
  constructor(session, onExit) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.title = session.title;
    this.onExit = onExit;
    this.proc = null;
    this.dead = false;
    this._reqSeq = 0;
    this._pending = new Map();
    this._outBuf = Buffer.alloc(0);
    this.subscribers = new Set();
    this.streaming = false;
    this.curMsgId = null;
    this.liveText = "";
    this.liveTools = [];
    this.lastUserPrompt = "";
    this._resolveTurn = null;
    this._lastActive = Date.now();
  }

  _write(command) {
    if (!this.proc || this.dead) return;
    try { this.proc.stdin.write(`${JSON.stringify(command)}\n`); } catch {}
  }

  _send(command) {
    const id = command.id || `req-${++this._reqSeq}`;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._write({ ...command, id });
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
      "-c",
      "--model", model,
      "-n", session.title || "New Session",
    ];

    this.proc = spawn("pi", args, {
      cwd: space.local_path,
      env: buildPiEnv(this.spaceId, { ownerId: session.owner_id }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => {
      this._outBuf = Buffer.concat([this._outBuf, chunk]);
      while (true) {
        const index = this._outBuf.indexOf(0x0a);
        if (index === -1) break;
        const line = this._outBuf.subarray(0, index);
        this._outBuf = this._outBuf.subarray(index + 1);
        const text = line.toString("utf8");
        this._handleLine(text.endsWith("\r") ? text.slice(0, -1) : text);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.trim()) {
        console.error(`[agent:${this.sessionId}] stderr:`, text.trim().slice(0, 300));
      }
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      this.streaming = false;
      if (!this._intentionalKill) {
        this.broadcast({ type: "error", message: `Agent exited (code ${code})` });
      }
      this._resolveTurn?.();
      this.onExit?.();
    });

    this.proc.on("error", (error) => {
      this.dead = true;
      this.streaming = false;
      this.broadcast({ type: "error", message: `Failed to start agent: ${error.message}` });
      this._resolveTurn?.();
      this.onExit?.();
    });
  }

  _handleLine(raw) {
    if (!raw.trim()) return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }

    if (event.type === "response") {
      const pending = this._pending.get(event.id);
      if (pending) {
        this._pending.delete(event.id);
        if (event.success === false) pending.reject(new Error(event.error || "command failed"));
        else pending.resolve(event);
      }
      return;
    }

    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        this._write({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
      return;
    }
    normalizeAgentEvent(this, event);
  }

  _onAgentEnd() {
    this.streaming = false;
    this.broadcast({ type: "end" });
    this._maybeRename();
    this._meterTokenUsage();
    const resolve = this._resolveTurn;
    this._resolveTurn = null;
    resolve?.();
  }

  async _meterTokenUsage() {
    try {
      const response = await this._send({ type: "get_session_stats" });
      const total = response?.data?.tokens?.total;
      if (typeof total !== "number" || Number.isNaN(total)) return;
      const space = getSpace(this.spaceId);
      if (space?.org_id) recordSessionTokenTotal(this.sessionId, space.org_id, total);
    } catch (error) {
      console.error(`[agent:${this.sessionId}] token metering failed:`, error.message);
    }
  }

  async _maybeRename() {
    if (this._renamed) return;
    const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) return;
    if (session.title && session.title !== "New Session") {
      this._renamed = true;
      return;
    }
    const title = await generateTitle(this.lastUserPrompt, this.liveText);
    if (!title) return;
    this._renamed = true;
    this.title = title;
    updateSession(this.sessionId, { title });
    this._send({ type: "set_session_name", name: title }).catch(() => {});
    this.broadcast({ type: "session_renamed", title });
  }

  async sendPrompt(prompt, isGoal = false) {
    if (this.dead) throw new Error("Agent is dead");
    this.lastUserPrompt = prompt;
    this.streaming = true;
    this._renamed = this._renamed || false;
    const done = new Promise((resolve, reject) => {
      this._resolveTurn = resolve;
      this._rejectTurn = reject;
    });
    const message = isGoal
      ? `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: ${prompt}`
      : prompt;
    try {
      await this._send({ type: "prompt", message });
    } catch (error) {
      this.streaming = false;
      this.broadcast({ type: "error", message: error.message });
      throw error;
    }
    return done;
  }

  async abort() {
    this._send({ type: "abort" }).catch(() => {});
  }

  queueFollowUp(prompt) {
    this.streaming = true;
    this._send({ type: "follow_up", message: prompt }).catch((error) =>
      this.broadcast({ type: "error", message: error.message })
    );
  }

  async setModel(provider, modelId) {
    return this._send({ type: "set_model", provider, modelId });
  }

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    subscriber(this.streaming
      ? { type: "sync", streaming: true, partialText: this.liveText, tools: this.liveTools }
      : { type: "sync", streaming: false });
    return () => this.subscribers.delete(subscriber);
  }

  broadcast(event) {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch {}
    }
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}
