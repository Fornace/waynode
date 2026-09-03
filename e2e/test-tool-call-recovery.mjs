/** Interrupted tool calls are completed once from the fsync journal or as uncertain errors. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairInterruptedToolCalls } from "../lib/pi-tool-recovery.mjs";
import { projectSession, readSessionEntries } from "../lib/pi-session-projection.mjs";

const root = mkdtempSync(join(tmpdir(), "waynode-tool-recovery-"));

function makeSession(name, calls) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
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

try {
  const journaled = makeSession("journaled", [{ id: "call-write", name: "bash" }]);
  writeFileSync(`${journaled.file}.waynode-tools.json`, `${JSON.stringify({
    version: 1,
    sessionFile: journaled.file,
    results: {
      "call-write": {
        toolCallId: "call-write",
        toolName: "bash",
        content: [{ type: "text", text: "created-once" }],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 123,
      },
    },
  })}\n`);
  assert.deepEqual(repairInterruptedToolCalls(journaled.dir), { repaired: 1, restored: 1, uncertain: 0 });
  const restored = projectSession(journaled.dir).items.at(-1);
  assert.equal(restored.role, "toolResult");
  assert.equal(restored.toolCallId, "call-write");
  assert.equal(restored.text, "created-once");
  assert.equal(restored.isError, false);
  assert.deepEqual(repairInterruptedToolCalls(journaled.dir), { repaired: 0, restored: 0, uncertain: 0 },
    "a repaired call is never appended twice");
  assert.equal(existsSync(`${journaled.file}.waynode-tools.json`), false,
    "the restored journal result is consumed and its empty file is removed");

  const unknown = makeSession("unknown", [{ id: "call-unknown", name: "write" }]);
  assert.deepEqual(repairInterruptedToolCalls(unknown.dir), { repaired: 1, restored: 0, uncertain: 1 });
  const fallback = projectSession(unknown.dir).items.at(-1);
  assert.equal(fallback.role, "toolResult");
  assert.equal(fallback.isError, true);
  assert.match(fallback.text, /may have produced side effects/);

  const partial = makeSession("partial", [
    { id: "call-done", name: "read" },
    { id: "call-pending", name: "bash" },
  ]);
  const entries = readSessionEntries(partial.dir);
  writeFileSync(partial.file, `${entries.map(JSON.stringify).join("\n")}\n${JSON.stringify({
    type: "message", id: "done0001", parentId: "assist01", timestamp: "2026-09-03T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call-done", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
  })}\n`);
  assert.deepEqual(repairInterruptedToolCalls(partial.dir), { repaired: 1, restored: 0, uncertain: 1 },
    "only unmatched calls are repaired");
  const resultIds = readSessionEntries(partial.dir)
    .filter((entry) => entry.message?.role === "toolResult").map((entry) => entry.message.toolCallId);
  assert.deepEqual(resultIds, ["call-done", "call-pending"]);

  console.log("interrupted tool finalization regressions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
