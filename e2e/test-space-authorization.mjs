/** Adversarial regression for canonical organization-space authorization. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-space-authz-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "space-authz-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { default: db } = await import("../lib/db.mjs");
const {
  acceptInvite, createInvite, createOrg, removeMember, updateMemberRole,
} = await import("../lib/orgs.mjs");
const { createSpaceRecord, listSpaces, listSpacesByOrg } = await import("../lib/spaces.mjs");
const { getSpaceAuthorization } = await import("../lib/space-access.mjs");
const { requireSpaceAccess } = await import("../lib/auth.mjs");

function seedUser(id) {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(id, id);
}

function accept(orgId, createdBy, userId, role) {
  const invite = createInvite(orgId, { createdBy, role });
  assert.equal(acceptInvite(invite.token, userId).error, undefined);
}

function middlewareResult(spaceId, userId) {
  const result = { status: 200, body: null, next: false, role: null };
  const req = { params: { spaceId }, body: {}, user: { id: userId } };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  requireSpaceAccess(req, res, () => { result.next = true; result.role = req.spaceRole; });
  return result;
}

try {
  for (const id of ["owner", "editor", "viewer", "admin", "outsider"]) seedUser(id);
  const org = createOrg({ name: "Authorization org", userId: "owner" });
  const orgSpace = createSpaceRecord("https://github.com/example/org.git", "main", "owner", org.id);
  accept(org.id, "owner", "editor", "editor");
  accept(org.id, "owner", "viewer", "viewer");
  accept(org.id, "owner", "admin", "admin");

  assert.equal(getSpaceAuthorization(orgSpace.id, "owner").role, "owner");
  assert.equal(getSpaceAuthorization(orgSpace.id, "editor").role, "editor");
  assert.equal(getSpaceAuthorization(orgSpace.id, "viewer").role, "viewer");
  assert.equal(getSpaceAuthorization(orgSpace.id, "admin").role, "owner");
  assert.equal(middlewareResult(orgSpace.id, "viewer").role, "viewer");
  const rows = db.prepare("SELECT user_id, role FROM space_members WHERE space_id = ? ORDER BY user_id")
    .all(orgSpace.id).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { user_id: "admin", role: "owner" },
    { user_id: "editor", role: "editor" },
    { user_id: "owner", role: "owner" },
    { user_id: "viewer", role: "viewer" },
  ]);

  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(orgSpace.id, "outsider");
  assert.equal(getSpaceAuthorization(orgSpace.id, "outsider").role, null);
  assert.equal(middlewareResult(orgSpace.id, "outsider").status, 403);
  assert.equal(listSpaces("outsider").some((space) => space.id === orgSpace.id), false);
  assert.deepEqual(listSpacesByOrg(org.id, "outsider"), []);

  updateMemberRole(org.id, "editor", "viewer");
  assert.equal(getSpaceAuthorization(orgSpace.id, "editor").role, "viewer");
  assert.equal(db.prepare("SELECT role FROM space_members WHERE space_id = ? AND user_id = ?")
    .get(orgSpace.id, "editor").role, "viewer");

  removeMember(org.id, "owner");
  assert.equal(getSpaceAuthorization(orgSpace.id, "owner").role, null, "owner_id cannot bypass org removal");
  assert.equal(db.prepare("SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?")
    .get(orgSpace.id, "owner"), undefined);

  const personal = createSpaceRecord("ssh://git@example.test/personal.git", "main", "admin", null);
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'editor')")
    .run(personal.id, "outsider");
  assert.equal(getSpaceAuthorization(personal.id, "outsider").role, "editor");
  assert.equal(listSpaces("outsider").some((space) => space.id === personal.id), true);
  console.log("space authorization regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
