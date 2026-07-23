import db from "./db.mjs";
import { computeSessionTokenTotal, readGoalStatus, runPiMessage } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { createRequestId } from "./agent-rpc-events.mjs";
import { SubmissionLedger } from "./agent-submissions.mjs";

/** Run each chat turn in a fresh microsandbox while preserving the SSE API. */
const MAX_QUEUED_FOLLOW_UPS = 5;

export class SandboxedAgentHandle {
  constructor(session, { runMessage = runPiMessage } = {}) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.session = session;
    this.streaming = false;
    this.dead = false;
    this.subscribers = new Set();
    this.liveText = "";
    this.liveTools = [];
    this.lastUserPrompt = "";
    this._lastActive = Date.now();
    this.titleJob = null;
    this.followUps = [];
    this.runMessage = runMessage;
    this.currentSubmission = null;
    /** The microVM of the in-flight turn, set by _runPrompt via onSandbox.
     *  Held so abort()/shutdown() can actually stop the run — without it a
     *  sandboxed turn was unstoppable and session delete leaked the VM. */
    this.activeSandbox = null;
    this.abortRequestedId = null;
    this.submissions = new SubmissionLedger((event) => this.broadcast(event));
  }

  async start() {}

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    subscriber({
      type: "sync",
      streaming: this.streaming,
      partialText: this.liveText,
      tools: this.liveTools,
      submissions: this.submissions.snapshot(),
    });
    return () => this.subscribers.delete(subscriber);
  }

  broadcast(event) {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch {}
    }
  }

  sendPrompt(prompt, mode = "message", submissionId) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (this.streaming) throw new Error("Agent is busy");
    const { record } = this.submissions.create({ id: submissionId, prompt, mode, status: "starting" });
    this.followUps.push(record);
    void this._drain();
    return record.completion;
  }

  queueFollowUp(prompt, mode = "message", submissionId) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (!this.streaming) return this.sendPrompt(prompt, mode, submissionId);
    if (this.followUps.length >= MAX_QUEUED_FOLLOW_UPS) {
      const error = new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can be queued`);
      error.status = 409;
      throw error;
    }
    const { record } = this.submissions.create({ id: submissionId, prompt, mode, status: "queued" });
    this.followUps.push(record);
    return record.completion;
  }

  async _drain() {
    if (this.streaming) return;
    this.streaming = true;
    while (!this.dead && this.followUps.length) {
      const turn = this.followUps.shift();
      this.currentSubmission = turn;
      this.submissions.update(turn, "starting");
      try {
        await this._runPrompt(turn.prompt, turn.mode);
        this.submissions.settle(turn, "completed");
      } catch (error) {
        const cancelled = this.abortRequestedId === turn.id;
        this.abortRequestedId = null;
        if (cancelled) this.submissions.settle(turn, "cancelled");
        else this.submissions.settle(turn, "failed", error);
      }
    }
    this.currentSubmission = null;
    this.streaming = false;
    this.liveText = "";
  }

  async _runPrompt(prompt, mode) {
    this.lastUserPrompt = prompt;
    this._lastActive = Date.now();
    this.liveText = "";

    // Re-read the session row so model/title changes made after this handle
    // was constructed take effect on the next turn (setModel only wrote the
    // DB; the cached snapshot kept every run on the old model until reap).
    const fresh = db.prepare("SELECT * FROM sessions WHERE id = ?").get(this.sessionId);
    if (fresh) this.session = fresh;

    const messageId = createRequestId();
    this.broadcast({ type: "start" });
    this.submissions.update(this.currentSubmission, "running");
    this.broadcast({ type: "message_start", messageId });

    let streamedLength = 0;
    const onChunk = (chunk) => {
      if (!chunk) return;
      this.liveText += chunk;
      streamedLength += chunk.length;
      this.broadcast({ type: "text_delta", messageId, delta: chunk });
    };

    const onSandbox = (sandbox) => { this.activeSandbox = sandbox; };
    try {
      const result = await this.runMessage({ session: this.session, prompt, mode, isGoal: mode === "goal", onChunk, onSandbox });
      const text = (result.stdout || "").trim();
      console.log(`[sandbox:${this.sessionId}] run complete (status=${result.status}, ${text.length} chars)`);
      if (streamedLength > 0) {
        if (streamedLength !== text.length) {
          console.warn(
            `[sandbox:${this.sessionId}] streamed length (${streamedLength}) != final text length (${text.length}); using final text as source of truth`
          );
        }
      } else if (text) {
        this.liveText = text;
        this.broadcast({ type: "text_delta", messageId, delta: text });
      }
      // No stderr-keyword sniffing here: pi legitimately writes words like
      // "error" to stderr during successful turns. A real failure exits
      // non-zero and is thrown (and broadcast) below.
      if (result.status !== 0) throw new Error(result.stderr?.trim() || `Agent exited ${result.status}`);
      this.broadcast({ type: "message_end", messageId });
    } catch (error) {
      console.error(`[sandbox:${this.sessionId}] message failed:`, error.message);
      this.broadcast({ type: "error", message: error.message || "Sandboxed run failed" });
      throw error;
    } finally {
      this.activeSandbox = null;
      this.broadcast({ type: "end" });
      this._meterTokenUsage();
      this._maybeGenerateTitle(prompt);
    }
  }

  getSubmission(submissionId) {
    return this.submissions.publicRecord(this.submissions.get(submissionId));
  }

  getSubmissionSnapshot() {
    return this.submissions.snapshot();
  }

  async abort() {
    const submission = this.currentSubmission;
    const sandbox = this.activeSandbox;
    if (!submission || !sandbox) return { cancelled: false, reason: "No active run to stop" };
    this.abortRequestedId = submission.id;
    // Stopping the VM makes the in-flight exec throw; _drain settles the
    // submission as cancelled (not failed) via abortRequestedId.
    try { await sandbox.stop(); } catch {}
    return { cancelled: true, submissionId: submission.id };
  }

  /** Tear down without broadcasting a crash: stop the running VM (if any),
   *  drop queued follow-ups, and mark the handle dead so _drain exits. */
  shutdown() {
    this.dead = true;
    this.streaming = false;
    this.followUps.length = 0;
    const sandbox = this.activeSandbox;
    if (sandbox) Promise.resolve(sandbox.stop()).catch(() => {});
  }

  _meterTokenUsage() {
    try {
      const total = computeSessionTokenTotal(this.session.pi_session_dir);
      const space = getSpace(this.spaceId);
      if (space?.org_id) recordSessionTokenTotal(this.sessionId, space.org_id, total);
    } catch (error) {
      console.error(`[sandbox:${this.sessionId}] token metering failed:`, error.message);
    }
  }

  async _maybeGenerateTitle(userPrompt) {
    try {
      const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(this.sessionId);
      const isDefault = !session?.title || session.title === "New Session";
      if (!isDefault || this.titleJob) return;
      this.titleJob = (async () => {
        const title = await generateTitle(userPrompt, this.liveText);
        if (!title) return;
        await updateSession(this.sessionId, { title });
        this.title = title;
        this.broadcast({ type: "session_renamed", title });
      })().catch(() => {});
    } catch {}
  }

  async setModel(provider, modelId) {
    try { await updateSession(this.sessionId, { model: modelId }); } catch {}
    return { success: true, provider, modelId };
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}
