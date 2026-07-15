import { createHash, randomBytes } from "node:crypto";
import db from "./db.mjs";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 5 * 60 * 1000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDERS = new Set(["github", "gitlab"]);

db.exec(`
  CREATE TABLE IF NOT EXISTS account_deletion_challenges (
    nonce       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK(provider IN ('github', 'gitlab')),
    expires_at  INTEGER NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS account_deletion_challenges_expiry_idx
    ON account_deletion_challenges(expires_at);

  CREATE TABLE IF NOT EXISTS account_deletion_grants (
    grant_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK(provider IN ('github', 'gitlab')),
    nonce       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS account_deletion_grants_expiry_idx
    ON account_deletion_grants(expires_at);
`);

function pruneExpired(now) {
  db.prepare("DELETE FROM account_deletion_challenges WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM account_deletion_grants WHERE expires_at <= ?").run(now);
}

export function isDeletionNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function isDeletionProvider(value) {
  return PROVIDERS.has(value);
}

export function createDeletionChallenge(userId, provider, nonce, now = Date.now()) {
  if (!userId || !isDeletionProvider(provider) || !isDeletionNonce(nonce)) return false;
  pruneExpired(now);
  try {
    db.prepare(`
      INSERT INTO account_deletion_challenges (nonce, user_id, provider, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(nonce, userId, provider, now + CHALLENGE_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export function hasDeletionChallenge(provider, nonce, now = Date.now()) {
  if (!isDeletionProvider(provider) || !isDeletionNonce(nonce)) return false;
  return !!db.prepare(`
    SELECT 1 FROM account_deletion_challenges
    WHERE nonce = ? AND provider = ? AND expires_at > ?
  `).get(nonce, provider, now);
}

export function consumeDeletionChallenge(provider, nonce, now = Date.now()) {
  if (!isDeletionProvider(provider) || !isDeletionNonce(nonce)) return null;
  const row = db.prepare(`
    DELETE FROM account_deletion_challenges
    WHERE nonce = ? AND provider = ? AND expires_at > ?
    RETURNING user_id
  `).get(nonce, provider, now);
  return row?.user_id ?? null;
}

export function issueDeletionGrant(userId, provider, nonce, now = Date.now()) {
  if (!userId || !isDeletionProvider(provider) || !isDeletionNonce(nonce)) return null;
  pruneExpired(now);
  const grant = `wnd_${randomBytes(32).toString("base64url")}`;
  db.prepare(`
    INSERT INTO account_deletion_grants (grant_hash, user_id, provider, nonce, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashGrant(grant), userId, provider, nonce, now + GRANT_TTL_MS);
  return grant;
}

export function exchangeDeletionChallenge(authenticatedUserId, provider, nonce, now = Date.now()) {
  const targetUserId = consumeDeletionChallenge(provider, nonce, now);
  if (!targetUserId) return { error: "invalid_or_expired_challenge" };
  if (targetUserId !== authenticatedUserId) return { error: "identity_mismatch" };
  const grant = issueDeletionGrant(targetUserId, provider, nonce, now);
  return grant ? { grant } : { error: "grant_failed" };
}

export function consumeDeletionGrant(userId, grant, nonce, now = Date.now()) {
  if (!userId || typeof grant !== "string" || !grant.startsWith("wnd_") || !isDeletionNonce(nonce)) {
    return false;
  }
  const row = db.prepare(`
    DELETE FROM account_deletion_grants
    WHERE grant_hash = ? AND user_id = ? AND nonce = ? AND expires_at > ?
    RETURNING grant_hash
  `).get(hashGrant(grant), userId, nonce, now);
  return !!row;
}

function hashGrant(grant) {
  return createHash("sha256").update(grant).digest("hex");
}
