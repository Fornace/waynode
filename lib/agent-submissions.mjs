import { createRequestId } from "./agent-rpc-events.mjs";

const ACTIVE = new Set(["queued", "starting", "running"]);

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

export class SubmissionLedger {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.records = new Map();
  }

  create({ id = createRequestId(), prompt, mode, status }) {
    const existing = this.records.get(id);
    if (existing) return { record: existing, duplicate: true };
    let resolve;
    let reject;
    const completion = new Promise((done, fail) => { resolve = done; reject = fail; });
    const record = { id, prompt, mode: normalizeSubmissionMode(mode), status, completion, resolve, reject };
    this.records.set(id, record);
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
    this.emit(record);
  }

  settle(record, status, error = null) {
    if (!record || !ACTIVE.has(record.status)) return;
    this.update(record, status, error);
    record.resolve({ status, ...(error ? { error: error.message || String(error) } : {}) });
    this.prune();
  }

  failActive(error) {
    for (const record of this.records.values()) {
      if (ACTIVE.has(record.status)) this.settle(record, "failed", error);
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
