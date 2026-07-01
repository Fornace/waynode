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

/** Lookup by the 8-hex short id (suffix of a UUID, dashes removed). */
export function getSessionByShortId(shortId) {
  return db
    .prepare("SELECT * FROM sessions WHERE lower(substr(replace(id, '-', ''), 1, 8)) = ?")
    .get(String(shortId || "").toLowerCase());
}

export function listSessions(spaceId, { includeArchived = false } = {}) {
  return db.prepare(`
    SELECT * FROM sessions WHERE space_id = ? AND (archived = 0 OR ?)
    ORDER BY updated_at DESC
  `).all(spaceId, includeArchived ? 1 : 0);
}

export function archiveSession(id, archived = true) {
  db.prepare("UPDATE sessions SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
  return getSession(id);
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
// pi stores entries like {type:"message", message:{role, content:[blocks]}}.
// Reconstruct a flat, UI-friendly message list.

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || !b.type))
      .map((b) => b.text || "")
      .join("");
  }
  return String(content);
}

function contentHasThinking(content) {
  if (!Array.isArray(content)) return null;
  const t = content.find((b) => b && b.type === "thinking");
  return t ? t.thinking || "" : null;
}

export function getMessagesFromDisk(session) {
  const messages = [];
  const sessionDir = session.pi_session_dir;

  const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

  for (const file of jsonlFiles) {
    try {
      const raw = readFileSync(join(sessionDir, file), "utf8");
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (!msg || !msg.role) continue;

          if (msg.role === "user") {
            const text = contentToText(msg.content);
            if (text.trim()) messages.push({ role: "user", content: text });
          } else if (msg.role === "assistant") {
            const text = contentToText(msg.content);
            const thinking = contentHasThinking(msg.content);
            // Skip assistant turns that are pure tool calls with no text/thinking.
            if (text.trim() || thinking) {
              messages.push({ role: "assistant", content: text, thinking });
            }
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
