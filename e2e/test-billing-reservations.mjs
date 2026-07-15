/** Proves quota admission is atomic across real concurrent Node processes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "waynode-reservations-"));
const barrier = join(root, "start");
const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
Object.assign(process.env, {
  DATA_DIR: root,
  SESSION_SECRET: "reservation-test",
  ENCRYPTION_KEY: key,
  WAYNODE_DEPLOYMENT: "hosted",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_TEAM: "price_team",
});

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "billing-reservation-worker.mjs");
const { default: db } = await import("../lib/db.mjs");
const {
  checkQuota, releaseTokenReservation, reserveTokenQuota, upsertSubscription,
} = await import("../lib/billing.mjs");
const { createOrg } = await import("../lib/orgs.mjs");

function runWorker(id, orgId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, barrier, orgId, id, "2000000"], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `worker exited ${code}`));
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1))); }
      catch { reject(new Error(`invalid worker output: ${stdout} ${stderr}`)); }
    });
  });
}

try {
  db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("owner", "owner");
  const org = createOrg({ name: "Race org", userId: "owner" });
  upsertSubscription(org.id, {
    stripe_customer_id: "cus_race", stripe_subscription_id: "sub_race",
    plan: "starter", status: "active",
    current_period_start: "2026-07-01T00:00:00.000Z",
    current_period_end: "2026-08-01T00:00:00.000Z",
  });

  const attempts = [runWorker("race-a", org.id), runWorker("race-b", org.id)];
  writeFileSync(barrier, "go");
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result.ok).length, 1, "only one concurrent lease fits");
  assert.equal(results.filter((result) => result.status === 402).length, 1, "loser gets recovery-safe 402");
  assert.match(results.find((result) => !result.ok).message, /included agent usage/);
  assert.equal(checkQuota(org.id).tokens.reserved, 2_000_000);

  releaseTokenReservation(results.find((result) => result.ok).id);
  assert.equal(reserveTokenQuota(org.id, "after-release", 2_000_000).id, "after-release");
  console.log("billing reservations: multi-process atomic admission PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
