/** Extension-level journal ordering, cleanup, and parallel-write regression. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import waynodeToolJournal from "../pi-extensions/waynode-tool-journal.ts";

const root = mkdtempSync(join(tmpdir(), "waynode-tool-journal-"));
const sessionFile = join(root, "session.jsonl");
const journalPath = `${sessionFile}.waynode-tools.json`;
const handlers = new Map();
const pi = { on(event, handler) { handlers.set(event, handler); } };
const context = {
  sessionManager: {
    getSessionFile: () => sessionFile,
    getSessionId: () => "stable-session-id",
  },
};

function appendToolResult(toolCallId) {
  writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${JSON.stringify({
    type: "message", id: `result-${toolCallId}`, parentId: "assistant",
    message: { role: "toolResult", toolCallId },
  })}\n`);
}

try {
  mkdirSync(root, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "stable-session-id" })}\n`);
  writeFileSync(`${journalPath}.old.stale.tmp`, "partial");
  waynodeToolJournal(pi);
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), [],
    "startup removes stale interrupted temporary writes");

  // Invoke two completions concurrently. Handlers are synchronous, but this
  // models Pi's parallel tool fan-in and proves no shared temporary filename.
  await Promise.all(["call-a", "call-b"].map((toolCallId) => handlers.get("tool_execution_end")({
    type: "tool_execution_end", toolCallId, toolName: "bash",
    result: { content: [{ type: "text", text: toolCallId }], details: { ok: true } },
    isError: false,
  })));
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(journal.version, 2);
  assert.equal(journal.sessionId, "stable-session-id");
  assert.deepEqual(Object.keys(journal.results).sort(), ["call-a", "call-b"]);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);

  // Pi emits message_end before SessionManager appends JSONL. The extension
  // deliberately has no handler there, so both exact results remain durable.
  assert.equal(handlers.has("message_end"), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(journalPath, "utf8")).results).sort(), ["call-a", "call-b"]);

  appendToolResult("call-a");
  await handlers.get("agent_settled")({ type: "agent_settled" }, context);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(journalPath, "utf8")).results), ["call-b"],
    "settle deletes only the result already proven in JSONL");

  appendToolResult("call-b");
  await handlers.get("agent_settled")({ type: "agent_settled" }, context);
  assert.equal(existsSync(journalPath), false, "empty sidecar is durably removed after both results persist");

  console.log("tool result journal extension ordering regressions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
