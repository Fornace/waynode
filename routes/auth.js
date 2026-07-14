import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { passport, resolveApiToken, requireAuth, prepareAccountDeletion, deletePreparedAccount } from "../lib/auth.mjs";
import { config } from "../lib/config.mjs";
import { createToken, countTokens, listTokens, revokeRawToken, revokeToken } from "../lib/api-tokens.mjs";

const NATIVE_MAX_TOKENS = 10;
import db from "../lib/db.mjs";
import { deleteSpace } from "../lib/spaces.mjs";

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
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const NATIVE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function clearBrowserSessionCookie(res) {
  res.clearCookie("connect.sid", {
    path: "/",
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
  });
}

function freshNonce() {
  return randomBytes(32).toString("base64url");
}

// Format: base64url(payload).base64url(HMAC). Native state is cookie-free;
// browser state is additionally bound to the initiating server session.
function signOAuthState({ native, nonce, provider }) {
  const iat = Date.now();
  const payload = JSON.stringify({ native, nonce, provider, iat, exp: iat + OAUTH_STATE_TTL_MS });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", config.sessionSecret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || typeof state !== "string") return null;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot !== state.lastIndexOf(".") || dot === state.length - 1) return null;
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", config.sessionSecret).update(b64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    const now = Date.now();
    if (typeof payload.native !== "boolean") return null;
    if (!NATIVE_NONCE_PATTERN.test(payload.nonce)) return null;
    if (!["github", "gitlab"].includes(payload.provider)) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
    if (payload.exp - payload.iat !== OAUTH_STATE_TTL_MS) return null;
    if (payload.iat > now + 5_000 || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqualText(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function oauthOptions(req, provider) {
  const native = req.query.native === "1";
  const requestedNonce = typeof req.query.native_nonce === "string" ? req.query.native_nonce : "";
  const nonce = native && NATIVE_NONCE_PATTERN.test(requestedNonce) ? requestedNonce : freshNonce();
  const state = signOAuthState({ native, nonce, provider });
  if (!native) {
    req.session.oauthState = { nonce, provider, expiresAt: Date.now() + OAUTH_STATE_TTL_MS };
  }
  // passport-oauth2's configured NullStore passes through string state; this
  // route verifies the HMAC and browser-session binding before Passport runs.
  return { state };
}

function requireOAuthState(provider) {
  return (req, res, next) => {
    const state = verifyOAuthState(req.query?.state);
    if (!state || state.provider !== provider) {
      return res.redirect("/login?auth_error=invalid_oauth_state");
    }
    if (!state.native) {
      const pending = req.session?.oauthState;
      delete req.session.oauthState;
      if (!pending || pending.provider !== provider || pending.expiresAt <= Date.now()
          || !safeEqualText(pending.nonce, state.nonce)) {
        return res.redirect("/login?auth_error=invalid_oauth_state");
      }
    }
    req.oauthState = state;
    next();
  };
}

// After successful OAuth, either redirect to web `/` or, if the request
// originated from the native app, create an API token and redirect to the
// custom URL scheme `waynode://auth?token=wn_...`.
function authRedirect(req, res) {
  const nativeState = req.oauthState?.native ? req.oauthState : null;

  if (nativeState && req.user) {
    // Enforce the same MAX_TOKENS limit as /api/tokens, but evict the oldest
    // token first so native re-login never hits a wall (rolling replacement).
    if (countTokens(req.user.id) >= NATIVE_MAX_TOKENS) {
      const oldest = listTokens(req.user.id).pop(); // listTokens orders DESC by created_at
      if (oldest) revokeToken(req.user.id, oldest.id);
    }
    const { token } = createToken(req.user.id, "iOS / Mac App");
    const params = new URLSearchParams({ token, nonce: nativeState.nonce });
    return res.redirect(`${NATIVE_SCHEME}://auth?${params}`);
  }
  res.redirect("/");
}

function rotateAndLogin(req, res, user) {
  // Regenerate the pre-auth session before attaching an identity so a session
  // ID set before OAuth cannot survive into an authenticated browser session.
  req.session.regenerate((regenerateError) => {
    if (regenerateError) return res.redirect("/login?auth_error=session_failed");
    req.login(user, (loginError) => {
      if (loginError) return res.redirect("/login?auth_error=login_failed");
      authRedirect(req, res);
    });
  });
}

router.get("/auth/github", (req, res, next) => {
  passport.authenticate("github", oauthOptions(req, "github"))(req, res, next);
});

router.get("/auth/github/callback", requireOAuthState("github"), (req, res, next) => {
  passport.authenticate("github", { failureRedirect: "/" }, (err, user) => {
    if (err || !user) return res.redirect("/login?auth_error=github_failed");
    rotateAndLogin(req, res, user);
  })(req, res, next);
});

router.get("/auth/gitlab", (req, res, next) => {
  passport.authenticate("gitlab", oauthOptions(req, "gitlab"))(req, res, next);
});

router.get("/auth/gitlab/callback", requireOAuthState("gitlab"), (req, res, next) => {
  passport.authenticate("gitlab", async (err, user, info, status) => {
    if (err) return res.redirect("/login?auth_error=" + encodeURIComponent(err.message));
    if (!user) return res.redirect("/login?auth_error=gitlab_failed");

    // Provider linking must be an explicit, state-bound flow. Do not silently
    // merge an OAuth identity into whichever browser account happens to have a
    // session: that is an account-confusion vulnerability and the verifier only
    // returns a user ID, not safely linkable provider credentials.
    rotateAndLogin(req, res, user);
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
    return res.json({ user: bearerUser, providers: { github: !!bearerUser.github_id, gitlab: !!bearerUser.gitlab_id, dev: false }, availableProviders: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId } });
  }
  // If a Bearer header was sent but no user resolved, the token is
  // invalid/revoked. Return 401 so the native client can detect this
  // and prompt re-authentication — NOT a silent 200 with user:null.
  if (hasBearer) {
    return res.status(401).json({ error: "Invalid or revoked API token" });
  }
  const devUser = resolveDevToken(req);
  if (devUser) {
    return res.json({ user: devUser, providers: { github: false, gitlab: false, dev: true }, availableProviders: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId } });
  }
  if (!req.isAuthenticated()) {
    // Return which OAuth providers are configured on the server so the
    // native app can show the right login buttons before authenticating.
    return res.json({
      user: null,
      providers: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId },
      availableProviders: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId },
    });
  }
  res.json({
    user: req.user,
    providers: getLinkedProviders(req.user.id),
    availableProviders: { github: !!config.github.clientId, gitlab: !!config.gitlab.clientId },
  });
});

