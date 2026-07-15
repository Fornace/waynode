import { config } from "./config.mjs";
import { createSecretCodec, secretCodec, SecretCryptoError } from "./secret-crypto.mjs";

export const OAUTH_TOKEN_PREFIX = "wnenc:v1:";
const TOKEN_FIELDS = [
  ["github", "access", "github_token"],
  ["github", "refresh", "github_refresh_token"],
  ["gitlab", "access", "gitlab_token"],
  ["gitlab", "refresh", "gitlab_refresh_token"],
];

function descriptor(provider, kind) {
  const match = TOKEN_FIELDS.find(([candidateProvider, candidateKind]) => (
    candidateProvider === provider && candidateKind === kind
  ));
  if (!match) throw new Error("Unsupported OAuth credential field");
  return { provider: match[0], kind: match[1], field: match[2] };
}

function context(provider, kind) {
  return `waynode:oauth:${provider}:${kind}:v1`;
}

export function createOAuthTokenCodec(keyHex = config.encryptionKey) {
  const codec = createSecretCodec(keyHex);
  return {
    encrypt(value, provider, kind = "access") {
      descriptor(provider, kind);
      return OAUTH_TOKEN_PREFIX + codec.encrypt(value, context(provider, kind));
    },
    decrypt(stored, provider, kind = "access") {
      descriptor(provider, kind);
      if (typeof stored !== "string" || !stored.startsWith(OAUTH_TOKEN_PREFIX)) {
        throw new SecretCryptoError();
      }
      return codec.decrypt(stored.slice(OAUTH_TOKEN_PREFIX.length), context(provider, kind));
    },
  };
}

const configuredOAuthCodec = {
  encrypt(value, provider, kind) {
    return OAUTH_TOKEN_PREFIX + secretCodec().encrypt(value, context(provider, kind));
  },
  decrypt(stored, provider, kind) {
    descriptor(provider, kind);
    if (typeof stored !== "string" || !stored.startsWith(OAUTH_TOKEN_PREFIX)) {
      throw new SecretCryptoError();
    }
    return secretCodec().decrypt(stored.slice(OAUTH_TOKEN_PREFIX.length), context(provider, kind));
  },
};

export function encryptOAuthToken(value, provider, kind = "access") {
  descriptor(provider, kind);
  return configuredOAuthCodec.encrypt(value, provider, kind);
}

/** Return null for missing, plaintext, corrupt, or wrong-key values. */
export function decryptOAuthToken(value, provider, kind = "access", codec = configuredOAuthCodec) {
  if (!value) return null;
  try {
    return codec.decrypt(value, provider, kind);
  } catch {
    return null;
  }
}

export function oauthTokenForUser(db, userId, provider, kind = "access") {
  const { field } = descriptor(provider, kind);
  const row = db.prepare(`SELECT ${field} AS value FROM users WHERE id = ?`).get(userId);
  return decryptOAuthToken(row?.value, provider, kind);
}

export function oauthConnectionStatus(db, userId) {
  return {
    github: !!oauthTokenForUser(db, userId, "github"),
    gitlab: !!oauthTokenForUser(db, userId, "gitlab"),
  };
}

/** Atomically upgrade legacy plaintext columns; encrypted rows are unchanged. */
export function migrateOAuthTokenStorage(db, codec = configuredOAuthCodec) {
  const rows = db.prepare(`
    SELECT id, github_token, github_refresh_token, gitlab_token, gitlab_refresh_token
    FROM users
  `).all();
  const updates = new Map(TOKEN_FIELDS.map(([provider, kind, field]) => [
    field, db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`),
  ]));
  let migrated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      for (const [provider, kind, field] of TOKEN_FIELDS) {
        const value = row[field];
        if (!value || value.startsWith(OAUTH_TOKEN_PREFIX)) continue;
        updates.get(field).run(codec.encrypt(value, provider, kind), row.id);
        migrated++;
      }
    }
    db.exec("COMMIT");
    return migrated;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new SecretCryptoError("OAuth credential migration failed");
  }
}
