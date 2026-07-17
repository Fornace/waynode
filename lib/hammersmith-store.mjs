import { randomUUID } from "node:crypto";
import db from "./db.mjs";
import { finishTokenReservation, releaseTokenReservation } from "./billing.mjs";

db.exec(`
  CREATE TABLE IF NOT EXISTS hammersmith_jobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    run_id TEXT,
    job_description TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('running','finished','stopped')),
    total_tasks INTEGER NOT NULL DEFAULT 1,
    checked_tasks INTEGER NOT NULL DEFAULT 0,
    passed_tasks INTEGER NOT NULL DEFAULT 0,
    failed_tasks INTEGER NOT NULL DEFAULT 0,
    state_dir TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    billing_reservation_id TEXT,
    runtime_kind TEXT,
    runtime_id TEXT,
    runtime_pid INTEGER,
    git_fingerprint TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
`);

try {
  const jobColumns = db.prepare("PRAGMA table_info(hammersmith_jobs)").all();
  if (!jobColumns.some((column) => column.name === "submission_id")) {
    db.exec("ALTER TABLE hammersmith_jobs ADD COLUMN submission_id TEXT");
  }
  for (const [name, type] of [
    ["billing_reservation_id", "TEXT"], ["runtime_kind", "TEXT"],
    ["runtime_id", "TEXT"], ["runtime_pid", "INTEGER"], ["git_fingerprint", "TEXT"],
  ]) {
    if (!jobColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE hammersmith_jobs ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS hammersmith_submission_identity
    ON hammersmith_jobs(owner_id, session_id, submission_id) WHERE submission_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS hammersmith_one_running_per_space
    ON hammersmith_jobs(space_id) WHERE lifecycle = 'running';`);
  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  if (!columns.some((column) => column.name === "composer_mode")) {
    db.exec("ALTER TABLE sessions ADD COLUMN composer_mode TEXT NOT NULL DEFAULT 'message'");
  }
} catch (error) {
  console.error("Failed to migrate Hammersmith session state:", error.message);
}

const now = () => new Date().toISOString();

function transaction(operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function reconcileInterruptedHammersmithJobs() {
  const stamp = now();
  db.prepare(`UPDATE hammersmith_jobs SET
    error = COALESCE(error, 'Waynode restarted before shutdown was acknowledged; the Space lock is retained'),
    updated_at = ? WHERE lifecycle = 'running'`).run(stamp);
}

export function createHammersmithJob({
  id = randomUUID(), ownerId, sessionId, submissionId, spaceId, jobDescription,
  stateDir, manifestPath, billingReservationId = null, runtimeKind = null,
}) {
  if (typeof submissionId !== "string" || !submissionId || submissionId.length > 128) {
    throw Object.assign(new TypeError("submission_id required"), { status: 400 });
  }
  const stamp = now();
  const create = () => transaction(() => {
    const existing = getHammersmithJobBySubmission(ownerId, sessionId, submissionId);
    if (existing) return existing;
    db.prepare(`INSERT INTO hammersmith_jobs
      (id, owner_id, session_id, submission_id, space_id, job_description, lifecycle,
       state_dir, manifest_path, billing_reservation_id, runtime_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run(
        id, ownerId, sessionId, submissionId, spaceId, jobDescription,
        stateDir, manifestPath, billingReservationId, runtimeKind, stamp, stamp,
      );
    db.prepare("UPDATE sessions SET composer_mode = 'message', updated_at = datetime('now') WHERE id = ?")
      .run(sessionId);
    return getHammersmithJob(id);
  });
  try {
    return create();
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      const duplicate = getHammersmithJobBySubmission(ownerId, sessionId, submissionId);
      if (duplicate) return duplicate;
      const busy = new Error("A Hammersmith job is already running in this Space");
      busy.status = 409;
      throw busy;
    }
    throw error;
  }
}

export function updateHammersmithJob(id, fields) {
  const allowed = [
    "run_id", "lifecycle", "total_tasks", "checked_tasks", "passed_tasks",
    "failed_tasks", "error", "finished_at", "runtime_kind", "runtime_id",
    "runtime_pid", "git_fingerprint", "billing_reservation_id",
  ];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return getHammersmithJob(id);
  const stamp = now();
  db.prepare(`UPDATE hammersmith_jobs SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), stamp, id);
  const job = getHammersmithJob(id);
  if (["finished", "stopped"].includes(job?.lifecycle)) settleHammersmithReservation(job);
  return getHammersmithJob(id);
}

export function settleHammersmithReservation(job) {
  if (!job?.billing_reservation_id || !["finished", "stopped"].includes(job.lifecycle)) return;
  const reservationId = job.billing_reservation_id;
  if (job.lifecycle === "finished") finishTokenReservation(reservationId);
  else releaseTokenReservation(reservationId);
  db.prepare("UPDATE hammersmith_jobs SET billing_reservation_id = NULL WHERE id = ? AND billing_reservation_id = ?")
    .run(job.id, reservationId);
}

export function getHammersmithJob(id) {
  return db.prepare("SELECT * FROM hammersmith_jobs WHERE id = ?").get(id) || null;
}

export function getHammersmithJobBySubmission(ownerId, sessionId, submissionId) {
  return db.prepare(`SELECT * FROM hammersmith_jobs
    WHERE owner_id = ? AND session_id = ? AND submission_id = ?`).get(ownerId, sessionId, submissionId) || null;
}

export function listHammersmithJobs(sessionId) {
  return db.prepare("SELECT * FROM hammersmith_jobs WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
}

export function hasRunningHammersmithJob(spaceId) {
  return !!db.prepare("SELECT 1 FROM hammersmith_jobs WHERE space_id = ? AND lifecycle = 'running' LIMIT 1").get(spaceId);
}

export function publicHammersmithJob(job, monitorUrl = null) {
  if (!job) return null;
  return {
    id: job.id,
    submissionId: job.submission_id,
    runId: job.run_id || null,
    sessionId: job.session_id,
    spaceId: job.space_id,
    description: job.job_description,
    lifecycle: job.lifecycle,
    totalTasks: job.total_tasks,
    checkedTasks: job.checked_tasks,
    passedTasks: job.passed_tasks,
    failedTasks: job.failed_tasks,
    updatedAt: job.updated_at,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    error: job.error || null,
    monitorUrl,
  };
}

export function sessionForHammersmith(sessionId, ownerId) {
  return db.prepare(`SELECT sessions.*, spaces.local_path, spaces.org_id FROM sessions
    JOIN spaces ON spaces.id = sessions.space_id
    WHERE sessions.id = ? AND sessions.owner_id = ?`).get(sessionId, ownerId) || null;
}

export function settingForUser(userId, key) {
  return db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, key)?.value ?? null;
}

export function setSettingsForUser(userId, entries) {
  const statement = db.prepare(`INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`);
  transaction(() => {
    for (const [key, value] of Object.entries(entries)) statement.run(userId, key, value);
  });
}

reconcileInterruptedHammersmithJobs();
