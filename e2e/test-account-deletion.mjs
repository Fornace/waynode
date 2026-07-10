#!/usr/bin/env node
// Self-contained regression coverage for the destructive account-deletion
// flow. Uses the dev auth header only in a throwaway server/database.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const port = 3997;
const base = `http://localhost:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "waynode-delete-account-"));
const devToken = "test-delete-account-token";
let passed = 0;
let failed = 0;
const assert = (condition, message) => {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
};

const proc = spawn("node", ["server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATA_DIR: dataDir, DEV_AUTH_TOKEN: devToken, SESSION_SECRET: "test-delete-session", ENCRYPTION_KEY: "0".repeat(64), APP_URL: base },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[server!] ${chunk}`));

try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`${base}/api/auth/me`)).ok) break; } catch {}
    await sleep(250);
    if (attempt === 39) throw new Error("Server did not start");
  }
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { "x-dev-token": devToken, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  console.log("[1] Solo administrator is blocked");
  await request("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Paid workspace" }) });
  let result = await request("/api/auth/account/deletion-check");
  assert(result.status === 200 && result.body?.can_delete === false, "sole administrator receives a deletion blocker");
  assert(result.body?.blockers?.[0]?.name === "Paid workspace", "blocker identifies the organization");

  console.log("[2] Ownership transfer and revocation");
  const db = new DatabaseSync(join(dataDir, "waynode.db"));
  const org = db.prepare("SELECT id FROM orgs WHERE name = ?").get("Paid workspace");
  db.prepare("INSERT INTO users (id, name) VALUES ('successor', 'Successor')").run();
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, 'successor', 'admin')").run(org.id);
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES ('shared-space', ?, 'dev-user', 'https://example.test/repo.git', 'repo', ?)").run(org.id, join(dataDir, "shared-space"));
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('shared-space', 'dev-user', 'owner')").run();
  db.prepare("INSERT INTO sessions (id, space_id, owner_id, pi_session_dir) VALUES ('shared-session', 'shared-space', 'dev-user', ?)").run(join(dataDir, "session"));
  db.prepare("INSERT INTO api_tokens (id, user_id, token_hash) VALUES ('token', 'dev-user', ?)").run("a".repeat(64));

  result = await request("/api/auth/account", { method: "DELETE", body: JSON.stringify({ confirmation: "nope" }) });
  assert(result.status === 400, "explicit DELETE confirmation is required");
  result = await request("/api/auth/account", { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) });
  assert(result.status === 200 && result.body?.ok === true, "account deletion succeeds after successor is present");
  assert(!db.prepare("SELECT 1 FROM users WHERE id = 'dev-user'").get(), "user record is removed");
  assert(!db.prepare("SELECT 1 FROM api_tokens WHERE user_id = 'dev-user'").get(), "API tokens are revoked by cascade");
  assert(db.prepare("SELECT owner_id FROM spaces WHERE id = 'shared-space'").get()?.owner_id === "successor", "shared space is transferred, not destroyed");
  assert(db.prepare("SELECT owner_id FROM sessions WHERE id = 'shared-session'").get()?.owner_id === "successor", "shared session ownership transfers too");
} finally {
  proc.kill("SIGTERM");
  await sleep(200);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
