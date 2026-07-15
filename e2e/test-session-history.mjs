import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-history-"));
const sessionDir = join(root, "sessions", "fixture");
process.env.DATA_DIR = join(root, "data");
process.env.SESSION_SECRET = "test-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

try {
  mkdirSync(sessionDir, { recursive: true });
  const entries = [
    {
      type: "message",
      timestamp: "2026-07-15T09:00:05.000Z",
      message: { role: "user", content: "First", timestamp: 1784106000000 },
    },
    {
      type: "message",
      timestamp: "2026-07-15T09:00:08.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Second" }], timestamp: "bad" },
    },
    {
      type: "message",
      timestamp: "2026-07-15T11:00:12+02:00",
      message: { role: "user", content: "Third", timestamp: "" },
    },
    {
      type: "message",
      message: { role: "assistant", content: "Legacy" },
    },
    {
      type: "message",
      timestamp: false,
      message: { role: "user", content: "Invalid", timestamp: -1 },
    },
  ];
  writeFileSync(join(sessionDir, "fixture.jsonl"), `${entries.map(JSON.stringify).join("\n")}\n`);

  const { getMessagesFromDisk } = await import("../lib/sessions.mjs");
  const messages = getMessagesFromDisk({ pi_session_dir: sessionDir });
  assert.deepEqual(messages, [
    { role: "user", content: "First", timestamp: "2026-07-15T09:00:00.000Z" },
    { role: "assistant", content: "Second", thinking: null, timestamp: "2026-07-15T09:00:08.000Z" },
    { role: "user", content: "Third", timestamp: "2026-07-15T09:00:12.000Z" },
    { role: "assistant", content: "Legacy", thinking: null, timestamp: null },
    { role: "user", content: "Invalid", timestamp: null },
  ]);
  console.log("session history timestamp test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
