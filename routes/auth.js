import { Router } from "express";
import { passport } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";

const router = Router();

function getLinkedProviders(userId) {
  const user = db.prepare("SELECT github_id, gitlab_id FROM users WHERE id = ?").get(userId);
  return {
    github: !!user?.github_id,
    gitlab: !!user?.gitlab_id,
  };
}

function resolveDevToken(req) {
  if (!config.devToken || req.headers["x-dev-token"] !== config.devToken) return null;
  let user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
  if (!user) {
    db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("dev-user", config.devUserName);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get("dev-user");
  }
  return user;
}

router.get("/auth/github", passport.authenticate("github"));

router.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);

router.get("/auth/gitlab", passport.authenticate("gitlab"));

router.get("/auth/gitlab/callback", (req, res, next) => {
  passport.authenticate("gitlab", async (err, user, info, status) => {
    if (err) return res.redirect("/?auth_error=" + encodeURIComponent(err.message));
    if (!user) return res.redirect("/?auth_error=gitlab_failed");

    // If already logged in via GitHub, link GitLab to the existing account
    if (req.user && req.user.id !== user.id) {
      db.prepare(`
        UPDATE users SET gitlab_id = ?, gitlab_token = ?
        WHERE id = ?
      `).run(
        user.gitlab_id || null,
        user.gitlab_token || null,
        req.user.id
      );
      req.login({ id: req.user.id }, () => res.redirect("/"));
    } else {
      req.login(user, () => res.redirect("/"));
    }
  })(req, res, next);
});

router.get("/api/auth/me", (req, res) => {
  const devUser = resolveDevToken(req);
  if (devUser) {
    return res.json({ user: devUser, providers: { github: false, gitlab: false, dev: true } });
  }
  if (!req.isAuthenticated()) return res.json({ user: null });
  res.json({
    user: req.user,
    providers: getLinkedProviders(req.user.id),
  });
});

router.post("/auth/logout", (req, res) => {
  req.logout(() => {
    res.json({ ok: true });
  });
});

export default router;
