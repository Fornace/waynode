import { billingEnabled } from "./config.mjs";
import db from "./db.mjs";
import { getOrgTrialWindow, TRIAL_DAYS } from "./trial-eligibility.mjs";

export const PLANS = {
  trial: { name: "Free trial", price: 0, storageBytes: 2 * 1024 ** 3, tokensPerMonth: 5_000_000, seats: 1 },
  free: { name: "Free", price: 0, storageBytes: 0, tokensPerMonth: 0, seats: 1 },
  starter: { name: "Starter", price: 39, storageBytes: 10 * 1024 ** 3, tokensPerMonth: 3_000_000, seats: 3 },
  pro: { name: "Pro", price: 99, storageBytes: 50 * 1024 ** 3, tokensPerMonth: 8_000_000, seats: 10 },
  team: { name: "Team", price: 249, storageBytes: 200 * 1024 ** 3, tokensPerMonth: 20_000_000, seats: 25 },
  // The $8.99/mo per-org hosted-Hammersmith tier: an add-on that unlocks
  // managed Hammersmith runs for one organization's sessions.
  hammersmith: { name: "Hammersmith", price: 8.99, storageBytes: 2 * 1024 ** 3, tokensPerMonth: 5_000_000, seats: 1 },
};

export { TRIAL_DAYS };
export const TURN_RESERVATION_TOKENS = 250_000;
const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
const METERING_GRACE_MS = 60_000;

export function orgTrialEnd(orgId) {
  return getOrgTrialWindow(orgId).endsAt;
}

function trialSubscription(orgId) {
  const { startsAt, endsAt } = getOrgTrialWindow(orgId);
  const active = endsAt && endsAt.getTime() > Date.now();
  return {
    org_id: orgId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: active ? "trial" : "free",
    status: active ? "trialing" : "expired",
    current_period_start: startsAt?.toISOString() || null,
    current_period_end: endsAt?.toISOString() || null,
  };
}

export function getSubscription(orgId) {
  const row = db.prepare("SELECT * FROM org_subscriptions WHERE org_id = ?").get(orgId);
  if (row) return row;
  if (billingEnabled) return trialSubscription(orgId);
  return {
    org_id: orgId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: "free",
    status: "active",
    current_period_start: null,
    current_period_end: null,
  };
}

/** True only while the org holds an active/trialing subscription to the
 *  $8.99/mo per-org hosted-Hammersmith tier (PLANS.hammersmith). */
export function hostedHammersmithEntitled(orgId) {
  if (!orgId) return false;
  const subscription = getSubscription(orgId);
  return subscription.plan === "hammersmith" && ["active", "trialing"].includes(subscription.status);
}

export function usagePeriodStart(orgId, subscription = getSubscription(orgId)) {
  if (subscription.current_period_start) return subscription.current_period_start;
  if (!billingEnabled) return "self-hosted";
  // A legacy paid row may predate current_period_start. Keep it in one stable,
  // conservative bucket until the next Stripe lifecycle snapshot supplies the
  // authoritative billing anchor; never silently reset it every calendar month.
  return `legacy:${subscription.stripe_subscription_id || subscription.current_period_end || orgId}`;
}

export function upsertSubscription(orgId, fields) {
  const existing = db.prepare("SELECT org_id FROM org_subscriptions WHERE org_id = ?").get(orgId);
  const merged = {
    plan: "free", status: "active", stripe_customer_id: null,
    stripe_subscription_id: null, current_period_start: null, current_period_end: null,
    last_stripe_event_created: 0, last_stripe_event_priority: 0,
    last_stripe_event_id: null, ...getSubscription(orgId), ...fields,
  };
  const values = [
    merged.stripe_customer_id, merged.stripe_subscription_id, merged.plan,
    merged.status, merged.current_period_start, merged.current_period_end,
    merged.last_stripe_event_created, merged.last_stripe_event_priority,
    merged.last_stripe_event_id,
  ];
  if (existing) {
    db.prepare(`
      UPDATE org_subscriptions SET
        stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = ?,
        current_period_start = ?, current_period_end = ?, last_stripe_event_created = ?,
        last_stripe_event_priority = ?, last_stripe_event_id = ?, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(...values, orgId);
  } else {
    db.prepare(`
      INSERT INTO org_subscriptions (
        org_id, stripe_customer_id, stripe_subscription_id, plan, status,
        current_period_start, current_period_end, last_stripe_event_created,
        last_stripe_event_priority, last_stripe_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orgId, ...values);
  }
  return getSubscription(orgId);
}

export function getUsage(orgId, periodStart = usagePeriodStart(orgId)) {
  const row = db.prepare("SELECT * FROM org_usage WHERE org_id = ? AND period_start = ?")
    .get(orgId, periodStart);
  return row || { org_id: orgId, period_start: periodStart, tokens_used: 0, storage_bytes: 0 };
}

export function recordTokenUsage(orgId, tokens, periodStart = usagePeriodStart(orgId)) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const amount = Math.floor(tokens);
  db.prepare(`
    INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(org_id, period_start) DO UPDATE SET
      tokens_used = tokens_used + excluded.tokens_used, updated_at = datetime('now')
  `).run(orgId, periodStart, amount);
  return amount;
}

