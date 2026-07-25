import { randomUUID } from "node:crypto";
import { billingEnabled, config } from "./config.mjs";
import { PLANS, getSubscription, hostedHammersmithEntitled } from "./billing-state.mjs";
import { deleteSecret, getSecretValue, listSecrets, setSecret } from "./secrets.mjs";

// Per-org mantice gateway keys.
//
// Every hosted org gets its own bearer token at the LLM gateway (mantice —
// see ~/works/repos/mantice), minted lazily on the first turn and capped
// gateway-side at the plan's monthly token allowance. This isolates orgs at
// the gateway (revocation, per-org spend attribution) instead of sharing one
// deployment-wide runtime key. The gateway ADMIN token (config.llm.adminToken)
// is used only here, server-side, to mint/disable keys — it must NEVER enter
// a sandbox env (the same rule sandbox-llm-key.mjs documents for admin keys).
//
// Correctness model: the org's key is stored with a grant snapshot
// (plan + token limit). Any subscription change that alters the grant makes
// the snapshot stale, so the next turn disables the old gateway token and
// mints a fresh one under the current plan — no webhook coupling required.
// Webhook-driven revocation (subscription deletion) is a promptness bonus,
// wired in billing-webhooks.mjs.

export const ORG_LLM_KEY = "ORG_LLM_KEY";
export const ORG_LLM_KEY_META = "ORG_LLM_KEY_META";
// Hosted Hammersmith workers get their OWN gateway token, separate from the
// chat key: mutating microVM runs are worth isolating for revocation and spend
// attribution. It is still tenant-scoped — never the deployment-wide key.
export const HAMMERSMITH_LLM_KEY = "HAMMERSMITH_LLM_KEY";
export const HAMMERSMITH_LLM_KEY_META = "HAMMERSMITH_LLM_KEY_META";

// Mint window matches mantice's default quota window (30 days), aligning
// gateway-side token caps with the plan's per-month allowance.
const WINDOW_SECONDS = 30 * 24 * 60 * 60;
const GATEWAY_TIMEOUT_MS = 10_000;

function gatewayBase(runtimeConfig = config) {
  // LLM_BASE_URL points at the OpenAI-compatible surface (…/v1); the admin
  // API lives at the root.
  return runtimeConfig.llm.baseUrl.replace(/\/v1\/?$/, "");
}

/** Gateway ADMIN credential: env override first, else the encrypted global
 *  secret — the latter survives container recreation and is encrypted at
 *  rest, so it is the preferred production home. */
export const LLM_ADMIN_TOKEN_SECRET = "LLM_ADMIN_TOKEN";
function adminToken(runtimeConfig = config) {
  if (runtimeConfig.llm.adminToken) return runtimeConfig.llm.adminToken;
  try {
    return getSecretValue({ scope: "global", keyName: LLM_ADMIN_TOKEN_SECRET }) || "";
  } catch {
    return "";
  }
}

function adminHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function grantFor(orgId) {
  const subscription = getSubscription(orgId);
  if (!["active", "trialing"].includes(subscription.status)) return null;
  const plan = PLANS[subscription.plan] || PLANS.free;
  if (!plan.tokensPerMonth) return null;
  return { plan: subscription.plan, tokenLimit: plan.tokensPerMonth };
}

/** Hammersmith's grant is the add-on entitlement, not the chat plan: only an
 *  org actually subscribed to Hammersmith gets a Hammersmith gateway token. */
function hammersmithGrantFor(orgId) {
  if (!hostedHammersmithEntitled(orgId)) return null;
  const tokenLimit = PLANS.hammersmith.tokensPerMonth;
  if (!tokenLimit) return null;
  return { plan: "hammersmith", tokenLimit };
}

// The two kinds of per-org gateway token. Both mint through the same machinery
// (grant snapshot, rotation on change, revocation) and differ only in which
// secret they live under, how the gateway labels them, and what entitles them.
const PURPOSES = {
  chat: {
    keyName: ORG_LLM_KEY,
    metaName: ORG_LLM_KEY_META,
    label: (orgId) => `waynode-org:${orgId}`,
    grant: grantFor,
  },
  hammersmith: {
    keyName: HAMMERSMITH_LLM_KEY,
    metaName: HAMMERSMITH_LLM_KEY_META,
    label: (orgId) => `waynode-hammersmith:${orgId}`,
    grant: hammersmithGrantFor,
  },
};

