#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repoRoot, "config/pi-components.json");
const docsPath = resolve(repoRoot, "docs/PI-COMPONENT-UPDATES.md");
const current = JSON.parse(readFileSync(manifestPath, "utf8"));
const root = mkdtempSync(join(tmpdir(), "waynode-pi-update-"));
const prefix = join(root, "npm-global");
const agentDir = join(root, "agent");
const binDir = join(prefix, "bin");
const env = {
  PATH: `${binDir}:${process.env.PATH || ""}`,
  HOME: process.env.HOME,
  npm_config_prefix: prefix,
  PI_CODING_AGENT_DIR: agentDir,
};

function run(command, args, options = {}) {
  console.log(`+ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  })?.trim();
}

function packageVersion(name) {
  const packagePath = join(agentDir, "npm", "node_modules", name, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function npmField(spec, field) {
  const value = run("npm", ["view", spec, field, "--json"], { capture: true }).replace(/^"|"$/g, "");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Invalid ${field} for ${spec}: ${value.slice(0, 24) || "empty"}`);
  }
  return value;
}

async function leanRelease(version) {
  const url = `https://api.github.com/repos/yvgude/lean-ctx/releases/tags/v${version}`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "waynode-pi-updater" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Lean-ctx release lookup failed: HTTP ${response.status}`);
  const release = await response.json();
  const assets = Object.fromEntries(release.assets.map((asset) => [asset.name, asset]));
  const readAsset = (name) => {
    const asset = assets[name];
    const digest = asset?.digest;
    if (!digest?.startsWith("sha256:")) throw new Error(`Missing SHA-256 digest for ${name}`);
    return { name, sha256: digest.slice("sha256:".length) };
  };
  return {
    version,
    releaseTag: release.tag_name,
    assets: {
      x86_64: readAsset("lean-ctx-x86_64-unknown-linux-musl.tar.gz"),
      aarch64: readAsset("lean-ctx-aarch64-unknown-linux-musl.tar.gz"),
    },
  };
}

function syncDocumentation(next) {
  let docs = readFileSync(docsPath, "utf8");
  const currentGoal = current.packages.find((item) => item.name === "pi-codex-goal").version;
  const currentLean = current.packages.find((item) => item.name === "pi-lean-ctx").version;
  const nextGoal = next.packages.find((item) => item.name === "pi-codex-goal").version;
  const nextLean = next.packages.find((item) => item.name === "pi-lean-ctx").version;
  const replace = (before, after) => {
    if (before === after) return;
    if (!docs.includes(before)) throw new Error(`Documentation marker missing: ${before}`);
    docs = docs.replace(before, after);
  };
  replace(`Reviewed: ${current.reviewedAt}`, `Reviewed: ${next.reviewedAt}`);
  replace(`- \`${current.pi.package}\` ${current.pi.version}`, `- \`${next.pi.package}\` ${next.pi.version}`);
  replace(`- \`pi-codex-goal\` ${currentGoal}`, `- \`pi-codex-goal\` ${nextGoal}`);
  replace(`- \`pi-lean-ctx\` ${currentLean}`, `- \`pi-lean-ctx\` ${nextLean}`);
  replace(`- standalone \`lean-ctx\` ${current.leanCtx.version}`, `- standalone \`lean-ctx\` ${next.leanCtx.version}`);
  replace(`Sources reviewed on ${current.reviewedAt}:`, `Sources reviewed on ${next.reviewedAt}:`);
  replace(`- lean-ctx ${current.leanCtx.version} release assets:`, `- lean-ctx ${next.leanCtx.version} release assets:`);
  replace(`releases/tag/${current.leanCtx.releaseTag}>`, `releases/tag/${next.leanCtx.releaseTag}>`);
  writeFileSync(docsPath, docs);
}

function writeOutput(changed, next) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, [
    `changed=${changed}`,
    `pi_version=${next.pi.version}`,
    `goal_version=${next.packages.find((item) => item.name === "pi-codex-goal").version}`,
    `lean_version=${next.packages.find((item) => item.name === "pi-lean-ctx").version}`,
    "",
  ].join("\n"));
}

try {
  run("npm", ["install", "-g", `${current.pi.package}@${current.pi.version}`]);
  for (const item of current.packages) {
    run("pi", ["install", `npm:${item.name}@${item.version}`, "--approve"]);
  }

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.packages = current.packages.map((item) => `npm:${item.name}`);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  // Exercise pi's supported update paths in an isolated global npm prefix.
  run("pi", ["update", "--approve"]);
  run("pi", ["update", "--extensions", "--approve"]);

  const piVersion = run("pi", ["--version"], { capture: true });
  const packages = current.packages.map((item) => ({
    name: item.name,
    version: packageVersion(item.name),
  }));
  const leanExtension = packages.find((item) => item.name === "pi-lean-ctx");
  if (!leanExtension) throw new Error("pi-lean-ctx must remain in the component manifest");

  const nextCore = {
    schemaVersion: current.schemaVersion,
    pi: {
      package: current.pi.package,
      version: piVersion,
      integrity: npmField(`${current.pi.package}@${piVersion}`, "dist.integrity"),
    },
    packages: packages.map((item) => ({
      ...item,
      integrity: npmField(`${item.name}@${item.version}`, "dist.integrity"),
    })),
    leanCtx: await leanRelease(leanExtension.version),
  };
  const currentCore = {
    schemaVersion: current.schemaVersion,
    pi: current.pi,
    packages: current.packages,
    leanCtx: current.leanCtx,
  };
  const changed = JSON.stringify(nextCore) !== JSON.stringify(currentCore);
  const next = { ...nextCore, reviewedAt: changed ? new Date().toISOString().slice(0, 10) : current.reviewedAt };
  // Keep the human-facing date next to the schema header.
  const ordered = {
    schemaVersion: next.schemaVersion,
    reviewedAt: next.reviewedAt,
    pi: next.pi,
    packages: next.packages,
    leanCtx: next.leanCtx,
  };
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(ordered, null, 2)}\n`);
    syncDocumentation(ordered);
  }
  writeOutput(changed, ordered);
  console.log(changed
    ? `Updated pi component pins: pi ${piVersion}, ${packages.map((item) => `${item.name} ${item.version}`).join(", ")}`
    : "Pi component pins are already current.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
