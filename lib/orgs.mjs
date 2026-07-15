import { randomUUID } from "crypto";
import db from "./db.mjs";
import { billingEnabled } from "./config.mjs";
import { checkQuota, PLANS } from "./billing.mjs";
import { syncOrgSpaceMemberships } from "./space-access.mjs";
import { claimHostedTrial } from "./trial-eligibility.mjs";

export function createOrg({ name, slug, userId }) {
  const id = randomUUID();
  const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 30);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(id, name, finalSlug);
    db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'admin')").run(id, userId);
    claimHostedTrial(userId, id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getOrg(id);
}

export function getOrg(id) {
  return db.prepare("SELECT * FROM orgs WHERE id = ?").get(id);
}

export function getOrgBySlug(slug) {
  return db.prepare("SELECT * FROM orgs WHERE slug = ?").get(slug);
}

export function listOrgs(userId) {
  return db.prepare(`
    SELECT o.*, om.role as my_role,
      (SELECT COUNT(*) FROM spaces WHERE org_id = o.id) as space_count
    FROM orgs o
    JOIN org_members om ON om.org_id = o.id
    WHERE om.user_id = ?
    ORDER BY o.created_at ASC
  `).all(userId);
}

export function renameOrg(orgId, name) {
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run(name, orgId);
  return getOrg(orgId);
}

export function getOrgSetting(orgId, key) {
  const row = db.prepare("SELECT value FROM org_settings WHERE org_id = ? AND key = ?").get(orgId, key);
  return row?.value || null;
}

export function getOrgSettings(orgId) {
  const rows = db.prepare("SELECT key, value FROM org_settings WHERE org_id = ?").all(orgId);
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

export function setOrgSetting(orgId, key, value) {
  db.prepare(`
    INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value
  `).run(orgId, key, value);
}

export function listOrgMembers(orgId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.avatar_url, om.role, u.created_at
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ?
    ORDER BY om.role DESC, u.name ASC
  `).all(orgId);
}

export function updateMemberRole(orgId, userId, role) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
    syncOrgSpaceMemberships(orgId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function removeMember(orgId, userId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, userId);
    syncOrgSpaceMemberships(orgId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function isOrgMember(orgId, userId) {
  const row = db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId);
  return row;
}

export function createInvite(orgId, { role = "editor", createdBy, ttlDays = 7 }) {
  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();

  db.prepare(`
    INSERT INTO org_invites (id, org_id, token, role, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, orgId, token, role, createdBy, expiresAt);

  return getInviteByToken(token);
}

export function getInviteByToken(token) {
  return db.prepare("SELECT * FROM org_invites WHERE token = ?").get(token);
}

export function acceptInvite(token, userId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const invite = getInviteByToken(token);
    if (!invite) { db.exec("ROLLBACK"); return { error: "not_found" }; }
    if (invite.used_by) { db.exec("ROLLBACK"); return { error: "used" }; }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      db.exec("ROLLBACK");
      return { error: "expired" };
    }
    const existing = isOrgMember(invite.org_id, userId);
    if (!existing) {
      // Seat limits only apply on explicit Waynode Cloud deployments. Enforce
      // at acceptance so stale links cannot reserve or oversubscribe seats.
      if (billingEnabled) {
        const quota = checkQuota(invite.org_id);
        const seats = (PLANS[quota.plan] || PLANS.free).seats;
        const members = db.prepare("SELECT COUNT(*) AS count FROM org_members WHERE org_id = ?")
          .get(invite.org_id).count;
        if (!["active", "trialing"].includes(quota.status) || members >= seats) {
          db.exec("ROLLBACK");
          return { error: "seat_limit" };
        }
      }
      db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)")
        .run(invite.org_id, userId, invite.role);
    }
    syncOrgSpaceMemberships(invite.org_id);
    db.prepare("UPDATE org_invites SET used_by = ?, used_at = datetime('now') WHERE token = ?").run(userId, token);
    db.exec("COMMIT");
    return { org: getOrg(invite.org_id) };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/**
 * Delete an org row. Every org-scoped table (org_members, org_settings,
 * org_secrets, org_invites, org_subscriptions, org_usage, and spaces.org_id)
 * declares `REFERENCES orgs(id) ON DELETE CASCADE` in lib/db.mjs, and
 * `PRAGMA foreign_keys = ON` is set at DB init, so this single DELETE cleans
 * up all related rows — including spaces (whose own ON DELETE CASCADE then
 * cleans up space_members). It does NOT remove on-disk repo directories for
 * the org's spaces; callers that need that should call deleteSpace() per
 * space first (see routes/orgs.js).
 */
export function deleteOrg(orgId) {
  db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
}

export function ensureDefaultOrg(userId, userName) {
  const orgs = listOrgs(userId);
  if (orgs.length > 0) return orgs[0];

  const org = createOrg({
    name: `${userName}'s Workspace`,
    slug: userName.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20),
    userId,
  });
  return org;
}
