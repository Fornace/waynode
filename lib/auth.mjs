import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as GitLabStrategy } from "passport-gitlab2";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { randomUUID, createHash, timingSafeEqual } from "crypto";
import { getSpaceAuthorization } from "./space-access.mjs";
import { encryptOAuthToken } from "./oauth-tokens.mjs";

/**
 * Return organisations that would be left without an administrator if this
 * user disappeared.  Organisations deliberately have no implicit owner: an
 * admin is the operational owner, including for billing.  Account deletion
 * must therefore stop before removing a user's final admin membership.
 */
export function accountDeletionBlockers(userId) {
  return db.prepare(`
    SELECT o.id, o.name, o.slug
    FROM orgs o
    JOIN org_members mine ON mine.org_id = o.id
    WHERE mine.user_id = ? AND mine.role = 'admin'
      AND NOT EXISTS (
        SELECT 1 FROM org_members other
        WHERE other.org_id = o.id AND other.user_id != ? AND other.role = 'admin'
      )
    ORDER BY o.name COLLATE NOCASE
  `).all(userId, userId);
}

/**
 * Permanently remove a user after `accountDeletionBlockers` has passed.
 *
 * The database foreign keys revoke API tokens, memberships and personal
 * settings.  Org-owned spaces and their sessions are retained, with ownership
 * moved to another existing org admin; unscoped legacy spaces are personal and
 * are returned to the caller for filesystem removal before this transaction.
 */
export function prepareAccountDeletion(userId) {
  const blockers = accountDeletionBlockers(userId);
  if (blockers.length) return { blockers, personalSpaces: [] };

  const ownedSpaces = db.prepare("SELECT id, org_id, local_path FROM spaces WHERE owner_id = ?").all(userId);
  const personalSpaces = ownedSpaces.filter((space) => !space.org_id);
  const transfers = ownedSpaces
    .filter((space) => space.org_id)
    .map((space) => ({
      spaceId: space.id,
      successor: db.prepare(`
        SELECT user_id FROM org_members
        WHERE org_id = ? AND user_id != ? AND role = 'admin'
        ORDER BY user_id ASC LIMIT 1
      `).get(space.org_id, userId)?.user_id,
    }));

  // The blocker query above guarantees a successor for each org where the
  // user is an admin.  This extra guard also protects malformed historic data.
  if (transfers.some((transfer) => !transfer.successor)) {
    return { blockers: [{ id: "unknown", name: "an organization", slug: "" }], personalSpaces: [] };
  }
  return { blockers: [], personalSpaces, transfers };
}

export function deletePreparedAccount(userId, transfers = []) {
  // node:sqlite's DatabaseSync exposes explicit SQL transactions (unlike
  // better-sqlite3's `.transaction()` helper), so keep this all-or-nothing.
  db.exec("BEGIN IMMEDIATE");
  try {
    // Preserve shared work by assigning both spaces and their sessions to the
    // successor admin.  Ensure the successor has an explicit space membership
    // as well; org membership alone does not grant space access in Waynode.
    for (const { spaceId, successor } of transfers) {
      db.prepare("UPDATE spaces SET owner_id = ? WHERE id = ? AND owner_id = ?").run(successor, spaceId, userId);
      db.prepare("UPDATE sessions SET owner_id = ? WHERE space_id = ? AND owner_id = ?").run(successor, spaceId, userId);
      db.prepare(`
        INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')
        ON CONFLICT(space_id, user_id) DO UPDATE SET role = 'owner'
      `).run(spaceId, successor);
    }

    // A member can own a session inside somebody else's space. Sessions have a
    // non-cascading user FK, so preserve those transcripts by assigning them to
    // the (possibly just-transferred) space owner before deleting the user.
    db.prepare(`
      UPDATE sessions
      SET owner_id = (SELECT owner_id FROM spaces WHERE spaces.id = sessions.space_id)
      WHERE owner_id = ?
    `).run(userId);

    // These two foreign keys intentionally do not cascade so used/in-flight
    // invites cannot retain a deleted identity. Revoking them is safer than
    // silently preserving an invite audit record tied to no account.
    db.prepare("DELETE FROM org_invites WHERE created_by = ? OR used_by = ?").run(userId, userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function upsertUser(profile, provider, accessToken, refreshToken) {
  const existing = provider === "github"
    ? db.prepare("SELECT * FROM users WHERE github_id = ?").get(profile.id)
    : db.prepare("SELECT * FROM users WHERE gitlab_id = ?").get(profile.id);

  if (existing) {
    const encryptedAccess = encryptOAuthToken(accessToken, provider);
    const refreshField = `${provider}_refresh_token`;
    const encryptedRefresh = refreshToken
      ? encryptOAuthToken(refreshToken, provider, "refresh")
      : existing[refreshField];
    db.prepare(`
      UPDATE users SET
        name = ?, email = ?, avatar_url = ?,
        ${provider}_id = ?,
        ${provider}_token = ?,
        ${refreshField} = ?
      WHERE id = ?
    `).run(
      profile.displayName || profile.username,
      profile.emails?.[0]?.value,
      profile.photos?.[0]?.value,
      profile.id,
      encryptedAccess,
      encryptedRefresh,
      existing.id
    );
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (
      id, ${provider}_id, name, email, avatar_url, ${provider}_token, ${provider}_refresh_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, profile.id,
    profile.displayName || profile.username,
    profile.emails?.[0]?.value,
    profile.photos?.[0]?.value,
    encryptOAuthToken(accessToken, provider),
    refreshToken ? encryptOAuthToken(refreshToken, provider, "refresh") : null
  );
  return id;
}

function linkProvider(profile, provider, accessToken) {
  const col = `${provider}_id`;
  const existing = db.prepare(`SELECT * FROM users WHERE ${col} = ?`).get(profile.id);
  if (existing) return existing.id;
  return null;
}

if (config.github.clientId) {
  passport.use(new GitHubStrategy({
    clientID: config.github.clientId,
    clientSecret: config.github.clientSecret,
    callbackURL: `${config.appUrl}/auth/github/callback`,
    scope: ["user:email", "repo", "read:org"],
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const userId = upsertUser(profile, "github", accessToken, refreshToken);
      done(null, { id: userId });
    } catch (err) {
      done(err);
    }
  }));
}

if (config.gitlab.clientId) {
  passport.use(new GitLabStrategy({
    clientID: config.gitlab.clientId,
    clientSecret: config.gitlab.clientSecret,
    callbackURL: `${config.appUrl}/auth/gitlab/callback`,
    baseURL: config.gitlab.baseUrl,
scope: ["read_user", "api", "read_repository", "write_repository"],
  }, (accessToken, refreshToken, profile, done) => {
    // NOTE: account-linking (GitHub session + GitLab) is handled in the
    // /auth/gitlab/callback route, which has `req`. Do NOT reference `req`
    // here — passReqToCallback is not set, so it would be a ReferenceError.
    try {
      const userId = upsertUser(profile, "gitlab", accessToken, refreshToken);
      done(null, { id: userId });
    } catch (err) {
      done(err);
    }
  }));
}

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  const user = db.prepare("SELECT id, github_id, gitlab_id, name, email, avatar_url, role FROM users WHERE id = ?").get(id);
  done(null, user || false);
});

function resolveBearerUser(req) {
  // Authorization: Bearer wn_.....
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    return resolveApiToken(auth.slice(7).trim());
  }
  return null;
}

