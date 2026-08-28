/** Recovery continuation: interrupted turns are detected and resumed on boot. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-recovery-"));
const sessionDir = join(root, "sess");
Object.assign(process.env, {
  DATA_DIR: join(root, "data"),
  SESSION_SECRET: "recovery-test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "s.jsonl"), [
  { type: "session", version: 3, id: "aaa", timestamp: "2026-08-29T09:00:00.000Z" },
  { type: "message", id: "u1", parentId: null, timestamp: "2026-08-29T09:00:01.000Z", message: { role: "user", content: "ship the feature" } },
].map((e) => JSON.stringify(e)).join("\n") + "\n");

const db = (await import("../lib/db.mjs")).default;
const { SubmissionLedger } = await import("../lib/agent-submissions.mjs");
const { resumeInterruptedSessions, resumePromptFor, detectInterruptedTurn } = await import("../lib/session-recovery.mjs");
const { subscribeSession } = await import("../lib/session-bus.mjs");
const { __injectAgentForTest } = await import("../lib/agent-manager.mjs");
const { AgentHandle } = await import("../lib/agent-rpc-handle.mjs");

db.prepare("INSERT INTO users (id, name) VALUES (?,?)").run("user-1", "Tester");
db.prepare("INSERT INTO spaces (id, org_id, repo_url, repo_name, branch, local_path, owner_id) VALUES (?,?,?,?,?,?,?)")
  .run("space-1", null, "https://example.com/r.git", "r", "main", root, "user-1");
db.prepare("INSERT INTO sessions (id, space_id, owner_id, title, pi_session_dir, model, provider) VALUES (?,?,?,?,?,?,?)")
  .run("sess-1", "space-1", "user-1", "Recovery", sessionDir, null, null);

try {
  // Two turns were in flight when the server died: a goal and a queued follow-up.
  db.prepare("INSERT INTO submissions (id, session_id, prompt, mode, status) VALUES (?,?,?,?,?)")
    .run("sub-goal", "sess-1", "ship the feature", "goal", "running");
  db.prepare("INSERT INTO submissions (id, session_id, prompt, mode, status) VALUES (?,?,?,?,?)")
    .run("sub-next", "sess-1", "then run the tests", "message", "queued");

  const detected = detectInterruptedTurn(db.prepare("SELECT * FROM sessions WHERE id = ?").get("sess-1"));
  assert.equal(detected.submission.id, "sub-goal", "oldest active submission is the resume candidate");
  assert.equal(detected.queuedBehind, 1);

  // A real AgentHandle with the RPC channel stubbed: resume runs through the
  // true sendPrompt path (ledger create persists status running).
  const commands = [];
  const handle = new AgentHandle(
    { id: "sess-1", space_id: "space-1", pi_session_dir: sessionDir, title: "Recovery" },
    () => {},
  );
  handle._send = async (command) => { commands.push(command); return { success: true, command }; };
  handle._meterTokenUsage = () => {};
  handle._maybeRename = () => {};
  handle.isReady = true;
  handle.ready = Promise.resolve();
  __injectAgentForTest("sess-1", handle);

  const events = [];
  subscribeSession("sess-1", (event) => events.push(event));

  const { resumed, failed } = await resumeInterruptedSessions({ log: () => {} });
  assert.equal(resumed, 1);
  assert.equal(failed, 0);

  // The interrupted goal turn is resumed with a continuation instruction…
  const promptCommand = commands.find((command) => command.type === "prompt");
  assert.ok(promptCommand, "resume sends a prompt to pi");
  assert.equal(promptCommand.message, resumePromptFor("goal"));
  assert.equal(promptCommand.streamingBehavior, "followUp");
  // …under the ORIGINAL submission id, so clients reconcile instead of duplicate.
  const row = db.prepare("SELECT status FROM submissions WHERE id = 'sub-goal'").get();
  assert.equal(row.status, "running", "interrupted row is running again");

  // The queued sibling rides behind as a pi follow-up.
  const followUp = commands.find((command) => command.type === "follow_up");
  assert.ok(followUp, "sibling is re-queued as a follow-up");
  assert.equal(followUp.message, "then run the tests");

  // Viewers learn about the resume through the session bus.
  const resumedEvent = events.find((event) => event.type === "resumed");
  assert.ok(resumedEvent, "resumed event is broadcast");
  assert.equal(resumedEvent.submissionId, "sub-goal");

  // A second scan is a no-op: nothing is recoverable anymore.
  const again = await resumeInterruptedSessions({ log: () => {} });
  assert.deepEqual(again, { resumed: 0, failed: 0 });

  // Turn settles: the ledger completes and the row is durable.
  const { normalizeAgentEvent } = await import("../lib/agent-rpc-events.mjs");
  normalizeAgentEvent(handle, { type: "agent_start" });
  normalizeAgentEvent(handle, { type: "agent_settled" });
  assert.equal(db.prepare("SELECT status FROM submissions WHERE id = 'sub-goal'").get().status, "completed");

  console.log("recovery continuation regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
