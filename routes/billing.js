import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { config, billingEnabled } from "../lib/config.mjs";
import { isOrgMember, getOrg } from "../lib/orgs.mjs";
import { refreshOrgStorageUsage } from "../lib/storage-quota.mjs";
import { orgLlmKeyStatus } from "../lib/org-llm-key.mjs";
import {
  PLANS, getSubscription, getUsage, checkQuota,
  createCheckoutSession, createPortalSession,
  constructWebhookEvent, handleWebhookEvent, BillingNotConfiguredError,
} from "../lib/billing.mjs";

const router = Router();

function requireOrgAdmin(req, res, next) {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  next();
}

// Unauthenticated: lets the frontend decide whether to render billing UI at
// all on self-host installs (where STRIPE_SECRET_KEY is never set).
router.get("/api/billing/enabled", (req, res) => {
  res.json({ enabled: billingEnabled, deployment: config.deployment });
});

// Keep every hosted-billing read and write inert on self-host installs. The
// public capability endpoint above is intentionally the only exception, so
// the client can hide its billing affordances without probing protected URLs.
router.use((req, res, next) => {
  const isBillingRoute =
    req.path.startsWith("/api/billing/") ||
    (req.path.startsWith("/api/orgs/") && req.path.includes("/billing"));
  if (!billingEnabled && isBillingRoute) {
    return res.status(404).json({ error: "Billing is not configured on this deployment" });
  }
  next();
});

router.get("/api/orgs/:orgId/billing", requireAuth, requireOrgAdmin, async (req, res) => {
  const orgId = req.params.orgId;
  let storageBytes;
  try {
    storageBytes = await refreshOrgStorageUsage(orgId, { strict: true });
  } catch (error) {
    console.error("[billing storage]", error.message);
    return res.status(503).json({ error: "Storage usage is temporarily unavailable. Try again." });
  }

  const subscription = getSubscription(orgId);
  const usage = getUsage(orgId);
  const quota = checkQuota(orgId);
  // Gateway-side truth for the org's own LLM key (spend, tokens, caps).
  // Optional: null whenever per-org keys aren't in play.
  const gateway = await orgLlmKeyStatus(orgId);

  res.json({
    enabled: billingEnabled,
    plan: subscription.plan,
    status: subscription.status,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    can_manage_billing: !!subscription.stripe_customer_id,
    usage: {
      tokens_used: usage.tokens_used,
      storage_bytes: storageBytes,
    },
    quota,
    gateway,
    plans: PLANS,
  });
});

router.post("/api/orgs/:orgId/billing/checkout", requireAuth, requireOrgAdmin, async (req, res) => {
  const { plan } = req.body || {};
  if (!["starter", "pro", "team", "hammersmith"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });

  try {
    const org = getOrg(req.params.orgId);
    const url = await createCheckoutSession(req.params.orgId, plan, {
      email: req.user.email,
      name: org?.name,
      successUrl: `${config.appUrl}/?billing=success`,
      cancelUrl: `${config.appUrl}/?billing=cancelled`,
    });
    res.json({ url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) return res.status(404).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/orgs/:orgId/billing/portal", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    const url = await createPortalSession(req.params.orgId, {
      returnUrl: `${config.appUrl}/`,
    });
    res.json({ url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) return res.status(404).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

export default router;

// Separate router for the webhook path. Stripe signature verification needs
// the untouched raw request body, so server.js mounts this BEFORE the global
// express.json() middleware, with its own express.raw() middleware — the
// main `router` above is mounted after express.json() like every other
// route module.
export const webhookRouter = Router();
webhookRouter.post("/api/billing/webhook", async (req, res) => {
  if (!billingEnabled) return res.status(404).json({ error: "Billing is not configured on this deployment" });
  const signature = req.headers["stripe-signature"];
  try {
    const event = constructWebhookEvent(req.body, signature);
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("[billing webhook]", err.message);
    res.status(400).json({ error: "Webhook rejected. Verify its signature and retry." });
  }
});
