/** OAuth provider credentials are encrypted at rest and legacy migration is atomic. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

process.env.SESSION_SECRET = "oauth-token-test-session";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const {
  OAUTH_TOKEN_PREFIX,
  createOAuthTokenCodec,
  decryptOAuthToken,
  migrateOAuthTokenStorage,
} = await import("../lib/oauth-tokens.mjs");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      github_token TEXT,
      github_refresh_token TEXT,
      gitlab_token TEXT,
      gitlab_refresh_token TEXT
    )
  `);
  return db;
}

const raw = {
  github_token: "github-access-plaintext",
  github_refresh_token: "github-refresh-plaintext",
  gitlab_token: "gitlab-access-plaintext",
  gitlab_refresh_token: "gitlab-refresh-plaintext",
};

const db = database();
db.prepare(`
  INSERT INTO users (id, github_token, github_refresh_token, gitlab_token, gitlab_refresh_token)
  VALUES ('legacy', ?, ?, ?, ?)
`).run(raw.github_token, raw.github_refresh_token, raw.gitlab_token, raw.gitlab_refresh_token);

assert.equal(migrateOAuthTokenStorage(db), 4);
const stored = db.prepare("SELECT * FROM users WHERE id = 'legacy'").get();
for (const [field, plaintext] of Object.entries(raw)) {
  assert.ok(stored[field].startsWith(OAUTH_TOKEN_PREFIX), `${field} has a versioned envelope`);
  assert.equal(stored[field].includes(plaintext), false, `${field} does not contain plaintext`);
}
assert.equal(JSON.stringify(stored).includes("plaintext"), false, "the database row contains no raw token text");
assert.equal(decryptOAuthToken(stored.github_token, "github"), raw.github_token);
assert.equal(decryptOAuthToken(stored.github_refresh_token, "github", "refresh"), raw.github_refresh_token);
assert.equal(decryptOAuthToken(stored.gitlab_token, "gitlab"), raw.gitlab_token);
assert.equal(decryptOAuthToken(stored.gitlab_refresh_token, "gitlab", "refresh"), raw.gitlab_refresh_token);

const firstPass = { ...stored };
assert.equal(migrateOAuthTokenStorage(db), 0, "migration is idempotent");
assert.deepEqual({ ...db.prepare("SELECT * FROM users WHERE id = 'legacy'").get() }, firstPass);

const wrongKeyCodec = createOAuthTokenCodec("1".repeat(64));
assert.equal(
  decryptOAuthToken(stored.github_token, "github", "access", wrongKeyCodec),
  null,
  "a key mismatch fails closed",
);
assert.equal(
  decryptOAuthToken(stored.github_token.slice(0, -2) + "AA", "github"),
  null,
  "corrupt ciphertext fails closed",
);
assert.equal(decryptOAuthToken(stored.github_token, "gitlab"), null, "provider swapping fails closed");
assert.equal(decryptOAuthToken(stored.github_token, "github", "refresh"), null, "token-kind swapping fails closed");
assert.equal(decryptOAuthToken(raw.github_token, "github"), null, "post-migration reads reject plaintext");

const rollbackDb = database();
rollbackDb.prepare("INSERT INTO users (id, github_token, gitlab_token) VALUES ('rollback', ?, ?)")
  .run("first-plaintext", "second-plaintext");
let calls = 0;
assert.throws(() => migrateOAuthTokenStorage(rollbackDb, {
  encrypt() {
    calls++;
    if (calls === 2) throw new Error("synthetic migration failure");
    return OAUTH_TOKEN_PREFIX + "synthetic";
  },
}), /OAuth credential migration failed/);
assert.deepEqual(
  { ...rollbackDb.prepare("SELECT github_token, gitlab_token FROM users WHERE id = 'rollback'").get() },
  { github_token: "first-plaintext", gitlab_token: "second-plaintext" },
  "a failed migration rolls back every credential update",
);

db.close();
rollbackDb.close();
console.log("oauth token encryption: migration, at-rest storage, corruption, and key mismatch passed");
