/**
 * Seed DATA_DIR/pi-agent with the exact, verified Pi components from the
 * reviewed manifest so self-host RPC sessions use the same pinned packages
 * the images bake for hosted microVMs. Runs at server startup; copies are
 * idempotent and content-verified, so a stale or partially written volume
 * repairs itself on every boot.
 */
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, renameSync, rmSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { piAgentDir } from "./pi-config.mjs";

function manifestError(detail) {
  return new Error(`Invalid Pi component manifest: ${detail}`);
}

function manifestPackages(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw manifestError(`cannot parse ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw manifestError("root must be an object");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw manifestError("packages must be a non-empty array");
  }
  const names = new Set();
  return manifest.packages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw manifestError(`packages[${index}] must be an object`);
    }
    const { name, version } = entry;
    if (typeof name !== "string" || !name.trim() || typeof version !== "string" || !version.trim()) {
      throw manifestError(`packages[${index}] requires non-empty name and version strings`);
    }
    if (names.has(name)) throw manifestError(`duplicate package ${name}`);
    names.add(name);
    return { name, version };
  });
}

function directoryDigest(root) {
  if (!existsSync(root)) return null;
  const hash = createHash("sha256");
  const visit = (path) => {
    const stat = lstatSync(path);
    const name = relative(root, path) || ".";
    if (stat.isDirectory()) {
      hash.update(`d\0${name}\0`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isSymbolicLink()) {
      hash.update(`l\0${name}\0${readlinkSync(path)}\0`);
    } else if (stat.isFile()) {
      const executable = stat.mode & 0o111 ? 1 : 0;
      hash.update(`f\0${name}\0${executable}\0${stat.size}\0`);
      hash.update(readFileSync(path));
    } else {
      throw new Error(`Unsupported package entry: ${path}`);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function replacePackage(source, destination, expectedDigest) {
  mkdirSync(dirname(destination), { recursive: true });
  const tempRoot = mkdtempSync(join(dirname(destination), `.${basename(destination)}.seed-`));
  const staged = join(tempRoot, "package");
  try {
    cpSync(source, staged, { recursive: true });
    if (directoryDigest(staged) !== expectedDigest) {
      throw new Error(`Seed staging verification failed for ${basename(destination)}`);
    }
    rmSync(destination, { recursive: true, force: true });
    renameSync(staged, destination);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
  manifestPath = process.env.PI_COMPONENT_MANIFEST,
  required = process.env.PI_COMPONENTS_REQUIRED === "1",
} = {}) {
  const sourceDir = bakedDir || "/root/.pi/agent";
  const sourceManifest = manifestPath || join(sourceDir, "pi-components.json");
  if (!existsSync(sourceManifest)) {
    if (required) throw new Error(`Pi component manifest is required but absent: ${sourceManifest}`);
    return { status: "skipped", seeded: false, changed: [], reason: "manifest absent" };
  }
  const packages = manifestPackages(sourceManifest);
  mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
  const changed = [];
  for (const entry of packages) {
    const source = join(sourceDir, "npm", "node_modules", entry.name);
    if (!existsSync(source)) throw new Error(`Baked package missing: ${entry.name}`);
    let expected;
    try {
      expected = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    } catch (error) {
      throw new Error(`Baked ${entry.name} package metadata is invalid: ${error.message}`);
    }
    if (expected !== entry.version) throw new Error(`Baked ${entry.name} is ${expected}, manifest expects ${entry.version}`);
    const expectedDigest = directoryDigest(source);
    const destination = join(agentDir, "npm", "node_modules", entry.name);
    if (installedVersion(agentDir, entry.name) === entry.version
        && directoryDigest(destination) === expectedDigest) continue;
    replacePackage(source, destination, expectedDigest);
    const seeded = installedVersion(agentDir, entry.name);
    if (seeded !== entry.version || directoryDigest(destination) !== expectedDigest) {
      throw new Error(`Seed verification failed for ${entry.name}: ${seeded}`);
    }
    changed.push(`${entry.name}@${entry.version}`);
  }
  return { status: "seeded", seeded: true, changed };
}
