import { Router } from "express";
import { requireAuth, requireSpaceAccess, requireAdmin } from "../lib/auth.mjs";
import { setSecret, listSecrets, deleteSecret, getSecret } from "../lib/secrets.mjs";

const router = Router();

// Global secrets are injected into EVERY space's pi environment, so reading
// names / adding / deleting them is admin-only. (Secret *values* are never
// returned by any of these endpoints.)
router.get("/api/secrets/global", requireAuth, requireAdmin, (req, res) => {
  res.json(listSecrets({ scope: "global" }));
});

router.post("/api/secrets/global", requireAuth, requireAdmin, (req, res) => {
  const { keyName, value } = req.body;
  if (!keyName || !value) return res.status(400).json({ error: "keyName and value required" });
  res.json(setSecret({ scope: "global", keyName, value }));
});

// Delete by id: enforce access based on the secret's OWN scope, not the
// caller's guess. Previously this only checked requireAuth, so any user could
// delete any secret (global or another space's) by id.
router.delete("/api/secrets/:id", requireAuth, (req, res) => {
  const secret = getSecret(req.params.id);
  if (!secret) return res.status(404).json({ error: "Not found" });

  const doDelete = () => { deleteSecret(secret.id); res.json({ ok: true }); };

  if (secret.scope === "global") {
    // Global secrets affect the whole deployment → admin only.
    return requireAdmin(req, res, doDelete);
  }

  // Space-scoped: the caller must have access to THAT space. requireSpaceAccess
  // reads req.params.spaceId, so point it at the secret's space.
  req.params.spaceId = secret.space_id;
  return requireSpaceAccess(req, res, doDelete);
});

router.get("/api/spaces/:spaceId/secrets", requireAuth, requireSpaceAccess, (req, res) => {
  res.json(listSecrets({ scope: "space", spaceId: req.params.spaceId }));
});

router.post("/api/spaces/:spaceId/secrets", requireAuth, requireSpaceAccess, (req, res) => {
  const { keyName, value } = req.body;
  if (!keyName || !value) return res.status(400).json({ error: "keyName and value required" });
  res.json(setSecret({ scope: "space", spaceId: req.params.spaceId, keyName, value }));
});

export default router;
