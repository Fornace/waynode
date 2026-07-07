import { Router } from "express";
import { passport, resolveApiToken } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import { createToken } from "../lib/api-tokens.mjs";
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

const NATIVE_SCHEME = "waynode";

// Flag the session when the native app initiates OAuth.
// The callback handler checks this to decide where to redirect.
function markNative(req, res, next) {
  if (req.query.native !== undefined) {
    req.session.nativeAuth = true;
  }
  next();
}

// After successful OAuth, either redirect to web `/` or, if the request
// originated from the native app, create an API token and redirect to the
// custom URL scheme `waynode://auth?token=wn_...`.
function authRedirect(req, res) {
  const isNative = req.session.nativeAuth;
  delete req.session.nativeAuth;

  if (isNative && req.user) {
    const { token } = createToken(req.user.id, "iOS / Mac App");
    const params = new URLSearchParams({ token });
    return res.redirect(`${NATIVE_SCHEME}://auth?${params}`);
  }
  res.redirect("/");
}

router.get("/auth/github", markNative, passport.authenticate("github"));

router.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  authRedirect
);

router.get("/auth/gitlab", markNative, passport.authenticate("gitlab"));

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
      req.login({ id: req.user.id }, () => authRedirect(req, res));
    } else {
      req.login(user, () => authRedirect(req, res));
    }
  })(req, res, next);
});

router.get("/api/auth/me", (req, res) => {
  // Native app: Bearer API token.
  const authHeader = req.headers["authorization"];
  const hasBearer = authHeader?.startsWith("Bearer ");
  const bearerUser = hasBearer
    ? resolveApiToken(authHeader.slice(7).trim())
    : null;
  if (bearerUser) {
    return res.json({ user: bearerUser, providers: { github: !!bearerUser.github_id, gitlab: !!bearerUser.gitlab_id, dev: false } });
  }
  // If a Bearer header was sent but no user resolved, the token is
  // invalid/revoked. Return 401 so the native client can detect this
  // and prompt re-authentication — NOT a silent 200 with user:null.
  if (hasBearer) {
    return res.status(401).json({ error: "Invalid or revoked API token" });
  }
  const devUser = resolveDevToken(req);
  if (devUser) {
    return res.json({ user: devUser, providers: { github: false, gitlab: false, dev: true } });
  }
  if (!req.isAuthenticated()) {
    // Return which OAuth providers are configured on the server so the
    // native app can show the right login buttons before authenticating.
    return res.json({
      user: null,
      providers: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId },
    });
  }
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
