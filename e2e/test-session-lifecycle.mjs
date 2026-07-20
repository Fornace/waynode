/**
 * Session lifecycle regression: delete-while-streaming, archived 409,
 * unarchive upsert, new-session double-submit guard.
 *
 * Failing-first: written BEFORE the fixes; each case asserts the post-fix shape.
 * Standalone runner: `node e2e/test-session-lifecycle.mjs`.
 */
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Env must be set BEFORE importing any app module (config reads on import). ──
const root = mkdtempSync(join(tmpdir(), "waynode-lifecycle-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "lifecycle-test";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.DEV_AUTH_TOKEN = "lifecycle-dev-token";

const { default: db } = await import("../lib/db.mjs");
const { createSession, archiveSession, getSession } = await import("../lib/sessions.mjs");
const agentManager = await import("../lib/agent-manager.mjs");
const { default: router } = await import("../routes/sessions.js");

const AUTH = { "x-dev-token": process.env.DEV_AUTH_TOKEN };

// ── DB fixtures: user, org, space with org_id (for metering). ──
const USER_ID = "dev-user";
const ORG_ID = "org-lifecycle";
const repoDir = join(root, "repos", "space-lifecycle");
mkdirSync(repoDir, { recursive: true });
db.prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)").run(USER_ID, "Lifecycle Tester");
db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(ORG_ID, "Lifecycle Org", "lifecycle-org");
db.prepare(`
  INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path)
  VALUES (?, ?, ?, ?, ?, ?)
`).run("space-lifecycle", ORG_ID, USER_ID, "https://github.com/test/repo.git", "repo", repoDir);

function makeSession(title = "Lifecycle Session") {
  return createSession({ spaceId: "space-lifecycle", userId: USER_ID, title });
}

/** Write assistant JSONL with token usage so computeSessionTokenTotal can meter. */
function writeUsageFixture(sessionDir, tokens) {
  mkdirSync(sessionDir, { recursive: true });
  const entry = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      usage: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead || 0, cacheWrite: tokens.cacheWrite || 0 },
    },
  };
  writeFileSync(join(sessionDir, "turn.jsonl"), JSON.stringify(entry) + "\n");
}

// ── Express app: mount the real sessions router with dev-token auth bypass. ──
const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const results = [];
function check(name, fn) { results.push({ name, fn }); }
async function runAll() {
  let failures = 0;
  for (const { name, fn } of results) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures += 1; console.log(`FAIL  ${name}: ${e.message}`); }
  }
  return failures;
}

