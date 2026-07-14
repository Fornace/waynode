import { config } from "./config.mjs";
import db from "./db.mjs";
import { getSubscription, upsertSubscription } from "./billing-state.mjs";

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
  if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) {
    return false;
  }
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
  upsertSubscription(orgId, {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    plan: plan || "free",
    status: plan ? subscription.status : "unrecognized_price",
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

/** Reconcile a verified, at-least-once and potentially unordered Stripe event. */
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
        default:
          break;
      }
    }
    db.exec("COMMIT");
    return { processed: true, orgId: orgId || null };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
