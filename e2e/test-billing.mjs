/** Hosted billing lifecycle regression. Uses a throwaway SQLite DB, never Stripe. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-billing-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "billing-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";
process.env.WAYNODE_STORAGE_MEASUREMENT_TIMEOUT_MS = "50";

const { default: db } = await import("../lib/db.mjs");
const {
  getSubscription, getUsage, handleWebhookEvent, recordSessionTokenTotal,
  usagePeriodStart,
} = await import("../lib/billing.mjs");
const { createOrg, createInvite, acceptInvite } = await import("../lib/orgs.mjs");

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

function invoiceFailure({ id, created, subscriptionId, customerId, orgId }) {
  return { id, type: "invoice.payment_failed", created, data: { object: {
    id: `in_${id}`, subscription: subscriptionId, customer: customerId,
    subscription_details: { metadata: { org_id: orgId } },
  } } };
}

try {
  seedUser("owner");
  seedUser("guest");
  const trialOrg = createOrg({ name: "Trial org", userId: "owner" });
  const trial = getSubscription(trialOrg.id);
  assert.equal(trial.plan, "trial");
  assert.equal(trial.status, "trialing");
  assert.equal(usagePeriodStart(trialOrg.id), trial.current_period_start);
  assert.equal(getUsage(trialOrg.id).period_start, trial.current_period_start);
  const invite = createInvite(trialOrg.id, { createdBy: "owner" });
  assert.equal(acceptInvite(invite.token, "guest").error, "seat_limit");

  const paidOrg = createOrg({ name: "Paid org", userId: "owner" });
  const checkout = {
    id: "evt_checkout", type: "checkout.session.completed", created: 90,
    data: { object: { id: "cs_1", customer: "cus_one", subscription: "sub_one",
      metadata: { org_id: paidOrg.id, plan: "team" } } },
  };
  await handleWebhookEvent(checkout);
  assert.equal(getSubscription(paidOrg.id).plan, "free", "a second org cannot mint another trial");
  assert.equal(getSubscription(paidOrg.id).stripe_subscription_id, null);

  const created = subscriptionEvent({
    id: "evt_100_a", created: 100, subscriptionId: "sub_one",
    customerId: "cus_one", priceId: "price_starter", orgId: paidOrg.id,
  });
  assert.deepEqual(await handleWebhookEvent(created), { processed: true, orgId: paidOrg.id });
  assert.equal(getSubscription(paidOrg.id).plan, "starter");
  assert.equal(usagePeriodStart(paidOrg.id), new Date(50_000).toISOString());
  assert.deepEqual(await handleWebhookEvent(created), { processed: false, reason: "duplicate" });

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_100_z", created: 100, type: "customer.subscription.updated",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_team",
    orgId: paidOrg.id, periodStart: 60,
  }));
  assert.equal(getSubscription(paidOrg.id).plan, "team", "equal-second cursor converges deterministically");
  assert.equal(usagePeriodStart(paidOrg.id), new Date(60_000).toISOString());

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_stale", created: 99, type: "customer.subscription.updated",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_starter", orgId: paidOrg.id,
  }));
  assert.equal(getSubscription(paidOrg.id).plan, "team", "older delivery cannot regress plan");

  await handleWebhookEvent(invoiceFailure({
    id: "evt_failure", created: 100, subscriptionId: "sub_one",
    customerId: "cus_one", orgId: paidOrg.id,
  }));
  assert.equal(getSubscription(paidOrg.id).status, "past_due");
  assert.equal(getSubscription(paidOrg.id).plan, "team", "payment failure retains price-derived plan");

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_same_second_active", created: 100, type: "customer.subscription.updated",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_team", orgId: paidOrg.id,
  }));
  assert.equal(getSubscription(paidOrg.id).status, "past_due", "equal-second active snapshot cannot undo failure");

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_recovered", created: 101, type: "customer.subscription.updated",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_pro", orgId: paidOrg.id,
    periodStart: 70,
  }));
  assert.equal(getSubscription(paidOrg.id).status, "active");
  assert.equal(getSubscription(paidOrg.id).plan, "pro");

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_deleted", created: 102, type: "customer.subscription.deleted",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_pro", orgId: paidOrg.id,
    status: "canceled", periodStart: 70,
  }));
  assert.equal(getSubscription(paidOrg.id).status, "canceled");
  assert.equal(getSubscription(paidOrg.id).plan, "free");
  assert.equal(getSubscription(paidOrg.id).stripe_subscription_id, null);

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_delayed_update", created: 101, type: "customer.subscription.updated",
    subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_team", orgId: paidOrg.id,
  }));
  assert.equal(getSubscription(paidOrg.id).status, "canceled", "delayed update cannot resurrect deletion");

  const meteredOrg = createOrg({ name: "Metered org", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_metered", created: 200, subscriptionId: "sub_metered", customerId: "cus_metered",
    priceId: "price_starter", orgId: meteredOrg.id, periodStart: 123,
  }));
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("meter-space", meteredOrg.id, "owner", "https://example.test/meter.git", "meter", root);
  db.prepare("INSERT INTO sessions (id, space_id, owner_id, pi_session_dir) VALUES (?, ?, ?, ?)")
    .run("meter-session", "meter-space", "owner", root);
  assert.equal(recordSessionTokenTotal("meter-session", meteredOrg.id, 100), 100);
  assert.equal(recordSessionTokenTotal("meter-session", meteredOrg.id, 100), 0);
  assert.equal(recordSessionTokenTotal("meter-session", meteredOrg.id, 130), 30);
  assert.equal(getUsage(meteredOrg.id).tokens_used, 130);
  assert.equal(getUsage(meteredOrg.id).period_start, new Date(123_000).toISOString());

  const unknownOrg = createOrg({ name: "Unknown price", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_unknown", created: 300, subscriptionId: "sub_unknown", customerId: "cus_unknown",
    priceId: "price_unmanaged", orgId: unknownOrg.id,
  }));
  assert.equal(getSubscription(unknownOrg.id).status, "unrecognized_price");
  assert.equal(getSubscription(unknownOrg.id).plan, "free");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stripe_webhook_events").get().count, 11);

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin);
  const fakeDu = join(fakeBin, "du");
  writeFileSync(fakeDu, "#!/usr/bin/env node\nsetTimeout(() => {}, 2000);\n");
  chmodSync(fakeDu, 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  const { measureOrgStorageBytes } = await import("../lib/storage-quota.mjs");
  let eventLoopAdvanced = false;
  setImmediate(() => { eventLoopAdvanced = true; });
  const startedAt = Date.now();
  await assert.rejects(measureOrgStorageBytes(meteredOrg.id), /timed out/);
  assert.equal(eventLoopAdvanced, true, "storage measurement leaves the event loop responsive");
  assert.ok(Date.now() - startedAt < 1_000, "storage measurement has a bounded timeout");
  console.log("billing lifecycle: created/updated/deleted/failure/duplicate/order/period PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
