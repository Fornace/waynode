import { spawn } from "child_process";
import db from "./db.mjs";
import { buildPiEnv, embeddedPiResourceArgs, readGoalStatus } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { normalizeAgentEvent } from "./agent-rpc-events.mjs";
import { resolvePiModel } from "./pi-model.mjs";
import { goalPrompt } from "./agent-submissions.mjs";
import { piSessionArgs } from "./pi-session-args.mjs";
import { projectSession } from "./pi-session-projection.mjs";
import { AgentSurface } from "./agent-surface.mjs";

/** One long-lived `pi --mode rpc` subprocess and its subscribers. */
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

export class AgentHandle extends AgentSurface {
  constructor(session, onExit) {
    super(session);
    this.title = session.title;
    this.onExit = onExit;
    this.proc = null;
    this.dead = false;
    this._reqSeq = 0;
    this._pending = new Map();
    this._outBuf = Buffer.alloc(0);
    this.lastUserPrompt = "";
    this.currentSubmission = null;
    this.abortRequestedId = null;
    this._piQueueCount = 0;
    this._messageEnded = false;
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

    this.proc = spawn("pi", getAgentRpcArgs(session), {
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
      this.onExit?.();
    });

    this.proc.on("error", (error) => {
      this.dead = true;
      this.streaming = false;
      this.broadcast({ type: "error", message: `Failed to start agent: ${error.message}` });
      this.submissions.failActive(error);
      this._rejectPending(error);
      this.onExit?.();
    });

    // Do not expose a session as connected until pi is actually consuming RPC
    // input. This turns startup/trust/config failures into a bounded SSE error
    // instead of leaving every submitted message in “Starting…” forever.
    await this._send({ type: "get_state" });
    const { leafId } = projectSession(this.piSessionDir);
    this._lastEntryId = leafId;
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

  /** pi started processing the next queued follow-up (FIFO mirror). */
  _promoteNextQueued() {
    if (this.currentSubmission && this.currentSubmission.status === "running") return;
    const next = this.submissions.queuedRecords()[0];
    if (!next) return;
    this.currentSubmission = next;
    this.lastUserPrompt = next.prompt;
    this.submissions.update(next, "running");
  }

  /** pi reports the turn fully settled: no retry, compaction, or queue left. */
  _settleTurn() {
    const finished = this.currentSubmission;
    const cancelled = finished?.id === this.abortRequestedId;
    this.abortRequestedId = null;
    if (finished) this.submissions.settle(finished, cancelled ? "cancelled" : "completed");
    this.currentSubmission = null;
    // Rename reads liveText synchronously, so run it before the reset below.
    this._maybeRename();
    this.liveText = "";
    this.liveThinking = "";
    this.liveTools = [];
    this.curMsgId = null;
    this._piQueueCount = 0;
    // A queued follow-up is delivered right after settle: stay busy so a
    // concurrent POST /message cannot race pi's own queue delivery.
    this.streaming = this.submissions.queuedRecords().length > 0;
    this.broadcast({ type: "end" });
    this._broadcastPersistedEntries();
    this._meterTokenUsage();
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

  sendPrompt(prompt, mode = "message", submissionId, { resumed = false, wirePrompt = null } = {}) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (this.dead) throw new Error("Agent is dead");
    if (this.streaming && !resumed) return this.followUp(prompt, mode, submissionId);
    // Claim synchronously. HTTP admission relies on persistence errors being
    // thrown before the route acknowledges or pi receives a command.
    const { record, created } = this.submissions.create({
      id: submissionId, prompt, mode, status: resumed ? "running" : "starting", resume: resumed,
    });
    if (!created) return Promise.resolve(record);
    this.lastUserPrompt = prompt;
    this.streaming = true;
    record.resumed = resumed;
    record.wirePrompt = wirePrompt;
    this.currentSubmission = record;
    return this._dispatchPrompt(record, prompt, resumed, wirePrompt);
  }

  async _dispatchPrompt(record, prompt, resumed, wirePrompt) {
    try {
      await this._send({
        type: "prompt",
        // User-facing submission truth remains the original prompt; recovery
        // sends a separate internal wire prompt into pi's existing context.
        message: wirePrompt ?? (resumed ? prompt : goalPrompt(prompt, record.mode)),
        streamingBehavior: "followUp",
      });
    } catch (error) {
      this.streaming = this._piQueueCount > 0 || this.submissions.queuedRecords().length > 0;
      if (this.currentSubmission === record) this.currentSubmission = null;
      this.submissions.settle(record, "failed", error);
      this.broadcast({ type: "error", message: error.message });
      throw error;
    }
    return record.completion;
  }

  /**
   * Queue a follow-up behind the running turn. pi owns the queue; the ledger
   * mirrors it FIFO: the next agent_start promotes this record to running.
   */
  followUp(prompt, mode = "message", submissionId, { resumed = false } = {}) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (!this.streaming) return this.sendPrompt(prompt, mode, submissionId);
    if (this.submissions.queuedRecords().length >= MAX_QUEUED_FOLLOW_UPS) {
      const error = new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can be queued`);
      error.status = 409;
      throw error;
    }
    const { record, created } = this.submissions.create({
      id: submissionId, prompt, mode, status: "queued", resume: resumed,
    });
    if (!created) return record;
    this.streaming = true;
    this._piQueueCount = Math.max(this._piQueueCount, this.submissions.queuedRecords().length);
    this._send({ type: "follow_up", message: goalPrompt(prompt, record.mode) }).catch((error) => {
      // pi rejected the queue: settle the record and unwind busy state if pi
      // has nothing left, or the handle wedges busy forever.
      this.submissions.settle(record, "failed", error);
      this._piQueueCount = Math.max(0, this._piQueueCount - 1);
      if (this._piQueueCount === 0 && !this.currentSubmission) this.streaming = false;
    });
    return record.completion;
  }

  // Compat alias: routes and older callers used queueFollowUp.
  queueFollowUp(prompt, mode, submissionId, options) {
    return this.followUp(prompt, mode, submissionId, options);
  }

  async abort() {
    if (!this.currentSubmission) return { cancelled: false };
    const currentId = this.currentSubmission.id;
    // Pi's `abort` stops only the active turn and then starts queued follow-ups.
    // Interactive Stop means stop the complete session queue, so clear Pi's
    // queue first and settle the ledger mirror to the same terminal truth.
    try {
      await this._send({ type: "clear_queue" });
    } catch (error) {
      // Pi never confirmed the clear, so its queue is untouched and the
      // ledger mirror must keep reporting queued. Report the failure instead
      // of rejecting, so the route answers and the client can retry Stop.
      return { cancelled: false, reason: `Stop failed: ${error.message}` };
    }
    this.submissions.cancelQueued();
    this._piQueueCount = 0;
    this.abortRequestedId = currentId;
    try {
      await this._send({ type: "abort" });
    } catch (error) {
      // The queue was cleared and its mirror is already cancelled, but the
      // active turn may still run. Keep abortRequestedId so a late settlement
      // lands on cancelled, and tell the client Stop was not acknowledged.
      return {
        cancelled: false, submissionId: currentId,
        reason: `Stop was not acknowledged: ${error.message}`,
      };
    }
    return { cancelled: true, submissionId: currentId };
  }

  /** Kill the underlying pi process without broadcasting a crash. */
  shutdown() {
    this._intentionalKill = true;
    try { this.proc?.kill(); } catch {}
    this.dead = true;
    this.streaming = false;
  }

  async setModel(provider, modelId) {
    return this._send({ type: "set_model", provider, modelId });
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}