export function recordSessionTokenTotal(sessionId, orgId, total, periodStart = usagePeriodStart(orgId)) {
  if (!sessionId || !orgId || !Number.isFinite(total) || total < 0) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT metered_tokens FROM sessions WHERE id = ?").get(sessionId);
    if (!row) { db.exec("COMMIT"); return 0; }
    const previous = Number(row.metered_tokens) || 0;
    const measured = Math.floor(total);
    const delta = Math.max(0, measured - previous);
    if (delta > 0) {
      db.prepare(`
        INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(org_id, period_start) DO UPDATE SET
          tokens_used = tokens_used + excluded.tokens_used, updated_at = datetime('now')
      `).run(orgId, periodStart, delta);
    }
    if (measured > previous) {
      db.prepare("UPDATE sessions SET metered_tokens = ?, updated_at = datetime('now') WHERE id = ?")
        .run(measured, sessionId);
    }
    db.exec("COMMIT");
    return delta;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function recordStorageBytes(orgId, bytes, periodStart = usagePeriodStart(orgId)) {
  const measured = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  db.prepare(`
    INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(org_id, period_start) DO UPDATE SET
      storage_bytes = excluded.storage_bytes, updated_at = datetime('now')
  `).run(orgId, periodStart, measured);
}

function activeReservedTokens(orgId, periodStart, now = Date.now()) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(tokens), 0) AS total FROM token_quota_reservations
    WHERE org_id = ? AND period_start = ? AND expires_at > ?
  `).get(orgId, periodStart, now)?.total) || 0;
}

export class BillingAdmissionError extends Error {
  constructor(message) { super(message); this.name = "BillingAdmissionError"; this.status = 402; }
}

export function reserveTokenQuota(
  orgId, reservationId, requestedTokens = TURN_RESERVATION_TOKENS,
  { now = Date.now(), ttlMs = RESERVATION_TTL_MS } = {},
) {
  if (!billingEnabled || !orgId) return null;
  if (!reservationId) throw new Error("A token reservation id is required");
  const tokens = Math.max(1, Math.floor(requestedTokens));
  db.exec("BEGIN IMMEDIATE");
  try {
    const subscription = getSubscription(orgId);
    const plan = PLANS[subscription.plan] || PLANS.free;
    if (!["active", "trialing"].includes(subscription.status)) {
      throw new BillingAdmissionError("Your Waynode Cloud trial or subscription is not active. Update billing to continue.");
    }
    const periodStart = usagePeriodStart(orgId, subscription);
    const used = getUsage(orgId, periodStart).tokens_used;
    const reserved = activeReservedTokens(orgId, periodStart, now);
    const amount = Math.min(tokens, plan.tokensPerMonth);
    if (!amount || used + reserved + amount > plan.tokensPerMonth) {
      throw new BillingAdmissionError("Your organization does not have enough included agent usage for another turn. Update billing or wait for active work to finish.");
    }
    db.prepare(`
      INSERT INTO token_quota_reservations (id, org_id, period_start, tokens, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(reservationId, orgId, periodStart, amount, now + ttlMs);
    db.exec("COMMIT");
    return { id: reservationId, orgId, periodStart, tokens: amount };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function finishTokenReservation(reservationId, now = Date.now()) {
  if (!reservationId) return;
  // Keep a short overlap while the agent's asynchronous final stats are
  // reconciled into tokens_used. It is deliberately conservative, not a bill.
  db.prepare("UPDATE token_quota_reservations SET expires_at = MIN(expires_at, ?) WHERE id = ?")
    .run(now + METERING_GRACE_MS, reservationId);
}

export function releaseTokenReservation(reservationId) {
  if (reservationId) db.prepare("DELETE FROM token_quota_reservations WHERE id = ?").run(reservationId);
}

export function checkQuota(orgId, now = Date.now()) {
  const subscription = getSubscription(orgId);
  const plan = PLANS[subscription.plan] || PLANS.free;
  const periodStart = usagePeriodStart(orgId, subscription);
  const usage = getUsage(orgId, periodStart);
  const reserved = activeReservedTokens(orgId, periodStart, now);
  return {
    plan: subscription.plan, status: subscription.status, period_start: periodStart,
    tokens: {
      used: usage.tokens_used, reserved, limit: plan.tokensPerMonth,
      exceeded: usage.tokens_used + reserved >= plan.tokensPerMonth,
    },
    storage: {
      used: usage.storage_bytes, limit: plan.storageBytes,
      exceeded: usage.storage_bytes >= plan.storageBytes,
    },
  };
}
