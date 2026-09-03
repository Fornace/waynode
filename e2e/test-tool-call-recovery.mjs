/** Interrupted tool calls are completed once from the fsync journal or as uncertain errors. */
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { repairInterruptedToolCalls } from "../lib/pi-tool-recovery.mjs";
import { projectSession, readSessionEntries } from "../lib/pi-session-projection.mjs";

const root = mkdtempSync(join(tmpdir(), "waynode-tool-recovery-"));

function makeSession(name, calls) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, [
    { type: "session", version: 3, id: name, timestamp: "2026-09-03T00:00:00.000Z" },
    { type: "message", id: "user0001", parentId: null, timestamp: "2026-09-03T00:00:01.000Z", message: { role: "user", content: "run" } },
    { type: "message", id: "assist01", parentId: "user0001", timestamp: "2026-09-03T00:00:02.000Z", message: {
      role: "assistant", content: calls.map((call) => ({
        type: "toolCall", id: call.id, name: call.name, arguments: call.arguments || {},
      })),
    } },
  ].map(JSON.stringify).join("\n") + "\n");
  return { dir, file };
}

function result(callId, text = "created-once") {
  return {
    toolCallId: callId, toolName: "bash", content: [{ type: "text", text }],
    details: { exitCode: 0 }, isError: false, timestamp: 123,
  };
}

function writeJournal(session, results, options = {}) {
  const value = options.version === 1 ? {
    version: 1,
    sessionFile: options.sessionFile || session.file,
    results,
  } : { version: 2, sessionId: options.sessionId || basename(session.file, ".jsonl"), results };
  writeFileSync(`${session.file}.waynode-tools.json`, `${JSON.stringify(value)}\n`);
}

function appendResult(session, callId, parentId = "assist01") {
  writeFileSync(session.file, `${readFileSync(session.file, "utf8")}${JSON.stringify({
    type: "message", id: `done-${callId}`, parentId, timestamp: "2026-09-03T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
  })}\n`);
}

function assertNoJournal(session, message) {
  assert.equal(existsSync(`${session.file}.waynode-tools.json`), false, message);
}

try {
  // Crash before or during execution: no final result exists, so recover as
  // uncertain and prevent Pi from automatically replaying the tool call.
  for (const name of ["before-execution", "during-execution"]) {
    const session = makeSession(name, [{ id: `call-${name}`, name: "bash" }]);
    assert.deepEqual(repairInterruptedToolCalls(session.dir), { repaired: 1, restored: 0, uncertain: 1 });
    const fallback = projectSession(session.dir).items.at(-1);
    assert.equal(fallback.isError, true);
    assert.match(fallback.text, /may have produced side effects/);
  }

  // Crash after journal fsync, including after message_end but before Pi's
  // subsequent JSONL append: the exact finalized result remains recoverable.
  for (const name of ["after-journal-fsync", "after-message-end"]) {
    const session = makeSession(name, [{ id: `call-${name}`, name: "bash" }]);
    writeJournal(session, { [`call-${name}`]: result(`call-${name}`, name) });
    assert.deepEqual(repairInterruptedToolCalls(session.dir), { repaired: 1, restored: 1, uncertain: 0 });
    assert.equal(projectSession(session.dir).items.at(-1).text, name);
    assertNoJournal(session, "restored final result is consumed only after JSONL append is fsynced");
  }

  // Hosted microVM journals identify sessions by Pi session id rather than
  // the guest /workspace absolute path. Legacy v1 uses adjacent filename.
  const hosted = makeSession("hosted-path", [{ id: "call-hosted", name: "bash" }]);
  writeJournal(hosted, { "call-hosted": result("call-hosted", "hosted exact") }, {
    version: 1, sessionFile: `/workspace/.waynode/sessions/hosted-path/${basename(hosted.file)}`,
  });
  assert.deepEqual(repairInterruptedToolCalls(hosted.dir), { repaired: 1, restored: 1, uncertain: 0 });
  assert.equal(projectSession(hosted.dir).items.at(-1).text, "hosted exact");

  const wrongIdentity = makeSession("wrong-identity", [{ id: "call-other", name: "bash" }]);
  writeJournal(wrongIdentity, { "call-other": result("call-other") }, { sessionId: "another-session" });
  assert.deepEqual(repairInterruptedToolCalls(wrongIdentity.dir), { repaired: 1, restored: 0, uncertain: 1 },
    "an adjacent journal with another stable session id is never trusted");

  // Crash after normal JSONL persistence but before agent_settled: recovery
  // proves persistence before removing the redundant sidecar record.
  const persisted = makeSession("persisted-cleanup", [{ id: "call-persisted", name: "bash" }]);
  appendResult(persisted, "call-persisted");
  writeJournal(persisted, { "call-persisted": result("call-persisted") });
  writeFileSync(`${persisted.file}.waynode-tools.json.999.stale.tmp`, "partial");
  assert.deepEqual(repairInterruptedToolCalls(persisted.dir), { repaired: 0, restored: 0, uncertain: 0 });
  assertNoJournal(persisted, "a normally persisted result consumes its redundant journal record");
  assert.deepEqual(readdirSync(persisted.dir).filter((name) => name.endsWith(".tmp")), [],
    "stale interrupted temporary writes are cleaned");

  const partial = makeSession("partial", [
    { id: "call-done", name: "read" }, { id: "call-pending", name: "bash" },
  ]);
  appendResult(partial, "call-done");
  assert.deepEqual(repairInterruptedToolCalls(partial.dir), { repaired: 1, restored: 0, uncertain: 1 });
  const resultIds = readSessionEntries(partial.dir)
    .filter((entry) => entry.message?.role === "toolResult").map((entry) => entry.message.toolCallId);
  assert.deepEqual(resultIds, ["call-done", "call-pending"]);
  assert.deepEqual(repairInterruptedToolCalls(partial.dir), { repaired: 0, restored: 0, uncertain: 0 },
    "a repaired call is never appended twice");

  console.log("interrupted tool finalization crash-window regressions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
