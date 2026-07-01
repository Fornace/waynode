import { Router } from "express";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { requireAuth } from "../lib/auth.mjs";
import { config, billingEnabled } from "../lib/config.mjs";
import { isOrgMember, getOrg } from "../lib/orgs.mjs";
import { listSpacesByOrg } from "../lib/spaces.mjs";
import {
  PLANS, getSubscription, getUsage, checkQuota, recordStorageBytes,
  createCheckoutSession, createPortalSession,
  constructWebhookEvent, handleWebhookEvent, BillingNotConfiguredError,
} from "../lib/billing.mjs";

const router = Router();

function requireOrgAdmin(req, res, next) {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  next();
}

// Best-effort on-disk size of every space in the org, in bytes. `du` is not
// exact for sparse/hardlinked files but is good enough for a usage display;
// this is not used for hard-limit enforcement of storage today.
function measureOrgStorageBytes(orgId) {
  const spaces = listSpacesByOrg(orgId);
  let total = 0;
  for (const space of spaces) {
    if (!space.local_path || !existsSync(space.local_path)) continue;
    try {
      const result = spawnSync("du", ["-sk", space.local_path], { encoding: "utf8" });
      const kb = parseInt((result.stdout || "0").split(/\s+/)[0], 10);
      if (Number.isFinite(kb)) total += kb * 1024;
    } catch {}
  }
  return total;
}

// Unauthenticated: lets the frontend decide whether to render billing UI at
// all on self-host installs (where STRIPE_SECRET_KEY is never set).
router.get("/api/billing/enabled", (req, res) => {
  res.json({ enabled: billingEnabled });
});

router.get("/api/orgs/:orgId/billing", requireAuth, requireOrgAdmin, (req, res) => {
  const orgId = req.params.orgId;
  const storageBytes = measureOrgStorageBytes(orgId);
  recordStorageBytes(orgId, storageBytes);

  const subscription = getSubscription(orgId);
  const usage = getUsage(orgId);
  const quota = checkQuota(orgId);

  res.json({
    enabled: billingEnabled,
    plan: subscription.plan,
    status: subscription.status,
    current_period_end: subscription.current_period_end,
    usage: {
      tokens_used: usage.tokens_used,
      storage_bytes: storageBytes,
    },
    quota,
    plans: PLANS,
  });
});

router.post("/api/orgs/:orgId/billing/checkout", requireAuth, requireOrgAdmin, async (req, res) => {
  if (!billingEnabled) return res.status(404).json({ error: "Billing is not configured on this deployment" });
  const { plan } = req.body || {};
  if (!["starter", "pro", "team"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });

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
  if (!billingEnabled) return res.status(404).json({ error: "Billing is not configured on this deployment" });
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
    res.status(400).json({ error: `Webhook error: ${err.message}` });
  }
});
