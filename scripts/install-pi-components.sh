#!/usr/bin/env bash
set -Eeuo pipefail

manifest=${1:-/tmp/pi-components.json}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$manifest" ]] || { printf 'Missing pi component manifest: %s\n' "$manifest" >&2; exit 64; }
[[ "$(node -p 'process.platform')" == "linux" ]] || {
  printf 'Pi image components must be installed in the target Linux environment.\n' >&2
  exit 64
}

manifest_value() {
  local expression=$1
  MANIFEST_PATH="$manifest" MANIFEST_EXPRESSION="$expression" node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.env.MANIFEST_PATH, "utf8"));
    const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
    if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
    const required = ["pi-codex-goal", "pi-lean-ctx"];
    const names = value.packages.map((entry) => entry.name);
    if (!required.every((name) => names.includes(name))) throw new Error("Required Pi package is missing");
    const asset = value.leanCtx.assets[arch];
    const outputs = {
      pi: [value.pi.package, value.pi.version],
      lean: [value.leanCtx.version, value.leanCtx.releaseTag, asset?.name, asset?.sha256],
    }[process.env.MANIFEST_EXPRESSION];
    if (!outputs || outputs.some((item) => !item || /[\r\n\t]/.test(item))) {
      throw new Error("Invalid pi component manifest");
    }
    console.log(outputs.join("\t"));
  '
}

IFS=$'\t' read -r pi_package pi_version < <(manifest_value pi)
IFS=$'\t' read -r lean_version lean_tag lean_asset lean_sha256 < <(manifest_value lean)

pack_dir=$(mktemp -d /tmp/waynode-pi-package.XXXXXX)
trap 'rm -rf "${pack_dir:-}"' EXIT
pack_json="$pack_dir/pack.json"
npm pack "${pi_package}@${pi_version}" --json --pack-destination "$pack_dir" >"$pack_json"
pi_tarball=$(node "$script_dir/resolve-pi-pack.mjs" "$manifest" "$pack_json" "$pack_dir")
npm install -g --ignore-scripts "$pi_tarball"
rm -rf "$pack_dir"
trap - EXIT
[[ "$(pi --version)" == "$pi_version" ]] || { printf 'pi version mismatch\n' >&2; exit 1; }

pi_root=$(npm root -g)
PI_ROOT="$pi_root" MANIFEST_PATH="$manifest" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const value = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
  const packageDir = path.join(process.env.PI_ROOT, value.pi.package);
  const actual = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"))).version;
  if (actual !== value.pi.version) throw new Error(`Pi expected ${value.pi.version}, got ${actual}`);
'

export npm_config_save_exact=true
while IFS=$'\t' read -r package_name package_version; do
  pi install "npm:${package_name}@${package_version}" --approve < /dev/null
done < <(MANIFEST_PATH="$manifest" node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.env.MANIFEST_PATH, "utf8"));
  for (const entry of value.packages) {
    if (!entry.name || !entry.version || /[\r\n\t]/.test(`${entry.name}${entry.version}`)) {
      throw new Error("Invalid Pi package entry");
    }
    console.log(`${entry.name}\t${entry.version}`);
  }
')

agent_dir=${PI_CODING_AGENT_DIR:-/root/.pi/agent}
PI_AGENT_DIR="$agent_dir" MANIFEST_PATH="$manifest" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const value = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
  const installRoot = path.join(process.env.PI_AGENT_DIR, "npm");
  const root = path.join(installRoot, "node_modules");
  const lock = JSON.parse(fs.readFileSync(path.join(installRoot, "package-lock.json")));
  for (const expected of value.packages) {
    const actual = JSON.parse(fs.readFileSync(path.join(root, expected.name, "package.json"))).version;
    const lockEntry = Object.entries(lock.packages || {}).find(([key, entry]) =>
      (key === `node_modules/${expected.name}` || key.endsWith(`/node_modules/${expected.name}`)) &&
      entry.version === expected.version && entry.integrity === expected.integrity);
    if (actual !== expected.version) throw new Error(`${expected.name}: expected ${expected.version}, got ${actual}`);
    if (!lockEntry) throw new Error(`${expected.name}: package integrity mismatch`);
  }
'

curl -fsSL -o /tmp/lean-ctx.tar.gz \
  "https://github.com/yvgude/lean-ctx/releases/download/${lean_tag}/${lean_asset}"
printf '%s  %s\n' "$lean_sha256" /tmp/lean-ctx.tar.gz | sha256sum -c -
tar xzf /tmp/lean-ctx.tar.gz -C /tmp
install_dir=${LEAN_CTX_INSTALL_DIR:-/usr/local/bin}
install -d "$install_dir"
install -m 0755 /tmp/lean-ctx "$install_dir/lean-ctx"
lean_output=$("$install_dir/lean-ctx" --version)
[[ "$lean_output" =~ lean-ctx[[:space:]]+"$lean_version"([^0-9.]|$) ]] || {
  printf 'lean-ctx version mismatch: %s\n' "$lean_output" >&2
  exit 1
}
rm -f /tmp/lean-ctx.tar.gz /tmp/lean-ctx

printf 'Installed pi %s with %s package(s), lean-ctx %s\n' \
  "$pi_version" "$(MANIFEST_PATH="$manifest" node -p 'JSON.parse(require("node:fs").readFileSync(process.env.MANIFEST_PATH)).packages.length')" \
  "$lean_version"
