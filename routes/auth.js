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
  passport.authenticate("github", { failureRedirect: "/login" }),
  (req, res) => res.redirect("/")
);

router.get("/auth/gitlab", passport.authenticate("gitlab"));

router.get("/auth/gitlab/callback",
  passport.authenticate("gitlab", { failureRedirect: "/login" }),
  (req, res) => res.redirect("/")
);

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
