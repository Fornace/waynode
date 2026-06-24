import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import db from "./db.mjs";

export function createSession({ spaceId, orgId, userId, title, model, provider }) {
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

// ── Read messages from pi session JSONL on disk ──

export function getMessagesFromDisk(session) {
  const messages = [];
  const sessionDir = session.pi_session_dir;

  // Find session.jsonl files
  const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
  const jsonlFiles = files.filter(f => f.endsWith(".jsonl")).sort();

  for (const file of jsonlFiles) {
    try {
      const raw = readFileSync(join(sessionDir, file), "utf8");
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" || entry.role) {
            messages.push({
              role: entry.role || (entry.type === "user" ? "user" : "assistant"),
              content: typeof entry.content === "string" ? entry.content : (entry.content || "").toString(),
              thinking: entry.thinking || entry.reasoning || null,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return messages;
}

export function touchSession(sessionId) {
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);
}
