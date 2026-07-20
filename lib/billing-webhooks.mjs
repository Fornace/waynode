import { config } from "./config.mjs";
import db from "./db.mjs";
import { getSubscription, upsertSubscription } from "./billing-state.mjs";

function stripeId(value) {
  return typeof value === "string" && value.length ? value : null;
}

function configuredEntitlement(subscription) {
  const matches = [];
  for (const item of subscription?.items?.data || []) {
    const priceId = stripeId(item?.price?.id || item?.price);
    for (const [plan, configuredPriceId] of Object.entries({
      ...config.stripe.priceIds,
      hammersmith: config.stripe.hammersmithPriceId,
    })) {
      if (configuredPriceId && priceId === configuredPriceId) matches.push({ plan, item });
    }
  }
  const plans = new Set(matches.map(({ plan }) => plan));
  if (plans.size !== 1) return null;
  const starts = matches.map(({ item }) => item.current_period_start).filter(Number.isSafeInteger);
  const ends = matches.map(({ item }) => item.current_period_end).filter(Number.isSafeInteger);
  return {
    plan: [...plans][0],
    periodStart: starts.length ? Math.min(...starts) : subscription.current_period_start,
    periodEnd: ends.length ? Math.max(...ends) : subscription.current_period_end,
  };
}

function eventTimestamp(event) {
  return Number.isSafeInteger(event?.created) && event.created > 0 ? event.created : 0;
}

function subscriptionCandidates(object) {
  return [stripeId(object?.subscription), stripeId(object?.id)].filter(Boolean);
}

function existingOrgId(object) {
  for (const subscriptionId of subscriptionCandidates(object)) {
    const row = db.prepare("SELECT org_id FROM org_subscriptions WHERE stripe_subscription_id = ?")
      .get(subscriptionId);
    if (row?.org_id) return row.org_id;
  }
  const customerId = stripeId(object?.customer);
  const byCustomer = customerId && db.prepare(
    "SELECT org_id FROM org_subscriptions WHERE stripe_customer_id = ?"
  ).get(customerId);
  if (byCustomer?.org_id) return byCustomer.org_id;

  const metadataOrgId = stripeId(object?.metadata?.org_id)
    || stripeId(object?.subscription_details?.metadata?.org_id);
  return metadataOrgId
    ? db.prepare("SELECT id FROM orgs WHERE id = ?").get(metadataOrgId)?.id || null
    : null;
}

function timestampIso(unixSeconds) {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

const STATUS_PRIORITY = {
  active: 20, trialing: 20, incomplete: 40, past_due: 60,
  paused: 70, unpaid: 70, incomplete_expired: 80, canceled: 90,
};

function lifecyclePriority(type, status) {
  if (type === "customer.subscription.deleted") return 100;
  if (type === "invoice.payment_failed") return 65;
  return STATUS_PRIORITY[status] || 50;
}

function cursorIsNewer(current, event, priority) {
  const created = eventTimestamp(event);
  const priorCreated = Number(current.last_stripe_event_created) || 0;
  const priorPriority = Number(current.last_stripe_event_priority) || 0;
  if (created !== priorCreated) return created > priorCreated;
  if (priority !== priorPriority) return priority > priorPriority;
  return event.id > (current.last_stripe_event_id || "");
}

function lifecycleCursor(event, priority) {
  return {
    last_stripe_event_created: event.created,
    last_stripe_event_priority: priority,
    last_stripe_event_id: event.id,
  };
}

function applySubscriptionSnapshot(event, subscription, orgId) {
  const current = getSubscription(orgId);
  const subscriptionId = stripeId(subscription?.id);
  const customerId = stripeId(subscription?.customer);
  const entitlement = configuredEntitlement(subscription);
  const priority = lifecyclePriority(event.type, entitlement ? subscription.status : "unpaid");
  if (!subscriptionId || !customerId || !cursorIsNewer(current, event, priority)) return;
  if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) return;

  // Unresolved entitlement: the subscription carries either a mix of multiple
  // configured prices (e.g. starter + the hammersmith add-on added via the
  // Stripe Dashboard) or no configured price at all. The single-slot v1 model
  // has no add-on concept, so this snapshot cannot select a plan. NEVER wipe a
  // recorded paid entitlement — keep the org's current plan/status and only
  // advance the cursor + bind ids, logging a warning. An org that holds no
  // paid entitlement yet still records free/unrecognized_price, mirroring the
  // no-prior-subscription case (preserves the fresh-org behavior the lifecycle
  // regression relies on).
  if (!entitlement) {
    if (PLANS_WITH_ENTITLEMENT.has(current.plan)) {
      console.warn(
        `[billing] subscription ${subscriptionId} for org ${orgId} matched multiple/no configured prices; ` +
        `preserving recorded entitlement "${current.plan}/${current.status}"`,
      );
      upsertSubscription(orgId, {
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        ...lifecycleCursor(event, priority),
      });
      return;
    }
    upsertSubscription(orgId, {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan: "free",
      status: "unrecognized_price",
      current_period_start: timestampIso(entitlement?.periodStart),
      current_period_end: timestampIso(entitlement?.periodEnd),
      ...lifecycleCursor(event, priority),
    });
    return;
  }

  upsertSubscription(orgId, {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    // Metadata and Checkout input are never entitlement evidence. Only an
    // exact configured Stripe Price can select a paid plan.
    plan: entitlement.plan,
    status: subscription.status,
    current_period_start: timestampIso(entitlement.periodStart),
    current_period_end: timestampIso(entitlement.periodEnd),
    ...lifecycleCursor(event, priority),
  });
}

