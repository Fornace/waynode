/**
 * Seed DATA_DIR/pi-agent with the exact, verified Pi components from the
 * reviewed manifest so self-host RPC sessions use the same pinned packages
 * the images bake for hosted microVMs. Runs at server startup; copies are
 * idempotent and content-verified, so a stale or partially written volume
 * repairs itself on every boot.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { piAgentDir } from "./pi-config.mjs";

function manifestPackages(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.packages.map((entry) => ({ name: entry.name, version: entry.version }));
}

function installedVersion(agentDir, name) {
  const packageJson = join(agentDir, "npm", "node_modules", name, "package.json");
  if (!existsSync(packageJson)) return null;
  try {
    return JSON.parse(readFileSync(packageJson, "utf8")).version;
  } catch {
    return null;
  }
}

/** Copy each manifest package into the runtime agent dir when missing or wrong. */
export function seedPiComponents({
  agentDir = piAgentDir(),
  bakedDir = "/root/.pi/agent",
  manifestPath = join(bakedDir, "pi-components.json"),
} = {}) {
  if (!existsSync(manifestPath)) return { seeded: false, reason: "manifest absent" };
  const packages = manifestPackages(manifestPath);
  mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
  const changed = [];
  for (const entry of packages) {
    if (installedVersion(agentDir, entry.name) === entry.version) continue;
    const source = join(bakedDir, "npm", "node_modules", entry.name);
    const expected = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    if (expected !== entry.version) throw new Error(`Baked ${entry.name} is ${expected}, manifest expects ${entry.version}`);
    cpSync(source, join(agentDir, "npm", "node_modules", entry.name), { recursive: true });
    const seeded = installedVersion(agentDir, entry.name);
    if (seeded !== entry.version) throw new Error(`Seed verification failed for ${entry.name}: ${seeded}`);
    changed.push(`${entry.name}@${entry.version}`);
  }
  return { seeded: true, changed };
}
