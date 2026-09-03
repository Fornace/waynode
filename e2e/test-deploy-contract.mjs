/** Static contract for transactional, revision-verifiable production deploys. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/deploy.yml");
const serverDockerfile = read("Dockerfile");
const sandboxDockerfile = read("sandbox/Dockerfile");
const componentManifest = JSON.parse(read("config/pi-components.json"));
const deploy = read(".github/deploy/deploy-production.sh");
const tls = read(".github/deploy/reconcile-tls.sh");
const nginx = read(".github/deploy/waynode.nginx.conf");
const backup = read("scripts/waynode-backup.sh");
const server = read("server.js");
const compose = read("docker-compose.ffrapposerver.yml");

// CI is the ONLY deploy path. The manual script was deleted for good after
// the 2026-07-23 bypass incident; it must never come back, and the CI copy
// must refuse to run outside the workflow.
assert.equal(
  existsSync(new URL("../scripts/deploy-production.sh", import.meta.url)),
  false,
  "the manually runnable deploy script must stay deleted — deploys go through CI only",
);
assert.match(deploy, /WAYNODE_CI_DEPLOY[^\n]*!= "1"/, "deploy script must gate on the CI-only flag");
assert.match(deploy, /manual invocation is not supported/i);
assert.match(workflow, /WAYNODE_CI_DEPLOY=1/, "workflow must set the CI-only flag");
assert.match(workflow, /\.github\/deploy\/deploy-production\.sh/, "workflow must call the CI-owned script");
assert.match(deploy, /\.github\/deploy\/reconcile-tls\.sh/, "deploy must reconcile TLS from verified source");

assert.match(tls, /WAYNODE_CI_DEPLOY[^\n]*== 1/, "TLS changes must stay CI-only");
assert.match(tls, /waynode\.fornace\.net-managed/);
assert.match(tls, /--webroot-path "\$webroot"/);
assert.match(tls, /--cert-name "\$cert_name"/);
assert.match(tls, /certbot renew --cert-name "\$cert_name" --dry-run/);
assert.match(tls, /Public ACME webroot preflight/);
assert.match(tls, /public_fingerprint == "\$local_fingerprint"/);
assert.match(tls, /for _attempt in \{1\.\.20\}/, "Nginx certificate handoff must be bounded and retried");
assert.match(tls, /rollback/);
assert.match(tls, /--connect-timeout 5 --max-time 15/);
assert.match(nginx, /live\/waynode\.fornace\.net-managed\/fullchain\.pem/);
assert.match(nginx, /live\/waynode\.fornace\.net-managed\/privkey\.pem/);

assert.match(workflow, /find scripts \.github\/deploy -type f -name '\*\.sh' -exec bash -n/);
assert.match(workflow, /docker compose -f docker-compose\.yml config --quiet/);
assert.match(workflow, /docker compose -f docker-compose\.ffrapposerver\.yml config --quiet/);
assert.match(workflow, /git archive --format=tar\.gz/);
assert.match(workflow, /docker build --build-arg "WAYNODE_REVISION=\$\{GITHUB_SHA\}" -t waynode-ci/,
  "every main deployment must build the server image before touching production");
assert.match(workflow, /docker build --file sandbox\/Dockerfile[\s\S]*--tag waynode-sandbox-ci/,
  "every main deployment must build the sandbox image before touching production");
assert.match(workflow, /for image in waynode-ci waynode-sandbox-ci/);
assert.match(workflow, /smoke-pi-components\.mjs \/tmp\/pi-components\.json/);
assert.match(workflow, /waynode-sandbox-ci[\s\S]*check-sandbox-image\.mjs \/root\/\.pi\/agent\/models\.json/);
assert.match(workflow, /Reconcile, deploy, and publicly verify transaction/);
assert.match(workflow, /permissions:\s+contents: read/);
assert.doesNotMatch(workflow, /actions\/checkout@v\d/);
assert.doesNotMatch(workflow, /actions\/setup-node@v\d/);

for (const [name, dockerfile] of [
  ["server", serverDockerfile], ["sandbox", sandboxDockerfile],
]) {
  assert.match(dockerfile, /node:26\.0\.0-slim@sha256:[0-9a-f]{64}/, `${name} base is immutable`);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$WAYNODE_REVISION/);
  const sharedPins = name === "server"
    ? /COPY config\/pi-components\.json \/root\/\.pi\/agent\/pi-components\.json/
    : /COPY config\/pi-components\.json \/tmp\/pi-components\.json/;
  assert.match(dockerfile, sharedPins);
  assert.match(dockerfile, /COPY scripts\/install-pi-components\.sh \/tmp\/install-pi-components\.sh/);
  assert.match(dockerfile, /bash \/tmp\/install-pi-components\.sh .*pi-components\.json/);
  assert.match(dockerfile, /hammersmith-0\.1\.0\+86a8308d\.tar\.gz/);
  assert.match(dockerfile, /1a8f44f26bf9d7cce0b7191c74fbfe8f2c3a96f7c01c0826c3ffba34964242c1/);
  assert.match(dockerfile, /hammersmith --version/);
  assert.match(dockerfile, /--no-build-isolation \/tmp\/hammersmith\.tar\.gz/);
  assert.doesNotMatch(dockerfile, /pip install(?:[^\n]*\s)hammersmith(?:\s|$)/);
  assert.doesNotMatch(dockerfile, /@latest|npm ci \|\||install failed|\|\| true/);
}

assert.equal(componentManifest.schemaVersion, 1);
assert.match(componentManifest.pi.version, /^\d+\.\d+\.\d+$/);
assert.equal(new Set(componentManifest.packages.map((entry) => entry.name)).size, componentManifest.packages.length);
for (const required of ["pi-codex-goal", "pi-lean-ctx"]) {
  assert.ok(componentManifest.packages.some((entry) => entry.name === required), `${required} stays pinned`);
}

assert.doesNotMatch(
  serverDockerfile,
  /npx\s+--no-install\s+microsandbox\s+install/,
  "the microsandbox CLI install command expects an OCI image, not runtime setup",
);
assert.match(
  serverDockerfile,
  /import \{ install, isInstalled \} from 'microsandbox'/,
  "the runtime must be installed and verified through the microsandbox SDK",
);

assert.match(deploy, /Unreconciled production source changes found/);
assert.match(deploy, /Interrupted source-only deployment detected/, "source-only cancellation is reconciled");
assert.match(deploy, /trap 'rollback 130' HUP INT TERM/, "SSH cancellation must invoke rollback");
assert.match(deploy, /waynode-backup\.sh" restore-offline/);
assert.match(deploy, /api\/health\/version/);
assert.match(deploy, /\$public_url\/api\/health\/ready/);
assert.match(deploy, /Running container has the wrong revision label/);
assert.match(deploy, /Waynode is stopped; recovery set:/);
assert.match(deploy, /The previous server image could not be resolved/);
assert.match(deploy, /The previous sandbox image could not be resolved/);
assert.match(deploy, /capture_backup_timer_state/);
assert.match(deploy, /capture_backup_timer_state\s+backup_timer_changed=1\s+quiesce_backup_timer/);
assert.match(deploy, /restore_backup_timer_state \|\| rollback_failed=1/);
assert.match(deploy, /launch_revision "\$previous_revision" \|\| rollback_failed=1/,
  "rollback must launch and verify the restored image with its exact prior revision");
assert.match(deploy, /if \[\[ -n "\$previous_revision" \]\]; then\s+launch_revision "\$previous_revision" \|\| rollback_failed=1\s+else\s+unset WAYNODE_REVISION/,
  "only an unversioned legacy rollback may use the Compose fallback");
assert.match(deploy, /prepare_deploy_storage\s+install -d -m 700 "\$transaction_dir"\s+capture_backup_timer_state/,
  "host storage must be checked before recovery-set creation, backup, and image builds");
assert.match(deploy, /docker builder prune -af --min-free-space "\$DEPLOY_MIN_FREE_BYTES"/);
assert.match(deploy, /Deployment requires \$DEPLOY_MIN_FREE_BYTES free bytes/);
assert.match(deploy, /waynode-rollback:\*\|waynode-sandbox:rollback-\*/);
assert.doesNotMatch(deploy, /docker image prune -af/,
  "deployment cleanup must preserve unused but active microsandbox image tags");
assert.match(deploy, /prune_successful_recovery_sets/);
assert.match(deploy, /-name SUCCEEDED/);
assert.match(deploy, /--connect-timeout 5 --max-time 15/);
assert.equal(
  deploy.match(/\bcurl --fail/g)?.length,
  deploy.match(/--connect-timeout 5 --max-time 15/g)?.length,
  "every deployment curl must have bounded connect and response timeouts",
);
assert.match(backup, /restore-offline/);
assert.match(backup, /TimeoutStartSec=2h/);
assert.match(backup, /restic forget --tag waynode --group-by host,tags/);
assert.match(backup, /--keep-daily "\$RESTIC_KEEP_DAILY"/);
assert.match(compose, /WAYNODE_REVISION=\$\{WAYNODE_REVISION:-development\}/);
assert.match(server, /api\/health\/version/);

console.log("deploy contract: validation, provenance, public gate, and matching rollback are wired");
