import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";
import db from "./db.mjs";

export function createSession({ spaceId, userId, title, model, provider }) {
  const id = randomUUID();
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(spaceId);
  if (!space) throw new Error("Space not found");

  const piSessionDir = join(space.local_path, ".waynode", "sessions", id);
  mkdirSync(piSessionDir, { recursive: true });

  db.prepare(`
    INSERT INTO sessions (id, space_id, owner_id, title, pi_session_dir, model, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, spaceId, userId, title || "New Session", piSessionDir, model || null, provider || null);

  return getSession(id);
}

export function getSession(id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

export function listSessions(spaceId) {
  return db.prepare(`
    SELECT * FROM sessions WHERE space_id = ?
    ORDER BY updated_at DESC
  `).all(spaceId);
}

export function updateSession(id, updates) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(updates)) {
    if (["title", "model", "provider"].includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (fields.length === 0) return getSession(id);
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function deleteSession(id) {
  const session = getSession(id);
  if (!session) return false;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return true;
}

export function addMessage({ sessionId, role, content, isGoal = false }) {
  const info = db.prepare(`
    INSERT INTO messages (session_id, role, content, is_goal)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, role, content, isGoal ? 1 : 0);
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);
  return info.lastInsertRowid;
}

export function getMessages(sessionId) {
  return db.prepare(`
    SELECT id, role, content, is_goal, created_at FROM messages
    WHERE session_id = ? ORDER BY id ASC
  `).all(sessionId).map((m) => ({
    ...m,
    is_goal: !!m.is_goal,
  }));
}

export function autoTitle(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.title !== "New Session") return;
  const first = db.prepare(`
    SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1
  `).get(sessionId);
  if (!first) return;
  const title = first.content.slice(0, 50).trim() + (first.content.length > 50 ? "..." : "");
  updateSession(sessionId, { title });
}