function readMeta(orgId, metaName = ORG_LLM_KEY_META) {
  const raw = getSecretValue({ scope: "org", orgId, keyName: metaName });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function deleteOrgSecrets(orgId, keyNames) {
  for (const row of listSecrets({ scope: "org", orgId })) {
    if (keyNames.includes(row.key_name)) deleteSecret(row.id);
  }
}

async function gatewayFetch(path, init, { fetchImpl = fetch, runtimeConfig = config } = {}) {
  return fetchImpl(`${gatewayBase(runtimeConfig)}${path}`, {
    ...init,
    headers: { ...adminHeaders(adminToken(runtimeConfig)), ...(init.headers || {}) },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
}

async function ensureGatewayUser(orgId, opts) {
  const response = await gatewayFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify({ id: orgId, name: `Waynode org ${orgId.slice(0, 8)}` }),
  }, opts);
  // 201 created, 409 already exists — both fine.
  if (response.status !== 201 && response.status !== 409) {
    throw new Error(`gateway user upsert failed (HTTP ${response.status})`);
  }
}

async function disableGatewayToken(fingerprint, opts) {
  const response = await gatewayFetch(`/admin/tokens/${fingerprint}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  }, opts);
  // 404 = already gone; anything else unexpected but non-fatal for callers.
  if (!response.ok && response.status !== 404) {
    throw new Error(`gateway token disable failed (HTTP ${response.status})`);
  }
}

/**
 * Return one of the org's own gateway keys, minting (or rotating after a grant
 * change) if needed. Returns null when per-org keys don't apply — billing
 * disabled, no admin token configured, or the org isn't entitled for this
 * purpose — so the caller can fall back to its existing behavior.
 */
async function ensureOrgGatewayKey(orgId, purpose, opts = {}) {
  const runtimeConfig = opts.runtimeConfig || config;
  const enabled = opts.billingEnabled ?? billingEnabled;
  if (!enabled || !orgId || !adminToken(runtimeConfig)) return null;

  const grant = purpose.grant(orgId);
  if (!grant) return null;

  const meta = readMeta(orgId, purpose.metaName);
  const stored = getSecretValue({ scope: "org", orgId, keyName: purpose.keyName });
  if (stored && meta && meta.plan === grant.plan && meta.tokenLimit === grant.tokenLimit) {
    return stored;
  }

  // Grant changed (or first use): disable any previous gateway token, then
  // mint under the current plan.
  if (meta?.fingerprint) {
    try { await disableGatewayToken(meta.fingerprint, opts); }
    catch (error) { console.warn(`[org-llm-key] stale token disable failed for org ${orgId}:`, error.message); }
  }

  await ensureGatewayUser(orgId, opts);
  const response = await gatewayFetch("/admin/tokens", {
    method: "POST",
    headers: { "Idempotency-Key": `waynode-${orgId}-${randomUUID()}` },
    body: JSON.stringify({
      user_id: orgId,
      label: purpose.label(orgId),
      token_limit: grant.tokenLimit,
      window_seconds: WINDOW_SECONDS,
    }),
  }, opts);
  if (response.status !== 201) {
    throw new Error(`gateway token mint failed (HTTP ${response.status})`);
  }
  const body = await response.json();
  if (!body?.token || !body?.fingerprint) throw new Error("gateway token mint returned no token");

  deleteOrgSecrets(orgId, [purpose.keyName, purpose.metaName]);
  setSecret({ scope: "org", orgId, keyName: purpose.keyName, value: body.token });
  setSecret({
    scope: "org", orgId, keyName: purpose.metaName,
    value: JSON.stringify({ fingerprint: body.fingerprint, plan: grant.plan, tokenLimit: grant.tokenLimit }),
  });
  console.log(`[org-llm-key] minted ${purpose.keyName} for org ${orgId} (${grant.plan}, ${grant.tokenLimit} tokens/window)`);
  return body.token;
}

/** The org's chat gateway key (see ensureOrgGatewayKey). */
export async function ensureOrgLlmKey(orgId, opts = {}) {
  return ensureOrgGatewayKey(orgId, PURPOSES.chat, opts);
}

/**
 * The org's Hammersmith worker gateway key. Lets an entitled org start a
 * hosted run without an operator hand-planting a secret first, while keeping
 * the credential tenant-scoped, plan-capped and independently revocable.
 */
export async function ensureOrgHammersmithKey(orgId, opts = {}) {
  return ensureOrgGatewayKey(orgId, PURPOSES.hammersmith, opts);
}

/**
 * Disable the org's gateway token and forget it locally. Fire-and-forget
 * safe: every failure is logged, never thrown (used from webhook handlers).
 */
export async function revokeOrgLlmKey(orgId, opts = {}) {
  const runtimeConfig = opts.runtimeConfig || config;
  if (!orgId) return;
  // Every purpose, not just chat: a cancelled subscription must not leave a
  // live Hammersmith worker token behind at the gateway.
  for (const purpose of Object.values(PURPOSES)) {
    const meta = readMeta(orgId, purpose.metaName);
    try {
      if (meta?.fingerprint && adminToken(runtimeConfig)) {
        await disableGatewayToken(meta.fingerprint, opts);
      }
    } catch (error) {
      console.warn(`[org-llm-key] revoke of ${purpose.keyName} failed for org ${orgId}:`, error.message);
    } finally {
      deleteOrgSecrets(orgId, [purpose.keyName, purpose.metaName]);
    }
  }
}

/**
 * Gateway-side usage for the org's key (spend, token usage, caps) for the
 * billing UI. Null when unavailable — the UI treats it as optional.
 */
export async function orgLlmKeyStatus(orgId, opts = {}) {
  const runtimeConfig = opts.runtimeConfig || config;
  if (!orgId || !adminToken(runtimeConfig)) return null;
  const meta = readMeta(orgId);
  if (!meta?.fingerprint) return null;
  try {
    const response = await gatewayFetch("/admin/tokens", { method: "GET" }, opts);
    if (!response.ok) return null;
    const body = await response.json();
    const row = (body?.data || []).find((token) => token.fingerprint === meta.fingerprint);
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      tokensUsed: row.tokens_used,
      tokenLimit: row.token_limit,
      windowStart: row.window_start,
      windowSeconds: row.window_seconds,
      spendUsd: row.spend_usd,
      enabled: row.enabled,
    };
  } catch {
    return null;
  }
}
