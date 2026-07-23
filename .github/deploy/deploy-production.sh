#!/usr/bin/env bash
set -Eeuo pipefail

# ── CI-only entry point ─────────────────────────────────────────────────────
# Production deploys run EXCLUSIVELY from .github/workflows/deploy.yml
# (push to main). There is no manual path: hand-run deploys are how the
# 2026-07-23 incident happened (container updated without the sandbox-image
# msb reload, bricking every hosted turn). The workflow sets
# WAYNODE_CI_DEPLOY=1; nothing else may.
if [[ "${WAYNODE_CI_DEPLOY:-}" != "1" ]]; then
  printf 'FATAL: production deploys run only via the Deploy GitHub Actions workflow (push to main).\n' >&2
  printf 'See .github/workflows/deploy.yml — manual invocation is not supported.\n' >&2
  exit 64
fi

LIVE_DIR=${LIVE_DIR:-/opt/waynode}
STAGED_SOURCE_DIR=${STAGED_SOURCE_DIR:?Set STAGED_SOURCE_DIR to the extracted release source}
STAGED_ROOT=${STAGED_ROOT:-$(dirname "$STAGED_SOURCE_DIR")}
DEPLOY_SHA=${DEPLOY_SHA:?Set DEPLOY_SHA to the exact Git commit}
DEPLOY_ID=${DEPLOY_ID:?Set DEPLOY_ID to a unique workflow run id}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/waynode/deployments}
COMPOSE_NAME=${COMPOSE_NAME:-docker-compose.ffrapposerver.yml}
ALLOW_LEGACY_SOURCE=${ALLOW_LEGACY_SOURCE:-0}
DEPLOYMENT_RETENTION_DAYS=${DEPLOYMENT_RETENTION_DAYS:-30}

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; false; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }

case "$DEPLOY_SHA" in *[!0-9a-f]*|'') die "DEPLOY_SHA must be lowercase hexadecimal." ;; esac
[[ ${#DEPLOY_SHA} == 40 ]] || die "DEPLOY_SHA must contain 40 characters."
case "$DEPLOY_ID" in *[!a-zA-Z0-9._-]*|'') die "DEPLOY_ID contains unsupported characters." ;; esac
case "$DEPLOYMENT_RETENTION_DAYS" in
  *[!0-9]*|'') die "DEPLOYMENT_RETENTION_DAYS must be a non-negative integer." ;;
esac
[[ -d "$LIVE_DIR" && -f "$LIVE_DIR/.env" ]] || die "Live Waynode source and .env are required."
[[ -d "$STAGED_SOURCE_DIR" && -f "$STAGED_SOURCE_DIR/$COMPOSE_NAME" ]] \
  || die "The staged release is incomplete."
for command in docker rsync sha256sum tar curl node systemctl; do need "$command"; done

transaction_dir="$BACKUP_ROOT/$DEPLOY_SHA-$DEPLOY_ID"
[[ ! -e "$transaction_dir" ]] || die "Deployment transaction already exists: $transaction_dir"
install -d -m 700 "$transaction_dir"

compose() {
  docker compose --project-directory "$LIVE_DIR" -f "$LIVE_DIR/$COMPOSE_NAME" "$@"
}

source_digest() {
  local directory=$1
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    --exclude='./.env' --exclude='./data' --exclude='./node_modules' \
    --exclude='./frontend/node_modules' --exclude='./frontend/dist' \
    --exclude='./.waynode-revision' --exclude='./.waynode-source.sha256' \
    -cf - -C "$directory" . | sha256sum | cut -d' ' -f1
}

archive_live_source() {
  tar --exclude='./.env' --exclude='./data' --exclude='./node_modules' \
    --exclude='./frontend/node_modules' --exclude='./frontend/dist' \
    --exclude='./.waynode-revision' --exclude='./.waynode-source.sha256' \
    -czf "$transaction_dir/source.tar.gz" -C "$LIVE_DIR" .
  sha256sum "$transaction_dir/source.tar.gz" >"$transaction_dir/source.sha256"
}

restore_live_source() {
  local restore_dir
  restore_dir=$(mktemp -d /tmp/waynode-source-restore.XXXXXX)
  tar -xzf "$transaction_dir/source.tar.gz" -C "$restore_dir" || return 1
  rsync -a --delete --exclude='.env' "$restore_dir/" "$LIVE_DIR/" || return 1
  rm -rf "$restore_dir"
  if [[ -n "$previous_revision" ]]; then
    printf '%s\n' "$previous_revision" >"$LIVE_DIR/.waynode-revision"
    printf '%s\n' "$previous_source_digest" >"$LIVE_DIR/.waynode-source.sha256"
  fi
}

revision_from_image() {
  local image=$1 revision
  revision=$(docker image inspect "$image" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)
  [[ "$revision" == '<no value>' ]] && revision=""
  printf '%s' "$revision"
}

verify_revision_url() {
  local url=$1
  EXPECTED_REVISION="$DEPLOY_SHA" curl --fail --silent --show-error \
    --connect-timeout 5 --max-time 15 \
    --retry 12 --retry-delay 2 --retry-all-errors "$url" | \
    EXPECTED_REVISION="$DEPLOY_SHA" node -e '
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (value.revision !== process.env.EXPECTED_REVISION) process.exit(2);
        } catch { process.exit(3); }
      });
    '
}

