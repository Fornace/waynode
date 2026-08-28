import { SubmissionLedger, goalPrompt } from "./agent-submissions.mjs";
import { projectAfter } from "./pi-session-projection.mjs";
import { publishSessionEvent } from "./session-bus.mjs";

/**
 * Shared durable surface for both execution substrates:
 * - long-lived pi RPC (self-host)
 * - one-shot microsandbox turns (hosted)
 *
 * Transport and clients never care which substrate runs the agent. Both emit
 * the same sync snapshot, durable entry batches, submission lifecycle, and
 * session-bus events. Keeping this in one class prevents the hosted/self-host
 * UX from drifting again.
 */
export class AgentSurface {
  constructor(session) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.piSessionDir = session.pi_session_dir;
    this.streaming = false;
    this.dead = false;
    this.subscribers = new Set();
    this.liveText = "";
    this.liveThinking = "";
    this.liveTools = [];
    this.curMsgId = null;
    this._lastEntryId = null;
    this._lastActive = Date.now();
    this.submissions = new SubmissionLedger((event) => this.broadcast(event), { sessionId: session.id });
  }

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

  /** Full-fidelity, stable-id items persisted since the last broadcast. */
  _broadcastPersistedEntries() {
    try {
      const { items: entries, leafId } = projectAfter(this.piSessionDir, this._lastEntryId);
      if (entries.length === 0) return;
      this.annotateSubmissions(entries);
      this._lastEntryId = leafId;
      this.broadcast({ type: "entries", entries, leafId });
    } catch (error) {
      console.error(`[agent-surface:${this.sessionId}] entries broadcast failed:`, error.message);
    }
  }

  /** Tag persisted user entries with the accepted submission id. */
  annotateSubmissions(entries) {
    const active = [...this.submissions.records.values()].filter((record) =>
      ["queued", "starting", "running"].includes(record.status),
    );
    for (const entry of entries) {
      if (entry.role !== "user") continue;
      const match = active.find((record) => {
        const wrapped = goalPrompt(record.prompt, record.mode);
        return entry.text === record.prompt || entry.text === wrapped || entry.text.includes(record.prompt);
      });
      if (match) entry.submissionId = match.id;
    }
  }

  getSubmission(submissionId) {
    return this.submissions.publicRecord(this.submissions.get(submissionId));
  }

  getSubmissionSnapshot() {
    return this.submissions.snapshot();
  }
}
