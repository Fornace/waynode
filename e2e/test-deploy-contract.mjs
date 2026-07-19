/** Static contract for transactional, revision-verifiable production deploys. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/deploy.yml");
const serverDockerfile = read("Dockerfile");
const sandboxDockerfile = read("sandbox/Dockerfile");
const deploy = read("scripts/deploy-production.sh");
const backup = read("scripts/waynode-backup.sh");
const server = read("server.js");
const compose = read("docker-compose.ffrapposerver.yml");

assert.match(workflow, /find scripts -type f -name '\*\.sh' -exec bash -n/);
assert.match(workflow, /docker compose -f docker-compose\.yml config --quiet/);
assert.match(workflow, /docker compose -f docker-compose\.ffrapposerver\.yml config --quiet/);
assert.match(workflow, /git archive --format=tar\.gz/);
assert.match(workflow, /Reconcile, deploy, and publicly verify transaction/);
assert.match(workflow, /permissions:\s+contents: read/);
assert.doesNotMatch(workflow, /actions\/checkout@v\d/);
assert.doesNotMatch(workflow, /actions\/setup-node@v\d/);

for (const [name, dockerfile] of [
  ["server", serverDockerfile], ["sandbox", sandboxDockerfile],
]) {
  assert.match(dockerfile, /node:26\.0\.0-slim@sha256:[0-9a-f]{64}/, `${name} base is immutable`);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$WAYNODE_REVISION/);
  assert.match(dockerfile, /@earendil-works\/pi-coding-agent@0\.80\.7/);
  assert.match(dockerfile, /pi-codex-goal@0\.1\.36/);
  assert.match(dockerfile, /pi-lean-ctx@3\.9\.9/);
  assert.match(dockerfile, /hammersmith-0\.1\.0\+1fcefd80\.tar\.gz/);
  assert.match(dockerfile, /d4a3fe2c0b9f3758b032cd71784187836ec420bde448ec14d0c4e5289ad75d49/);
  assert.match(dockerfile, /hammersmith --version/);
  assert.match(dockerfile, /--no-build-isolation \/tmp\/hammersmith\.tar\.gz/);
  assert.doesNotMatch(dockerfile, /pip install(?:[^\n]*\s)hammersmith(?:\s|$)/);
  assert.doesNotMatch(dockerfile, /@latest|npm ci \|\||install failed|\|\| true/);
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
