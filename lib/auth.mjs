import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as GitLabStrategy } from "passport-gitlab2";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { randomUUID } from "crypto";

function upsertUser(profile, provider, accessToken) {
  const existing = provider === "github"
    ? db.prepare("SELECT * FROM users WHERE github_id = ?").get(profile.id)
    : db.prepare("SELECT * FROM users WHERE gitlab_id = ?").get(profile.id);

  if (existing) {
    db.prepare(`
      UPDATE users SET
        name = ?, email = ?, avatar_url = ?,
        ${provider}_id = ?,
        ${provider}_token = ?
      WHERE id = ?
    `).run(
      profile.displayName || profile.username,
      profile.emails?.[0]?.value,
      profile.photos?.[0]?.value,
      profile.id,
      accessToken,
      existing.id
    );
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, ${provider}_id, name, email, avatar_url, ${provider}_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, profile.id,
    profile.displayName || profile.username,
    profile.emails?.[0]?.value,
    profile.photos?.[0]?.value,
    accessToken
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
      const userId = upsertUser(profile, "github", accessToken);
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
      const userId = upsertUser(profile, "gitlab", accessToken);
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
  const user = db.prepare("SELECT id, github_id, gitlab_id, name, email, avatar_url FROM users WHERE id = ?").get(id);
  done(null, user || false);
});

export function requireAuth(req, res, next) {
  if (config.devToken && req.headers["x-dev-token"] === config.devToken) {
    let user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    if (!user) {
      db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("dev-user", config.devUserName);
      user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
    }
    req.user = user;
    req.isAuthenticated = () => true;
    return next();
  }
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Authentication required" });
}

export function requireSpaceAccess(req, res, next) {
  const spaceId = req.params.spaceId || req.body?.spaceId;
  if (!spaceId) return res.status(400).json({ error: "spaceId required" });

  const member = db.prepare(`
    SELECT role FROM space_members
    WHERE space_id = ? AND user_id = ?
  `).get(spaceId, req.user.id);

  const space = db.prepare("SELECT owner_id FROM spaces WHERE id = ?").get(spaceId);

  if (!space) return res.status(404).json({ error: "Space not found" });
  if (space.owner_id !== req.user.id && !member) {
    return res.status(403).json({ error: "Access denied" });
  }

  req.spaceRole = space.owner_id === req.user.id ? "owner" : member.role;
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
