import session from "express-session";
import db from "./db.mjs";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Persistent express-session store backed by Waynode's WAL SQLite database. */
export class SQLiteSessionStore extends session.Store {
  constructor({ database = db, ttlMs = WEEK_MS, pruneIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.database = database;
    this.ttlMs = ttlMs;
    this.getStatement = database.prepare(
      "SELECT session_json, expires_at FROM browser_sessions WHERE sid = ?"
    );
    this.setStatement = database.prepare(`
      INSERT INTO browser_sessions (sid, session_json, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        session_json = excluded.session_json,
        expires_at = excluded.expires_at
    `);
    this.deleteStatement = database.prepare("DELETE FROM browser_sessions WHERE sid = ?");
    this.touchStatement = database.prepare(
      "UPDATE browser_sessions SET expires_at = ? WHERE sid = ?"
    );
    this.deleteExpiredStatement = database.prepare(
      "DELETE FROM browser_sessions WHERE expires_at <= ?"
    );
    this.clearStatement = database.prepare("DELETE FROM browser_sessions");
    this.lengthStatement = database.prepare(
      "SELECT COUNT(*) AS count FROM browser_sessions WHERE expires_at > ?"
    );
    this.allStatement = database.prepare(
      "SELECT sid, session_json FROM browser_sessions WHERE expires_at > ? ORDER BY sid"
    );
    this.pruneExpired();
    this.pruneTimer = setInterval(() => this.pruneExpired(), pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) this.deleteStatement.run(sid);
        return callback(null, null);
      }
      try {
        const value = JSON.parse(row.session_json);
        if (!value || typeof value !== "object" || Array.isArray(value)
          || !value.cookie || typeof value.cookie !== "object" || Array.isArray(value.cookie)) {
          throw new Error("Invalid session shape");
        }
        value.cookie.expires = new Date(row.expires_at).toISOString();
        callback(null, value);
      } catch {
        this.deleteStatement.run(sid);
        callback(null, null);
      }
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      this.setStatement.run(sid, JSON.stringify(value), this.expiryFor(value));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      // UPDATE-only is intentional: a stale request must never recreate a SID
      // that logout or session regeneration already destroyed.
      this.touchStatement.run(this.expiryFor(value), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.clearStatement.run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback) {
    try {
      callback(null, this.lengthStatement.get(Date.now()).count);
    } catch (error) {
      callback(error);
    }
  }

  all(callback) {
    try {
      const sessions = this.allStatement.all(Date.now()).flatMap((row) => {
        try { return [{ ...JSON.parse(row.session_json), id: row.sid }]; }
        catch { this.deleteStatement.run(row.sid); return []; }
      });
      callback(null, sessions);
    } catch (error) {
      callback(error);
    }
  }

  close() {
    clearInterval(this.pruneTimer);
  }

  pruneExpired() {
    try { this.deleteExpiredStatement.run(Date.now()); }
    catch (error) { console.error("[sessions] expiry cleanup failed:", error.message); }
  }

  expiryFor(value) {
    const expires = value?.cookie?.expires;
    const timestamp = expires ? new Date(expires).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : Date.now() + this.ttlMs;
  }
}
