import { billingEnabled } from "./config.mjs";
import db from "./db.mjs";

export const PLANS = {
  trial: { name: "Free trial", price: 0, storageBytes: 2 * 1024 ** 3, tokensPerMonth: 5_000_000, seats: 1 },
  free: { name: "Free", price: 0, storageBytes: 0, tokensPerMonth: 0, seats: 1 },
  starter: { name: "Starter", price: 39, storageBytes: 10 * 1024 ** 3, tokensPerMonth: 3_000_000, seats: 3 },
  pro: { name: "Pro", price: 99, storageBytes: 50 * 1024 ** 3, tokensPerMonth: 8_000_000, seats: 10 },
  team: { name: "Team", price: 249, storageBytes: 200 * 1024 ** 3, tokensPerMonth: 20_000_000, seats: 25 },
};

export const TRIAL_DAYS = 15;

export function orgTrialEnd(orgId) {
  const org = db.prepare("SELECT created_at FROM orgs WHERE id = ?").get(orgId);
  if (!org?.created_at) return null;
  const createdAt = new Date(`${org.created_at.replace(" ", "T")}Z`);
  if (Number.isNaN(createdAt.getTime())) return null;
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function trialSubscription(orgId) {
  const endsAt = orgTrialEnd(orgId);
  if (!endsAt || endsAt.getTime() <= Date.now()) {
    return {
      org_id: orgId,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      plan: "free",
      status: "expired",
      current_period_end: endsAt?.toISOString() || null,
    };
  }
  return {
    org_id: orgId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: "trial",
    status: "trialing",
    current_period_end: endsAt.toISOString(),
  };
}

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
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
    current_period_end: null,
  };
}

export function upsertSubscription(orgId, fields) {
  const existing = db.prepare("SELECT org_id FROM org_subscriptions WHERE org_id = ?").get(orgId);
  const merged = {
    plan: "free",
    status: "active",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    last_stripe_event_created: 0,
    last_stripe_event_id: null,
    ...getSubscription(orgId),
    ...fields,
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

export function getUsage(orgId, periodStart = currentPeriodStart()) {
  const row = db.prepare("SELECT * FROM org_usage WHERE org_id = ? AND period_start = ?")
    .get(orgId, periodStart);
  return row || { org_id: orgId, period_start: periodStart, tokens_used: 0, storage_bytes: 0 };
}

export function recordTokenUsage(orgId, tokens, periodStart = currentPeriodStart()) {
  db.prepare(`
    INSERT INTO org_usage (org_id, period_start, tokens_used, storage_bytes)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(org_id, period_start) DO UPDATE SET
      tokens_used = tokens_used + excluded.tokens_used,
      updated_at = datetime('now')
  `).run(orgId, periodStart, tokens);
}

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
  const subscription = getSubscription(orgId);
  const plan = PLANS[subscription.plan] || PLANS.free;
  const usage = getUsage(orgId);
  return {
    plan: subscription.plan,
    status: subscription.status,
    tokens: {
      used: usage.tokens_used,
      limit: plan.tokensPerMonth,
      exceeded: usage.tokens_used >= plan.tokensPerMonth,
    },
    storage: {
      used: usage.storage_bytes,
      limit: plan.storageBytes,
      exceeded: usage.storage_bytes >= plan.storageBytes,
    },
  };
}
