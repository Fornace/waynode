/**
 * routes/api-tokens.js — Personal API token management for native clients.
 *
 *   GET    /api/tokens              → list (metadata only, no raw tokens)
 *   POST   /api/tokens              → create → { id, token, label }  (raw token shown once)
 *   DELETE /api/tokens/:id          → revoke
 *
 * All require an authenticated session (cookie / dev-token / existing bearer).
 * Bearer tokens CANNOT create other bearer tokens (no privilege escalation
 * from a leaked token) — enforced by the `requireSessionOrDev` guard.
 */
import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { createToken, listTokens, revokeToken, countTokens } from "../lib/api-tokens.mjs";

const router = Router();
const MAX_TOKENS = 10;

/** Block bearer-authed requests from CREATING tokens: a leaked token
 *  must not mint more tokens (privilege escalation). Listing and revoking
 *  your OWN tokens is allowed for bearer-authed native clients — they
 *  have no other auth method. */
function requireSessionOrDevForCreate(req, res, next) {
  if (req.authMethod === "bearer") {
    return res.status(403).json({
      error: "API tokens cannot be created with a bearer token. Sign in via web session.",
    });
  }
  next();
}

router.get("/api/tokens", requireAuth, (req, res) => {
  res.json({ tokens: listTokens(req.user.id) });
});

router.post("/api/tokens", requireAuth, requireSessionOrDevForCreate, (req, res) => {
  if (countTokens(req.user.id) >= MAX_TOKENS) {
    return res.status(400).json({ error: `Maximum of ${MAX_TOKENS} tokens reached. Revoke one first.` });
  }
  const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 60) : "Default";
  const created = createToken(req.user.id, label);
  res.status(201).json(created);
});

router.delete("/api/tokens/:id", requireAuth, (req, res) => {
  const ok = revokeToken(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Token not found" });
  res.json({ ok: true });
});

export default router;
