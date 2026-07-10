/** Hosted billing regression test. It uses a throwaway SQLite DB, never Stripe. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const { default: db } = await import("../lib/db.mjs");
const { getSubscription, handleWebhookEvent, recordSessionTokenTotal } = await import("../lib/billing.mjs");
const { createOrg, createInvite, acceptInvite } = await import("../lib/orgs.mjs");

function seedUser(id) {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(id, id);
}

function subscriptionEvent({ id, created, type = "customer.subscription.created", subscriptionId, customerId, priceId, orgId, status = "active" }) {
  return { id, type, created, data: { object: {
    id: subscriptionId, customer: customerId, status,
    current_period_end: created + 2_592_000,
    metadata: { org_id: orgId }, items: { data: [{ price: { id: priceId } }] },
  } } };
}

try {
  seedUser("owner");
  seedUser("guest");
  const trialOrg = createOrg({ name: "Trial org", userId: "owner" });
  assert.equal(getSubscription(trialOrg.id).plan, "trial");
  assert.equal(getSubscription(trialOrg.id).status, "trialing");
  const invite = createInvite(trialOrg.id, { createdBy: "owner" });
  assert.equal(acceptInvite(invite.token, "guest").error, "seat_limit");

  const paidOrg = createOrg({ name: "Paid org", userId: "owner" });
  const first = subscriptionEvent({ id: "evt_first", created: 100, subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_starter", orgId: paidOrg.id });
  assert.deepEqual(await handleWebhookEvent(first), { processed: true, orgId: paidOrg.id });
  assert.equal(getSubscription(paidOrg.id).plan, "starter");
  assert.deepEqual(await handleWebhookEvent(first), { processed: false, reason: "duplicate" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stripe_webhook_events").get().count, 1);

  await handleWebhookEvent(subscriptionEvent({ id: "evt_stale", created: 99, type: "customer.subscription.updated", subscriptionId: "sub_one", customerId: "cus_one", priceId: "price_team", orgId: paidOrg.id }));
  assert.equal(getSubscription(paidOrg.id).plan, "starter");

  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("meter-space", paidOrg.id, "owner", "https://example.test/meter.git", "meter", root);
  db.prepare("INSERT INTO sessions (id, space_id, owner_id, pi_session_dir) VALUES (?, ?, ?, ?)")
    .run("meter-session", "meter-space", "owner", root);
  assert.equal(recordSessionTokenTotal("meter-session", paidOrg.id, 100), 100);
  assert.equal(recordSessionTokenTotal("meter-session", paidOrg.id, 100), 0);
  assert.equal(recordSessionTokenTotal("meter-session", paidOrg.id, 130), 30);
  assert.equal(db.prepare("SELECT tokens_used FROM org_usage WHERE org_id = ?").get(paidOrg.id).tokens_used, 130);

  const unknownOrg = createOrg({ name: "Unknown price", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({ id: "evt_unknown", created: 101, subscriptionId: "sub_unknown", customerId: "cus_unknown", priceId: "price_unmanaged", orgId: unknownOrg.id }));
  assert.equal(getSubscription(unknownOrg.id).status, "unrecognized_price");
  console.log("billing lifecycle: 13 assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
