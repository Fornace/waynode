import { existsSync } from "fs";
import { spawnSync } from "child_process";
import db from "./db.mjs";
import { billingEnabled, checkQuota, recordStorageBytes } from "./billing.mjs";

function orgStorageBytes(orgId) {
  const spaces = db.prepare("SELECT local_path FROM spaces WHERE org_id = ?").all(orgId);
  let total = 0;
  for (const space of spaces) {
    if (!space.local_path || !existsSync(space.local_path)) continue;
    const result = spawnSync("du", ["-sk", space.local_path], { encoding: "utf8", timeout: 10_000 });
    const kb = Number.parseInt((result.stdout || "0").trim().split(/\s+/)[0], 10);
    if (Number.isFinite(kb) && kb >= 0) total += kb * 1024;
  }
  return total;
}

/**
 * Refreshes a hosted organization's measured storage and rejects work that
 * would exceed its plan. Self-hosted installations deliberately bypass this.
 * `incomingBytes` is a conservative reservation for a prospective write.
 */
export function assertOrgStorageCapacity(orgId, incomingBytes = 0) {
  if (!billingEnabled || !orgId) return { used: 0, limit: Infinity };
  const quota = checkQuota(orgId);
  const used = orgStorageBytes(orgId);
  recordStorageBytes(orgId, used);
  if (!['active', 'trialing'].includes(quota.status)) {
    const error = new Error("Your Waynode Cloud trial or subscription is not active. Update billing to continue.");
    error.status = 402;
    throw error;
  }
  const limit = quota.storage.limit;
  if (used + Math.max(0, incomingBytes) > limit) {
    const error = new Error("Your organization has reached its storage limit. Free space or update billing to continue.");
    error.status = 402;
    throw error;
  }
  return { used, limit };
}

export function refreshOrgStorageUsage(orgId) {
  if (!billingEnabled || !orgId) return 0;
  const used = orgStorageBytes(orgId);
  recordStorageBytes(orgId, used);
  return used;
}
