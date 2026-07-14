/**
 * lib/api-tokens.mjs — Personal API token CRUD.
 *
 * Tokens are `wn_<64hex>` (32 bytes of entropy). Only the SHA-256 hash is
 * stored (`token_hash`), so a DB compromise never yields usable credentials.
 * The raw token is shown ONCE at creation time — there is no read-back path.
 */
import db from "./db.mjs";
import { randomUUID, createHash, randomBytes } from "crypto";

/** Mint a new token for `userId`. Returns the raw token (show once). */
export function createToken(userId, label) {
  const raw = "wn_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  const id = randomUUID();
  db.prepare(`
    INSERT INTO api_tokens (id, user_id, label, token_hash)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, label?.trim() || "Default", hash);
  return { id, token: raw, label: label?.trim() || "Default" };
}

/** List a user's tokens (never returns the raw token — only metadata). */
export function listTokens(userId) {
  return db.prepare(`
    SELECT id, label, last_used_at, created_at
    FROM api_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

/** Revoke a token by id. Only the owning user may revoke. */
export function revokeToken(userId, tokenId) {
  const result = db.prepare(`
    DELETE FROM api_tokens WHERE id = ? AND user_id = ?
  `).run(tokenId, userId);
  return result.changes > 0;
}

/** Revoke the exact raw token used for the current bearer request. */
export function revokeRawToken(userId, rawToken) {
  if (!rawToken || !rawToken.startsWith("wn_") || rawToken.length < 20) return false;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const result = db.prepare(`
    DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?
  `).run(hash, userId);
  return result.changes > 0;
}

/** Count a user's active tokens (for UI limits). */
export function countTokens(userId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?").get(userId);
  return row?.n ?? 0;
}
