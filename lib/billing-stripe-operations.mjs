import { config } from "./config.mjs";
import { requireStripe } from "./billing-stripe-client.mjs";
import { getSubscription, orgTrialEnd, upsertSubscription } from "./billing-state.mjs";

export async function ensureStripeCustomer(orgId, { email, name } = {}) {
  const stripe = requireStripe();
  const subscription = getSubscription(orgId);
  if (subscription.stripe_customer_id) return subscription.stripe_customer_id;

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { org_id: orgId },
  }, { idempotencyKey: `waynode-customer:${orgId}` });
  upsertSubscription(orgId, { stripe_customer_id: customer.id });
  return customer.id;
}

/** Resolve a Stripe price id for a checkout plan name, or null if none is
 *  configured. The hammersmith add-on price is intentionally stored OUTSIDE
 *  config.stripe.priceIds (it would otherwise be caught by the
 *  billingEnabled every(Boolean) trap and disable checkout entirely if its
 *  env var were unset); priceIdForPlan stitches it back in here so the
 *  checkout path can still resolve the tier. */
export function priceIdForPlan(plan) {
  const byPlan = { ...config.stripe.priceIds, hammersmith: config.stripe.hammersmithPriceId };
  return byPlan[plan] || null;
}

export async function createCheckoutSession(
  orgId,
  plan,
  { email, name, successUrl, cancelUrl } = {},
) {
  const stripe = requireStripe();
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    throw new Error(`No Stripe price configured for plan "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`);
  }

  const customerId = await ensureStripeCustomer(orgId, { email, name });
  const current = getSubscription(orgId);
  // Refuse checkout whenever the org already holds any Stripe subscription,
  // regardless of local status. A drifted/unrecognized row still represents a
  // live (or recently-live) subscription that must be reconciled via the
  // billing portal — a second checkout would create a subscription whose
  // snapshots the webhook then silently drops via the mismatched-subscription
  // guard.
  if (current.stripe_subscription_id) {
    throw new Error("This organization already has a subscription. Use the billing portal to change its plan.");
  }

  const priorSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 1,
  });
  const trialEnd = orgTrialEnd(orgId);
  const canStartTrial = !priorSubscriptions.data.length
    && trialEnd
    && trialEnd.getTime() > Date.now() + 2 * 24 * 60 * 60 * 1000;
  const subscriptionData = { metadata: { org_id: orgId, plan } };
  if (canStartTrial) subscriptionData.trial_end = Math.floor(trialEnd.getTime() / 1000);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { org_id: orgId, plan },
    subscription_data: subscriptionData,
  }, {
    // Derive the key from org+plan only. The previous hourly time component
    // (`new Date().toISOString().slice(0, 13)`) let a second live subscription
    // slip in an hour later — its snapshots then had no matching org row and
    // were silently dropped. A stable key lets Stripe itself reject the
    // duplicate checkout attempt.
    idempotencyKey: `waynode-checkout:${orgId}:${plan}`,
  });
  return session.url;
}

/** A Stripe error is "the subscription is already gone" — already canceled or
 *  resource_missing/404 — i.e. the desired terminal state. It must not block
 *  local settlement or org deletion. Any other error is surfaced to callers. */
function isResourceGone(error) {
  if (!error) return false;
  const code = String(error.code || error.error_code || error.type || "").toLowerCase();
  const status = Number(error.statusCode || error.status) || 0;
  return (
    code.includes("resource_missing") ||
    code.includes("no such") ||
    code.includes("already_canceled") ||
    code.includes("already canceled") ||
    status === 404
  );
}

export async function cancelSubscription(orgId) {
  const subscription = getSubscription(orgId);
  if (!subscription.stripe_subscription_id) return null;
  const stripe = requireStripe();
  const subscriptionId = subscription.stripe_subscription_id;
  let canceled;
  try {
    canceled = await stripe.subscriptions.cancel(subscriptionId);
  } catch (e) {
    // Tolerate an already-canceled / missing subscription: it is gone in Stripe,
    // which is the intended outcome. Other errors propagate so the billing
    // portal cancel and org-delete paths can react.
    if (!isResourceGone(e)) throw e;
    canceled = { id: subscriptionId, status: "canceled" };
  }
  const now = Math.floor(Date.now() / 1000);
  upsertSubscription(orgId, {
    plan: "free",
    status: "canceled",
    // Keep the subscription id AND stamp the lifecycle cursor (priority 90 ==
    // STATUS_PRIORITY.canceled in billing-webhooks.mjs). A stale in-flight
    // customer.subscription.updated created just before this cancel (lower
    // created timestamp) is now rejected by the cursor instead of resurrecting
    // the paid plan. The authoritative customer.subscription.deleted event
    // (priority 100, created after this call) still settles the row.
    stripe_subscription_id: subscriptionId,
    last_stripe_event_created: now,
    last_stripe_event_priority: 90,
    last_stripe_event_id: `local-cancel:${subscriptionId}:${now}`,
  });
  return canceled;
}

export async function createPortalSession(orgId, { returnUrl } = {}) {
  const stripe = requireStripe();
  const subscription = getSubscription(orgId);
  if (!subscription.stripe_customer_id) {
    throw new Error("Org has no Stripe customer yet — subscribe to a plan first");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripe_customer_id,
    return_url: returnUrl,
  });
  return session.url;
}

export function constructWebhookEvent(rawBody, signature) {
  const stripe = requireStripe();
  if (!config.stripe.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
