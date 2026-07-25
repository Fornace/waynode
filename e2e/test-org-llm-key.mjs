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
const { getSecretValue, setSecret } = await import("../lib/secrets.mjs");
const {
  ensureOrgLlmKey, ensureOrgHammersmithKey, revokeOrgLlmKey,
  ORG_LLM_KEY, HAMMERSMITH_LLM_KEY,
} = await import("../lib/org-llm-key.mjs");
const { hammersmithWorkerLlmEnv } = await import("../lib/sandbox-llm-key.mjs");

// ── Fake mantice ────────────────────────────────────────────────────────────
const calls = [];
let mintCounter = 0;
let gatewayDown = false;
const fakeFetch = async (url, init = {}) => {
  if (gatewayDown) throw new Error("connect ECONNREFUSED");
  const { pathname } = new URL(url);
  const method = init.method || "GET";
  calls.push({ method, pathname, body: init.body });
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

// ── Hosted Hammersmith worker key ───────────────────────────────────────────
// An org that pays for the Hammersmith add-on must be able to start its first
// run without an operator hand-planting a secret, while the credential stays
// tenant-scoped — the deployment-wide chat runtime key is never a fallback.
const hammerOrg = "org-hammersmith";
db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(hammerOrg, "Hammer Org", "hammer-org");
const workerSession = { space_id: "hammer-no-space", org_id: hammerOrg };

await check("chat entitlement alone does not mint a Hammersmith key", async () => {
  upsertSubscription(hammerOrg, { plan: "pro", status: "active" });
  assert.ok(await ensureOrgLlmKey(hammerOrg, opts), "pro org still gets its chat key");
  assert.equal(await ensureOrgHammersmithKey(hammerOrg, opts), null, "add-on is a separate entitlement");
  await assert.rejects(
    () => hammersmithWorkerLlmEnv(workerSession, opts),
    (error) => error.status === 503,
    "a non-entitled org fails closed instead of borrowing any key",
  );
});

let workerKey;
await check("entitled org self-provisions a tenant-scoped worker key", async () => {
  upsertSubscription(hammerOrg, { plan: "hammersmith", status: "active" });
  const env = await hammersmithWorkerLlmEnv(workerSession, opts);
  workerKey = env.WAYNODE_LLM_KEY;
  assert.ok(workerKey, "first run provisions its own credential");
  assert.ok(workerKey.endsWith(`_${PLANS.hammersmith.tokensPerMonth}`), "capped at the add-on allowance");
  assert.equal(
    getSecretValue({ scope: "org", orgId: hammerOrg, keyName: HAMMERSMITH_LLM_KEY }), workerKey,
    "stored encrypted under its own secret name",
  );
  assert.notEqual(
    workerKey, getSecretValue({ scope: "org", orgId: hammerOrg, keyName: ORG_LLM_KEY }),
    "worker credential is distinct from the chat credential",
  );
  assert.notEqual(workerKey, process.env.WAYNODE_SANDBOX_LLM_KEY, "never the deployment-wide key");
  const minted = calls.filter((c) => c.method === "POST" && c.pathname === "/admin/tokens");
  assert.ok(
    JSON.parse(minted.at(-1).body).label === `waynode-hammersmith:${hammerOrg}`,
    "labelled at the gateway so spend and revocation are attributable",
  );
});

await check("route pre-flight and runner reuse one key, not two", async () => {
  const before = calls.filter((c) => c.method === "POST" && c.pathname === "/admin/tokens").length;
  assert.equal((await hammersmithWorkerLlmEnv(workerSession, opts)).WAYNODE_LLM_KEY, workerKey);
  assert.equal(calls.filter((c) => c.method === "POST" && c.pathname === "/admin/tokens").length, before);
});

await check("Space-scoped secret still overrides the org key", async () => {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("hammer-owner", "Hammer Owner");
  db.prepare("INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run("hammer-space", hammerOrg, "hammer-owner", "https://example.test/h.git", "h", root);
  setSecret({ scope: "space", spaceId: "hammer-space", keyName: HAMMERSMITH_LLM_KEY, value: "space-worker-key" });
  const env = await hammersmithWorkerLlmEnv({ space_id: "hammer-space", org_id: hammerOrg }, opts);
  assert.deepEqual(env, { WAYNODE_LLM_KEY: "space-worker-key" });
});

await check("gateway outage falls back to the stored tenant key, never the shared one", async () => {
  gatewayDown = true;
  const env = await hammersmithWorkerLlmEnv(workerSession, opts);
  assert.equal(env.WAYNODE_LLM_KEY, workerKey, "last good tenant key keeps the run alive");
  assert.notEqual(env.WAYNODE_LLM_KEY, process.env.WAYNODE_SANDBOX_LLM_KEY);
  gatewayDown = false;
});

await check("revoking the subscription disables the worker key too", async () => {
  await revokeOrgLlmKey(hammerOrg, opts);
  assert.equal(getSecretValue({ scope: "org", orgId: hammerOrg, keyName: HAMMERSMITH_LLM_KEY }), null);
  assert.equal(getSecretValue({ scope: "org", orgId: hammerOrg, keyName: ORG_LLM_KEY }), null);
});

console.log("org LLM key lifecycle checks passed");
