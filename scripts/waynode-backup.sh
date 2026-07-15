#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=${WAYNODE_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/waynode}
RETENTION_DAYS=${RETENTION_DAYS:-14}
RESTIC_KEEP_DAILY=${RESTIC_KEEP_DAILY:-14}
RESTIC_KEEP_WEEKLY=${RESTIC_KEEP_WEEKLY:-8}
RESTIC_KEEP_MONTHLY=${RESTIC_KEEP_MONTHLY:-12}
if [[ "$COMPOSE_FILE" != /* ]]; then
  COMPOSE_FILE="$ROOT_DIR/$COMPOSE_FILE"
fi
COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE")

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }

prepare() {
  need docker
  need sha256sum
  [[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: $COMPOSE_FILE"
  [[ -f "$ROOT_DIR/.env" ]] || die ".env is required in $ROOT_DIR"
  install -d -m 700 "$BACKUP_DIR"
}

running() {
  "${COMPOSE[@]}" ps --status running --services | awk '$0 == "waynode" { found=1 } END { exit !found }'
}

image_name() {
  "${COMPOSE[@]}" config --images | head -n 1
}

mirror_with_restic() {
  local data=$1 env=$2 manifest=$3 count
  [[ ${WAYNODE_BACKUP_RESTIC:-0} == 1 ]] || return 0
  need restic
  for count in "$RESTIC_KEEP_DAILY" "$RESTIC_KEEP_WEEKLY" "$RESTIC_KEEP_MONTHLY"; do
    case "$count" in *[!0-9]*|'') die "Restic retention counts must be non-negative integers." ;; esac
  done
  restic backup "$data" "$env" "$manifest" --tag waynode
  # Timestamped archive paths must not create a separate retention group each day.
  restic forget --tag waynode --group-by host,tags \
    --keep-daily "$RESTIC_KEEP_DAILY" --keep-weekly "$RESTIC_KEEP_WEEKLY" \
    --keep-monthly "$RESTIC_KEEP_MONTHLY" --prune
}

backup() {
  prepare
  need flock
  exec 9>"$BACKUP_DIR/.backup.lock"
  flock -n 9 || die "Another Waynode backup is already running."

  local stamp prefix data env_copy manifest partial container restart=0
  stamp=${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
  case "$stamp" in *[!a-zA-Z0-9._-]*|'') die "BACKUP_ID contains unsupported characters." ;; esac
  prefix="$BACKUP_DIR/waynode-$stamp"
  data="$prefix.data.tar.gz"
  env_copy="$prefix.env"
  manifest="$prefix.sha256"
  partial="$data.partial"

  container=$("${COMPOSE[@]}" ps -q waynode)
  running && restart=1
  [[ $restart -eq 0 ]] || docker stop --time 30 "$container" >/dev/null
  # Restart the exact pre-backup container instead of reconciling newer
  # Compose configuration during a pre-deploy backup.
  trap 'rm -f "$partial"; [[ $restart -eq 0 ]] || docker start "$container" >/dev/null' EXIT

  "${COMPOSE[@]}" run --rm --no-deps \
    -v "$BACKUP_DIR:/backup" --entrypoint sh waynode \
    -c 'tar -czf "/backup/$1" -C /data .' backup "$(basename "$partial")"
  mv "$partial" "$data"
  install -m 600 "$ROOT_DIR/.env" "$env_copy"
  (
    cd "$BACKUP_DIR"
    sha256sum "$(basename "$data")" "$(basename "$env_copy")" >"$(basename "$manifest").partial"
    mv "$(basename "$manifest").partial" "$(basename "$manifest")"
  )
  chmod 600 "$data" "$manifest"

  [[ $restart -eq 0 ]] || docker start "$container" >/dev/null
  trap - EXIT
  mirror_with_restic "$data" "$env_copy" "$manifest"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'waynode-*' -mtime "+$RETENTION_DAYS" -delete
  say "Backup complete: $data"
  say "Environment copy: $env_copy"
}

resolve_archive() {
  local requested=${1:-latest}
  if [[ "$requested" == latest ]]; then
    requested=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'waynode-*.data.tar.gz' -print | sort | tail -n 1)
  fi
  [[ -n "$requested" && -f "$requested" ]] || die "Backup archive not found."
  printf '%s' "$requested"
}

verify_set() {
  local data=$1 prefix manifest env_copy
  prefix=${data%.data.tar.gz}
  manifest="$prefix.sha256"
  env_copy="$prefix.env"
  [[ -f "$manifest" && -f "$env_copy" ]] || die "Backup set is incomplete: $prefix"
  (cd "$(dirname "$manifest")" && sha256sum -c "$(basename "$manifest")")
}

restore_environment() {
  local env_copy=$1
  install -m 600 "$env_copy" "$ROOT_DIR/.env"
  [[ ${WAYNODE_RESTORE_EXACT_ENV:-0} == 1 ]] && return 0
  if awk 'index($0, "DEV_AUTH_TOKEN=") == 1 { found=1 } END { exit !found }' "$ROOT_DIR/.env"; then
    local env_tmp
    env_tmp=$(mktemp "$ROOT_DIR/.env.restore.XXXXXX")
    awk 'index($0, "DEV_AUTH_TOKEN=") != 1' "$ROOT_DIR/.env" >"$env_tmp"
    chmod 600 "$env_tmp"
    mv "$env_tmp" "$ROOT_DIR/.env"
  fi
}

restore_payload() {
  local data=$1
  "${COMPOSE[@]}" run --rm --no-deps -v "$(dirname "$data"):/backup:ro" \
    --entrypoint sh waynode \
    -c 'tar -tzf "/backup/$1" >/dev/null && find /data -mindepth 1 -delete && tar -xzf "/backup/$1" -C /data' \
    restore "$(basename "$data")"
}

drill() {
  prepare
  local data image volume
  data=$(resolve_archive "${1:-latest}")
  verify_set "$data"
  image=$(image_name)
  [[ -n "$image" ]] || die "Waynode image could not be resolved."
  volume="waynode-restore-drill-$(date +%s)-$$"
  docker volume create "$volume" >/dev/null
  trap 'docker volume rm -f "$volume" >/dev/null 2>&1 || true' EXIT
  docker run --rm -v "$volume:/data" -v "$(dirname "$data"):/backup:ro" \
    --entrypoint sh "$image" -c 'tar -xzf "/backup/$1" -C /data' drill "$(basename "$data")"
  docker run --rm -v "$volume:/data:ro" --entrypoint node "$image" -e '
    const { DatabaseSync } = require("node:sqlite");
    const { existsSync } = require("node:fs");
    if (!existsSync("/data/waynode.db") || !existsSync("/data/repos")) process.exit(2);
    const db = new DatabaseSync("/data/waynode.db", { readOnly: true });
    const result = db.prepare("PRAGMA quick_check").get();
    db.close();
    if (result.quick_check !== "ok") process.exit(3);
  '
  docker volume rm -f "$volume" >/dev/null
  trap - EXIT
  say "Restore drill passed: $data"
}

restore() {
  prepare
  local data prefix env_copy restart=0 confirmation
  data=$(resolve_archive "${1:-}")
  verify_set "$data"
  prefix=${data%.data.tar.gz}
  env_copy="$prefix.env"
  if [[ ${WAYNODE_CONFIRM_RESTORE:-0} != 1 ]]; then
    read -r -p "Replace all Waynode data and .env from this backup? Type RESTORE: " confirmation
    [[ "$confirmation" == RESTORE ]] || die "Restore cancelled."
  fi
  running && restart=1
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" stop waynode
  install -m 600 "$ROOT_DIR/.env" "$ROOT_DIR/.env.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  restore_environment "$env_copy"
  trap '[[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d --wait --wait-timeout 120' EXIT
  restore_payload "$data"
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d --wait --wait-timeout 120
  trap - EXIT
  say "Restore complete. Verify OAuth, representative repositories, and one agent turn."
}

restore_offline() {
  prepare
  local data prefix env_copy
  data=$(resolve_archive "${1:-}")
  verify_set "$data"
  running && die "restore-offline requires the Waynode service to be stopped."
  prefix=${data%.data.tar.gz}
  env_copy="$prefix.env"
  restore_environment "$env_copy"
  restore_payload "$data"
  say "Offline restore complete: $data"
}

install_timer() {
  [[ $EUID -eq 0 ]] || die "install-timer must run as root."
  prepare
  cat >/etc/systemd/system/waynode-backup.service <<EOF
[Unit]
Description=Stop-consistent Waynode backup and restore drill
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
TimeoutStartSec=2h
TimeoutStopSec=2m
WorkingDirectory=$ROOT_DIR
Environment=COMPOSE_FILE=$COMPOSE_FILE
Environment=BACKUP_DIR=$BACKUP_DIR
EnvironmentFile=-/etc/waynode-backup.env
ExecStart=$ROOT_DIR/scripts/waynode-backup.sh backup
ExecStart=$ROOT_DIR/scripts/waynode-backup.sh drill latest
EOF
  cat >/etc/systemd/system/waynode-backup.timer <<'EOF'
[Unit]
Description=Nightly Waynode backup

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=20m
Persistent=true
Unit=waynode-backup.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now waynode-backup.timer
  say "Installed waynode-backup.timer. Inspect with: systemctl list-timers waynode-backup.timer"
}

case ${1:-} in
  backup) backup ;;
  drill) drill "${2:-latest}" ;;
  restore) restore "${2:-}" ;;
  restore-offline) restore_offline "${2:-}" ;;
  install-timer) install_timer ;;
  *) say "Usage: $0 backup|drill [BACKUP]|restore BACKUP|restore-offline BACKUP|install-timer"; exit 2 ;;
esac