router.delete("/api/auth/native-token", requireAuth, (req, res) => {
  if (req.authMethod !== "bearer") {
    return res.status(403).json({ error: "Only the current native bearer token can revoke itself." });
  }
  const rawToken = req.headers.authorization?.slice("Bearer ".length).trim();
  if (!revokeRawToken(req.user.id, rawToken)) {
    return res.status(404).json({ error: "Token not found" });
  }
  res.json({ ok: true });
});

router.post("/auth/logout", (req, res) => {
  req.logout(() => {
    // Destroy the server-side session too.  Merely calling passport logout
    // clears req.user but leaves a usable session identifier in the browser.
    req.session?.destroy(() => {
      clearBrowserSessionCookie(res);
      res.json({ ok: true });
    });
  });
});

// A preflight keeps the destructive UI honest and gives users a concrete way
// to resolve the only safe blocker: appoint another administrator for every
// org they are the final admin of (especially important for paid orgs).
router.get("/api/auth/account/deletion-check", requireAuth, (req, res) => {
  if (req.authMethod === "bearer") {
    return res.status(403).json({ error: "For account safety, delete your account from a web sign-in session." });
  }
  const prepared = prepareAccountDeletion(req.user.id);
  res.json({ can_delete: prepared.blockers.length === 0, blockers: prepared.blockers });
});

router.delete("/api/auth/account", requireAuth, (req, res) => {
  // A long-lived bearer token must not be enough to erase an account. Native
  // users can complete this from the web session created by OAuth instead.
  if (req.authMethod === "bearer") {
    return res.status(403).json({ error: "For account safety, delete your account from a web sign-in session." });
  }
  if (req.body?.confirmation !== "DELETE") {
    return res.status(400).json({ error: 'Type DELETE to permanently delete your account.' });
  }

  const prepared = prepareAccountDeletion(req.user.id);
  if (prepared.blockers.length) {
    return res.status(409).json({
      error: "Transfer administration before deleting your account. Each organization needs another admin to protect its work and billing.",
      blockers: prepared.blockers,
    });
  }

  // Delete only unscoped legacy/personal spaces. Org-owned work is transferred
  // inside deletePreparedAccount, never destroyed as a side effect of one
  // member leaving. Delete filesystem state first so a failure leaves the
  // account intact rather than a DB row pointing to a missing repository.
  try {
    for (const space of prepared.personalSpaces) deleteSpace(space.id);
    deletePreparedAccount(req.user.id, prepared.transfers);
  } catch (error) {
    console.error("[auth] account deletion failed:", error);
    return res.status(500).json({ error: "Could not delete the account safely. Nothing else was signed out." });
  }

  req.logout(() => {
    req.session?.destroy(() => {
      clearBrowserSessionCookie(res);
      res.json({ ok: true });
    });
  });
});

export default router;
