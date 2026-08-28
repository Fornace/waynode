import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-projection-"));
const dir = join(root, "sess");

function write(file, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${entries.map(JSON.stringify).join("\n")}\n`);
}

try {
  // ── Full agentic turn with tools, thinking, results, like live pi output ──
  write("2026-08-28T10-00-00-000Z_aaa.jsonl", [
    { type: "session", version: 3, id: "aaa", timestamp: "2026-08-28T10:00:00.000Z", cwd: "/w" },
    { type: "session_info", id: "s1", parentId: null, timestamp: "2026-08-28T10:00:00.000Z", name: "t" },
    { type: "model_change", id: "m1", parentId: "s1", timestamp: "2026-08-28T10:00:01.000Z", provider: "anthropic", modelId: "claude" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-08-28T10:00:02.000Z", message: { role: "user", content: "run the probe", timestamp: 1784930402000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-28T10:00:03.000Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "plan it" },
      { type: "toolCall", id: "call_x", name: "bash", arguments: { command: "echo hi" } },
    ], stopReason: "toolUse" } },
    { type: "message", id: "t1", parentId: "a1", timestamp: "2026-08-28T10:00:04.000Z", message: { role: "toolResult", toolCallId: "call_x", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false } },
    { type: "message", id: "a2", parentId: "t1", timestamp: "2026-08-28T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } },
    { type: "compaction", id: "c1", parentId: "a2", timestamp: "2026-08-28T10:00:06.000Z", summary: "Earlier work", tokensBefore: 500 },
    { type: "message", id: "u2", parentId: "c1", timestamp: "2026-08-28T10:00:07.000Z", message: { role: "user", content: "thanks" } },
    { type: "message", id: "a3", parentId: "u2", timestamp: "2026-08-28T10:00:08.000Z", message: { role: "assistant", content: "text" } },
  ]);

  const { projectSession, projectAfter } = await import("../lib/pi-session-projection.mjs");
  const { items, leafId } = projectSession(dir);

  assert.equal(leafId, "a3");
  assert.deepEqual(
    items.map((i) => [i.role, i.id, i.parentId]),
    [
      ["user", "u1", "m1"],
      ["assistant", "a1", "u1"],
      ["toolResult", "t1", "a1"],
      ["assistant", "a2", "t1"],
      ["note", "c1", "a2"],
      ["user", "u2", "c1"],
      ["assistant", "a3", "u2"],
    ],
  );
  assert.deepEqual(items[1].blocks, [
    { type: "thinking", text: "plan it" },
    { type: "toolCall", id: "call_x", name: "bash", args: { command: "echo hi" } },
  ]);
  assert.deepEqual(items[2], {
    id: "t1", parentId: "a1", timestamp: "2026-08-28T10:00:04.000Z",
    role: "toolResult", toolCallId: "call_x", toolName: "bash", isError: false, text: "hi\n",
  });
  assert.equal(items[0].timestamp, "2026-08-28T10:00:02.000Z");
  assert.equal(items[4].kind, "compaction");

  // ── Abandoned branch (terminal fork) is excluded ──
  write("2026-08-28T11-00-00-000Z_bbb.jsonl", [
    { type: "session", version: 3, id: "bbb", timestamp: "2026-08-28T11:00:00.000Z" },
    { type: "message", id: "bu1", parentId: null, timestamp: "2026-08-28T11:00:01.000Z", message: { role: "user", content: "q" } },
    { type: "message", id: "ba1", parentId: "bu1", timestamp: "2026-08-28T11:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "old branch" }] } },
    { type: "message", id: "bu2", parentId: "bu1", timestamp: "2026-08-28T11:00:03.000Z", message: { role: "user", content: "fork point" } },
    { type: "message", id: "ba2", parentId: "bu2", timestamp: "2026-08-28T11:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "active branch" }] } },
  ]);
  const dir2 = join(root, "sess2");
  mkdirSync(dir2, { recursive: true });
  rmSync(join(dir2, "x"), { force: true }); // no-op, keep API use explicit
  writeFileSync(join(dir2, "b.jsonl"), [
    { type: "session", version: 3, id: "b", timestamp: "2026-08-28T11:00:00.000Z" },
    { type: "message", id: "bu1", parentId: null, timestamp: "2026-08-28T11:00:01.000Z", message: { role: "user", content: "q" } },
    { type: "message", id: "ba1", parentId: "bu1", timestamp: "2026-08-28T11:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "old branch" }] } },
    { type: "message", id: "bu2", parentId: "bu1", timestamp: "2026-08-28T11:00:03.000Z", message: { role: "user", content: "fork point" } },
    { type: "message", id: "ba2", parentId: "bu2", timestamp: "2026-08-28T11:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "active branch" }] } },
  ].map(JSON.stringify).join("\n") + "\n");
  const p2 = projectSession(dir2);
  assert.deepEqual(p2.items.map((i) => i.id), ["bu1", "bu2", "ba2"], "abandoned branch excluded");

  // ── Cursor slicing (the bbb file above is a legacy second chain in the
  //    same dir; multi-file concatenation appends it after the first) ──
  const afterA1 = projectAfter(dir, "a1");
  assert.equal(afterA1.fromStart, false);
  assert.deepEqual(afterA1.items.map((i) => i.id), ["t1", "a2", "c1", "u2", "a3", "bu1", "bu2", "ba2"]);
  const unknown = projectAfter(dir, "zzzz");
  assert.equal(unknown.fromStart, true);
  assert.equal(unknown.items.length, 10);
  const fresh = projectAfter(dir, undefined);
  assert.equal(fresh.fromStart, true);

  // ── Bash execution entries ──
  const dir3 = join(root, "sess3");
  mkdirSync(dir3, { recursive: true });
  writeFileSync(join(dir3, "c.jsonl"), [
    { type: "message", id: "x1", parentId: null, timestamp: "2026-08-28T12:00:00.000Z", message: { role: "bashExecution", command: "ls", output: "a b", exitCode: 0, cancelled: false } },
  ].map(JSON.stringify).join("\n") + "\n");
  const p3 = projectSession(dir3);
  assert.deepEqual(p3.items[0], {
    id: "x1", parentId: null, timestamp: "2026-08-28T12:00:00.000Z",
    role: "bashExecution", command: "ls", exitCode: 0, cancelled: false, text: "a b",
  });

  // ── Empty dir ──
  const empty = projectSession(join(root, "nope"));
  assert.deepEqual(empty, { items: [], leafId: null });

  console.log("test-session-projection: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
