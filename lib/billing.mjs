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
  trial: { name: "Free trial", price: 0, storageBytes: 2 * 1024 ** 3, tokensPerMonth: 5_000_000, seats: 1 },
  free: { name: "Free", price: 0, storageBytes: 0, tokensPerMonth: 0, seats: 1 },
  starter: { name: "Starter", price: 39, storageBytes: 10 * 1024 ** 3, tokensPerMonth: 3_000_000, seats: 3 },
  pro: { name: "Pro", price: 99, storageBytes: 50 * 1024 ** 3, tokensPerMonth: 8_000_000, seats: 10 },
  team: { name: "Team", price: 249, storageBytes: 200 * 1024 ** 3, tokensPerMonth: 20_000_000, seats: 25 },
};

export const TRIAL_DAYS = 15;

function orgTrialEnd(orgId) {
  const org = db.prepare("SELECT created_at FROM orgs WHERE id = ?").get(orgId);
  if (!org?.created_at) return null;
  const createdAt = new Date(`${org.created_at.replace(" ", "T")}Z`);
  if (Number.isNaN(createdAt.getTime())) return null;
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function trialSubscription(orgId) {
  const endsAt = orgTrialEnd(orgId);
  if (!endsAt || endsAt.getTime() <= Date.now()) {
    return { org_id: orgId, stripe_customer_id: null, stripe_subscription_id: null, plan: "free", status: "expired", current_period_end: endsAt?.toISOString() || null };
  }
  return { org_id: orgId, stripe_customer_id: null, stripe_subscription_id: null, plan: "trial", status: "trialing", current_period_end: endsAt.toISOString() };
}

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ── Subscription state (DB-only, no Stripe calls) ──────────────────────

export function getSubscription(orgId) {
  const row = db.prepare("SELECT * FROM org_subscriptions WHERE org_id = ?").get(orgId);
  if (row) return row;
  // A hosted org starts its single, calendar-bound 15-day trial when created.
  // We derive it from the immutable org timestamp instead of inserting a row
  // on read, so an attacker cannot reset it by deleting client-side state.
  if (billingEnabled) return trialSubscription(orgId);
  // No row yet == self-host free plan; don't insert until there is something
  // to persist (e.g. a Stripe customer), so untouched orgs cost nothing.
  return { org_id: orgId, stripe_customer_id: null, stripe_subscription_id: null, plan: "free", status: "active", current_period_end: null };
}

export function upsertSubscription(orgId, fields) {
  const existing = db.prepare("SELECT org_id FROM org_subscriptions WHERE org_id = ?").get(orgId);
  const merged = {
    plan: "free", status: "active", stripe_customer_id: null,
    stripe_subscription_id: null, current_period_end: null,
    last_stripe_event_created: 0, last_stripe_event_id: null,
    ...getSubscription(orgId), ...fields,
  };
  if (existing) {
    db.prepare(`
      UPDATE org_subscriptions SET
        stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = ?,
        current_period_end = ?, last_stripe_event_created = ?,
        last_stripe_event_id = ?, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(
      merged.stripe_customer_id, merged.stripe_subscription_id, merged.plan,
      merged.status, merged.current_period_end, merged.last_stripe_event_created,
      merged.last_stripe_event_id, orgId,
    );
  } else {
    db.prepare(`
      INSERT INTO org_subscriptions (
        org_id, stripe_customer_id, stripe_subscription_id, plan, status,
        current_period_end, last_stripe_event_created, last_stripe_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, merged.stripe_customer_id, merged.stripe_subscription_id,
      merged.plan, merged.status, merged.current_period_end,
      merged.last_stripe_event_created, merged.last_stripe_event_id,
    );
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

/**
 * Persist an agent session's cumulative pi token total and charge only the
 * newly observed delta. pi reports totals for the entire resumed session, so
 * keeping this cursor in SQLite (rather than an AgentHandle field) prevents a
 * restart, idle reap, or browser reconnect from re-billing historical tokens.
 */
export function recordSessionTokenTotal(sessionId, orgId, total, periodStart = currentPeriodStart()) {
  if (!sessionId || !orgId || !Number.isFinite(total) || total < 0) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT metered_tokens FROM sessions WHERE id = ?").get(sessionId);
    if (!row) {
      db.exec("COMMIT");
      return 0;
    }
    const previous = Number(row.metered_tokens) || 0;
    const delta = Math.max(0, Math.floor(total) - previous);
    if (delta > 0) {
      db.prepare(`
        INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(org_id, period_start) DO UPDATE SET
          tokens_used = tokens_used + excluded.tokens_used,
          updated_at = datetime('now')
      `).run(orgId, periodStart, delta);
    }
    if (total > previous) {
      db.prepare("UPDATE sessions SET metered_tokens = ?, updated_at = datetime('now') WHERE id = ?")
        .run(Math.floor(total), sessionId);
    }
    db.exec("COMMIT");
    return delta;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
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
  }, { idempotencyKey: `waynode-customer:${orgId}` });
  upsertSubscription(orgId, { stripe_customer_id: customer.id });
  return customer.id;
}

export async function createCheckoutSession(orgId, plan, { email, name, successUrl, cancelUrl } = {}) {
  const s = requireStripe();
  const priceId = config.stripe.priceIds[plan];
  if (!priceId) throw new Error(`No Stripe price configured for plan "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`);

  const customerId = await ensureStripeCustomer(orgId, { email, name });
  const current = getSubscription(orgId);
  if (current.stripe_subscription_id && ["active", "trialing", "past_due", "unpaid"].includes(current.status)) {
    throw new Error("This organization already has a subscription. Use the billing portal to change its plan.");
  }

  // Stripe's record is authoritative for trial eligibility. This prevents a
  // canceled subscription from gaining another trial while still allowing a
  // customer whose first Checkout was abandoned to resume it.
  const priorSubscriptions = await s.subscriptions.list({ customer: customerId, status: "all", limit: 1 });
  const trialEnd = orgTrialEnd(orgId);
  const canStartTrial = !priorSubscriptions.data.length
    && trialEnd
    && trialEnd.getTime() > Date.now() + 2 * 24 * 60 * 60 * 1000;

  const subscriptionData = { metadata: { org_id: orgId, plan } };
  if (canStartTrial) subscriptionData.trial_end = Math.floor(trialEnd.getTime() / 1000);

  const session = await s.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { org_id: orgId, plan },
    subscription_data: subscriptionData,
  }, {
    // One Checkout session per org/plan/hour prevents double-click and retry
    // races from creating duplicate subscriptions, without making a failed
    // checkout permanently unretryable.
    idempotencyKey: `waynode-checkout:${orgId}:${plan}:${new Date().toISOString().slice(0, 13)}`,
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

// ── Webhook reconciliation ─────────────────────────────────────────────
// Stripe webhooks are at-least-once and explicitly unordered. The event id
// table handles replay/concurrency, while the per-subscription cursor prevents
// an old lifecycle snapshot from undoing a newer one. We intentionally derive
// entitlements from the configured Stripe *price id*, never mutable metadata.

function normaliseStripeId(value) {
  return typeof value === "string" && value.length ? value : null;
}

function configuredPlanForSubscription(subscription) {
  const matches = new Set();
  for (const item of subscription?.items?.data || []) {
    const priceId = normaliseStripeId(item?.price?.id || item?.price);
    for (const [plan, configuredPriceId] of Object.entries(config.stripe.priceIds)) {
      if (configuredPriceId && priceId === configuredPriceId) matches.add(plan);
    }
  }
  // A subscription carrying two configured base prices is ambiguous. Fail
  // closed rather than accidentally granting the larger plan.
  return matches.size === 1 ? [...matches][0] : null;
}

function eventTimestamp(event) {
  return Number.isSafeInteger(event?.created) && event.created > 0 ? event.created : 0;
}

function existingOrgIdForStripeObject(object) {
  const subscriptionId = normaliseStripeId(object?.id) || normaliseStripeId(object?.subscription);
  const customerId = normaliseStripeId(object?.customer);
  const bySubscription = subscriptionId && db.prepare(
    "SELECT org_id FROM org_subscriptions WHERE stripe_subscription_id = ?"
  ).get(subscriptionId);
  const byCustomer = customerId && db.prepare(
    "SELECT org_id FROM org_subscriptions WHERE stripe_customer_id = ?"
  ).get(customerId);

  // A customer/subscription must never be redirected to a different org by
  // webhook metadata. Prefer the durable mapping made at Checkout creation.
  if (bySubscription?.org_id) return bySubscription.org_id;
  if (byCustomer?.org_id) return byCustomer.org_id;

  const metadataOrgId = normaliseStripeId(object?.metadata?.org_id)
    || normaliseStripeId(object?.subscription_details?.metadata?.org_id);
  if (!metadataOrgId) return null;
  return db.prepare("SELECT id FROM orgs WHERE id = ?").get(metadataOrgId)?.id || null;
}

function periodEndIso(unixSeconds) {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function shouldApplyLifecycleEvent(current, subscriptionId, created) {
  // Never let an event for an old, replaced subscription cancel or downgrade
  // the current one. A legitimate re-subscribe first receives the deletion
  // event, which clears stripe_subscription_id; until then, a second Stripe
  // subscription is a duplicate charge rather than an entitlement takeover.
  if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) return false;
  // `created` is Stripe's event creation time, not delivery time. Equal-time
  // events are allowed because Stripe timestamps are second-resolution and a
  // same-second lifecycle update can be newer than the previous snapshot.
  return created >= (current.last_stripe_event_created || 0);
}

function applySubscriptionSnapshot(event, subscription, orgId) {
  const current = getSubscription(orgId);
  const created = eventTimestamp(event);
  const subscriptionId = normaliseStripeId(subscription?.id);
  const customerId = normaliseStripeId(subscription?.customer);
  if (!subscriptionId || !customerId || !created) return;
  if (!shouldApplyLifecycleEvent(current, subscriptionId, created)) return;

  const plan = configuredPlanForSubscription(subscription);
  // An active subscription with an unrecognised price must not become an
  // entitlement merely because a Dashboard price was changed or metadata was
  // tampered with. `routes/sessions.js` allows only active/trialing statuses.
  const status = plan ? subscription.status : "unrecognized_price";
  upsertSubscription(orgId, {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    plan: plan || "free",
    status,
    current_period_end: periodEndIso(subscription.current_period_end),
    last_stripe_event_created: created,
    last_stripe_event_id: event.id,
  });
}

function applySubscriptionDeletion(event, subscription, orgId) {
  const current = getSubscription(orgId);
  const created = eventTimestamp(event);
  const subscriptionId = normaliseStripeId(subscription?.id);
  if (!subscriptionId || !created) return;
  // A late deletion for a prior subscription is a normal occurrence after a
  // customer re-subscribes. It must not cancel the new subscription.
  if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) return;
  if (!shouldApplyLifecycleEvent(current, subscriptionId, created)) return;
  upsertSubscription(orgId, {
    stripe_customer_id: normaliseStripeId(subscription.customer) || current.stripe_customer_id,
    stripe_subscription_id: null,
    plan: "free",
    status: "canceled",
    current_period_end: periodEndIso(subscription.current_period_end),
    last_stripe_event_created: created,
    last_stripe_event_id: event.id,
  });
}

/**
 * Handle a verified Stripe event exactly once.
 *
 * This remains async for the route's stable API, but all database work is
 * synchronous and committed in one SQLite transaction. If a process dies
 * before COMMIT Stripe retries; after COMMIT the event id is already durable.
 */
export async function handleWebhookEvent(event) {
  if (!normaliseStripeId(event?.id) || !eventTimestamp(event) || !normaliseStripeId(event?.type)) {
    throw new Error("Invalid Stripe webhook event");
  }

  const object = event.data?.object;
  const objectId = normaliseStripeId(object?.id) || normaliseStripeId(object?.subscription);
  const orgId = existingOrgIdForStripeObject(object);

  db.exec("BEGIN IMMEDIATE");
  try {
    const claimed = db.prepare(`
      INSERT OR IGNORE INTO stripe_webhook_events
        (event_id, event_type, stripe_created, object_id, org_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.type, event.created, objectId, orgId).changes;
    if (!claimed) {
      db.exec("COMMIT");
      return { processed: false, reason: "duplicate" };
    }

    if (orgId) {
      switch (event.type) {
        case "checkout.session.completed": {
          // Checkout completion is not entitlement evidence. It only binds
          // Stripe ids for subsequent authoritative subscription snapshots.
          const current = getSubscription(orgId);
          const customerId = normaliseStripeId(object?.customer);
          const subscriptionId = normaliseStripeId(object?.subscription);
          if (customerId && (!current.stripe_customer_id || current.stripe_customer_id === customerId)) {
            upsertSubscription(orgId, {
              stripe_customer_id: customerId,
              stripe_subscription_id: current.stripe_subscription_id || subscriptionId,
            });
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
          applySubscriptionSnapshot(event, object, orgId);
          break;
        case "customer.subscription.deleted":
          applySubscriptionDeletion(event, object, orgId);
          break;
        // `invoice.payment_failed` is intentionally recorded but does not
        // mutate entitlement state: subscription.updated is Stripe's
        // authoritative status snapshot, and invoices can arrive out of order.
        default:
          break;
      }
    }
    db.exec("COMMIT");
    return { processed: true, orgId: orgId || null };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

export { billingEnabled, BillingNotConfiguredError };