capture_backup_timer_state() {
  local state_dir="$transaction_dir/systemd" unit path state
  state=$(systemctl is-active waynode-backup.service 2>/dev/null || true)
  case "$state" in
    active|activating|reloading|deactivating)
      die "Waynode backup service is active; retry the deployment after it finishes." ;;
  esac
  install -d -m 700 "$state_dir"
  for unit in waynode-backup.service waynode-backup.timer; do
    path="/etc/systemd/system/$unit"
    if [[ -e "$path" || -L "$path" ]]; then
      cp -a "$path" "$state_dir/$unit"
    fi
  done
  state=$(systemctl is-enabled waynode-backup.timer 2>/dev/null || true)
  printf '%s\n' "${state:-disabled}" >"$state_dir/timer.enabled"
  state=$(systemctl is-active waynode-backup.timer 2>/dev/null || true)
  printf '%s\n' "${state:-inactive}" >"$state_dir/timer.active"
  backup_timer_state_captured=1
}

quiesce_backup_timer() {
  systemctl disable --now waynode-backup.timer >/dev/null 2>&1 || true
  systemctl stop waynode-backup.service >/dev/null 2>&1 || true
  ! systemctl is-active --quiet waynode-backup.timer \
    && ! systemctl is-active --quiet waynode-backup.service \
    && ! systemctl is-enabled --quiet waynode-backup.timer
}

restore_backup_timer_state() {
  local state_dir="$transaction_dir/systemd" unit active enabled
  [[ $backup_timer_state_captured == 1 ]] || return 0
  quiesce_backup_timer || return 1
  for unit in waynode-backup.service waynode-backup.timer; do
    rm -f "/etc/systemd/system/$unit"
    if [[ -e "$state_dir/$unit" || -L "$state_dir/$unit" ]]; then
      cp -a "$state_dir/$unit" "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  enabled=$(<"$state_dir/timer.enabled")
  active=$(<"$state_dir/timer.active")
  case "$enabled" in
    enabled) systemctl enable waynode-backup.timer >/dev/null ;;
    enabled-runtime) systemctl enable --runtime waynode-backup.timer >/dev/null ;;
  esac
  [[ "$active" != active ]] || systemctl start waynode-backup.timer
}

prune_successful_recovery_sets() {
  local marker recovery_dir failed=0
  while IFS= read -r -d '' marker; do
    recovery_dir=${marker%/SUCCEEDED}
    [[ "$(dirname "$recovery_dir")" == "$BACKUP_ROOT" ]] || continue
    rm -rf -- "$recovery_dir" || failed=1
  done < <(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name SUCCEEDED \
    -mtime "+$DEPLOYMENT_RETENTION_DAYS" -print0)
  return "$failed"
}

remove_dev_token() {
  if awk 'index($0, "DEV_AUTH_TOKEN=") == 1 { found=1 } END { exit !found }' "$LIVE_DIR/.env"; then
    local env_tmp
    env_tmp=$(mktemp "$LIVE_DIR/.env.XXXXXX")
    awk 'index($0, "DEV_AUTH_TOKEN=") != 1' "$LIVE_DIR/.env" >"$env_tmp"
    chmod 600 "$env_tmp"
    mv "$env_tmp" "$LIVE_DIR/.env"
  fi
}

cleanup_stage() {
  case "$STAGED_ROOT" in /var/tmp/waynode-deploy-*) rm -rf "$STAGED_ROOT" ;; esac
}

