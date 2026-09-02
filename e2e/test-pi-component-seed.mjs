/** Regression: the runtime agent dir is seeded from the reviewed manifest. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load a copy of the seeder with a stubbed config module so this test runs
// in CI without a .env (config.mjs throws at import time without secrets).
const stubRoot = mkdtempSync(join(tmpdir(), "waynode-pi-seed-stub-"));
process.on("exit", () => rmSync(stubRoot, { recursive: true, force: true }));
mkdirSync(join(stubRoot, "lib"), { recursive: true });
writeFileSync(join(stubRoot, "lib", "pi-config.mjs"),
  'export function piAgentDir() { return "/tmp/agent"; }\n');
writeFileSync(join(stubRoot, "lib", "pi-component-seed.mjs"),
  readFileSync(new URL("../lib/pi-component-seed.mjs", import.meta.url), "utf8"));
const { seedPiComponents } = await import(pathToFileURL(join(stubRoot, "lib", "pi-component-seed.mjs")));

const root = mkdtempSync(join(tmpdir(), "waynode-pi-seed-"));

function packageDir(target, name, version) {
  const dir = join(target, "npm", "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

try {
  const baked = join(root, "baked");
  const agent = join(root, "agent");
  packageDir(baked, "pi-codex-goal", "0.2.0");
  packageDir(baked, "pi-lean-ctx", "3.9.20");
  const manifestPath = join(baked, "pi-components.json");
  writeFileSync(manifestPath, JSON.stringify({
    packages: [
      { name: "pi-codex-goal", version: "0.2.0" },
      { name: "pi-lean-ctx", version: "3.9.20" },
    ],
  }));

  const first = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.equal(first.status, "seeded");
  assert.deepEqual(first.changed.sort(), ["pi-codex-goal@0.2.0", "pi-lean-ctx@3.9.20"]);

  const second = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.deepEqual(second.changed, [], "seeding is idempotent");

  packageDir(agent, "pi-codex-goal", "0.1.36");
  const repaired = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.deepEqual(repaired.changed, ["pi-codex-goal@0.2.0"], "a stale volume version is repaired");

  writeFileSync(join(agent, "npm", "node_modules", "pi-lean-ctx", "tampered.js"), "unreviewed");
  const repairedTamper = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.deepEqual(repairedTamper.changed, ["pi-lean-ctx@3.9.20"],
    "same-version content drift is repaired from reviewed image bytes");
  assert.equal(
    readFileSync(join(agent, "npm", "node_modules", "pi-lean-ctx", "package.json"), "utf8"),
    readFileSync(join(baked, "npm", "node_modules", "pi-lean-ctx", "package.json"), "utf8"),
  );
  assert.equal(existsSync(join(agent, "npm", "node_modules", "pi-lean-ctx", "tampered.js")), false,
    "replacement removes unreviewed same-version files");

  writeFileSync(manifestPath, JSON.stringify({
    packages: [{ name: "pi-codex-goal", version: "9.9.9" }],
  }));
  assert.throws(
    () => seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath }),
    /Baked pi-codex-goal is 0\.2\.0, manifest expects 9\.9\.9/,
    "a manifest/baked mismatch fails loudly instead of seeding garbage",
  );

  const absent = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath: join(root, "absent.json") });
  assert.deepEqual(absent, {
    status: "skipped", seeded: false, changed: [], reason: "manifest absent",
  }, "an intentionally absent manifest has a stable, safe result shape");

  const invalidManifests = [
    ["malformed JSON", "{", /Invalid Pi component manifest: cannot parse/],
    ["missing packages", JSON.stringify({ schemaVersion: 1 }), /packages must be a non-empty array/],
    ["empty packages", JSON.stringify({ packages: [] }), /packages must be a non-empty array/],
    ["invalid package", JSON.stringify({ packages: [{ name: "pi-codex-goal" }] }), /requires non-empty name and version strings/],
    ["duplicate package", JSON.stringify({ packages: [
      { name: "pi-codex-goal", version: "0.2.0" },
      { name: "pi-codex-goal", version: "0.2.0" },
    ] }), /duplicate package pi-codex-goal/],
  ];
  for (const [name, contents, expected] of invalidManifests) {
    writeFileSync(manifestPath, contents);
    assert.throws(
      () => seedPiComponents({ agentDir: join(root, `invalid-${name}`), bakedDir: baked, manifestPath }),
      expected,
      `${name} fails closed`,
    );
  }

  rmSync(join(baked, "npm", "node_modules", "pi-codex-goal"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    packages: [{ name: "pi-codex-goal", version: "0.2.0" }],
  }));
  assert.throws(
    () => seedPiComponents({ agentDir: join(root, "missing-baked"), bakedDir: baked, manifestPath }),
    /Baked package missing: pi-codex-goal/,
    "missing baked bytes fail closed",
  );

  const malformedStartupRoot = join(root, "startup-malformed");
  mkdirSync(join(malformedStartupRoot, "pi-agent"), { recursive: true });
  writeFileSync(join(malformedStartupRoot, "pi-agent", "pi-components.json"), "{");
  const malformedStartup = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        DATA_DIR: malformedStartupRoot,
        SESSION_SECRET: "pi-seed-startup-regression",
        ENCRYPTION_KEY: "0".repeat(64),
        PI_COMPONENT_MANIFEST: join(malformedStartupRoot, "pi-agent", "pi-components.json"),
        PI_COMPONENTS_REQUIRED: "1",
        NODE_ENV: "test",
      },
      encoding: "utf8",
      timeout: 8_000,
    },
  );
  assert.notEqual(malformedStartup.status, 0, "server startup fails closed on a malformed image manifest");
  assert.match(`${malformedStartup.stdout}${malformedStartup.stderr}`, /Invalid Pi component manifest: cannot parse/);

  const startupRoot = join(root, "startup");
  const startup = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: {
      ...process.env,
      DATA_DIR: startupRoot,
      PORT: "0",
      SESSION_SECRET: "pi-seed-startup-regression",
      ENCRYPTION_KEY: "0".repeat(64),
      PI_COMPONENT_MANIFEST: join(startupRoot, "absent.json"),
      PI_COMPONENTS_REQUIRED: "0",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupOutput = "";
  startup.stdout.on("data", (chunk) => { startupOutput += chunk; });
  startup.stderr.on("data", (chunk) => { startupOutput += chunk; });
  await Promise.race([
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server startup timed out:\n${startupOutput}`)), 8_000);
      startup.stdout.on("data", () => {
        if (!startupOutput.includes("Waynode listening on")) return;
        clearTimeout(timer);
        resolve();
      });
      startup.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code}:\n${startupOutput}`));
      });
    }),
  ]).finally(() => startup.kill("SIGKILL"));
  await new Promise((resolve) => startup.once("exit", resolve));
  assert.match(startupOutput, /\[pi-components\] skipped: manifest absent/);
  assert.doesNotMatch(startupOutput, /seeding failed|Cannot read properties of undefined/,
    "the real startup path handles an absent image manifest without an exception");

  console.log("pi component seeding and startup regressions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
