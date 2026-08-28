import { createRequestId } from "./agent-rpc-events.mjs";
import db from "./db.mjs";

const ACTIVE = new Set(["queued", "starting", "running"]);
const PERSISTED = new Set(["queued", "starting", "running", "completed", "failed", "cancelled"]);

export const SUBMISSION_MODES = ["message", "goal", "hammersmith"];

export function normalizeSubmissionMode(mode = "message") {
  if (mode == null) return "message";
  if (SUBMISSION_MODES.includes(mode)) return mode;
  throw new TypeError("Unknown submission mode");
}

export function goalPrompt(prompt, mode) {
  return normalizeSubmissionMode(mode) === "goal"
    ? `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: ${prompt}`
    : prompt;
}

function persistRow(record) {
  try {
    const error = record.error ? String(record.error.message ?? record.error) : null;
    db.prepare(`
      INSERT INTO submissions (id, session_id, prompt, mode, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        updated_at = datetime('now')
    `).run(record.id, record.sessionId, record.prompt, record.mode, record.status, error);
  } catch (error) {
    // Persistence is a durability aid, never a turn blocker.
    console.error(`[submissions] persist failed for ${record.id}:`, error.message);
  }
}

/**
 * Submission ledger: the user-facing truth of what was sent, what is queued
 * or running, and how it ended. Every state change is written through to the
 * submissions table so a server restart knows exactly which turns were in
 * flight (recovery continuation) and any device can see active work.
 */
export class SubmissionLedger {
  constructor(broadcast, { sessionId = null } = {}) {
    this.broadcast = broadcast;
    this.sessionId = sessionId;
    this.records = new Map();
  }

  static activeSubmissionRows(sessionId) {
    try {
      return db
        .prepare("SELECT id, prompt, mode, status, created_at, updated_at FROM submissions WHERE session_id = ? AND status IN ('queued','starting','running') ORDER BY created_at")
        .all(sessionId);
    } catch {
      return [];
    }
  }

  static markInterrupted(sessionId) {
    try {
      db.prepare(`
        UPDATE submissions SET status = 'interrupted', updated_at = datetime('now')
        WHERE session_id = ? AND status IN ('queued','starting','running')
      `).run(sessionId);
    } catch {}
  }

  static recent(sessionId, limit = 50) {
    try {
      return db
        .prepare("SELECT id, prompt, mode, status, error, created_at, updated_at FROM submissions WHERE session_id = ? ORDER BY datetime(created_at) DESC LIMIT ?")
        .all(sessionId, limit);
    } catch {
      return [];
    }
  }

  create({ id = createRequestId(), prompt, mode, status, persist = true }) {
    const existing = this.records.get(id);
    if (existing) return { record: existing, duplicate: true };
    let resolve;
    let reject;
    const completion = new Promise((done, fail) => { resolve = done; reject = fail; });
    const record = {
      id,
      sessionId: this.sessionId,
      prompt,
      mode: normalizeSubmissionMode(mode),
      status,
      completion,
      resolve,
      reject,
    };
    this.records.set(id, record);
    if (persist && this.sessionId) persistRow(record);
    this.emit(record);
    return { record, duplicate: false };
  }

  get(id) {
    return this.records.get(id) || null;
  }

  update(record, status, error = null) {
    if (!record) return;
    record.status = status;
    record.error = error || undefined;
    if (this.sessionId && PERSISTED.has(status)) persistRow(record);
    this.emit(record);
  }

  settle(record, status, error = null) {
    if (!record || !ACTIVE.has(record.status)) return;
    this.update(record, status, error);
    record.resolve({ status, ...(error ? { error: error.message || String(error) } : {}) });
    this.prune();
  }

  /** Mark every active record as interrupted (process death). */
  failActive(error) {
    for (const record of this.records.values()) {
      if (ACTIVE.has(record.status)) this.settle(record, "interrupted", error);
    }
  }

  publicRecord(record) {
    if (!record) return null;
    const { id, prompt, mode, status, error } = record;
    return { id, prompt, mode, status, ...(error ? { error: error.message || String(error) } : {}) };
  }

  snapshot() {
    return [...this.records.values()].filter((record) => ACTIVE.has(record.status)).map((record) => this.publicRecord(record));
  }

  /** FIFO list of active queued records in send order (Map insertion order). */
  queuedRecords() {
    return [...this.records.values()].filter((record) => record.status === "queued");
  }

  emit(record) {
    this.broadcast({ type: "submission", submission: this.publicRecord(record) });
  }

  prune() {
    if (this.records.size <= 100) return;
    for (const [id, record] of this.records) {
      if (!ACTIVE.has(record.status)) this.records.delete(id);
      if (this.records.size <= 80) break;
    }
  }
}
