/** Static contract for safe, reproducible Pi component automation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("config/pi-components.json"));
const updater = read("scripts/update-pi-components.mjs");
const installer = read("scripts/install-pi-components.sh");
const workflow = read(".github/workflows/update-pi-components.yml");

assert.equal(manifest.schemaVersion, 1);
assert.match(manifest.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(manifest.pi.package, "@earendil-works/pi-coding-agent");
assert.match(manifest.pi.version, /^\d+\.\d+\.\d+$/);
assert.match(manifest.pi.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
assert.ok(manifest.packages.length >= 2);
for (const entry of manifest.packages) {
  assert.match(entry.name, /^[a-z0-9@/._-]+$/);
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
}
assert.equal(manifest.leanCtx.version, manifest.packages.find((entry) => entry.name === "pi-lean-ctx").version);
for (const arch of ["x86_64", "aarch64"]) {
  assert.match(manifest.leanCtx.assets[arch].sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.leanCtx.assets[arch].name, /unknown-linux-musl\.tar\.gz$/);
}

assert.match(installer, /npm pack "\$\{pi_package\}@\$\{pi_version\}" --json/);
assert.match(installer, /packed\.integrity !== value\.pi\.integrity/);
assert.match(installer, /npm install -g --ignore-scripts "\$pi_tarball"/);
assert.match(installer, /pi install "npm:\$\{package_name\}@\$\{package_version\}" --approve < \/dev\/null/);
assert.match(installer, /lean-ctx\[\[:space:\]\]\+"\$lean_version"/);
assert.match(installer, /sha256sum -c -/);
assert.match(installer, /PI_AGENT_DIR=.*MANIFEST_PATH=.*node -e/);
assert.doesNotMatch(installer, /@latest|\|\| true/);

assert.match(updater, /run\("pi", \["update", "--approve"\]\)/);
assert.match(updater, /run\("pi", \["update", "--extensions", "--approve"\]\)/);
assert.match(updater, /sha512-\[A-Za-z0-9\+\/]\+\=\{0,2\}\$\/\.test\(value\)/);
assert.match(updater, /npmField\(`\$\{current\.pi\.package\}@\$\{piVersion\}`, "dist\.integrity"\)/);
assert.match(updater, /api\.github\.com\/repos\/yvgude\/lean-ctx\/releases\/tags/);
assert.match(updater, /AbortSignal\.timeout\(20_000\)/);

assert.match(workflow, /cron: "17 6 \* \* \*"/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /PI_UPDATE_TOKEN/);
assert.match(workflow, /node scripts\/update-pi-components\.mjs/);
assert.match(workflow, /npm test/);
assert.match(workflow, /npm run build:frontend/);
assert.match(workflow, /bash scripts\/install-pi-components\.sh config\/pi-components\.json/);
assert.match(workflow, /docker build --build-arg "WAYNODE_REVISION=\$\{GITHUB_SHA\}"/);
assert.match(workflow, /docker build --file sandbox\/Dockerfile/);
assert.match(workflow, /permissions: \{\}/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /gh pr merge "\$pr" --squash --delete-branch/);
assert.match(workflow, /sha256sum -c -/);
assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ secrets\.PI_UPDATE_TOKEN \}\}\n\s+steps:/);
assert.doesNotMatch(workflow, /pull_request_target|@latest/);

console.log("pi component automation: update, integrity, test, image, and merge gates are wired");
