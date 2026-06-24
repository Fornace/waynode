import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import db from "../lib/db.mjs";

const router = Router();

function requireAdmin(req, res, next) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

router.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, avatar_url, role, github_id, gitlab_id, created_at,
      (SELECT COUNT(*) FROM spaces WHERE owner_id = users.id) as space_count,
      (SELECT COUNT(*) FROM sessions WHERE owner_id = users.id) as session_count
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

router.patch("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!["admin", "user", "disabled"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  if (req.params.id === req.user.id && role === "disabled") {
    return res.status(400).json({ error: "Cannot disable yourself" });
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  const user = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(req.params.id);
  res.json(user);
});

router.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "Cannot delete yourself" });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  const stats = {
    users: db.prepare("SELECT COUNT(*) as c FROM users").get().c,
    spaces: db.prepare("SELECT COUNT(*) as c FROM spaces").get().c,
    sessions: db.prepare("SELECT COUNT(*) as c FROM sessions").get().c,
    messages: db.prepare("SELECT COUNT(*) as c FROM messages").get().c,
  };
  res.json(stats);
});

export default router;
