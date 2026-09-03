/** Durable submission claims are fail-closed, immutable, and idempotent. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-submission-claims-"));
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "submission-claim-test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

const db = (await import("../lib/db.mjs")).default;
const { SubmissionLedger } = await import("../lib/agent-submissions.mjs");

try {
  const sessionA = new SubmissionLedger(() => {}, { sessionId: "session-a" });
  const sessionB = new SubmissionLedger(() => {}, { sessionId: "session-b" });

  const first = sessionA.create({ id: "stable-id", prompt: "hello", mode: "goal", status: "starting" });
  assert.equal(first.created, true);
  const immutable = db.prepare("SELECT * FROM submissions WHERE id = ?").get("stable-id");

  const duplicate = sessionA.create({ id: "stable-id", prompt: "hello", mode: "goal", status: "starting" });
  assert.equal(duplicate.created, false);
  assert.deepEqual(
    { id: duplicate.record.id, prompt: duplicate.record.prompt, mode: duplicate.record.mode, status: duplicate.record.status },
    { id: "stable-id", prompt: "hello", mode: "goal", status: "starting" },
  );

  for (const [ledger, prompt, mode] of [
    [sessionB, "hello", "goal"],
    [sessionA, "changed", "goal"],
    [sessionA, "hello", "message"],
  ]) {
    assert.throws(
      () => ledger.create({ id: "stable-id", prompt, mode, status: "starting" }),
      (error) => error.status === 409 && error.code === "SUBMISSION_OWNERSHIP_CONFLICT",
    );
  }
  const unchanged = db.prepare("SELECT * FROM submissions WHERE id = ?").get("stable-id");
  assert.equal(unchanged.session_id, immutable.session_id);
  assert.equal(unchanged.prompt, immutable.prompt);
  assert.equal(unchanged.mode, immutable.mode);

  first.record.status = "running";
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("UPDATE submissions SET status = ?, error = ?")) throw new Error("disk full");
    return originalPrepare(sql);
  };
  assert.throws(() => sessionA.update(first.record, "completed"), /disk full/);
  assert.equal(first.record.status, "running", "failed persistence rolls memory back");
  db.prepare = originalPrepare;

  assert.deepEqual(SubmissionLedger.lookup("stable-id"), {
    sessionId: "session-a",
    submission: {
      id: "stable-id", prompt: "hello", mode: "goal", status: "starting", error: null,
      createdAt: unchanged.created_at, updatedAt: unchanged.updated_at,
    },
  });
  console.log("durable submission claim regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
