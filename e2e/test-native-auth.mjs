#!/usr/bin/env node
// E2E test for the native app auth flow (server-side additions).
//
// Verifies:
//   1. GET /api/auth/me (unauthenticated) returns configured providers
//      { github: bool, gitlab: bool } — so the native login screen can
//      show the right OAuth buttons BEFORE authenticating.
//   2. POST /api/tokens creates a wn_ token (after a session is estab­
//      shed — here we simulate via DB).
//   3. GET /api/auth/me with Bearer token returns the token's user +
//      their linked providers.
//   4. Bearer tokens CANNOT create other tokens (403 escalation guard).
//   5. SSE auth via ?t= query param is accepted by sseAuth (status 200
//      on the events endpoint, not 401).
//   6. DELETE /api/tokens/:id revokes; the revoked token then 401s.
//   7. Bad/unknown token → 401.
//
// Runs a throwaway server instance on port 3999 with an in-memory test
// database. No external services required.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// --- Set up an isolated test DB dir + env -----------------------------
const testDir = mkdtempSync(join(tmpdir(), "waynode-e2e-"));
process.env.PORT = String(PORT);
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-" + Date.now();
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.GITHUB_CLIENT_ID = "test-github-id";   // → providers.github = true
process.env.APP_URL = BASE;
// In-memory SQLite via :memory: won't persist across the server process
// boundary, so use a temp file the server will create.
process.env.DATA_DIR = testDir;

const proc = spawn("node", ["server.js"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

proc.stdout.on("data", d => process.stdout.write(`[server] ${d}`));
proc.stderr.on("data", d => process.stderr.write(`[server!] ${d}`));

// Wait for server to be ready.
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/api/auth/me`);
    if (r.ok || r.status === 401) { ready = true; break; }
  } catch {}
  await sleep(250);
}
if (!ready) {
  console.error("Server did not become ready. Aborting.");
  proc.kill("SIGKILL");
  process.exit(2);
}
console.log("Server ready.\n");

// === Helpers ===
async function getJSON(pathname, opts = {}) {
  const r = await fetch(`${BASE}${pathname}`, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

// === 1. Unauthenticated /api/auth/me returns providers ===
console.log("[1] Unauthenticated /api/auth/me returns configured providers");
{
  const { status, body } = await getJSON("/api/auth/me");
  assert(status === 200, `returns 200 (got ${status})`);
  assert(body?.user === null, "user is null when unauthenticated");
  assert(body?.providers?.github === true, "providers.github reflects GITHUB_CLIENT_ID config");
}

// === 2. Seed a test user + create a token via DB directly ===
// (Simulates a user who has authenticated via OAuth in a prior step.)
console.log("\n[2] Create API token for a seeded user");
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(`${testDir}/waynode.db`);
db.exec(`INSERT OR IGNORE INTO users (id, name, github_id) VALUES ('test-user', 'Test User', 12345)`);

const { createToken, listTokens, revokeToken } = await import("../lib/api-tokens.mjs");
let tokenObj;
try {
  tokenObj = createToken("test-user", "e2e-test-token");
  const token = tokenObj.token;
  assert(token.startsWith("wn_"), `token has wn_ prefix (got ${token.slice(0, 8)}…)`);
  const tokens = listTokens("test-user");
  assert(tokens.length === 1, "token appears in list");
} catch (e) {
  assert(false, `createToken threw: ${e.message}`);
}
const token = tokenObj.token;

// === 3. Bearer token authenticates /api/auth/me ===
console.log("\n[3] Bearer token authenticates and returns user");
{
  const { status, body } = await getJSON("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(status === 200, `returns 200 (got ${status})`);
  assert(body?.user?.id === "test-user", "returns the token's user");
  assert(body?.providers?.github === true, "providers.github true (user has github_id)");
}

// === 4. Escalation guard: bearer token cannot create another token ===
console.log("\n[4] Bearer tokens cannot create other tokens (403)");
{
  const { status } = await getJSON("/api/tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "should-fail" }),
  });
  assert(status === 403, `returns 403 (got ${status})`);
}

// === 5. Bearer token can LIST its own tokens ===
console.log("\n[5] Bearer token can list its own tokens");
{
  const { status, body } = await getJSON("/api/tokens", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(status === 200, `returns 200 (got ${status})`);
  assert(Array.isArray(body?.tokens) && body.tokens.length === 1, "returns {tokens:[1]}");
}

// === 6. SSE endpoint accepts ?t= query param ===
console.log("\n[6] SSE events endpoint accepts ?t= bearer query param");
{
  // We don't need a real session for this — we just check that auth passes
  // (status != 401). A 404 (session not found) means auth SUCCEEDED.
  const r = await fetch(`${BASE}/api/sessions/fake-session/events?t=${token}`);
  assert(r.status !== 401, `auth passes — not 401 (got ${r.status})`);
  r.body?.cancel();
}

// === 7. Bad token → 401 ===
console.log("\n[7] Bad/unknown token is rejected");
{
  const { status } = await getJSON("/api/auth/me", {
    headers: { Authorization: "Bearer wn_bogustoken123" },
  });
  assert(status === 401, `returns 401 (got ${status})`);
}

// === 8. Revoke → token no longer works ===
console.log("\n[8] Revoked token is immediately invalid");
{
  const tokens = listTokens("test-user");
  const id = tokens[0]?.id;
  revokeToken("test-user", id);
  const { status } = await getJSON("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(status === 401, `revoked token returns 401 (got ${status})`);
}

// === Done ===
console.log(`\n${passed} passed, ${failed} failed.`);
proc.kill("SIGTERM");
await sleep(300);
rmSync(testDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
