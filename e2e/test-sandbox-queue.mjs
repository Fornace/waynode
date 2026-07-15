/** Hosted sandbox follow-up FIFO and completion-contract regression. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-sandbox-queue-"));
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "sandbox-queue-test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

const { SandboxedAgentHandle } = await import("../lib/sandboxed-agent-handle.mjs");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("queue test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function testHandle(runMessage) {
  const handle = new SandboxedAgentHandle({
    id: "session", space_id: "space", pi_session_dir: root,
  }, { runMessage });
  handle._meterTokenUsage = () => {};
  handle._maybeGenerateTitle = () => {};
  return handle;
}

try {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const events = [];
  const handle = testHandle(async ({ prompt, isGoal, onChunk }) => {
    calls.push({ prompt, isGoal });
    if (prompt === "first") await first.promise;
    if (prompt === "second") await second.promise;
    onChunk(`${prompt}-done`);
    return { status: 0, stdout: `${prompt}-done`, stderr: "" };
  });
  handle.subscribe((event) => events.push(event.type));

  const initialCompletion = handle.sendPrompt("first", false, "first-id");
  await until(() => calls.length === 1);
  let queuedCompleted = false;
  const queuedCompletion = handle.queueFollowUp("second", true, "second-id").then(() => { queuedCompleted = true; });
  const duplicateCompletion = handle.queueFollowUp("second", true, "second-id");
  handle.queueFollowUp("third", false, "third-id");
  first.resolve();
  await until(() => calls.some((call) => call.prompt === "second"));
  assert.equal(queuedCompleted, false, "queued promise does not finish in the turn boundary");
  assert.equal(handle.streaming, true, "streaming remains continuous across the FIFO");
  second.resolve();
  await Promise.all([queuedCompletion, duplicateCompletion]);
  await initialCompletion;
  assert.deepEqual(calls, [
    { prompt: "first", isGoal: false },
    { prompt: "second", isGoal: true },
    { prompt: "third", isGoal: false },
  ], "goal mode and duplicate suppression survive the FIFO");
  assert.equal(events.filter((type) => type === "start").length, 3);
  assert.equal(events.filter((type) => type === "end").length, 3);
  assert.equal(handle.streaming, false);

  const blocked = deferred();
  const bounded = testHandle(async () => {
    await blocked.promise;
    return { status: 0, stdout: "ok", stderr: "" };
  });
  const boundedRun = bounded.sendPrompt("active");
  await until(() => bounded.streaming);
  const accepted = Array.from({ length: 5 }, (_, index) => bounded.queueFollowUp(`q${index}`));
  assert.throws(() => bounded.queueFollowUp("overflow", false, "overflow"), /At most 5/);
  assert.equal(bounded.getSubmission("overflow"), null, "rejected work is not left in queue state");
  blocked.resolve();
  await Promise.all([boundedRun, ...accepted]);
  const attempts = [];
  const retrying = testHandle(async ({ prompt }) => {
    attempts.push(prompt);
    if (attempts.length === 1) throw new Error("first attempt failed");
    return { status: 0, stdout: "recovered", stderr: "" };
  });
  const failed = await retrying.sendPrompt("retry me", false, "attempt-1");
  assert.equal(failed.status, "failed");
  assert.equal((await retrying.sendPrompt("retry me", false, "attempt-1")).status, "failed");
  assert.deepEqual(attempts, ["retry me"], "same submission id never executes twice");
  assert.equal((await retrying.sendPrompt("retry me", false, "attempt-2")).status, "completed");
  assert.deepEqual(attempts, ["retry me", "retry me"], "an explicit new retry executes exactly once");

  console.log("sandbox queue: truth, goal, bounds, exact retry and deduplication PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