source_replaced=0
replacement_started=0
backup_timer_state_captured=0
backup_timer_changed=0
previous_image_id=$(docker inspect --format '{{.Image}}' waynode 2>/dev/null || true)
previous_image_name=$(compose config --images | head -n 1)
previous_sandbox_id=$(docker image inspect --format '{{.Id}}' waynode-sandbox:latest 2>/dev/null || true)
previous_revision=$(revision_from_image "$previous_image_id")
previous_source_digest=$(source_digest "$LIVE_DIR")
data_archive="$transaction_dir/waynode-predeploy.data.tar.gz"
previous_sandbox_archive="$transaction_dir/sandbox-image.tar"
new_sandbox_archive="$transaction_dir/new-sandbox-image.tar"

rollback() {
  local status=$? rollback_failed=0
  trap - ERR
  set +e
  say "Deployment failed; restoring the matching predeploy recovery set."
  if [[ $backup_timer_changed == 1 ]]; then
    quiesce_backup_timer || rollback_failed=1
  fi
  if [[ $source_replaced == 1 ]]; then
    docker stop --time 30 waynode >/dev/null 2>&1 || true
    restore_live_source || rollback_failed=1
    docker tag "$previous_image_id" "$previous_image_name" || rollback_failed=1
    if [[ $replacement_started == 1 ]]; then
      WAYNODE_ROOT_DIR="$LIVE_DIR" COMPOSE_FILE="$LIVE_DIR/$COMPOSE_NAME" \
        BACKUP_DIR="$transaction_dir" WAYNODE_RESTORE_EXACT_ENV=1 \
        "$STAGED_SOURCE_DIR/scripts/waynode-backup.sh" restore-offline "$data_archive" \
        || rollback_failed=1
    else
      install -m 600 "$transaction_dir/waynode-predeploy.env" "$LIVE_DIR/.env" \
        || rollback_failed=1
    fi
    if [[ -s "$previous_sandbox_archive" ]]; then
      docker run --rm --network none \
        --volume /root/.microsandbox:/root/.microsandbox \
        --volume "$previous_sandbox_archive:/tmp/waynode-sandbox.tar:ro" \
        "$previous_image_id" msb image load --input /tmp/waynode-sandbox.tar \
          --tag waynode-sandbox:latest --quiet || rollback_failed=1
    fi
    if [[ $rollback_failed == 0 ]]; then
      unset WAYNODE_REVISION
      compose up -d --force-recreate || rollback_failed=1
      curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-all-errors \
        --connect-timeout 5 --max-time 15 \
        http://127.0.0.1:3000/api/auth/me >/dev/null || rollback_failed=1
    fi
  fi
  if [[ $backup_timer_changed == 1 ]]; then
    restore_backup_timer_state || rollback_failed=1
  fi
  if [[ $rollback_failed != 0 ]]; then
    docker stop --time 10 waynode >/dev/null 2>&1 || true
    say "Rollback could not be completed safely. Waynode is stopped; recovery set: $transaction_dir"
  else
    say "Predeploy source, environment, data, server image, and sandbox image restored."
  fi
  cleanup_stage
  exit "$status"
}
trap rollback ERR

[[ -n "$previous_image_id" ]] || die "The previous server image could not be resolved."
[[ -n "$previous_image_name" ]] || die "The previous server image name could not be resolved."
[[ -n "$previous_sandbox_id" ]] || die "The previous sandbox image could not be resolved."

capture_backup_timer_state
backup_timer_changed=1
quiesce_backup_timer
archive_live_source
{
  printf 'previous_image=%s\n' "$previous_image_id"
  printf 'previous_revision=%s\n' "${previous_revision:-legacy-unversioned}"
  printf 'previous_source_digest=%s\n' "$previous_source_digest"
} >"$transaction_dir/reconciliation.txt"

if [[ -f "$LIVE_DIR/.waynode-revision" && -f "$LIVE_DIR/.waynode-source.sha256" ]]; then
  recorded_revision=$(<"$LIVE_DIR/.waynode-revision")
  recorded_digest=$(<"$LIVE_DIR/.waynode-source.sha256")
  [[ "$recorded_revision" == "$previous_revision" ]] || die "Live source/image revision mismatch."
  [[ "$recorded_digest" == "$previous_source_digest" ]] || die "Unreconciled production source changes found."
else
  [[ -z "$previous_revision" && "$ALLOW_LEGACY_SOURCE" == 1 ]] \
    || die "Production source has no trusted revision manifest."
  say "One-time legacy source bootstrap accepted after full source preservation."
fi

