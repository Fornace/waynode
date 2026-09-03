/** Hosted readiness must verify the private sandbox LLM route. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-health-"));
const dataDir = join(root, "data");
mkdirSync(join(dataDir, "repos"), { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "health-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LLM_BASE_URL = "10.200.0.1:4000/v1?ignored=true";
process.env.WAYNODE_SANDBOX_LLM_KEY = "present-only-for-readiness-test";

const { config } = await import("../lib/config.mjs");
const {
  cachedSandboxGatewayReady,
  publicReadinessReport,
  readinessReport,
  resetSandboxGatewayReadinessCache,
  sandboxGatewayReadinessUrl,
  sandboxGatewayReady,
} = await import("../lib/health.mjs");

try {
  assert.equal(
    sandboxGatewayReadinessUrl(),
    "http://10.200.0.1:4000/readyz",
    "the readiness probe targets the gateway root instead of its authenticated API prefix",
  );
  assert.equal(
    sandboxGatewayReadinessUrl("https://gateway.example/v1/"),
    "https://gateway.example/readyz",
  );

  let request = null;
  const healthy = await sandboxGatewayReady({
    baseUrl: "http://private-gateway:4000/v1",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ status: "ok" }) };
    },
  });
  assert.equal(healthy, true);
  assert.equal(request.url, "http://private-gateway:4000/readyz");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.accept, "application/json");
  assert.ok(request.options.signal instanceof AbortSignal, "gateway request has a bounded timeout signal");

  for (const response of [
    { ok: false, json: async () => ({ status: "ok" }) },
    { ok: true, json: async () => ({ status: "starting" }) },
    { ok: true, json: async () => { throw new SyntaxError("bad JSON"); } },
  ]) {
    assert.equal(await sandboxGatewayReady({ fetchImpl: async () => response }), false);
  }
  assert.equal(
    await sandboxGatewayReady({ fetchImpl: async () => { throw new Error("unreachable"); } }),
    false,
    "transport failures fail closed",
  );

  resetSandboxGatewayReadinessCache();
  let cacheProbeCount = 0;
  let resolveProbe;
  const pendingProbe = new Promise((resolve) => { resolveProbe = resolve; });
  const cacheOptions = {
    now: () => 10_000,
    gatewayProbe: async () => { cacheProbeCount += 1; return pendingProbe; },
  };
  const firstCached = cachedSandboxGatewayReady(cacheOptions);
  const secondCached = cachedSandboxGatewayReady(cacheOptions);
  assert.equal(cacheProbeCount, 1, "concurrent readiness requests share one gateway probe");
  resolveProbe(true);
  assert.equal(await firstCached, true);
  assert.equal(await secondCached, true);
  assert.equal(await cachedSandboxGatewayReady({ ...cacheOptions, now: () => 14_999 }), true);
  assert.equal(cacheProbeCount, 1, "fresh route results are reused");
  assert.equal(await cachedSandboxGatewayReady({
    now: () => 15_000,
    gatewayProbe: async () => { cacheProbeCount += 1; return false; },
  }), false);
  assert.equal(cacheProbeCount, 2, "route results expire after five seconds");

  config.deployment = "self-hosted";
  let selfHostedProbeCount = 0;
  const selfHosted = await readinessReport({
    gatewayProbe: async () => { selfHostedProbeCount += 1; return false; },
  });
  assert.equal(selfHostedProbeCount, 0, "self-hosted readiness has no hosted gateway dependency");
  assert.equal(selfHosted.ready, true);
  assert.deepEqual(publicReadinessReport(selfHosted), { ready: true });

  config.deployment = "hosted";
  const failed = await readinessReport({ gatewayProbe: async () => false });
  assert.equal(failed.checks.sandboxCredential, true);
  assert.equal(failed.checks.sandboxGateway, false);
  assert.equal(failed.ready, false, "a present credential cannot mask an unreachable private route");

  console.log("hosted readiness: private gateway route and failure behavior passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
