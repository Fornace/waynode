import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config.mjs";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS org_members (
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'editor',
    PRIMARY KEY (org_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS org_settings (
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,
    value         TEXT,
    PRIMARY KEY (org_id, key)
  );

  CREATE TABLE IF NOT EXISTS org_invites (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    token         TEXT UNIQUE NOT NULL,
    role          TEXT NOT NULL DEFAULT 'editor',
    created_by    TEXT NOT NULL REFERENCES users(id),
    expires_at    TEXT NOT NULL,
    used_by       TEXT REFERENCES users(id),
    used_at       TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS org_secrets (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key_name      TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    github_id     INTEGER UNIQUE,
    gitlab_id     INTEGER UNIQUE,
    name          TEXT NOT NULL,
    email         TEXT,
    avatar_url    TEXT,
    github_token  TEXT,
    gitlab_token  TEXT,
    role          TEXT DEFAULT 'user',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spaces (
    id            TEXT PRIMARY KEY,
    org_id        TEXT REFERENCES orgs(id) ON DELETE CASCADE,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    repo_url      TEXT NOT NULL,
    repo_name     TEXT NOT NULL,
    repo_full_name TEXT,
    branch        TEXT DEFAULT 'main',
    local_path    TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS space_members (
    space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'editor',
    PRIMARY KEY (space_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    title         TEXT DEFAULT 'New Session',
    pi_session_dir TEXT NOT NULL,
    model         TEXT,
    provider      TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS secrets (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL CHECK(scope IN ('global','org','space')),
    org_id        TEXT REFERENCES orgs(id) ON DELETE CASCADE,
    space_id      TEXT REFERENCES spaces(id) ON DELETE CASCADE,
    key_name      TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,
    value         TEXT,
    PRIMARY KEY (user_id, key)
  );

  -- Billing (hosted-only; see lib/billing.mjs and lib/config.mjs config.stripe).
  -- One row per org. plan is 'free' until a Checkout session completes.
  CREATE TABLE IF NOT EXISTS org_subscriptions (
    org_id                TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    stripe_customer_id    TEXT,
    stripe_subscription_id TEXT,
    plan                  TEXT NOT NULL DEFAULT 'free',
    status                TEXT NOT NULL DEFAULT 'active',
    current_period_end    TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  );

  -- Usage metering per org per billing period (calendar month by default).
  -- tokens_used is a running counter for the period; storage_bytes is a
  -- point-in-time snapshot refreshed on read (see lib/billing.mjs).
  CREATE TABLE IF NOT EXISTS org_usage (
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    period_start  TEXT NOT NULL,
    tokens_used   INTEGER NOT NULL DEFAULT 0,
    storage_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, period_start)
  );

  -- Personal API tokens for native/CLI clients (bearer auth).
  -- token_hash stores a SHA-256 of the raw 'wn_...' token so a DB leak
  -- never exposes usable credentials. 'label' is a user-chosen name
  -- ("iPhone", "MacBook"). last_used_at is bumped on each bearer auth.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label         TEXT NOT NULL DEFAULT 'Default',
    token_hash    TEXT UNIQUE NOT NULL,
    last_used_at  TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );
`);

function migrate() {
  // Add columns that may be missing on existing databases
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'github_token')) db.exec('ALTER TABLE users ADD COLUMN github_token TEXT');
    if (!userCols.some(c => c.name === 'gitlab_token')) db.exec('ALTER TABLE users ADD COLUMN gitlab_token TEXT');
    if (!userCols.some(c => c.name === 'role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
      const first = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();
      if (first) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
    }
  } catch {}

  try {
    const spaceCols = db.prepare("PRAGMA table_info(spaces)").all();
    if (!spaceCols.some(c => c.name === 'org_id')) {
      db.exec('ALTER TABLE spaces ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE');
    }
  } catch {}

  try {
    const sessionCols = db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionCols.some(c => c.name === 'archived')) {
      db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
  } catch {}

  // Drop messages table if it exists — sessions are on disk now
  try {
    db.exec('DROP TABLE IF EXISTS messages');
  } catch {}

  // Rebuild secrets table if it predates the org_id column / 3-way scope CHECK.
  // Older DBs have CHECK(scope IN ('global','space')) with no org_id column,
  // which can't be altered in place — SQLite doesn't support modifying CHECK
  // constraints via ALTER TABLE, so we rebuild into a new table and swap it in.
  // Existing rows (including scope='global') are carried over unchanged.
  try {
    const secretsCols = db.prepare("PRAGMA table_info(secrets)").all();
    if (!secretsCols.some(c => c.name === 'org_id')) {
      db.exec(`
        CREATE TABLE secrets_new (
          id            TEXT PRIMARY KEY,
          scope         TEXT NOT NULL CHECK(scope IN ('global','org','space')),
          org_id        TEXT REFERENCES orgs(id) ON DELETE CASCADE,
          space_id      TEXT REFERENCES spaces(id) ON DELETE CASCADE,
          key_name      TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          created_at    TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        INSERT INTO secrets_new (id, scope, space_id, key_name, encrypted_value, created_at)
        SELECT id, scope, space_id, key_name, encrypted_value, created_at FROM secrets;
      `);
      db.exec('DROP TABLE secrets');
      db.exec('ALTER TABLE secrets_new RENAME TO secrets');
    }
  } catch (err) {
    console.error('Failed to migrate secrets table to 3-way scope schema:', err);
  }
}

migrate();

export default db;
