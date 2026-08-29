/** Regression: the runtime agent dir is seeded from the reviewed manifest. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPiComponents } from "../lib/pi-component-seed.mjs";

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
  assert.deepEqual(first.changed.sort(), ["pi-codex-goal@0.2.0", "pi-lean-ctx@3.9.20"]);

  const second = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.deepEqual(second.changed, [], "seeding is idempotent");

  packageDir(agent, "pi-codex-goal", "0.1.36");
  const repaired = seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath });
  assert.deepEqual(repaired.changed, ["pi-codex-goal@0.2.0"], "a stale volume version is repaired");

  writeFileSync(manifestPath, JSON.stringify({
    packages: [{ name: "pi-codex-goal", version: "9.9.9" }],
  }));
  assert.throws(
    () => seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath }),
    /Baked pi-codex-goal is 0\.2\.0, manifest expects 9\.9\.9/,
    "a manifest/baked mismatch fails loudly instead of seeding garbage",
  );

  assert.equal(
    seedPiComponents({ agentDir: agent, bakedDir: baked, manifestPath: join(root, "absent.json") }).seeded,
    false,
    "a missing manifest is reported, not fatal",
  );

  console.log("pi component seeding regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
