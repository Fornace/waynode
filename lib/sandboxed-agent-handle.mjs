import db from "./db.mjs";
import { computeSessionTokenTotal, readGoalStatus, runPiMessage } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordSessionTokenTotal } from "./billing.mjs";
import { createRequestId } from "./agent-rpc-events.mjs";

/** Run each chat turn in a fresh microsandbox while preserving the SSE API. */
export class SandboxedAgentHandle {
  constructor(session) {
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
  }

  async start() {}

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    subscriber({
      type: "sync",
      streaming: this.streaming,
      partialText: this.liveText,
      tools: this.liveTools,
    });
    return () => this.subscribers.delete(subscriber);
  }

  broadcast(event) {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch {}
    }
  }

  async sendPrompt(prompt, isGoal = false) {
    if (this.streaming) return;
    this.streaming = true;
    this.lastUserPrompt = prompt;
    this._lastActive = Date.now();

    const messageId = createRequestId();
    this.broadcast({ type: "start" });
    this.broadcast({ type: "message_start", messageId });

    let streamedLength = 0;
    const onChunk = (chunk) => {
      if (!chunk) return;
      this.liveText += chunk;
      streamedLength += chunk.length;
      this.broadcast({ type: "text_delta", messageId, delta: chunk });
    };

    try {
      const result = await runPiMessage({ session: this.session, prompt, isGoal, onChunk });
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
      if (result.stderr && /error|fail|exception/i.test(result.stderr)) {
        this.broadcast({ type: "error", message: result.stderr.slice(0, 500) });
      }
      this.broadcast({ type: "message_end", messageId });
    } catch (error) {
      console.error(`[sandbox:${this.sessionId}] message failed:`, error.message);
      this.broadcast({ type: "error", message: error.message || "Sandboxed run failed" });
    } finally {
      this.streaming = false;
      this.liveText = "";
      this.broadcast({ type: "end" });
    }

    this._meterTokenUsage();
    this._maybeGenerateTitle(prompt);
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