function applySubscriptionDeletion(event, subscription, orgId) {
  const current = getSubscription(orgId);
  const subscriptionId = stripeId(subscription?.id);
  const period = configuredEntitlement(subscription);
  const priority = lifecyclePriority(event.type, "canceled");
  if (!subscriptionId || !cursorIsNewer(current, event, priority)) return;
  if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId) return;
  upsertSubscription(orgId, {
    stripe_customer_id: stripeId(subscription.customer) || current.stripe_customer_id,
    stripe_subscription_id: null,
    plan: "free",
    status: "canceled",
    current_period_start: timestampIso(period?.periodStart) || current.current_period_start,
    current_period_end: timestampIso(period?.periodEnd) || current.current_period_end,
    ...lifecycleCursor(event, priority),
  });
}

function applyPaymentFailure(event, invoice, orgId) {
  const current = getSubscription(orgId);
  const subscriptionId = stripeId(invoice?.subscription);
  const priority = lifecyclePriority(event.type, "past_due");
  if (!subscriptionId || subscriptionId !== current.stripe_subscription_id) return;
  if (!PLANS_WITH_ENTITLEMENT.has(current.plan) || !cursorIsNewer(current, event, priority)) return;
  upsertSubscription(orgId, { status: "past_due", ...lifecycleCursor(event, priority) });
}

const PLANS_WITH_ENTITLEMENT = new Set(["starter", "pro", "team", "hammersmith"]);

/** Reconcile a verified, at-least-once and potentially unordered Stripe event. */
export async function handleWebhookEvent(event) {
  if (!stripeId(event?.id) || !eventTimestamp(event) || !stripeId(event?.type)) {
    throw new Error("Invalid Stripe webhook event");
  }
  const object = event.data?.object;
  const objectId = subscriptionCandidates(object)[0] || null;
  const orgId = existingOrgId(object);

  db.exec("BEGIN IMMEDIATE");
  try {
    const claimed = db.prepare(`
      INSERT OR IGNORE INTO stripe_webhook_events
        (event_id, event_type, stripe_created, object_id, org_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.type, event.created, objectId, orgId).changes;
    if (!claimed) { db.exec("COMMIT"); return { processed: false, reason: "duplicate" }; }

    if (orgId) {
      if (["customer.subscription.created", "customer.subscription.updated"].includes(event.type)) {
        applySubscriptionSnapshot(event, object, orgId);
      } else if (event.type === "customer.subscription.deleted") {
        applySubscriptionDeletion(event, object, orgId);
      } else if (event.type === "invoice.payment_failed") {
        applyPaymentFailure(event, object, orgId);
      } else if (event.type === "checkout.session.completed") {
        // Bind only the Customer. Subscription lifecycle snapshots, with an
        // exact configured Price, remain the sole entitlement authority.
        const current = getSubscription(orgId);
        const customerId = stripeId(object?.customer);
        if (customerId && (!current.stripe_customer_id || current.stripe_customer_id === customerId)) {
          upsertSubscription(orgId, { stripe_customer_id: customerId });
        }
      }
    }
    db.exec("COMMIT");
    return { processed: true, orgId: orgId || null };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
