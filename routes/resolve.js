import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import db from "../lib/db.mjs";
import { getSpaceByShortId } from "../lib/spaces.mjs";
import { getSessionByShortId } from "../lib/sessions.mjs";

const router = Router();

/**
 * Resolve pretty-URL short ids to full records.
 *   GET /api/resolve?space=<shortId>[&session=<shortId>]
 *
 * Returns:
 *   { space: {...}, session: {...}|null,
 *     spaceSlug: "<slug>-<shortId>", sessionSlug: "<slug>-<shortId>"|null }
 *
 * Access: caller must be owner or member of the resolved space.
 * 404 if either short id is unknown; 403 if the user lacks access.
 */
router.get("/api/resolve", requireAuth, (req, res) => {
  const spaceShort = String(req.query.space || "").toLowerCase();
  const sessionShort = req.query.session ? String(req.query.session).toLowerCase() : null;

  if (!/^[0-9a-f]{8}$/.test(spaceShort)) {
    return res.status(400).json({ error: "invalid space short id" });
  }

  const space = getSpaceByShortId(spaceShort);
  if (!space) return res.status(404).json({ error: "space not found" });

  // Access check — owner or member.
  const member = db.prepare(
    "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?"
  ).get(space.id, req.user.id);
  if (space.owner_id !== req.user.id && !member) {
    return res.status(403).json({ error: "access denied" });
  }

  const deDash = (id) => (id || "").replace(/-/g, "");
  const slugify = (s) =>
    (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 48);
  const spaceSlug = `${slugify(space.repo_name)}-${deDash(space.id).slice(0, 8)}`;

  let session = null;
  let sessionSlug = null;
  if (sessionShort) {
    if (!/^[0-9a-f]{8}$/.test(sessionShort)) {
      return res.status(400).json({ error: "invalid session short id" });
    }
    session = getSessionByShortId(sessionShort);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.space_id !== space.id) {
      return res.status(404).json({ error: "session not in this space" });
    }
    sessionSlug = `${slugify(session.title)}-${deDash(session.id).slice(0, 8)}`;
  }

  res.json({ space, session, spaceSlug, sessionSlug });
});

export default router;
