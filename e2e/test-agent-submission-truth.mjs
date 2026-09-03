/** Direct RPC handle submission lifecycle without spawning pi. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-agent-submissions-"));
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "agent-submission-test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

const { AgentHandle } = await import("../lib/agent-rpc-handle.mjs");
const { normalizeAgentEvent } = await import("../lib/agent-rpc-events.mjs");

function handleWith(commands, send = async (command) => ({ success: true, command })) {
  const handle = new AgentHandle({ id: "session", space_id: "space", title: "Test" }, () => {});
  handle._send = async (command) => { commands.push(command); return send(command); };
  handle._meterTokenUsage = () => {};
  handle._maybeRename = () => {};
  return handle;
}

try {
  const commands = [];
  const handle = handleWith(commands);
  const first = handle.sendPrompt("first", "message", "first-id");
  await Promise.resolve();
  normalizeAgentEvent(handle, { type: "agent_start" });
  const goal = handle.queueFollowUp("ship it", "goal", "goal-id");
  const duplicate = handle.queueFollowUp("ship it", "goal", "goal-id");
  assert.equal(commands.filter((command) => command.type === "follow_up").length, 1);
  assert.match(commands.find((command) => command.type === "follow_up").message, /create_goal/);
  assert.equal(handle.getSubmission("goal-id").mode, "goal");

  // agent_end alone never settles: pi may retry, compact, or deliver queued
  // follow-ups after it. Only agent_settled completes the turn.
  normalizeAgentEvent(handle, { type: "agent_end", messages: [] });
  assert.equal(handle.getSubmission("first-id").status, "running");
  normalizeAgentEvent(handle, { type: "agent_settled" });
  assert.equal((await first).status, "completed");
  // pi had the follow-up queued, so the handle stays busy and the next
  // agent_start promotes the queued record FIFO.
  assert.equal(handle.streaming, true);
  assert.equal(handle.getSubmission("goal-id").status, "queued");
  normalizeAgentEvent(handle, { type: "agent_start" });
  assert.equal(handle.getSubmission("goal-id").status, "running");
  normalizeAgentEvent(handle, { type: "agent_end", messages: [] });
  normalizeAgentEvent(handle, { type: "agent_settled" });
  assert.equal((await goal).status, "completed");
  assert.equal((await duplicate).status, "completed");

  const abortCommands = [];
  const aborting = handleWith(abortCommands);
  const cancelled = aborting.sendPrompt("stop me", "message", "cancel-id");
  await Promise.resolve();
  const queuedAfterStop = aborting.queueFollowUp("do not run", "message", "queued-stop-id");
  await aborting.abort();
  assert.deepEqual(
    abortCommands.slice(-2).map((command) => command.type),
    ["clear_queue", "abort"],
    "interactive Stop clears Pi's queue before aborting the active turn",
  );
  assert.equal((await queuedAfterStop).status, "cancelled");
  normalizeAgentEvent(aborting, { type: "agent_settled" });
  assert.equal((await cancelled).status, "cancelled");
  assert.equal(aborting.streaming, false);

  const failedCommands = [];
  const failing = handleWith(failedCommands, async () => { throw new Error("command rejected"); });
  await assert.rejects(failing.sendPrompt("retry", "message", "failed-id"), /command rejected/);
  assert.equal(failing.getSubmission("failed-id").status, "failed");
  assert.equal(failedCommands.length, 1, "retrying one id cannot duplicate an RPC command");

  // Stop failures: a rejected clear_queue must leave pi's queue untouched.
  const clearFailCommands = [];
  const clearFailing = handleWith(clearFailCommands, async (command) => {
    if (command.type === "clear_queue") throw new Error("rpc closed");
    return { success: true, command };
  });
  clearFailing.sendPrompt("keep running", "message", "keep-id");
  await Promise.resolve();
  normalizeAgentEvent(clearFailing, { type: "agent_start" });
  clearFailing.queueFollowUp("still queued", "message", "keep-queued-id");
  const clearFailResult = await clearFailing.abort();
  assert.equal(clearFailResult.cancelled, false);
  assert.match(clearFailResult.reason, /Stop failed/);
  assert.equal(clearFailing.getSubmission("keep-queued-id").status, "queued");
  assert.equal(clearFailing.getSubmission("keep-id").status, "running");
  assert.equal(clearFailCommands.some((command) => command.type === "abort"), false);
  normalizeAgentEvent(clearFailing, { type: "agent_end", messages: [] });
  normalizeAgentEvent(clearFailing, { type: "agent_settled" });
  assert.equal(clearFailing.getSubmission("keep-id").status, "completed");

  // A rejected abort (process death between clear_queue and abort) keeps the
  // cleared-queue truth but reports Stop as unacknowledged.
  const abortFailCommands = [];
  const abortFailing = handleWith(abortFailCommands, async (command) => {
    if (command.type === "abort") throw new Error("process exited");
    return { success: true, command };
  });
  abortFailing.sendPrompt("stop me", "message", "abort-fail-id");
  await Promise.resolve();
  normalizeAgentEvent(abortFailing, { type: "agent_start" });
  abortFailing.queueFollowUp("never starts", "message", "abort-queued-id");
  const abortFailResult = await abortFailing.abort();
  assert.equal(abortFailResult.cancelled, false);
  assert.match(abortFailResult.reason, /not acknowledged/);
  assert.equal(abortFailing.getSubmission("abort-queued-id").status, "cancelled");
  assert.equal(abortFailing.getSubmission("abort-fail-id").status, "running");
  normalizeAgentEvent(abortFailing, { type: "agent_settled" });
  assert.equal(abortFailing.getSubmission("abort-fail-id").status, "cancelled",
    "late settlement of a lost-ack abort lands on cancelled");
  console.log("RPC submission lifecycle regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
