import Stripe from "stripe";
import { config, billingEnabled } from "./config.mjs";
import db from "./db.mjs";

// Lazily construct the Stripe client. Self-host deployments never set
// STRIPE_SECRET_KEY, so `stripe` stays null and every write path below throws
// a clear, catchable error instead of Stripe's SDK throwing on a missing key.
const stripe = billingEnabled ? new Stripe(config.stripe.secretKey) : null;

class BillingNotConfiguredError extends Error {
  constructor() {
    super("Billing is not configured on this deployment");
    this.name = "BillingNotConfiguredError";
    this.status = 404;
  }
}

function requireStripe() {
  if (!stripe) throw new BillingNotConfiguredError();
  return stripe;
}

// ── Plan definitions ────────────────────────────────────────────────────
// Quotas mirror docs/PRICING.md. Kept here (not just in Stripe) so quota
// checks work without a network round-trip, and so self-host code that
// imports PLANS for reference doesn't need a Stripe key.
export const PLANS = {
  free: { name: "Free", price: 0, storageBytes: 2 * 1024 ** 3, tokensPerMonth: 5_000_000, seats: 1 },
  starter: { name: "Starter", price: 39, storageBytes: 10 * 1024 ** 3, tokensPerMonth: 3_000_000, seats: 3 },
  pro: { name: "Pro", price: 99, storageBytes: 50 * 1024 ** 3, tokensPerMonth: 8_000_000, seats: 10 },
  team: { name: "Team", price: 249, storageBytes: 200 * 1024 ** 3, tokensPerMonth: 20_000_000, seats: 25 },
};

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ── Subscription state (DB-only, no Stripe calls) ──────────────────────

export function getSubscription(orgId) {
  const row = db.prepare("SELECT * FROM org_subscriptions WHERE org_id = ?").get(orgId);
  if (row) return row;
  // No row yet == free plan; don't insert until there's something to persist
  // (e.g. a stripe_customer_id), so untouched orgs cost nothing to look up.
  return { org_id: orgId, stripe_customer_id: null, stripe_subscription_id: null, plan: "free", status: "active", current_period_end: null };
}

