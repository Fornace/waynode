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

export async function createCheckoutSession(
  orgId,
  plan,
  { email, name, successUrl, cancelUrl } = {},
) {
  const stripe = requireStripe();
  const priceId = config.stripe.priceIds[plan];
  if (!priceId) {
    throw new Error(`No Stripe price configured for plan "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`);
  }

  const customerId = await ensureStripeCustomer(orgId, { email, name });
  const current = getSubscription(orgId);
  if (
    current.stripe_subscription_id &&
    ["active", "trialing", "past_due", "unpaid"].includes(current.status)
  ) {
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
    idempotencyKey: `waynode-checkout:${orgId}:${plan}:${new Date().toISOString().slice(0, 13)}`,
  });
  return session.url;
}

export async function cancelSubscription(orgId) {
  const subscription = getSubscription(orgId);
  if (!subscription.stripe_subscription_id) return null;
  const stripe = requireStripe();
  const canceled = await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
  upsertSubscription(orgId, {
    plan: "free",
    status: "canceled",
    stripe_subscription_id: null,
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
