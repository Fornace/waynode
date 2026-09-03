import { randomUUID } from "node:crypto";
import db from "./db.mjs";

export const SUBMISSION_MODES = Object.freeze(["message", "goal", "hammersmith"]);
export const ACTIVE_SUBMISSION_STATUSES = Object.freeze(["queued", "starting", "running", "interrupted"]);

export function normalizeSubmissionMode(mode = "message") {
  if (mode == null) return "message";
  if (SUBMISSION_MODES.includes(mode)) return mode;
  throw new TypeError("Unknown submission mode");
}

export function goalPrompt(prompt, mode) {
  if (mode !== "goal") return prompt;
  return `You are executing a durable Waynode Goal. Start by calling create_goal with this concrete objective and a token_budget of 50000000, then keep working autonomously until the objective is fully achieved. Before stopping, audit every explicit requirement against concrete evidence; only then call update_goal with status complete.\n\nObjective:\n${prompt}`;
}

function rowRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    prompt: row.prompt,
    mode: normalizeSubmissionMode(row.mode),
    status: row.status,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameOwnership(row, record) {
  return row.session_id === record.sessionId
    && row.prompt === record.prompt
    && normalizeSubmissionMode(row.mode) === record.mode;
}

function claimRow(record, { resume = false } = {}) {
  const inserted = db.prepare(`
    INSERT INTO submissions (id, session_id, prompt, mode, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(record.id, record.sessionId, record.prompt, record.mode, record.status, record.error || null);
  if (inserted.changes === 1) return { claimed: true, record: null };

  const existing = db.prepare("SELECT * FROM submissions WHERE id = ?").get(record.id);
  if (!sameOwnership(existing, record)) {
    const error = new Error("submissionId already belongs to another request");
    error.status = 409;
    error.code = "SUBMISSION_OWNERSHIP_CONFLICT";
    throw error;
  }
  if (resume && ACTIVE_SUBMISSION_STATUSES.includes(existing.status)) {
    db.prepare(`
      UPDATE submissions SET status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ? AND session_id = ?
    `).run(record.status, record.error || null, record.id, record.sessionId);
    return { claimed: true, record: null };
  }
  return { claimed: false, record: rowRecord(existing) };
}

function persistStatus(record) {
  const result = db.prepare(`
    UPDATE submissions SET status = ?, error = ?, updated_at = datetime('now')
    WHERE id = ? AND session_id = ?
  `).run(record.status, record.error || null, record.id, record.sessionId);
  if (result.changes !== 1) throw new Error(`Submission ${record.id} is no longer owned by session ${record.sessionId}`);
}

/** Durable, per-session submission ledger. Persistence is part of acceptance. */
export class SubmissionLedger {
  constructor(emit, { sessionId } = {}) {
    this.emit = emit;
    this.sessionId = sessionId;
    this.records = new Map();
  }

  static lookup(id) {
    const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
    return row ? { sessionId: row.session_id, submission: rowRecord(row) } : null;
  }

  static activeSubmissionRows(sessionId) {
    return db.prepare(`
      SELECT id, prompt, mode, status, error, created_at, updated_at
      FROM submissions WHERE session_id = ? AND status IN ('queued','starting','running','interrupted')
      ORDER BY datetime(created_at), rowid
    `).all(sessionId).map(rowRecord);
  }

  static markInterrupted(sessionId) {
    return db.prepare(`
      UPDATE submissions SET status = 'interrupted', updated_at = datetime('now')
      WHERE session_id = ? AND status IN ('queued','starting','running')
    `).run(sessionId).changes;
  }

  static markAllInterrupted() {
    return db.prepare(`
      UPDATE submissions SET status = 'interrupted', updated_at = datetime('now')
      WHERE status IN ('queued','starting','running')
    `).run().changes;
  }

  static recoverableRows(sessionId) {
    return db.prepare(`
      SELECT id, prompt, mode, status, error, created_at, updated_at
      FROM submissions WHERE session_id = ? AND status IN ('queued','starting','running','interrupted')
      ORDER BY datetime(created_at), rowid
    `).all(sessionId).map(rowRecord);
  }

  static recentRows(sessionId, limit = 20) {
    return db.prepare(`
      SELECT id, prompt, mode, status, error, created_at, updated_at
      FROM submissions WHERE session_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?
    `).all(sessionId, limit).map(rowRecord);
  }

  create({ id = randomUUID(), prompt, mode = "message", status = "starting", resume = false } = {}) {
    const record = {
      id, sessionId: this.sessionId, prompt, mode: normalizeSubmissionMode(mode), status,
      error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const claim = claimRow(record, { resume });
    if (!claim.claimed) return { record: claim.record, created: false };

    let resolve;
    record.completion = new Promise((done) => { resolve = done; });
    record.resolve = resolve;
    this.records.set(id, record);
    this.publish(record);
    return { record, created: true };
  }

  get(id) { return this.records.get(id) || null; }

  publicRecord(record) {
    if (!record) return null;
    return {
      id: record.id, prompt: record.prompt, mode: record.mode,
      status: record.status, error: record.error || null,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
    };
  }

  snapshot() { return [...this.records.values()].map((record) => this.publicRecord(record)); }
  queuedRecords() { return [...this.records.values()].filter((record) => record.status === "queued"); }

  update(record, status, error = null) {
    if (!record?.resolve) return record;
    const before = { status: record.status, error: record.error, updatedAt: record.updatedAt };
    record.status = status;
    record.error = error ? String(error.message || error) : null;
    record.updatedAt = new Date().toISOString();
    try { persistStatus(record); } catch (cause) {
      Object.assign(record, before);
      throw cause;
    }
    this.publish(record);
    return record;
  }

  settle(record, status, error = null) {
    this.update(record, status, error);
    record.resolve(this.publicRecord(record));
    return record;
  }

  cancelQueued() {
    const cancelled = [];
    for (const record of this.queuedRecords()) {
      this.settle(record, "cancelled");
      cancelled.push(record);
    }
    return cancelled;
  }

  failActive(error) {
    for (const record of this.records.values()) {
      if (["queued", "starting", "running"].includes(record.status)) this.settle(record, "failed", error);
    }
  }

  publish(record) { this.emit?.({ type: "submission", submission: this.publicRecord(record) }); }
}