WAYNODE_ROOT_DIR="$LIVE_DIR" COMPOSE_FILE="$LIVE_DIR/$COMPOSE_NAME" \
  BACKUP_DIR="$transaction_dir" BACKUP_ID=predeploy \
  "$STAGED_SOURCE_DIR/scripts/waynode-backup.sh" backup
[[ -f "$data_archive" ]] || die "Predeploy data backup is missing."

docker tag "$previous_image_id" "waynode-rollback:$DEPLOY_SHA"
docker tag "$previous_sandbox_id" "waynode-sandbox:rollback-$DEPLOY_SHA"
docker save --output "$previous_sandbox_archive" "$previous_sandbox_id"

staged_digest=$(source_digest "$STAGED_SOURCE_DIR")
source_replaced=1
rsync -a --delete --exclude='.env' --exclude='data/' --exclude='node_modules/' \
  --exclude='frontend/node_modules/' --exclude='frontend/dist/' \
  "$STAGED_SOURCE_DIR/" "$LIVE_DIR/"
[[ "$(source_digest "$LIVE_DIR")" == "$staged_digest" ]] || die "Synced source digest mismatch."
printf '%s\n' "$DEPLOY_SHA" >"$LIVE_DIR/.waynode-revision"
printf '%s\n' "$staged_digest" >"$LIVE_DIR/.waynode-source.sha256"
remove_dev_token

export WAYNODE_REVISION="$DEPLOY_SHA"
compose build --build-arg WAYNODE_REVISION="$DEPLOY_SHA" waynode
[[ "$(revision_from_image "$previous_image_name")" == "$DEPLOY_SHA" ]] \
  || die "Built server image has the wrong revision label."
docker build --file "$LIVE_DIR/sandbox/Dockerfile" --build-arg WAYNODE_REVISION="$DEPLOY_SHA" \
  --tag waynode-sandbox:latest "$LIVE_DIR"
[[ "$(revision_from_image waynode-sandbox:latest)" == "$DEPLOY_SHA" ]] \
  || die "Built sandbox image has the wrong revision label."
docker run --rm \
  --volume "$LIVE_DIR/scripts/check-sandbox-image.mjs:/tmp/check-sandbox-image.mjs:ro" \
  --entrypoint node waynode-sandbox:latest \
  /tmp/check-sandbox-image.mjs /root/.pi/agent/models.json
docker save --output "$new_sandbox_archive" waynode-sandbox:latest
docker run --rm --network none \
  --volume /root/.microsandbox:/root/.microsandbox \
  --volume "$new_sandbox_archive:/tmp/waynode-sandbox.tar:ro" \
  "$previous_image_name" msb image load --input /tmp/waynode-sandbox.tar \
    --tag waynode-sandbox:latest --quiet

replacement_started=1
compose up -d --wait --wait-timeout 120 --force-recreate
[[ "$(docker inspect waynode --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" == "$DEPLOY_SHA" ]] \
  || die "Running container has the wrong revision label."
verify_revision_url "http://127.0.0.1:3000/api/health/version"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  http://127.0.0.1:3000/api/health/ready >/dev/null
if docker exec waynode printenv DEV_AUTH_TOKEN >/dev/null 2>&1; then
  die "DEV_AUTH_TOKEN must not exist in production."
fi
WAYNODE_ROOT_DIR="$LIVE_DIR" COMPOSE_FILE="$LIVE_DIR/$COMPOSE_NAME" \
  BACKUP_DIR=/var/backups/waynode "$LIVE_DIR/scripts/waynode-backup.sh" install-timer

public_url=$(awk 'index($0, "APP_URL=") == 1 { print substr($0, 9); exit }' "$LIVE_DIR/.env")
public_url=${public_url%/}
[[ "$public_url" == https://* ]] || die "Production APP_URL must use HTTPS."
verify_revision_url "$public_url/api/health/version"
curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-all-errors \
  --connect-timeout 5 --max-time 15 \
  "$public_url/api/health/ready" >/dev/null

printf 'revision=%s\nimage=%s\ncompleted_at=%s\n' \
  "$DEPLOY_SHA" "$previous_image_name" "$(date -u +%FT%TZ)" >"$transaction_dir/SUCCEEDED"
rm -f "$new_sandbox_archive"
trap - ERR
cleanup_stage
prune_successful_recovery_sets || say "Non-fatal: recovery-set pruning failed."
docker image prune -f --filter until=168h >/dev/null || say "Non-fatal: image pruning failed."
say "Deployment complete and publicly verified: $DEPLOY_SHA"
