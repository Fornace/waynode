/** App Store entitlement scaffold regression test; it never calls Apple. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-app-store-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "app-store-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { default: db } = await import("../lib/db.mjs");
const { createOrg } = await import("../lib/orgs.mjs");
const {
  createAppAccountToken, submitUnverifiedTransaction,
  recordUnverifiedNotification, getAppStoreEntitlement,
} = await import("../lib/app-store.mjs");

try {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("owner", "Owner");
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("other", "Other");
  const org = createOrg({ name: "Apple test", userId: "owner" });
  const otherOrg = createOrg({ name: "Other test", userId: "other" });

  const token = createAppAccountToken(org.id, "owner");
  createAppAccountToken(otherOrg.id, "other");
  assert.match(token, /^[0-9a-f-]{36}$/i);
  assert.equal(createAppAccountToken(org.id, "owner"), token);
  assert.equal(getAppStoreEntitlement(org.id).active, false);

  const first = submitUnverifiedTransaction({ orgId: org.id, signedTransactionInfo: "unverified.apple.jws", submittedBy: "owner" });
  assert.equal(first.status, "unverified");
  assert.equal(first.duplicate, false);
  assert.equal(getAppStoreEntitlement(org.id).status, "unverified");
  assert.equal(getAppStoreEntitlement(org.id).active, false);
  assert.equal(submitUnverifiedTransaction({ orgId: org.id, signedTransactionInfo: "unverified.apple.jws", submittedBy: "owner" }).duplicate, true);
  assert.throws(() => submitUnverifiedTransaction({ orgId: otherOrg.id, signedTransactionInfo: "unverified.apple.jws", submittedBy: "other" }), /another organization/);

  assert.equal(recordUnverifiedNotification("unverified.notification.jws").duplicate, false);
  assert.equal(recordUnverifiedNotification("unverified.notification.jws").duplicate, true);
  assert.equal(db.prepare("SELECT verification_status FROM app_store_transactions WHERE id = ?").get(first.id).verification_status, "unverified");
  console.log("app store entitlement scaffold: 11 assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
