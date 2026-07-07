import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { passport, resolveApiToken } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import { createToken, countTokens, listTokens, revokeToken } from "../lib/api-tokens.mjs";

const NATIVE_MAX_TOKENS = 10;
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
// 10-minute validity window for the signed native state token.
const NATIVE_STATE_TTL_MS = 10 * 60 * 1000;

// Sign a self-contained "native app" marker that survives the cross-domain
// OAuth round-trip. GitHub/GitLab echo the `state` query param back on the
// callback VERBATIM, so this does NOT depend on cookies or the session store
// surviving a redirect through github.com/gitlab.com — which is exactly the
// failure mode that broke native login inside ASWebAuthenticationSession on
// iOS (SameSite=Lax + shared cookie store round-trips are unreliable).
//
// Format:  base64url(payload).base64url(hmac)
function signNativeState() {
  const payload = JSON.stringify({ native: true, exp: Date.now() + NATIVE_STATE_TTL_MS });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", config.sessionSecret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

// Verify a state value returned by the OAuth provider. True iff the HMAC
// signature matches (timing-safe), the token is unexpired, and it carries
// native:true. Returns false for missing/tampered/expired state.
function verifyNativeState(state) {
  if (!state || typeof state !== "string") return false;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return false;
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", config.sessionSecret).update(b64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (payload.native !== true) return false;
    if (typeof payload.exp === "number" && Date.now() > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// Build per-request passport options. When the native app initiated the
// request (?native=1), embed the signed state so it round-trips through the
// OAuth provider back to the callback. passport-oauth2 adds a string `state`
// option to the authorize URL verbatim and (with NullStore) ignores it on the
// way back — so we read it ourselves in authRedirect.
function nativeAuthOptions(req) {
  return req.query.native !== undefined ? { state: signNativeState() } : {};
}

// Legacy fallback: also flag the session. Unreliable across the cross-domain
// OAuth redirect (the original bug), but kept as a belt-and-suspenders signal
// in case the state channel is ever stripped.
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
  // Primary signal: the signed `state` param echoed back by the OAuth
  // provider (cookie-independent — this is what makes native login robust).
  // Fallback: the session flag set by markNative.
  const isNative = verifyNativeState(req.query?.state) || !!req.session.nativeAuth;
  delete req.session.nativeAuth;

  if (isNative && req.user) {
    // Enforce the same MAX_TOKENS limit as /api/tokens, but evict the oldest
    // token first so native re-login never hits a wall (rolling replacement).
    if (countTokens(req.user.id) >= NATIVE_MAX_TOKENS) {
      const oldest = listTokens(req.user.id).pop(); // listTokens orders DESC by created_at
      if (oldest) revokeToken(req.user.id, oldest.id);
    }
    const { token } = createToken(req.user.id, "iOS / Mac App");
    const params = new URLSearchParams({ token });
    return res.redirect(`${NATIVE_SCHEME}://auth?${params}`);
  }
  res.redirect("/");
}

router.get("/auth/github", markNative, (req, res, next) => {
  passport.authenticate("github", nativeAuthOptions(req))(req, res, next);
});

router.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  authRedirect
);

router.get("/auth/gitlab", markNative, (req, res, next) => {
  passport.authenticate("gitlab", nativeAuthOptions(req))(req, res, next);
});

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
