import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import {
  createOrg, getOrg, listOrgs, renameOrg, getOrgSettings, setOrgSetting,
  listOrgMembers, updateMemberRole, removeMember, isOrgMember, ensureDefaultOrg,
  createInvite, getInviteByToken, acceptInvite, deleteOrg,
} from "../lib/orgs.mjs";
import { listSpacesByOrg, deleteSpace } from "../lib/spaces.mjs";
import { getSubscription, cancelSubscription, billingEnabled } from "../lib/billing.mjs";

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

router.patch("/api/orgs/:orgId", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
  const org = renameOrg(req.params.orgId, name.trim());
  res.json(org);
});

// Delete an org outright. Admin-only.
//
// Guard 1 — last org: every user needs at least one org (ensureDefaultOrg is
// invoked on every GET /api/orgs). We considered letting that self-heal
// silently — deleting your only org, then GET /api/orgs auto-creating a
// fresh "<name>'s Workspace" — but that's a bad UX surprise: the user asked
// to delete their workspace and would instead watch a new empty one
// reappear with no explanation. Blocking with a clear error (make/join
// another org first) is more honest about what "delete" actually does here.
//
// Guard 2 — active billing: an org can have a live Stripe subscription
// (org_subscriptions.status === 'active'). Silently deleting the org would
// orphan that subscription — Stripe keeps charging a customer tied to an
// org_id that no longer resolves to anything. Rather than block deletion
// outright and force a manual trip to the Stripe dashboard, we cancel the
// subscription (lib/billing.mjs cancelSubscription) as part of delete, then
// proceed — mirroring "delete my account" flows that fold subscription
// cleanup into the deletion instead of making it a precondition.
router.delete("/api/orgs/:orgId", requireAuth, async (req, res) => {
  const orgId = req.params.orgId;
  const member = isOrgMember(orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });

  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: "Not found" });

  const myOrgs = listOrgs(req.user.id);
  if (myOrgs.length <= 1) {
    return res.status(400).json({ error: "Cannot delete your only organization. Create or join another org first." });
  }

  if (billingEnabled) {
    const sub = getSubscription(orgId);
    if (["active", "trialing", "past_due", "unpaid"].includes(sub.status) && sub.stripe_subscription_id) {
      try {
        await cancelSubscription(orgId);
      } catch (e) {
        return res.status(502).json({ error: `Failed to cancel the org's Stripe subscription — try again or cancel it manually first. (${e.message})` });
      }
    }
  }

  // Remove on-disk repo directories before dropping the DB rows (once the
  // org row is gone, ON DELETE CASCADE removes the space rows themselves,
  // and we'd lose local_path to clean up after).
  for (const space of listSpacesByOrg(orgId)) {
    try { deleteSpace(space.id); } catch (e) { console.error(`[orgs] failed to delete space ${space.id} during org deletion:`, e.message); }
  }

  deleteOrg(orgId);
  res.json({ ok: true });
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

router.post("/api/orgs/:orgId/invites", requireAuth, (req, res) => {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  const { role = "editor" } = req.body || {};
  if (!["admin", "editor", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });
  const invite = createInvite(req.params.orgId, { role, createdBy: req.user.id });
  res.json({
    token: invite.token,
    url: `${config.appUrl}/invite/${invite.token}`,
    expires_at: invite.expires_at,
  });
});

router.post("/api/invites/:token/accept", requireAuth, (req, res) => {
  const invite = getInviteByToken(req.params.token);
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.used_by) return res.status(410).json({ error: "This invite has already been used" });
  if (new Date(invite.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "This invite has expired" });

  const result = acceptInvite(req.params.token, req.user.id);
  if (result.error === "seat_limit") return res.status(402).json({ error: "This organization has reached its plan's seat limit. Ask an admin to update billing or free a seat." });
  if (result.error) return res.status(410).json({ error: "This invite is no longer valid" });
  res.json(result.org);
});

export default router;