function isActiveUser(user) {
  return !!user && user.role !== "disabled";
}

/** Resolve a raw `wn_...` API token to a user row, bumping last_used_at.
 *  Shared by bearer-header auth, SSE query-param auth (?t=wn_...), and the
 *  terminal WebSocket handshake so all three transports agree. */
export function resolveApiToken(raw) {
  if (!raw || !raw.startsWith("wn_") || raw.length < 20) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash);
  if (!row) return null;
  try {
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  } catch {}
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id) || null;
  return isActiveUser(user) ? user : null;
}

/** Auth middleware for SSE / WebSocket routes that can't send headers.
 *  Accepts `?t=wn_...` (API token) or `?t=<devToken>` (dev). */
export function queryTokenAuth(req) {
  const tok = req.query.t;
  const user = resolveApiToken(tok);
  if (user) return user;
  if (config.devToken && tok && tok === config.devToken) {
    let u = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    if (!u) {
      db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("dev-user", config.devUserName);
      u = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    }
    return u;
  }
  return null;
}

/** Shared credential resolution for requireAuth/optionalAuth, in the same
 *  order: Bearer wn_ token → x-dev-token → passport session. Returns
 *  { user, authMethod } or null when no credential resolves. */
function resolveCredentials(req) {
  // 1) Personal API token (Bearer wn_...) — native apps & CLI.
  const bearerUser = resolveBearerUser(req);
  if (bearerUser) return { user: bearerUser, authMethod: "bearer" };
  // 2) Dev bypass token (x-dev-token header).
  if (config.devToken && req.headers["x-dev-token"] === config.devToken) {
    let user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    if (!user) {
      db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("dev-user", config.devUserName);
      user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    }
    return { user, authMethod: "dev" };
  }
  // 3) Passport session (cookie).
  if (typeof req.isAuthenticated === "function" && req.isAuthenticated() && isActiveUser(req.user)) {
    return { user: req.user, authMethod: "session" };
  }
  return null;
}

function applyResolvedCredentials(req, resolved) {
  req.user = resolved.user;
  req.authMethod = resolved.authMethod;
  // Passport sessions already provide isAuthenticated; token transports need one.
  if (resolved.authMethod !== "session") req.isAuthenticated = () => true;
}

export function requireAuth(req, res, next) {
  const resolved = resolveCredentials(req);
  if (resolved) {
    applyResolvedCredentials(req, resolved);
    return next();
  }
  if (req.isAuthenticated() && req.user?.role === "disabled") {
    req.logout?.(() => {});
    return res.status(403).json({ error: "Account disabled" });
  }
  res.status(401).json({ error: "Authentication required" });
}

/** Same credential resolution as requireAuth, but never rejects: unresolved
 *  requests continue with req.user unset. For public endpoints that enrich
 *  their response when the caller happens to be authenticated. */
export function optionalAuth(req, res, next) {
  const resolved = resolveCredentials(req);
  if (resolved) applyResolvedCredentials(req, resolved);
  next();
}

export function requireSpaceAccess(req, res, next) {
  const spaceId = req.params.spaceId || req.body?.spaceId;
  if (!spaceId) return res.status(400).json({ error: "spaceId required" });
  const access = getSpaceAuthorization(spaceId, req.user.id);
  if (!access.exists) return res.status(404).json({ error: "Space not found" });
  if (!access.role) return res.status(403).json({ error: "Access denied" });
  req.spaceRole = access.role;
  next();
}

export function requireAdmin(req, res, next) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export { passport };
