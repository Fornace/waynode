import db from "./db.mjs";
import { computeSessionTokenTotal, readGoalStatus, runPiMessage } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { createRequestId } from "./agent-rpc-events.mjs";
import { projectSession } from "./pi-session-projection.mjs";
import { AgentSurface } from "./agent-surface.mjs";

/** Run each chat turn in a fresh microsandbox while preserving the SSE API. */
const MAX_QUEUED_FOLLOW_UPS = 5;

export class SandboxedAgentHandle extends AgentSurface {
  constructor(session, { runMessage = runPiMessage } = {}) {
    super(session);
    this.session = session;
    this.lastUserPrompt = "";
    this.titleJob = null;
    this.followUps = [];
    this.runMessage = runMessage;
    this.currentSubmission = null;
    /** The microVM of the in-flight turn, set by _runPrompt via onSandbox.
     *  Held so abort()/shutdown() can actually stop the run — without it a
     *  sandboxed turn was unstoppable and session delete leaked the VM. */
    this.activeSandbox = null;
    this.abortRequestedId = null;
  }

  async start() {}

  sendPrompt(prompt, mode = "message", submissionId, { resumed = false, wirePrompt = null } = {}) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (this.streaming && !resumed) throw new Error("Agent is busy");
    const { record, created } = this.submissions.create({
      id: submissionId, prompt, mode, status: resumed ? "running" : "starting", resume: resumed,
    });
    if (!created) return record;
    record.resumed = resumed;
    record.wirePrompt = wirePrompt;
    this.followUps.push(record);
    void this._drain();
    return record.completion;
  }

  queueFollowUp(prompt, mode = "message", submissionId, { resumed = false } = {}) {
    const existing = submissionId && this.submissions.get(submissionId);
    if (existing) return existing.completion;
    if (!this.streaming) return this.sendPrompt(prompt, mode, submissionId);
    if (this.followUps.length >= MAX_QUEUED_FOLLOW_UPS) {
      const error = new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can be queued`);
      error.status = 409;
      throw error;
    }
    const { record, created } = this.submissions.create({
      id: submissionId, prompt, mode, status: "queued", resume: resumed,
    });
    if (!created) return record;
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
        await this._runPrompt(turn.wirePrompt ?? turn.prompt, turn.wirePrompt ? "message" : (turn.resumed ? "message" : turn.mode));
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
    // The hosted one-shot pi process writes its JSONL into the bind-mounted
    // worktree while it runs. Poll that durable source of truth so tool calls
    // and results appear within 500ms even when experimental stdout tapping is
    // disabled (the production default). Partial JSONL lines are skipped and
    // picked up on the next tick; stable entry ids make broadcasts idempotent.
    const entryPoll = setInterval(() => this._broadcastPersistedEntries(), 500);
    entryPoll.unref?.();
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
      clearInterval(entryPoll);
      this._broadcastPersistedEntries();
      this.activeSandbox = null;
      this._meterTokenUsage();
      this._maybeGenerateTitle(prompt);
    }
  }

  async abort() {
    const submission = this.currentSubmission;
    const sandbox = this.activeSandbox;
    if (!submission || !sandbox) return { cancelled: false, reason: "No active run to stop" };
    this.abortRequestedId = submission.id;
    // Stopping the VM makes the in-flight exec throw; _drain settles the
    // submission as cancelled (not failed) via abortRequestedId. If stop
    // fails, keep abortRequestedId so a late settle still lands on
    // cancelled, and report the failure instead of claiming success.
    try {
      await sandbox.stop();
    } catch (error) {
      return {
        cancelled: false,
        submissionId: submission.id,
        reason: `Stop was not acknowledged: ${error?.message || error}`,
      };
    }
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
