import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import db from "./db.mjs";
import { billingEnabled, checkQuota, recordStorageBytes } from "./billing.mjs";

const configuredTimeout = Number(process.env.WAYNODE_STORAGE_MEASUREMENT_TIMEOUT_MS);
const MEASUREMENT_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? Math.max(50, configuredTimeout)
  : 10_000;
const measurements = new Map();

async function existingOrgPaths(orgId) {
  const rows = db.prepare("SELECT local_path FROM spaces WHERE org_id = ?").all(orgId);
  const checked = await Promise.all(rows.map(async ({ local_path }) => {
    if (!local_path) return null;
    try { await access(local_path); return local_path; } catch { return null; }
  }));
  return checked.filter(Boolean);
}

async function runDu(paths) {
  if (!paths.length) return 0;
  return new Promise((resolve, reject) => {
    const child = spawn("du", ["-sk", "--", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MEASUREMENT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Storage measurement timed out. Try again."));
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || "Storage measurement failed. Try again."));
      }
      let total = 0;
      for (const line of stdout.trim().split("\n")) {
        const kb = Number.parseInt(line.split("\t", 1)[0], 10);
        if (Number.isFinite(kb) && kb >= 0) total += kb * 1024;
      }
      resolve(total);
    });
  });
}

export async function measureOrgStorageBytes(orgId) {
  return runDu(await existingOrgPaths(orgId));
}

/**
 * Synchronous admission reads the last durable measurement only; it never
 * shells out on the Node event loop. `incomingBytes` conservatively protects
 * prospective uploads while async post-write refreshes update the snapshot.
 */
export function assertOrgStorageCapacity(orgId, incomingBytes = 0) {
  if (!billingEnabled || !orgId) return { used: 0, limit: Infinity };
  const quota = checkQuota(orgId);
  if (!["active", "trialing"].includes(quota.status)) {
    const error = new Error("Your Waynode Cloud trial or subscription is not active. Update billing to continue.");
    error.status = 402;
    throw error;
  }
  const used = quota.storage.used;
  if (used + Math.max(0, incomingBytes) > quota.storage.limit) {
    const error = new Error("Your organization has reached its storage limit. Free space or update billing to continue.");
    error.status = 402;
    throw error;
  }
  return { used, limit: quota.storage.limit };
}

export function refreshOrgStorageUsage(orgId, { strict = false } = {}) {
  if (!billingEnabled || !orgId) return Promise.resolve(0);
  let measurement = measurements.get(orgId);
  if (!measurement) {
    measurement = measureOrgStorageBytes(orgId)
      .then((used) => { recordStorageBytes(orgId, used); return used; })
      .finally(() => measurements.delete(orgId));
    measurements.set(orgId, measurement);
  }
  if (strict) return measurement;
  return measurement.catch((error) => {
    console.error("[storage quota] refresh failed:", error.message);
    return checkQuota(orgId).storage.used;
  });
}