export function upsertSubscription(orgId, fields) {
  const existing = db.prepare("SELECT org_id FROM org_subscriptions WHERE org_id = ?").get(orgId);
  const merged = { plan: "free", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null, ...getSubscription(orgId), ...fields };
  if (existing) {
    db.prepare(`
      UPDATE org_subscriptions SET
        stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = ?,
        current_period_end = ?, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(merged.stripe_customer_id, merged.stripe_subscription_id, merged.plan, merged.status, merged.current_period_end, orgId);
  } else {
    db.prepare(`
      INSERT INTO org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(orgId, merged.stripe_customer_id, merged.stripe_subscription_id, merged.plan, merged.status, merged.current_period_end);
  }
  return getSubscription(orgId);
}

// ── Usage (DB-only) ─────────────────────────────────────────────────────

export function getUsage(orgId, periodStart = currentPeriodStart()) {
  const row = db.prepare("SELECT * FROM org_usage WHERE org_id = ? AND period_start = ?").get(orgId, periodStart);
  return row || { org_id: orgId, period_start: periodStart, tokens_used: 0, storage_bytes: 0 };
}

/**
 * Record additional token usage for an org's current billing period.
 *
 * IMPORTANT — this is a stub in terms of data source, not just wiring: pi's
 * agent-manager (lib/agent-manager.mjs) currently does not surface token
 * counts anywhere in its RPC event stream (message_start/message_update/
 * message_end/agent_end carry text deltas and tool calls, no usage object).
 * There is no `usage`/`tokens` field to read today. Calling this function is
 * therefore safe and correct, but nothing in the codebase calls it yet — real
 * metering needs either (a) pi upgraded to emit a usage event, or (b) this
 * app calling the fornace LLM gateway's own usage/billing API out-of-band.
 * Do not wire a fake call to this that always passes 0; leave it uncalled
 * until a real token count is available.
 */
export function recordTokenUsage(orgId, tokens, periodStart = currentPeriodStart()) {
  db.prepare(`
    INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(org_id, period_start) DO UPDATE SET
      tokens_used = tokens_used + excluded.tokens_used,
      updated_at = datetime('now')
  `).run(orgId, periodStart, tokens);
}

export function recordStorageBytes(orgId, bytes, periodStart = currentPeriodStart()) {
  db.prepare(`
    INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(org_id, period_start) DO UPDATE SET
      storage_bytes = excluded.storage_bytes,
      updated_at = datetime('now')
  `).run(orgId, periodStart, bytes);
}

export function checkQuota(orgId) {
  const sub = getSubscription(orgId);
  const plan = PLANS[sub.plan] || PLANS.free;
  const usage = getUsage(orgId);
  return {
    plan: sub.plan,
    status: sub.status,
    tokens: { used: usage.tokens_used, limit: plan.tokensPerMonth, exceeded: usage.tokens_used >= plan.tokensPerMonth },
    storage: { used: usage.storage_bytes, limit: plan.storageBytes, exceeded: usage.storage_bytes >= plan.storageBytes },
  };
}

// ── Stripe-backed operations (all throw BillingNotConfiguredError if unset) ──

export async function ensureStripeCustomer(orgId, { email, name } = {}) {
  const s = requireStripe();
  const sub = getSubscription(orgId);
  if (sub.stripe_customer_id) return sub.stripe_customer_id;

  const customer = await s.customers.create({
    email,
    name,
    metadata: { org_id: orgId },
  });
  upsertSubscription(orgId, { stripe_customer_id: customer.id });
  return customer.id;
}

export async function createCheckoutSession(orgId, plan, { email, name, successUrl, cancelUrl } = {}) {
  const s = requireStripe();
  const priceId = config.stripe.priceIds[plan];
  if (!priceId) throw new Error(`No Stripe price configured for plan "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`);

  const customerId = await ensureStripeCustomer(orgId, { email, name });

  const session = await s.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { org_id: orgId, plan },
    subscription_data: { metadata: { org_id: orgId, plan } },
  });

  return session.url;
}

/**
 * Cancel an org's active Stripe subscription immediately (used by org
 * deletion — see routes/orgs.js DELETE /api/orgs/:orgId). No-ops if the org
 * has no Stripe subscription on file, so it's safe to call unconditionally
 * before deleting an org row.
 */
export async function cancelSubscription(orgId) {
  const sub = getSubscription(orgId);
  if (!sub.stripe_subscription_id) return null;
  const s = requireStripe();
  const canceled = await s.subscriptions.cancel(sub.stripe_subscription_id);
  upsertSubscription(orgId, { plan: "free", status: "canceled", stripe_subscription_id: null });
  return canceled;
}

export async function createPortalSession(orgId, { returnUrl } = {}) {
  const s = requireStripe();
  const sub = getSubscription(orgId);
  if (!sub.stripe_customer_id) throw new Error("Org has no Stripe customer yet — subscribe to a plan first");

  const session = await s.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: returnUrl,
  });
  return session.url;
}

/** Verify a webhook signature and return the parsed Stripe event. */
export function constructWebhookEvent(rawBody, signature) {
  const s = requireStripe();
  if (!config.stripe.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return s.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/** Handle a verified Stripe event, updating org_subscriptions accordingly. */
export async function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const orgId = session.metadata?.org_id;
      if (!orgId) break;
      upsertSubscription(orgId, {
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        plan: session.metadata?.plan || "starter",
        status: "active",
      });
      break;
    }
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const orgId = subscription.metadata?.org_id;
      if (!orgId) break;
      upsertSubscription(orgId, {
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        current_period_end: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
      });
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const orgId = subscription.metadata?.org_id;
      if (!orgId) break;
      upsertSubscription(orgId, { plan: "free", status: "canceled", stripe_subscription_id: null });
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const orgId = invoice.subscription_details?.metadata?.org_id;
      if (!orgId) break;
      upsertSubscription(orgId, { status: "past_due" });
      break;
    }
    default:
      break;
  }
}

export { billingEnabled, BillingNotConfiguredError };
