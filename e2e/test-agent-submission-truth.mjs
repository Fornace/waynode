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
  const first = handle.sendPrompt("first", false, "first-id");
  await Promise.resolve();
  normalizeAgentEvent(handle, { type: "agent_start" });
  const goal = handle.queueFollowUp("ship it", true, "goal-id");
  const duplicate = handle.queueFollowUp("ship it", true, "goal-id");
  assert.equal(commands.filter((command) => command.type === "follow_up").length, 1);
  assert.match(commands.find((command) => command.type === "follow_up").message, /create_goal/);
  assert.equal(handle.getSubmission("goal-id").isGoal, true);

  handle._onAgentEnd();
  assert.equal((await first).status, "completed");
  assert.equal(handle.getSubmission("goal-id").status, "starting");
  normalizeAgentEvent(handle, { type: "agent_start" });
  handle._onAgentEnd();
  assert.equal((await goal).status, "completed");
  assert.equal((await duplicate).status, "completed");

  const abortCommands = [];
  const aborting = handleWith(abortCommands);
  const cancelled = aborting.sendPrompt("stop me", false, "cancel-id");
  await Promise.resolve();
  await aborting.abort();
  aborting._onAgentEnd();
  assert.equal((await cancelled).status, "cancelled");

  const failedCommands = [];
  const failing = handleWith(failedCommands, async () => { throw new Error("command rejected"); });
  await assert.rejects(failing.sendPrompt("retry", false, "failed-id"), /command rejected/);
  assert.equal((await failing.sendPrompt("retry", false, "failed-id")).status, "failed");
  assert.equal(failedCommands.length, 1, "retrying one id cannot duplicate an RPC command");
  console.log("RPC submission lifecycle regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
