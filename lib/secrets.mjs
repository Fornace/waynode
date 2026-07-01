import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { randomUUID } from "crypto";

const ALGO = "aes-256-gcm";
const KEY = Buffer.from(config.encryptionKey, "hex");

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload) {
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function setSecret({ scope, spaceId, orgId, keyName, value }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO secrets (id, scope, org_id, space_id, key_name, encrypted_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, scope, orgId || null, spaceId || null, keyName, encrypt(value));
  return { id, scope, spaceId, orgId, keyName };
}

export function listSecrets({ scope, spaceId, orgId }) {
  if (scope === "global") {
    return db.prepare("SELECT id, scope, key_name FROM secrets WHERE scope = 'global'").all();
  }
  if (scope === "org") {
    return db.prepare("SELECT id, scope, org_id, key_name FROM secrets WHERE scope = 'org' AND org_id = ?").all(orgId);
  }
  return db.prepare("SELECT id, scope, space_id, key_name FROM secrets WHERE scope = 'space' AND space_id = ?").all(spaceId);
}

export function deleteSecret(id) {
  db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
}

/** Look up a secret's scope/space so authorization can be enforced per-id. */
export function getSecret(id) {
  return db.prepare("SELECT id, scope, space_id, key_name FROM secrets WHERE id = ?").get(id);
}

/**
 * Look up a single secret's raw decrypted value by exact scope + key_name.
 * Used by callers that need one credential (e.g. git-creds.mjs resolving a
 * provider token) rather than the full env-var bag getSecretsEnv() builds.
 * Returns null when no such secret is set.
 */
export function getSecretValue({ scope, spaceId, orgId, keyName }) {
  const row = scope === "org"
    ? db.prepare("SELECT encrypted_value FROM secrets WHERE scope = 'org' AND org_id = ? AND key_name = ?").get(orgId, keyName)
    : db.prepare("SELECT encrypted_value FROM secrets WHERE scope = 'space' AND space_id = ? AND key_name = ?").get(spaceId, keyName);
  if (!row) return null;
  return decrypt(row.encrypted_value);
}

export function getSecretsEnv(spaceId) {
  const rows = [
    ...db.prepare("SELECT key_name, encrypted_value FROM secrets WHERE scope = 'global'").all(),
    ...(spaceId
      ? db.prepare("SELECT key_name, encrypted_value FROM secrets WHERE scope = 'space' AND space_id = ?").all(spaceId)
      : []),
  ];

  const env = {};
  for (const row of rows) {
    env[row.key_name] = decrypt(row.encrypted_value);
  }
  return env;
}
