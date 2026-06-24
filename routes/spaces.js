import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import { cloneRepo, getSpace, listSpaces, listSpacesByOrg, deleteSpace, pullSpace } from "../lib/spaces.mjs";
import { isOrgMember } from "../lib/orgs.mjs";

const router = Router();

router.get("/api/spaces", requireAuth, (req, res) => {
  const orgId = req.query.orgId;
  if (orgId) {
    const member = isOrgMember(orgId, req.user.id);
    if (!member) return res.status(403).json({ error: "Not an org member" });
    return res.json(listSpacesByOrg(orgId));
  }
  res.json(listSpaces(req.user.id));
});

router.post("/api/spaces", requireAuth, async (req, res) => {
  const { repoUrl, branch, authUser, authToken, orgId } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

  if (orgId) {
    const member = isOrgMember(orgId, req.user.id);
    if (!member || member.role === "viewer") return res.status(403).json({ error: "Editor required" });
  }

  try {
    const space = cloneRepo(repoUrl, branch || "main", req.user.id, orgId, { authUser, authToken });
    res.json(space);
  } catch (err) {
    res.status(500).json({ error: "Clone failed", detail: err.message });
  }
});

router.get("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, (req, res) => {
  const space = getSpace(req.params.spaceId);
  if (!space) return res.status(404).json({ error: "Not found" });
  res.json(space);
});

router.delete("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, (req, res) => {
  if (req.spaceRole !== "owner") return res.status(403).json({ error: "Owner only" });
  deleteSpace(req.params.spaceId);
  res.json({ ok: true });
});

router.post("/api/spaces/:spaceId/pull", requireAuth, requireSpaceAccess, async (req, res) => {
  try {
    const output = await pullSpace(req.params.spaceId);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: "Pull failed", detail: err.message });
  }
});

export default router;
