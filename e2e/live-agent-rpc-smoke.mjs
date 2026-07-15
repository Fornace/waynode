/** Opt-in live smoke for the exact AgentHandle → installed pi RPC boundary. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-live-agent-"));
const sessionId = "66666666-6666-4666-8666-666666666666";
const worktree = join(root, "worktree");
const clone = spawnSync("git", ["clone", "--quiet", "--local", process.cwd(), worktree], { encoding: "utf8" });
if (clone.status !== 0) throw new Error(clone.stderr || "local smoke clone failed");
const sessionDir = join(worktree, ".waynode", "sessions", sessionId);
mkdirSync(sessionDir, { recursive: true });
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "live-agent-smoke",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  WAYNODE_DEPLOYMENT: "self-hosted",
  PI_DEFAULT_PROVIDER: "fornace",
  PI_DEFAULT_MODEL: "fornace-fast",
});

const { default: db } = await import("../lib/db.mjs");
const { AgentHandle } = await import("../lib/agent-rpc-handle.mjs");
let handle;
try {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("live-owner", "Live Smoke");
  db.prepare(`
    INSERT INTO spaces (id, owner_id, repo_url, repo_name, local_path)
    VALUES (?, ?, ?, ?, ?)
  `).run("live-space", "live-owner", "https://example.test/live.git", "live", worktree);
  db.prepare(`
    INSERT INTO sessions (id, space_id, owner_id, title, pi_session_dir, model, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, "live-space", "live-owner", "Live RPC", sessionDir, "fornace-fast", "fornace");

  handle = new AgentHandle({
    id: sessionId, space_id: "live-space", owner_id: "live-owner",
    title: "Live RPC", pi_session_dir: sessionDir,
  }, () => {});
  handle._maybeRename = () => {};
  handle._meterTokenUsage = () => {};
  const events = [];
  handle.subscribe((event) => {
    events.push(event);
    console.log(`[live-agent] ${event.type}`);
  });
  await handle.start();
  console.log("[live-agent] RPC ready");
  const completion = handle.sendPrompt("Reply with exactly LIVE_AGENT_OK", false, "live-submission");
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("live agent turn timed out")), 30000));
  await Promise.race([completion, timeout]);
  assert.equal(handle.liveText.trim(), "LIVE_AGENT_OK");
  assert.ok(events.some((event) => event.type === "start"));
  assert.ok(events.some((event) => event.type === "end"));
  console.log("live AgentHandle RPC smoke passed");
} finally {
  handle?._rejectPending(new Error("live smoke cleanup"));
  try { handle?.proc?.kill(); } catch {}
  rmSync(root, { recursive: true, force: true });
}
