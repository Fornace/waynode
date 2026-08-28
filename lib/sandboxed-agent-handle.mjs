import db from "./db.mjs";
import { computeSessionTokenTotal, readGoalStatus, runPiMessage } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { createRequestId } from "./agent-rpc-events.mjs";
import { SubmissionLedger } from "./agent-submissions.mjs";
import { projectAfter, projectSession } from "./pi-session-projection.mjs";
import { publishSessionEvent } from "./session-bus.mjs";

/** Run each chat turn in a fresh microsandbox while preserving the SSE API. */
const MAX_QUEUED_FOLLOW_UPS = 5;

export class SandboxedAgentHandle {
  constructor(session, { runMessage = runPiMessage } = {}) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.piSessionDir = session.pi_session_dir;
    this.session = session;
    this.streaming = false;
    this.dead = false;
    this.subscribers = new Set();
    this.liveText = "";
    this.liveThinking = "";
    this.liveTools = [];
    this.curMsgId = null;
    this.lastUserPrompt = "";
    this._lastActive = Date.now();
    this._lastEntryId = null;
    this.titleJob = null;
    this.followUps = [];
    this.runMessage = runMessage;
    this.currentSubmission = null;
    /** The microVM of the in-flight turn, set by _runPrompt via onSandbox.
     *  Held so abort()/shutdown() can actually stop the run — without it a
     *  sandboxed turn was unstoppable and session delete leaked the VM. */
    this.activeSandbox = null;
    this.abortRequestedId = null;
    this.submissions = new SubmissionLedger((event) => this.broadcast(event), { sessionId: session.id });
  }

  async start() {}

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    subscriber(this._syncSnapshot());
    return () => this.subscribers.delete(subscriber);
  }

  _syncSnapshot() {
    return {
      type: "sync",
      streaming: this.streaming,
      live: this.streaming ? {
        messageId: this.curMsgId,
        text: this.liveText,
        thinking: this.liveThinking,
        tools: this.liveTools,
      } : null,
      // legacy fields (native app contract)
      partialText: this.liveText,
      tools: this.liveTools,
      submissions: this.submissions.snapshot(),
    };
  }

  broadcast(event) {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch {}
    }
    publishSessionEvent(this.sessionId, event);
  }

  /** Durable items persisted during the turn: full fidelity, stable ids. */
  _broadcastPersistedEntries() {
    try {
      const { items: entries, leafId } = projectAfter(this.piSessionDir, this._lastEntryId);
      if (entries.length === 0) return;
      this.annotateSubmissions(entries);
      this._lastEntryId = leafId;
      this.broadcast({ type: "entries", entries, leafId });
    } catch (error) {
      console.error(`[sandbox:${this.sessionId}] entries broadcast failed:`, error.message);
    }
  }

  annotateSubmissions(entries) {
    const actives = [...this.submissions.records.values()].filter((record) =>
      ["queued", "starting", "running"].includes(record.status),
    );
    for (const entry of entries) {
      if (entry.role !== "user") continue;
      const match = actives.find((record) => entry.text.includes(record.prompt));
      if (match) entry.submissionId = match.id;
    }
  }

  sendPrompt(prompt, mode = "message", submissionId, { resumed = false } = {}) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (this.streaming && !resumed) throw new Error("Agent is busy");
    const { record } = this.submissions.create({
      id: submissionId, prompt, mode, status: resumed ? "running" : "starting",
    });
    record.resumed = resumed;
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
        // A resumed goal turn must not re-trigger goal creation: the
        // original wrapped prompt is already in pi's context.
        await this._runPrompt(turn.prompt, turn.resumed ? "message" : turn.mode);
        this.submissions.settle(turn, "completed");
      } catch (error) {
        const cancelled = this.abortRequestedId === turn.id;
        this.abortRequestedId = null;
        if (cancelled) this.submissions.settle(turn, "cancelled");
        else this.submissions.settle(turn, "failed", error);
      }
      this.currentSubmission = null;
      // The turn's entries are durable now: broadcast tool calls and results
      // that the sandbox never streamed live, then close the turn.
      this._broadcastPersistedEntries();
      this.broadcast({ type: "end" });
    }
    this.streaming = false;
    this.liveText = "";
    this.liveThinking = "";
    this.curMsgId = null;
  }

  async _runPrompt(prompt, mode) {
    this.lastUserPrompt = prompt;
    this._lastActive = Date.now();
    this.liveText = "";
    this.liveTools = [];
    if (!this._lastEntryId) {
      const { leafId } = projectSession(this.piSessionDir);
      this._lastEntryId = leafId;
    }
    // Re-read the session row so model/title changes made after this handle
    // was constructed take effect on the next turn (setModel only wrote the
    // DB; the cached snapshot kept every run on the old model until reap).
    const fresh = db.prepare("SELECT * FROM sessions WHERE id = ?").get(this.sessionId);
    if (fresh) this.session = fresh;

    const messageId = createRequestId();
    this.curMsgId = messageId;
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
      const result = await this.runMessage({ session: this.session, prompt, mode, onChunk, onSandbox });
      const text = (result.stdout || "").trim();
      console.log(`[sandbox:${this.sessionId}] run complete (status=${result.status}, ${text.length} chars)`);
      if (streamedLength > 0) {
        if (streamedLength !== text.length) {
          console.warn(
            `[sandbox:${this.sessionId}] streamed length (${streamedLength}) != final text length (${text.length}); using final text as source of truth`,
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
