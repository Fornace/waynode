/** Hosted terminal admission and detached-PTY metering regression. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-terminal-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "terminal-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";

const { default: db } = await import("../lib/db.mjs");
const { createOrg } = await import("../lib/orgs.mjs");
const { getUsage, recordSessionTokenTotal, recordTokenUsage, upsertSubscription } = await import("../lib/billing.mjs");
const { computeSessionTokenTotal, enforceTerminalAvailability } = await import("../lib/pi-runner.mjs");
const { terminalBillingRejection } = await import("../routes/terminal.js");
const { TerminalHandle } = await import("../lib/agent-terminal-handle.mjs");

try {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("owner", "Owner");
  const org = createOrg({ name: "Hosted terminal", userId: "owner" });
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("space", org.id, "owner", "https://example.test/repo.git", "repo", root);
  db.prepare("INSERT INTO sessions (id, space_id, owner_id, pi_session_dir) VALUES (?, ?, ?, ?)")
    .run("session", "space", "owner", root);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get("session");

  assert.throws(
    () => enforceTerminalAvailability("hosted"),
    (error) => error.terminalDisabled === true && /not available/.test(error.message),
    "hosted terminal fails closed with a typed error",
  );
  assert.doesNotThrow(() => enforceTerminalAvailability("self-hosted"));
  assert.equal(terminalBillingRejection(session), null, "active trial has no separate billing rejection");
  recordTokenUsage(org.id, 5_000_000);
  assert.match(terminalBillingRejection(session), /included agent usage/, "quota blocks a new hosted terminal");
  upsertSubscription(org.id, { plan: "free", status: "expired" });
  assert.match(terminalBillingRejection(session), /not active/, "expired billing blocks terminal");

  let onData;
  let onExit;
  db.prepare("DELETE FROM org_usage WHERE org_id = ?").run(org.id);
  upsertSubscription(org.id, { plan: "starter", status: "active" });
  writeFileSync(join(root, "session.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 4, output: 6, cacheRead: 2, cacheWrite: 2 } } }) + "\n");
  const pty = {
    onData(callback) { onData = callback; },
    onExit(callback) { onExit = callback; },
    resize() {}, write() {}, kill() { onExit({ exitCode: 0 }); },
  };
  const meter = () => recordSessionTokenTotal(session.id, org.id, computeSessionTokenTotal(session.pi_session_dir));
  const handle = new TerminalHandle(session, pty, undefined, meter, 5);
  const detach = handle.attach(() => {});
  detach();
  onData("work continues while detached");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(getUsage(org.id).tokens_used, 14, "detached terminal usage is metered periodically");
  writeFileSync(join(root, "session.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 8, output: 8, cacheRead: 2, cacheWrite: 2 } } }) + "\n");
  onExit({ exitCode: 0 });
  assert.equal(getUsage(org.id).tokens_used, 20, "terminal records the final cumulative delta at exit");
  console.log("terminal safety and metering regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
