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
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS secrets (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL CHECK(scope IN ('org','space')),
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

  // Drop messages table if it exists — sessions are on disk now
  try {
    db.exec('DROP TABLE IF EXISTS messages');
  } catch {}

  // Migrate old secrets scope
  try {
    const oldSecrets = db.prepare("SELECT COUNT(*) as c FROM secrets WHERE scope = 'global'").get();
    if (oldSecrets?.c > 0) {
      db.prepare("UPDATE secrets SET scope = 'org', org_id = (SELECT id FROM orgs LIMIT 1) WHERE scope = 'global'").run();
    }
  } catch {}
}

migrate();

export default db;
