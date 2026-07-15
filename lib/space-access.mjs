import db from "./db.mjs";

function effectiveOrgRole(space, userId) {
  if (!space.org_role) return null;
  if (space.owner_id === userId || space.org_role === "admin") return "owner";
  return space.org_role;
}

/**
 * Canonical authorization rule:
 * - org spaces require current org membership; stale explicit rows never grant access;
 * - the space creator and org admins act as owners;
 * - personal spaces use their owner or an explicit space membership.
 */
export function getSpaceAuthorization(spaceId, userId) {
  const space = db.prepare(`
    SELECT s.id, s.org_id, s.owner_id, om.role AS org_role, sm.role AS space_role
    FROM spaces s
    LEFT JOIN org_members om ON om.org_id = s.org_id AND om.user_id = ?
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
    WHERE s.id = ?
  `).get(userId, userId, spaceId);
  if (!space) return { exists: false, role: null };
  if (space.org_id) return { exists: true, role: effectiveOrgRole(space, userId) };
  return {
    exists: true,
    role: space.owner_id === userId ? "owner" : (space.space_role || null),
  };
}

/** Keep explicit rows aligned for UI/query compatibility and revoke stale rows. */
export function syncOrgSpaceMemberships(orgId) {
  db.prepare(`
    DELETE FROM space_members
    WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ?)
      AND user_id NOT IN (SELECT user_id FROM org_members WHERE org_id = ?)
  `).run(orgId, orgId);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role)
    SELECT s.id, om.user_id,
      CASE WHEN s.owner_id = om.user_id OR om.role = 'admin' THEN 'owner' ELSE om.role END
    FROM spaces s
    JOIN org_members om ON om.org_id = s.org_id
    WHERE s.org_id = ?
    ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role
  `).run(orgId);
}

export function syncSpaceMemberships(spaceId) {
  const orgId = db.prepare("SELECT org_id FROM spaces WHERE id = ?").get(spaceId)?.org_id;
  if (orgId) syncOrgSpaceMemberships(orgId);
}
