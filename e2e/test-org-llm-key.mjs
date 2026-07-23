/** Per-org mantice gateway keys: mint, reuse, rotate on plan change, revoke,
 *  and graceful fallback when the gateway is down. Uses an injected fetch —
 *  no live gateway required. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-org-llm-key-"));
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "org-llm-key-test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  WAYNODE_DEPLOYMENT: "hosted",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_TEAM: "price_team",
  LLM_BASE_URL: "http://gateway.test/v1",
  LLM_ADMIN_TOKEN: "admin-secret",
});

const db = (await import("../lib/db.mjs")).default;
const { upsertSubscription, PLANS } = await import("../lib/billing-state.mjs");
const { getSecretValue } = await import("../lib/secrets.mjs");
const { ensureOrgLlmKey, revokeOrgLlmKey, ORG_LLM_KEY } = await import("../lib/org-llm-key.mjs");

// ── Fake mantice ────────────────────────────────────────────────────────────
const calls = [];
let mintCounter = 0;
let gatewayDown = false;
const fakeFetch = async (url, init = {}) => {
  if (gatewayDown) throw new Error("connect ECONNREFUSED");
  const { pathname } = new URL(url);
  const method = init.method || "GET";
  calls.push({ method, pathname });
  assert.equal(init.headers.Authorization, "Bearer admin-secret", "admin token must be sent");
  assert.ok(!url.includes("/v1/admin"), "admin API must be addressed at the gateway root, not /v1");
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (method === "POST" && pathname === "/admin/users") return json(201, {});
  if (method === "POST" && pathname === "/admin/tokens") {
    assert.ok(init.headers["Idempotency-Key"]?.length >= 16, "Idempotency-Key required");
    const body = JSON.parse(init.body);
    mintCounter += 1;
    return json(201, { token: `mantice_test_${mintCounter}_${body.token_limit}`, fingerprint: `fp${mintCounter}` });
  }
  if (method === "PATCH" && pathname.startsWith("/admin/tokens/")) return json(200, {});
  return json(404, {});
};
const opts = { fetchImpl: fakeFetch };

const orgId = "org-under-test";
db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(orgId, "Test Org", "test-org");

function check(name, fn) { return fn().then(() => console.log("PASS ", name)); }

await check("no entitlement -> no key minted", async () => {
  upsertSubscription(orgId, { plan: "free", status: "canceled" });
  assert.equal(await ensureOrgLlmKey(orgId, opts), null);
});

let firstKey;
await check("entitled org mints once and reuses", async () => {
  upsertSubscription(orgId, { plan: "starter", status: "active" });
  firstKey = await ensureOrgLlmKey(orgId, opts);
  assert.ok(firstKey.startsWith("mantice_test_1"), "mints a gateway token");
  assert.ok(firstKey.endsWith(`_${PLANS.starter.tokensPerMonth}`), "token_limit follows the plan");
  assert.equal(await ensureOrgLlmKey(orgId, opts), firstKey, "second call reuses stored key");
  assert.equal(calls.filter((c) => c.pathname === "/admin/tokens" && c.method === "POST").length, 1);
  assert.equal(getSecretValue({ scope: "org", orgId, keyName: ORG_LLM_KEY }), firstKey, "stored encrypted");
});

await check("plan change disables old token and mints under new limit", async () => {
  upsertSubscription(orgId, { plan: "pro", status: "active" });
  const rotated = await ensureOrgLlmKey(orgId, opts);
  assert.notEqual(rotated, firstKey);
  assert.ok(rotated.endsWith(`_${PLANS.pro.tokensPerMonth}`), "new token uses pro limit");
  assert.ok(calls.some((c) => c.method === "PATCH" && c.pathname === "/admin/tokens/fp1"), "old token disabled");
});

await check("revoke disables at gateway and forgets locally", async () => {
  await revokeOrgLlmKey(orgId, opts);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.pathname === "/admin/tokens/fp2"));
  assert.equal(getSecretValue({ scope: "org", orgId, keyName: ORG_LLM_KEY }), null);
});

await check("gateway outage -> ensure throws, sandbox env falls back to shared key", async () => {
  gatewayDown = true;
  await assert.rejects(() => ensureOrgLlmKey(orgId, opts));
  process.env.WAYNODE_SANDBOX_LLM_KEY = "sk-shared";
  const { config } = await import("../lib/config.mjs");
  const runtimeConfig = { ...config, deployment: "hosted", llm: { ...config.llm, sandboxRuntimeKey: "sk-shared" } };
  const { sandboxChatLlmEnv } = await import("../lib/sandbox-llm-key.mjs");
  const session = { model: "fornace/fornace-fast", provider: "fornace" };
  const env = await sandboxChatLlmEnv(session, runtimeConfig, { orgId });
  assert.deepEqual(env, { WAYNODE_LLM_KEY: "sk-shared" }, "work continues on the shared key");
  gatewayDown = false;
});

await check("no admin token configured -> per-org keys inert", async () => {
  const { config } = await import("../lib/config.mjs");
  const runtimeConfig = { ...config, llm: { ...config.llm, adminToken: "" } };
  assert.equal(await ensureOrgLlmKey(orgId, { ...opts, runtimeConfig }), null);
});

console.log("org LLM key lifecycle checks passed");
