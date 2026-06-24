import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import {
  createOrg, getOrg, listOrgs, getOrgSettings, setOrgSetting,
  listOrgMembers, updateMemberRole, removeMember, isOrgMember, ensureDefaultOrg,
} from "../lib/orgs.mjs";

const router = Router();

// Ensure user has at least one org
router.get("/api/orgs", requireAuth, (req, res) => {
  let orgs = listOrgs(req.user.id);
  if (orgs.length === 0) {
    const org = ensureDefaultOrg(req.user.id, req.user.name);
    orgs = listOrgs(req.user.id);
  }
  res.json(orgs);
});

router.post("/api/orgs", requireAuth, (req, res) => {
  const { name, slug } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const org = createOrg({ name, slug, userId: req.user.id });
  res.json(org);
});

router.get("/api/orgs/:orgId", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member) return res.status(403).json({ error: "Not a member" });
  const org = getOrg(req.params.orgId);
  if (!org) return res.status(404).json({ error: "Not found" });
  res.json({ ...org, my_role: member.role });
});

router.get("/api/orgs/:orgId/settings", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member) return res.status(403).json({ error: "Not a member" });
  res.json(getOrgSettings(req.params.orgId));
});

router.patch("/api/orgs/:orgId/settings", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role === "viewer") return res.status(403).json({ error: "Editor required" });
  for (const [key, value] of Object.entries(req.body)) {
    setOrgSetting(req.params.orgId, key, String(value));
  }
  res.json({ ok: true });
});

router.get("/api/orgs/:orgId/members", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member) return res.status(403).json({ error: "Not a member" });
  res.json(listOrgMembers(req.params.orgId));
});

router.patch("/api/orgs/:orgId/members/:userId", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  const { role } = req.body;
  if (!["admin", "editor", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });
  updateMemberRole(req.params.orgId, req.params.userId, role);
  res.json({ ok: true });
});

router.delete("/api/orgs/:orgId/members/:userId", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "Cannot remove yourself" });
  removeMember(req.params.orgId, req.params.userId);
  res.json({ ok: true });
});

export default router;
