import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import db from "../lib/db.mjs";

const router = Router();

router.get("/api/settings", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE user_id = ?").all(req.user.id);
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

router.patch("/api/settings", requireAuth, (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  const update = db.transaction((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      upsert.run(req.user.id, key, String(value));
    }
  });
  update(req.body);
  res.json({ ok: true });
});

export default router;
