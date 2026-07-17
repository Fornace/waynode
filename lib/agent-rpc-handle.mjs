import { spawn } from "child_process";
import db from "./db.mjs";
import { buildPiEnv, embeddedPiResourceArgs, readGoalStatus } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { normalizeAgentEvent } from "./agent-rpc-events.mjs";
import { resolvePiModel } from "./pi-model.mjs";
import { goalPrompt, SubmissionLedger } from "./agent-submissions.mjs";
import { piSessionArgs } from "./pi-session-args.mjs";

/** One long-lived `pi --mode rpc` subprocess and its SSE subscribers. */
const MAX_QUEUED_FOLLOW_UPS = 5;
export function getAgentRpcArgs(session) {
  return [
    "--mode", "rpc",
    "--no-approve",
    ...embeddedPiResourceArgs(),
    "--session-dir", session.pi_session_dir,
    ...piSessionArgs(session),
    "--model", resolvePiModel(session).spec,
    "-n", session.title || "New Session",
  ];
}

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
    this._followUpWaiters = [];
    this.currentSubmission = null;
    this.abortRequestedId = null;
    this.submissions = new SubmissionLedger((event) => this.broadcast(event));
    this._lastActive = Date.now();
  }

  _write(command) {
    if (!this.proc || this.dead || !this.proc.stdin.writable) return false;
    try { return this.proc.stdin.write(`${JSON.stringify(command)}\n`); }
    catch { return false; }
  }

  _send(command) {
    const id = command.id || `req-${++this._reqSeq}`;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (!this._write({ ...command, id })) {
        this._pending.delete(id);
        reject(new Error(`Agent RPC ${command.type} could not be written`));
        return;
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          console.error(`[agent:${this.sessionId}] RPC ${command.type} timed out`);
          reject(new Error(`Agent RPC ${command.type} timed out`));
        }
      }, 10000);
    });
  }

  async start() {
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) throw new Error("Session not found");
    const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(this.spaceId);
    if (!space) throw new Error("Space not found");

    const args = getAgentRpcArgs(session);

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
      this.submissions.failActive(new Error(`Agent exited (code ${code})`));
      this._rejectPending(new Error(`Agent exited (code ${code})`));
      this._followUpWaiters.splice(0);
      this.onExit?.();
    });

    this.proc.on("error", (error) => {
      this.dead = true;
      this.streaming = false;
      this.broadcast({ type: "error", message: `Failed to start agent: ${error.message}` });
      this.submissions.failActive(error);
      this._rejectPending(error);
      this._followUpWaiters.splice(0);
      this.onExit?.();
    });

    // Do not expose a session as connected until pi is actually consuming RPC
    // input. This turns startup/trust/config failures into a bounded SSE error
    // instead of leaving every submitted message in “Starting…” forever.
    await this._send({ type: "get_state" });
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
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
    const finished = this.currentSubmission;
    const cancelled = finished?.id === this.abortRequestedId;
    this.submissions.settle(finished, cancelled ? "cancelled" : "completed");
    if (cancelled) this.abortRequestedId = null;
    this.currentSubmission = this._followUpWaiters.shift() || null;
    if (this.currentSubmission) {
      this.lastUserPrompt = this.currentSubmission.prompt;
      this.streaming = true;
      this.submissions.update(this.currentSubmission, "starting");
    }
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

  async sendPrompt(prompt, mode = "message", submissionId) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (this.dead) throw new Error("Agent is dead");
    if (this.streaming) throw new Error("Agent is busy");
    this.lastUserPrompt = prompt;
    this.streaming = true;
    this._renamed = this._renamed || false;
    const { record } = this.submissions.create({ id: submissionId, prompt, mode, status: "starting" });
    this.currentSubmission = record;
    try {
      await this._send({ type: "prompt", message: goalPrompt(prompt, record.mode) });
    } catch (error) {
      this.streaming = false;
      this.currentSubmission = null;
      this.submissions.settle(record, "failed", error);
      this.broadcast({ type: "error", message: error.message });
      throw error;
    }
    return record.completion;
  }

  async abort() {
    if (!this.currentSubmission) return { cancelled: false };
    this.abortRequestedId = this.currentSubmission.id;
    await this._send({ type: "abort" });
    return { cancelled: true, submissionId: this.abortRequestedId };
  }

  queueFollowUp(prompt, mode = "message", submissionId) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (!this.streaming) return this.sendPrompt(prompt, mode, submissionId);
    if (this._followUpWaiters.length >= MAX_QUEUED_FOLLOW_UPS) {
      const error = new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can be queued`);
      error.status = 409;
      throw error;
    }
    const { record } = this.submissions.create({ id: submissionId, prompt, mode, status: "queued" });
    this._followUpWaiters.push(record);
    this._send({ type: "follow_up", message: goalPrompt(prompt, record.mode) }).catch((error) => {
        const index = this._followUpWaiters.indexOf(record);
        if (index >= 0) this._followUpWaiters.splice(index, 1);
        this.submissions.settle(record, "failed", error);
      });
    return record.completion;
  }

  async setModel(provider, modelId) {
    return this._send({ type: "set_model", provider, modelId });
  }

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    subscriber(this.streaming
      ? { type: "sync", streaming: true, partialText: this.liveText, tools: this.liveTools,
          submissions: this.submissions.snapshot() }
      : { type: "sync", streaming: false, submissions: this.submissions.snapshot() });
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

  getSubmission(submissionId) {
    return this.submissions.publicRecord(this.submissions.get(submissionId));
  }

  getSubmissionSnapshot() {
    return this.submissions.snapshot();
  }
}
