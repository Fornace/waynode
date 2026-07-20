/** Billing edge-case regression: multi-price entitlement, checkout idempotency,
 *  cancel lifecycle, org-delete Stripe cleanup, quota boundary.
 *  Throwaway SQLite, stubbed Stripe client — never real Stripe. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-billing-edges-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "billing-edges-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";
process.env.STRIPE_PRICE_HAMMERSMITH = "price_hammersmith";

const { default: db } = await import("../lib/db.mjs");
const { requireStripe } = await import("../lib/billing-stripe-client.mjs");
const {
  checkQuota, getSubscription, handleWebhookEvent, upsertSubscription,
} = await import("../lib/billing.mjs");
const {
  createCheckoutSession, cancelSubscription,
} = await import("../lib/billing-stripe-operations.mjs");
const { createOrg } = await import("../lib/orgs.mjs");
const { default: express } = await import("express");
const { default: orgsRouter } = await import("../routes/orgs.js");

// ── Stub the Stripe client so no call ever hits the network ──────────────
const stripe = requireStripe();
const checkoutCalls = [];
const cancelCalls = [];
stripe.customers = {
  create: async () => ({ id: "cus_stub" }),
};
stripe.subscriptions = {
  cancel: async (id) => { cancelCalls.push(id); return { id, status: "canceled" }; },
  list: async () => ({ data: [] }),
};
stripe.checkout = {
  sessions: {
    create: async (params, opts) => {
      checkoutCalls.push({ params, idempotencyKey: opts?.idempotencyKey });
      return { url: "https://checkout.test/session" };
    },
  },
};

function seedUser(id) {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(id, id);
}

function subscriptionEvent({
  id, created, type = "customer.subscription.created", subscriptionId,
  customerId, priceId, orgId, status = "active", periodStart = 50,
}) {
  return { id, type, created, data: { object: {
    id: subscriptionId, customer: customerId, status,
    metadata: { org_id: orgId },
    items: { data: [{
      price: { id: priceId },
      current_period_start: periodStart,
      current_period_end: periodStart + 2_592_000,
    }] },
  } } };
}

function multiPriceEvent({
  id, created, type = "customer.subscription.updated", subscriptionId,
  customerId, priceIds = [], orgId, status = "active", periodStart = 50,
}) {
  return { id, type, created, data: { object: {
    id: subscriptionId, customer: customerId, status,
    metadata: { org_id: orgId },
    items: { data: priceIds.map(priceId => ({
      price: { id: priceId },
      current_period_start: periodStart,
      current_period_end: periodStart + 2_592_000,
    })) },
  } } };
}

try {
  seedUser("owner");

  // ═══════════════════════════════════════════════════════════════════════
  // (1) Multi-price snapshot preserves the recorded plan + warning logged.
  // A subscription carrying starter + hammersmith prices (e.g. someone added
  // the add-on in the Stripe Dashboard) must NOT wipe a paying org's plan.
  // ═══════════════════════════════════════════════════════════════════════
  const multiOrg = createOrg({ name: "Multi-price org", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_setup", created: 100, subscriptionId: "sub_multi",
    customerId: "cus_multi", priceId: "price_starter", orgId: multiOrg.id,
  }));
  assert.equal(getSubscription(multiOrg.id).plan, "starter");
  assert.equal(getSubscription(multiOrg.id).status, "active");

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    await handleWebhookEvent(multiPriceEvent({
      id: "evt_multi", created: 110, subscriptionId: "sub_multi",
      customerId: "cus_multi", priceIds: ["price_starter", "price_hammersmith"],
      orgId: multiOrg.id, status: "active",
    }));
  } finally {
    console.warn = originalWarn;
  }
  const afterMulti = getSubscription(multiOrg.id);
  assert.equal(afterMulti.plan, "starter", "multi-price must not wipe the recorded plan");
  assert.equal(afterMulti.status, "active", "multi-price must not change the recorded status");
  assert.equal(afterMulti.stripe_subscription_id, "sub_multi", "subscription binding preserved");
  assert.ok(
    warnings.some((w) => /unresolved|multi|entitlement/i.test(w)),
    "a warning was logged for the unresolved entitlement",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // (2) Single-price snapshot still resolves the plan.
  // ═══════════════════════════════════════════════════════════════════════
  const singleOrg = createOrg({ name: "Single-price org", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_single", created: 200, subscriptionId: "sub_single",
    customerId: "cus_single", priceId: "price_pro", orgId: singleOrg.id,
  }));
  assert.equal(getSubscription(singleOrg.id).plan, "pro");
  assert.equal(getSubscription(singleOrg.id).status, "active");

  // ═══════════════════════════════════════════════════════════════════════
  // (3) Idempotency key has no time component (same key across hours).
  // The old key included new Date().toISOString().slice(0,13) (hourly),
  // allowing a second live subscription an hour later.
  // ═══════════════════════════════════════════════════════════════════════
  const checkoutOrg = createOrg({ name: "Checkout org", userId: "owner" });
  upsertSubscription(checkoutOrg.id, { stripe_customer_id: "cus_checkout" });
  checkoutCalls.length = 0;
  await createCheckoutSession(checkoutOrg.id, "starter", {
    email: "t@t.com", successUrl: "https://t/s", cancelUrl: "https://t/c",
  });
  assert.equal(checkoutCalls.length, 1, "checkout called Stripe once");
  const idempotencyKey = checkoutCalls[0].idempotencyKey;
  assert.equal(
    idempotencyKey,
    `waynode-checkout:${checkoutOrg.id}:starter`,
    "idempotencyKey derived from org+plan only — no time component",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // (4) Checkout refused whenever stripe_subscription_id is set, regardless
  // of local status. The old guard only refused active-like statuses.
  // ═══════════════════════════════════════════════════════════════════════
  for (const status of ["active", "trialing", "past_due", "unpaid", "canceled", "unrecognized_price"]) {
    const sOrg = createOrg({ name: `Sub-${status}`, userId: "owner" });
    upsertSubscription(sOrg.id, {
      stripe_customer_id: `cus_${status}`,
      stripe_subscription_id: `sub_${status}`,
      plan: "starter", status,
    });
    await assert.rejects(
      createCheckoutSession(sOrg.id, "pro", { email: "t@t.com" }),
      /already has a subscription/,
      `checkout must be refused for status=${status}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // (5) Local cancel keeps stripe_subscription_id and stamps the lifecycle
  // cursor so a stale customer.subscription.updated cannot resurrect the
  // paid plan. A real customer.subscription.deleted still settles the row.
  // ═══════════════════════════════════════════════════════════════════════
  const cancelOrg = createOrg({ name: "Cancel org", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_cancel_setup", created: 300, subscriptionId: "sub_cancel",
    customerId: "cus_cancel", priceId: "price_starter", orgId: cancelOrg.id,
  }));
  assert.equal(getSubscription(cancelOrg.id).plan, "starter");

  cancelCalls.length = 0;
  await cancelSubscription(cancelOrg.id);
  assert.equal(cancelCalls[0], "sub_cancel", "Stripe cancel was called");
  const afterCancel = getSubscription(cancelOrg.id);
  assert.equal(afterCancel.plan, "free");
  assert.equal(afterCancel.status, "canceled");
  assert.equal(
    afterCancel.stripe_subscription_id, "sub_cancel",
    "subscription id kept on local cancel — prevents stale resurrection",
  );

  // Stale customer.subscription.updated (created just before cancel, delivered
  // after) must NOT resurrect the paid plan.
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_stale_cancel", created: 305, type: "customer.subscription.updated",
    subscriptionId: "sub_cancel", customerId: "cus_cancel",
    priceId: "price_starter", orgId: cancelOrg.id,
  }));
  const afterStale = getSubscription(cancelOrg.id);
  assert.equal(afterStale.plan, "free", "stale update cannot resurrect paid plan");
  assert.equal(afterStale.status, "canceled", "stale update cannot undo cancel");

  // A genuine customer.subscription.deleted (created after cancel) still
  // settles the row by clearing the subscription binding.
  const futureCreated = Math.floor(Date.now() / 1000) + 10;
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_deleted_cancel", created: futureCreated, type: "customer.subscription.deleted",
    subscriptionId: "sub_cancel", customerId: "cus_cancel",
    priceId: "price_starter", orgId: cancelOrg.id, status: "canceled",
  }));
  assert.equal(
    getSubscription(cancelOrg.id).stripe_subscription_id, null,
    "customer.subscription.deleted settles the row after local cancel",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // (6) Org deletion cancels the Stripe subscription even when local status
  // has drifted (e.g. unrecognized_price). The old guard skipped cancel
  // for any status outside the active-like list, orphaning live subs.
  // ═══════════════════════════════════════════════════════════════════════
  const delOrg = createOrg({ name: "Delete-target", userId: "owner" });
  createOrg({ name: "Keep", userId: "owner" }); // prevent last-org guard
  upsertSubscription(delOrg.id, {
    stripe_customer_id: "cus_del",
    stripe_subscription_id: "sub_del",
    plan: "starter", status: "unrecognized_price",
  });

  const rawToken = `wn_test_${"a".repeat(40)}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  db.prepare("INSERT INTO api_tokens (id, user_id, label, token_hash) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "owner", "test", tokenHash);

  cancelCalls.length = 0;
  const app = express();
  app.use(express.json());
  app.use(orgsRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/api/orgs/${delOrg.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    assert.equal(res.status, 200, `org delete should succeed, got ${res.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(
    cancelCalls.includes("sub_del"),
    "org deletion must cancel Stripe subscription even with drifted status",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // (7) Free-plan quota not exceeded at zero usage. The old >= comparison
  // reported 0 >= 0 as exceeded, permanently blocking free-plan orgs.
  // ═══════════════════════════════════════════════════════════════════════
  const quotaOrg = createOrg({ name: "Quota org", userId: "owner" });
  upsertSubscription(quotaOrg.id, { plan: "free", status: "active" });
  const quota = checkQuota(quotaOrg.id);
  assert.equal(quota.storage.exceeded, false, "free plan at zero usage must not be exceeded");
  assert.equal(quota.storage.used, 0);

  console.log("test-billing-edges: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