// ────────────────────────────────────────────────────────────────────────────
// Bug 1 (P1): DELETE while streaming must kill the handle, meter, and remove dir.
// ────────────────────────────────────────────────────────────────────────────
check("delete-while-streaming-kills-handle-and-meters", async () => {
  const session = makeSession("Streaming Then Delete");
  writeUsageFixture(session.pi_session_dir, { input: 100, output: 200, cacheRead: 50, cacheWrite: 10 });

  // Inject a stub handle so stopAgent has something to kill.
  const killLog = { signaled: false };
  const stub = {
    dead: false,
    streaming: true,
    _intentionalKill: false,
    proc: { kill: () => { killLog.signaled = true; } },
    spaceId: "space-lifecycle",
  };
  if (typeof agentManager.__injectAgentForTest === "function") {
    agentManager.__injectAgentForTest(session.id, stub);
  }

  const { status, json } = await req("DELETE", `/api/sessions/${session.id}`);
  assert.equal(status, 200, `DELETE should return 200, got ${status}`);

  // Handle was killed with the intentional-kill flag (no crash broadcast).
  assert.equal(killLog.signaled, true, "proc.kill() must be called on the active handle");
  assert.equal(stub._intentionalKill, true, "_intentionalKill must be set so the exit path doesn't broadcast a crash");
  assert.equal(stub.dead, true, "handle must be marked dead");

  // Handle removed from the agents map.
  assert.equal(agentManager.getAgentIfActive(session.id), null, "handle must be removed from the agents map");

  // Session row is gone.
  assert.equal(getSession(session.id), undefined, "session row must be deleted");

  // On-disk pi session dir is removed (or quarantined).
  assert.equal(existsSync(session.pi_session_dir), false, "pi session dir must be removed on delete");

  // Final token total was metered BEFORE the row was deleted.
  const usage = db.prepare("SELECT tokens_used FROM org_usage WHERE org_id = ?").get(ORG_ID);
  assert.ok(usage && usage.tokens_used >= 360, `final token total must be metered before row deletion (got ${usage?.tokens_used})`);
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 1b: DELETE with no active handle still works (no crash).
// ────────────────────────────────────────────────────────────────────────────
check("delete-with-no-handle-is-safe", async () => {
  const session = makeSession("No Handle");
  mkdirSync(session.pi_session_dir, { recursive: true });

  // Ensure no handle is registered.
  assert.equal(agentManager.getAgentIfActive(session.id), null);

  const { status } = await req("DELETE", `/api/sessions/${session.id}`);
  assert.equal(status, 200, `DELETE with no handle should return 200, got ${status}`);
  assert.equal(getSession(session.id), undefined, "session row must be deleted");
  assert.equal(existsSync(session.pi_session_dir), false, "dir must still be removed");
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 2 (P2): Archived sessions reject /message and /queue with 409.
// ────────────────────────────────────────────────────────────────────────────
check("archived-session-rejects-message-409", async () => {
  const session = makeSession("Archived Message");
  archiveSession(session.id, true);

  const { status, json } = await req("POST", `/api/sessions/${session.id}/message`, { prompt: "hello" });
  assert.equal(status, 409, `archived /message must return 409, got ${status}`);
  assert.ok(json?.error, "409 response must include an error body");
});

check("archived-session-rejects-queue-409", async () => {
  const session = makeSession("Archived Queue");
  archiveSession(session.id, true);

  const { status, json } = await req("POST", `/api/sessions/${session.id}/queue`, { prompt: "hello" });
  assert.equal(status, 409, `archived /queue must return 409, got ${status}`);
  assert.ok(json?.error, "409 response must include an error body");
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 2b: Abort still works for archived sessions (a running turn can be stopped).
// ────────────────────────────────────────────────────────────────────────────
check("archived-session-abort-still-allowed", async () => {
  const session = makeSession("Archived Abort");
  archiveSession(session.id, true);

  const { status } = await req("POST", `/api/sessions/${session.id}/abort`);
  assert.equal(status, 200, `abort on archived session must return 200, got ${status}`);
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 3 (P2): Unarchive upserts into sessions list (source-level contract).
// ────────────────────────────────────────────────────────────────────────────
check("unarchive-upserts-into-sessions", () => {
  const app = readFileSync(join(process.cwd(), "frontend/src/App.tsx"), "utf8");
  const handler = app.match(/handleSessionArchived[\s\S]*?\}/);
  assert.ok(handler, "handleSessionArchived must exist");
  // The handler must insert when the session is absent (upsert), not only map.
  assert.ok(
    /prev\.some\(\s*\(\s*s\s*\)\s*=>\s*s\.id\s*===\s*session\.id\s*\)\s*\?[\s\S]*\[\.\.\.prev,\s*session\]/.test(handler[0]) ||
    /\[\.\.\.prev,\s*session\]/.test(handler[0]),
    "handleSessionArchived must insert the session when it is absent (upsert), not only map",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 4 (P3): New Session button has a double-submit guard (source-level contract).
// ────────────────────────────────────────────────────────────────────────────
check("new-session-double-submit-guard", () => {
  const sidebar = readFileSync(join(process.cwd(), "frontend/src/components/Sidebar.tsx"), "utf8");

  // There must be an in-flight guard state.
  assert.match(
    sidebar,
    /creatingSession|newSessionPending|creating/i,
    "Sidebar must track an in-flight creation state for the New Session button",
  );

  // handleNewSession must guard against re-entry.
  const handler = sidebar.match(/handleNewSession\s*=\s*async[\s\S]*?\}/);
  assert.ok(handler, "handleNewSession must exist");
  assert.ok(
    /if\s*\(\s*creatingSession\s*\)/.test(handler[0]) || /if\s*\(\s*newSessionPending\s*\)/.test(handler[0]) ||
    /if\s*\(\s*creating\s*\)/.test(handler[0]),
    "handleNewSession must guard re-entry with the pending state",
  );

  // The button must be disabled while the guard is active.
  assert.match(
    sidebar,
    /new-session-btn[\s\S]*?disabled=\{creatingSession\}/,
    "the New Session button must use the disabled attribute while a creation is in-flight",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Run all checks.
// ────────────────────────────────────────────────────────────────────────────
const failures = await runAll();
server.close();
rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall session lifecycle regression checks passed");
