import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import { setSecret, listSecrets, deleteSecret } from "../lib/secrets.mjs";

const router = Router();

router.get("/api/secrets/global", requireAuth, (req, res) => {
  res.json(listSecrets({ scope: "global" }));
});

router.post("/api/secrets/global", requireAuth, (req, res) => {
  const { keyName, value } = req.body;
  if (!keyName || !value) return res.status(400).json({ error: "keyName and value required" });
  res.json(setSecret({ scope: "global", keyName, value }));
});

router.delete("/api/secrets/:id", requireAuth, (req, res) => {
  deleteSecret(req.params.id);
  res.json({ ok: true });
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
