import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config.mjs";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
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
    scope         TEXT NOT NULL CHECK(scope IN ('global','space')),
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

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    is_goal       INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
`);

// Run migrations for existing databases
function migrate() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasGithubToken = columns.some(col => col.name === 'github_token');
  const hasGitlabToken = columns.some(col => col.name === 'gitlab_token');

  if (!hasGithubToken) {
    db.exec('ALTER TABLE users ADD COLUMN github_token TEXT');
  }
  if (!hasGitlabToken) {
    db.exec('ALTER TABLE users ADD COLUMN gitlab_token TEXT');
  }
  const hasRole = columns.some(col => col.name === 'role');
  if (!hasRole) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    // First user becomes admin
    const firstUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();
    if (firstUser) {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstUser.id);
    }
  }
}

migrate();

export default db;
