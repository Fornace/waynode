/** Durable per-user hosted trial eligibility and migration regression. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-trial-eligibility-"));
mkdirSync(root, { recursive: true });
const legacy = new DatabaseSync(join(root, "waynode.db"));
legacy.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE org_members (org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'editor',
    PRIMARY KEY (org_id, user_id));
  INSERT INTO users (id, name) VALUES ('legacy-admin', 'Legacy admin'), ('legacy-editor', 'Legacy editor');
  INSERT INTO orgs (id, name, slug, created_at) VALUES ('legacy-org', 'Legacy org', 'legacy-org', '2020-01-01 00:00:00');
  INSERT INTO org_members (org_id, user_id, role) VALUES
    ('legacy-org', 'legacy-admin', 'admin'), ('legacy-org', 'legacy-editor', 'editor');
`);
legacy.close();

process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "trial-eligibility-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";

const { default: db } = await import("../lib/db.mjs");
const { createOrg, deleteOrg } = await import("../lib/orgs.mjs");
const { getSubscription } = await import("../lib/billing.mjs");

try {
  assert.equal(db.prepare("SELECT org_id FROM hosted_trial_claims WHERE user_id = ?")
    .get("legacy-admin").org_id, "legacy-org");
  assert.equal(db.prepare("SELECT 1 FROM hosted_trial_claims WHERE user_id = ?")
    .get("legacy-editor"), undefined);

  const adminNext = createOrg({ name: "Admin next", userId: "legacy-admin" });
  assert.equal(getSubscription(adminNext.id).plan, "free");
  const editorFirst = createOrg({ name: "Editor first", userId: "legacy-editor" });
  assert.equal(getSubscription(editorFirst.id).plan, "trial");
  const editorSecond = createOrg({ name: "Editor second", userId: "legacy-editor" });
  assert.equal(getSubscription(editorSecond.id).plan, "free");

  deleteOrg(editorFirst.id);
  assert.equal(db.prepare("SELECT org_id FROM hosted_trial_claims WHERE user_id = ?")
    .get("legacy-editor").org_id, null, "deleting the trial org retains the user claim");
  const editorThird = createOrg({ name: "Editor third", userId: "legacy-editor" });
  assert.equal(getSubscription(editorThird.id).plan, "free");
  console.log("hosted trial eligibility regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
