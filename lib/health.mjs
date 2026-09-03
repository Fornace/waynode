import { accessSync, constants } from "node:fs";
import db from "./db.mjs";
import { billingEnabled, config } from "./config.mjs";

const SANDBOX_GATEWAY_TIMEOUT_MS = 1_500;
const SANDBOX_GATEWAY_CACHE_MS = 5_000;
let gatewayProbeCache = { checkedAt: 0, ready: false, pending: null };

function accessible(path, mode = constants.R_OK) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function sandboxGatewayReadinessUrl(baseUrl = config.llm.baseUrl) {
  const input = /^[a-z][a-z\d+.-]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  const url = new URL(input);
  url.pathname = "/readyz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function sandboxGatewayReady({
  baseUrl = config.llm.baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = SANDBOX_GATEWAY_TIMEOUT_MS,
} = {}) {
  try {
    const response = await fetchImpl(sandboxGatewayReadinessUrl(baseUrl), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    return (await response.json())?.status === "ok";
  } catch {
    return false;
  }
}

export async function cachedSandboxGatewayReady({
  now = Date.now,
  gatewayProbe = sandboxGatewayReady,
} = {}) {
  const current = now();
  if (current - gatewayProbeCache.checkedAt < SANDBOX_GATEWAY_CACHE_MS) {
    return gatewayProbeCache.ready;
  }
  if (gatewayProbeCache.pending) return gatewayProbeCache.pending;
  let probeResult;
  try {
    probeResult = gatewayProbe();
  } catch {
    probeResult = false;
  }
  gatewayProbeCache.pending = Promise.resolve(probeResult)
    .catch(() => false)
    .then((ready) => {
      gatewayProbeCache = { checkedAt: now(), ready, pending: null };
      return ready;
    });
  return gatewayProbeCache.pending;
}

export function resetSandboxGatewayReadinessCache() {
  gatewayProbeCache = { checkedAt: 0, ready: false, pending: null };
}

/** Bounded readiness checks suitable for Docker and monitors. */
export async function readinessReport({ gatewayProbe = cachedSandboxGatewayReady } = {}) {
  const checks = {
    database: false,
    data: accessible(config.dataDir, constants.R_OK | constants.W_OK),
    repositories: accessible(config.reposDir, constants.R_OK | constants.W_OK),
  };

  try {
    checks.database = db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  } catch {
    checks.database = false;
  }

  if (config.deployment === "hosted") {
    checks.kvm = accessible("/dev/kvm", constants.R_OK | constants.W_OK);
    checks.sandboxCredential = Boolean(config.llm.sandboxRuntimeKey);
    checks.sandboxGateway = checks.sandboxCredential && await gatewayProbe();
    checks.oauth = Boolean(
      (config.github.clientId && config.github.clientSecret)
      || (config.gitlab.clientId && config.gitlab.clientSecret),
    );
    checks.billing = billingEnabled;
  }

  return {
    ready: Object.values(checks).every(Boolean),
    revision: config.revision,
    deployment: config.deployment,
    checks,
  };
}

export function versionReport() {
  return { revision: config.revision };
}

/** Public status surface: preserve the readiness signal without topology detail. */
export function publicReadinessReport(report) {
  return { ready: report.ready === true };
}
