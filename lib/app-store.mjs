import { createHash, randomUUID } from "crypto";
import db from "./db.mjs";

// This module deliberately does not decode a JWS to make authorization
// decisions. Decoding is not signature verification. Apple entitlements may
// only be activated after a verifier validates the JWS signature chain,
// environment, bundle id, product id, transaction freshness, and the
// appAccountToken embedded in the signed payload.
const MAX_SIGNED_PAYLOAD_BYTES = 256 * 1024;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signedPayload(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} is required`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SIGNED_PAYLOAD_BYTES) {
    throw new RangeError(`${field} is too large`);
  }
  return value;
}

/**
 * Return one stable Apple appAccountToken per organization. Reusing a token
 * makes retries safe and prevents an admin from accidentally severing the
 * association of already-purchased subscriptions.
 */
export function createAppAccountToken(orgId, userId) {
  const existing = db.prepare(
    "SELECT app_account_token FROM org_app_store_accounts WHERE org_id = ?",
  ).get(orgId);
  if (existing) return existing.app_account_token;

  const token = randomUUID();
  try {
    db.prepare(`
      INSERT INTO org_app_store_accounts (org_id, app_account_token, created_by)
      VALUES (?, ?, ?)
    `).run(orgId, token, userId);
    return token;
  } catch (error) {
    // A concurrent retry may have created the org token first. Return its
    // value rather than issuing an incompatible second token.
    const concurrent = db.prepare(
      "SELECT app_account_token FROM org_app_store_accounts WHERE org_id = ?",
    ).get(orgId);
    if (concurrent) return concurrent.app_account_token;
    throw error;
  }
}

/**
 * Store a client-supplied signed transaction for later server verification.
 * Its organization association comes from the server-issued account token;
 * it is still untrusted until the signed payload proves that same token.
 */
export function submitUnverifiedTransaction({ orgId, signedTransactionInfo, submittedBy }) {
  const signedTransaction = signedPayload(signedTransactionInfo, "signedTransactionInfo");
  const account = db.prepare(
    "SELECT app_account_token FROM org_app_store_accounts WHERE org_id = ?",
  ).get(orgId);
  if (!account) throw new Error("Create an appAccountToken before submitting an App Store transaction");

  const digest = sha256(signedTransaction);
  const existing = db.prepare(
    "SELECT id, org_id, verification_status FROM app_store_transactions WHERE jws_sha256 = ?",
  ).get(digest);
  if (existing) {
    // A signed transaction must never be replayed into another organization.
    if (existing.org_id !== orgId) throw new Error("This App Store transaction is already associated with another organization");
    return { id: existing.id, status: existing.verification_status, duplicate: true };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO app_store_transactions
      (id, org_id, app_account_token, jws_sha256, signed_transaction, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, orgId, account.app_account_token, digest, signedTransaction, submittedBy);
  return { id, status: "unverified", duplicate: false };
}

/** Record an App Store Server Notification idempotently, without trusting it. */
export function recordUnverifiedNotification(signedPayloadValue) {
  const payload = signedPayload(signedPayloadValue, "signedPayload");
  const notificationKey = sha256(payload);
  const result = db.prepare(`
    INSERT OR IGNORE INTO app_store_notifications (notification_key, signed_payload)
    VALUES (?, ?)
  `).run(notificationKey, payload);
  return { notificationKey, duplicate: result.changes === 0, status: "unverified" };
}

/**
 * Entitlements remain inactive unless a future, full Apple JWS verifier marks
 * a transaction verified. Keeping this read conservative prevents a database
 * row, decoded JWT, or forged notification from becoming paid access.
 */
export function getAppStoreEntitlement(orgId) {
  const account = db.prepare(
    "SELECT app_account_token FROM org_app_store_accounts WHERE org_id = ?",
  ).get(orgId);
  const unverified = db.prepare(`
    SELECT COUNT(*) AS count FROM app_store_transactions
    WHERE org_id = ? AND verification_status = 'unverified'
  `).get(orgId).count;

  return {
    provider: "app_store",
    active: false,
    status: unverified > 0 ? "unverified" : "not_configured",
    app_account_token: account?.app_account_token || null,
    pending_transactions: unverified,
  };
}
