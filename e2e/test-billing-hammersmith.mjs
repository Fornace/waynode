/** Hosted Hammersmith $8.99/mo tier regression. Throwaway SQLite, never Stripe. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-billing-hammersmith-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "billing-hammersmith-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";
process.env.STRIPE_PRICE_HAMMERSMITH = "price_hammersmith";
process.env.WAYNODE_SANDBOX_LLM_KEY = "test-runtime-value";

const { default: db } = await import("../lib/db.mjs");
const {
  BillingAdmissionError, billingEnabled, getSubscription, handleWebhookEvent,
  hostedHammersmithEntitled, PLANS, recordTokenUsage, reserveTokenQuota,
  TURN_RESERVATION_TOKENS,
} = await import("../lib/billing.mjs");
const { config } = await import("../lib/config.mjs");
const { priceIdForPlan } = await import("../lib/billing-stripe-operations.mjs");
const { createOrg } = await import("../lib/orgs.mjs");
const { setSecret } = await import("../lib/secrets.mjs");
const { hammersmithWorkerLlmEnv } = await import("../lib/sandbox-llm-key.mjs");
const {
  createHammersmithJob, getHammersmithJob, updateHammersmithJob,
} = await import("../lib/hammersmith-store.mjs");
const {
  hostedHammersmithAdmission, hammersmithCapabilityRouter,
} = await import("../routes/hammersmith.js");
const { default: express } = await import("express");

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

function reservationRow(id) {
  return db.prepare("SELECT * FROM token_quota_reservations WHERE id = ?").get(id);
}

try {
  // (a) The $8.99/mo plan definition.
  assert.equal(PLANS.hammersmith.price, 8.99);
  assert.equal(PLANS.hammersmith.tokensPerMonth, 5_000_000);

  // (b) The four price envs must keep billing enabled (priceIds trap guard).
  assert.equal(billingEnabled, true);

  seedUser("owner");
  const hammersmithOrg = createOrg({ name: "Hammersmith org", userId: "owner" });
  const starterOrg = createOrg({ name: "Starter org", userId: "owner" });
  const trialOrg = createOrg({ name: "Trial org", userId: "owner" });

  // (c) Webhook entitlement from the configured hammersmith price.
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_hm_100", created: 100, subscriptionId: "sub_hm", customerId: "cus_hm",
    priceId: "price_hammersmith", orgId: hammersmithOrg.id,
  }));
  assert.equal(getSubscription(hammersmithOrg.id).plan, "hammersmith");
  assert.equal(getSubscription(hammersmithOrg.id).status, "active");
  assert.equal(hostedHammersmithEntitled(hammersmithOrg.id), true);

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_starter_100", created: 100, subscriptionId: "sub_starter",
    customerId: "cus_starter", priceId: "price_starter", orgId: starterOrg.id,
  }));
  assert.equal(getSubscription(starterOrg.id).plan, "starter");
  assert.equal(hostedHammersmithEntitled(starterOrg.id), false);
  assert.equal(hostedHammersmithEntitled(trialOrg.id), false, "a plain trial org is not entitled");
  assert.equal(hostedHammersmithEntitled(null), false);

  // (d) The send-path admission gate (pure helper from the route module).
  assert.equal(hostedHammersmithAdmission({ org_id: hammersmithOrg.id }, "hosted"), null);
  const denied = hostedHammersmithAdmission({ org_id: starterOrg.id }, "hosted");
  assert.equal(denied.status, 402);
  assert.match(denied.error, /Hammersmith/);
  assert.match(denied.error, /\$8\.99/);
  assert.equal(hostedHammersmithAdmission({ org_id: starterOrg.id }, "self-hosted"), null);
  assert.equal(hostedHammersmithAdmission({}, "hosted"), null, "org-less sessions skip the gate");

  // (c, cont.) Dunning: a failed payment moves the org to past_due and
  // suspends the hosted-Hammersmith entitlement until recovery.
  await handleWebhookEvent(invoiceFailure({
    id: "evt_hm_150", created: 150, subscriptionId: "sub_hm",
    customerId: "cus_hm", orgId: hammersmithOrg.id,
  }));
  assert.equal(getSubscription(hammersmithOrg.id).status, "past_due");
  assert.equal(hostedHammersmithEntitled(hammersmithOrg.id), false);

  await handleWebhookEvent(subscriptionEvent({
    id: "evt_hm_175", created: 175, type: "customer.subscription.updated",
    subscriptionId: "sub_hm", customerId: "cus_hm",
    priceId: "price_hammersmith", orgId: hammersmithOrg.id, status: "active",
  }));
  assert.equal(hostedHammersmithEntitled(hammersmithOrg.id), true);

  // (e) Plan-switch: a customer.subscription.updated that flips the item price
  // back to starter must drop hosted-Hammersmith entitlement while moving the
  // org's plan to starter. created ordering (175 < 180 < 200) keeps the cursor
  // monotonic with the later deletion event below.
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_hm_180", created: 180, type: "customer.subscription.updated",
    subscriptionId: "sub_hm", customerId: "cus_hm",
    priceId: "price_starter", orgId: hammersmithOrg.id, status: "active",
  }));
  assert.equal(getSubscription(hammersmithOrg.id).plan, "starter");
  assert.equal(hostedHammersmithEntitled(hammersmithOrg.id), false);

  // (c, cont.) Deletion revokes the entitlement.
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_hm_200", created: 200, type: "customer.subscription.deleted",
    subscriptionId: "sub_hm", customerId: "cus_hm", priceId: "price_hammersmith",
    orgId: hammersmithOrg.id, status: "canceled",
  }));
  assert.equal(hostedHammersmithEntitled(hammersmithOrg.id), false);

  // (e) Capability endpoint over real HTTP: caller-scoped billing projection.
  seedUser("cap-user");
  const capOrg = createOrg({ name: "Cap org", userId: "cap-user" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_cap_100", created: 100, subscriptionId: "sub_cap", customerId: "cus_cap",
    priceId: "price_hammersmith", orgId: capOrg.id,
  }));
  const rawToken = `wn_test_${"a".repeat(40)}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  db.prepare("INSERT INTO api_tokens (id, user_id, label, token_hash) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "cap-user", "test", tokenHash);

  const app = express();
  app.use(hammersmithCapabilityRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymous = await (await fetch(`${baseUrl}/api/hammersmith/capability`)).json();
    assert.equal(typeof anonymous.available, "boolean");
    assert.equal("hosted" in anonymous, false, "unauthenticated payload stays byte-identical");
    assert.doesNotMatch(JSON.stringify(anonymous), /secret/i);
    assert.doesNotMatch(JSON.stringify(anonymous), /llm/i);

    const authed = async () => (await fetch(`${baseUrl}/api/hammersmith/capability`, {
      headers: { authorization: `Bearer ${rawToken}` },
    })).json();
    const entitledBody = await authed();
    assert.equal(typeof entitledBody.available, "boolean");
    assert.deepEqual(entitledBody.hosted, { billingRequired: true, entitled: true });
    assert.doesNotMatch(JSON.stringify(entitledBody), /secret/i);
    assert.doesNotMatch(JSON.stringify(entitledBody), /llm/i);

    await handleWebhookEvent(subscriptionEvent({
      id: "evt_cap_200", created: 200, type: "customer.subscription.deleted",
      subscriptionId: "sub_cap", customerId: "cus_cap", priceId: "price_hammersmith",
      orgId: capOrg.id, status: "canceled",
    }));
    const revokedBody = await authed();
    assert.deepEqual(revokedBody.hosted, { billingRequired: true, entitled: false });
    assert.doesNotMatch(JSON.stringify(revokedBody), /secret/i);
    assert.doesNotMatch(JSON.stringify(revokedBody), /llm/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // (f) Credential boundary: tenant secrets only, never the deployment key.
  setSecret({
    scope: "org", orgId: starterOrg.id, keyName: "HAMMERSMITH_LLM_KEY",
    value: "org-scoped-runtime-key",
  });
  assert.deepEqual(
    hammersmithWorkerLlmEnv({ space_id: "no-space", org_id: starterOrg.id }),
    { WAYNODE_LLM_KEY: "org-scoped-runtime-key" },
  );
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("cred-space", starterOrg.id, "owner", "https://example.test/cred.git", "cred", root);
  setSecret({
    scope: "space", spaceId: "cred-space", keyName: "HAMMERSMITH_LLM_KEY",
    value: "space-scoped-runtime-key",
  });
  assert.deepEqual(
    hammersmithWorkerLlmEnv({ space_id: "cred-space", org_id: starterOrg.id }),
    { WAYNODE_LLM_KEY: "space-scoped-runtime-key" },
    "space-scope overrides org-scope",
  );
  assert.throws(
    () => hammersmithWorkerLlmEnv({ space_id: "space-y", org_id: trialOrg.id }),
    (error) => error.status === 503,
  );
  assert.notEqual(
    hammersmithWorkerLlmEnv({ space_id: "cred-space", org_id: starterOrg.id }).WAYNODE_LLM_KEY,
    process.env.WAYNODE_SANDBOX_LLM_KEY,
    "the deployment-wide runtime key is never a worker credential",
  );

  // (g) Reservation settlement on terminal job paths.
  // (c) Mirror the route's own reservation arithmetic instead of hardcoding
  // 500_000; pin that it still resolves to the historical value.
  const expectedReservationTokens = config.hammersmith.maxAttempts * TURN_RESERVATION_TOKENS;
  assert.equal(expectedReservationTokens, 500_000, "route reservation arithmetic stays at 500_000");
  const entitledOrg = createOrg({ name: "Entitled org", userId: "owner" });
  await handleWebhookEvent(subscriptionEvent({
    id: "evt_ent_100", created: 100, subscriptionId: "sub_ent", customerId: "cus_ent",
    priceId: "price_hammersmith", orgId: entitledOrg.id,
  }));
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("g-space", entitledOrg.id, "owner", "https://example.test/g.git", "g", root);
  db.prepare("INSERT INTO sessions (id, space_id, owner_id, pi_session_dir) VALUES (?, ?, ?, ?)")
    .run("g-session", "g-space", "owner", root);

  const reservationOne = reserveTokenQuota(entitledOrg.id, `hammersmith:${randomUUID()}`, expectedReservationTokens);
  assert.equal(reservationOne.tokens, expectedReservationTokens);
  const jobOne = createHammersmithJob({
    ownerId: "owner", sessionId: "g-session", submissionId: randomUUID(),
    spaceId: "g-space", jobDescription: "finish path", stateDir: join(root, "job-one"),
    manifestPath: join(root, "job-one", "manifest.json"),
    billingReservationId: reservationOne.id, runtimeKind: "hosted",
  });
  updateHammersmithJob(jobOne.id, { lifecycle: "finished", finished_at: new Date().toISOString() });
  const finishedRow = reservationRow(reservationOne.id);
  assert.ok(finishedRow, "finish keeps the row during the metering grace window");
  assert.ok(finishedRow.expires_at <= Date.now() + 60_500, "finish shortens expiry to ~now+60s");
  assert.ok(finishedRow.expires_at > Date.now() - 10_000);
  assert.equal(getHammersmithJob(jobOne.id).billing_reservation_id, null);
  // (d) Idempotent settle, DB-verified: capture the post-settle row state, then
  // re-run the terminal update and assert the job's reservation link stays
  // null and the reservation row's expires_at is bit-for-bit unchanged (no
  // duplicate inserts, no mutation of the settled window). 402 precedes 503.
  const expectedExpiresAt = reservationRow(reservationOne.id).expires_at;
  assert.doesNotThrow(() => updateHammersmithJob(jobOne.id, {
    lifecycle: "finished", finished_at: new Date().toISOString(),
  }), "settlement is idempotent");
  assert.equal(getHammersmithJob(jobOne.id).billing_reservation_id, null);
  const settledRow = reservationRow(reservationOne.id);
  assert.ok(settledRow, "reservation row survives the second settle");
  assert.equal(settledRow.expires_at, expectedExpiresAt, "second settle leaves expires_at untouched");
  const reservationCount = db.prepare("SELECT COUNT(*) AS n FROM token_quota_reservations WHERE id = ?")
    .get(reservationOne.id).n;
  assert.equal(reservationCount, 1, "no duplicate reservation rows");

  const reservationTwo = reserveTokenQuota(entitledOrg.id, `hammersmith:${randomUUID()}`, expectedReservationTokens);
  const jobTwo = createHammersmithJob({
    ownerId: "owner", sessionId: "g-session", submissionId: randomUUID(),
    spaceId: "g-space", jobDescription: "stop path", stateDir: join(root, "job-two"),
    manifestPath: join(root, "job-two", "manifest.json"),
    billingReservationId: reservationTwo.id, runtimeKind: "hosted",
  });
  updateHammersmithJob(jobTwo.id, { lifecycle: "stopped", finished_at: new Date().toISOString() });
  assert.equal(reservationRow(reservationTwo.id), undefined, "stop releases the reservation");

  recordTokenUsage(entitledOrg.id, 5_000_000);
  assert.throws(
    () => reserveTokenQuota(entitledOrg.id, `hammersmith:${randomUUID()}`, expectedReservationTokens),
    (error) => error instanceof BillingAdmissionError && error.status === 402,
    "an exhausted hammersmith plan rejects new reservations with 402",
  );

  // (h) Static guard: checkout accepts the hammersmith plan.
  const billingRouteSource = readFileSync(new URL("../routes/billing.js", import.meta.url), "utf8");
  assert.ok(
    billingRouteSource.includes('["starter", "pro", "team", "hammersmith"]'),
    "checkout allowlist includes the hammersmith plan",
  );

  // (a) Behavioral coverage for priceIdForPlan: the hammersmith price lives
  // outside config.stripe.priceIds (to dodge the billingEnabled every(Boolean)
  // trap) but must still resolve through the shared helper.
  assert.equal(priceIdForPlan("hammersmith"), "price_hammersmith");
  assert.equal(priceIdForPlan("starter"), "price_starter");
  assert.equal(priceIdForPlan("pro"), "price_pro");
  assert.equal(priceIdForPlan("team"), "price_team");
  assert.ok(!priceIdForPlan("nonexistent"), "unknown plans resolve falsy");

  // (b) Gate order: in the send route, the 402 admission gate must precede
  // the 503 credential check (hostedHammersmithAdmission before
  // hammersmithWorkerLlmEnv) so non-entitled orgs without a secret see the
  // paywall, not a 503.
  const hammersmithRouteSource = readFileSync(new URL("../routes/hammersmith.js", import.meta.url), "utf8");
  const admissionIdx = hammersmithRouteSource.indexOf("hostedHammersmithAdmission(");
  const credentialIdx = hammersmithRouteSource.indexOf("hammersmithWorkerLlmEnv(");
  assert.ok(admissionIdx > -1 && credentialIdx > -1, "both gate call sites exist in the send route");
  assert.ok(admissionIdx < credentialIdx, "402 admission gate precedes 503 credential check");

  console.log("test-billing-hammersmith: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
