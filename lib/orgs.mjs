import { randomUUID } from "crypto";
import db from "./db.mjs";

export function createOrg({ name, slug, userId }) {
  const id = randomUUID();
  const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 30);

  db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(id, name, finalSlug);
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'admin')").run(id, userId);

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
  db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
}

export function removeMember(orgId, userId) {
  db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, userId);
}

export function isOrgMember(orgId, userId) {
  const row = db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId);
  return row;
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
