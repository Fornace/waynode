#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$ROOT_DIR/docker-compose.yml")

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required."
}

need_docker() {
  need_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."
}

env_value() {
  local key=$1
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$ENV_FILE"
}

require_value() {
  local key=$1 value
  value=$(env_value "$key")
  [[ -n "$value" ]] || die "$key is required in .env."
  printf '%s' "$value"
}

validate_url() {
  local url=${1%/} authority
  case "$url" in
    http://*|https://*) ;;
    *) die "APP_URL must start with http:// or https://." ;;
  esac
  authority=${url#*://}
  [[ -n "$authority" && "$authority" != */* && "$authority" != *\?* && "$authority" != *\#* ]] \
    || die "APP_URL must be an origin without a path, query, or fragment."
}

provider_key_name() {
  case "$1" in
    anthropic) printf 'ANTHROPIC_API_KEY' ;;
    openai) printf 'OPENAI_API_KEY' ;;
    google) printf 'GEMINI_API_KEY' ;;
    openrouter) printf 'OPENROUTER_API_KEY' ;;
    *) die "Unsupported guided provider '$1'. Use anthropic, openai, google, or openrouter." ;;
  esac
}

check_config() {
  need_docker
  [[ -f "$ENV_FILE" ]] || die ".env is missing. Run: ./scripts/self-host.sh setup"

  local app_url session_secret encryption_key provider model key_name bootstrap_key
  local github_id github_secret gitlab_id gitlab_secret
  app_url=$(require_value APP_URL)
  validate_url "$app_url"
  session_secret=$(require_value SESSION_SECRET)
  encryption_key=$(require_value ENCRYPTION_KEY)
  [[ ${#session_secret} -ge 32 ]] || die "SESSION_SECRET must be at least 32 characters."
  [[ ${#encryption_key} -ge 32 ]] || die "ENCRYPTION_KEY must be at least 32 characters."
  [[ "$session_secret" != "$encryption_key" ]] || die "SESSION_SECRET and ENCRYPTION_KEY must differ."

  github_id=$(env_value GITHUB_CLIENT_ID)
  github_secret=$(env_value GITHUB_CLIENT_SECRET)
  gitlab_id=$(env_value GITLAB_CLIENT_ID)
  gitlab_secret=$(env_value GITLAB_CLIENT_SECRET)
  [[ ( -z "$github_id" && -z "$github_secret" ) || ( -n "$github_id" && -n "$github_secret" ) ]] \
    || die "GitHub OAuth needs both client ID and secret."
  [[ ( -z "$gitlab_id" && -z "$gitlab_secret" ) || ( -n "$gitlab_id" && -n "$gitlab_secret" ) ]] \
    || die "GitLab OAuth needs both client ID and secret."
  [[ -n "$github_id" || -n "$gitlab_id" ]] || die "Configure GitHub or GitLab OAuth before starting."

  provider=$(require_value PI_DEFAULT_PROVIDER)
  model=$(require_value PI_DEFAULT_MODEL)
  key_name=$(provider_key_name "$provider")
  bootstrap_key=$(env_value PI_PROVIDER_API_KEY)
  if [[ ${WAYNODE_REQUIRE_PROVIDER_KEY:-0} == 1 && -z "$bootstrap_key" ]]; then
    die "PI_PROVIDER_API_KEY is required for first-boot credential encryption."
  fi
  [[ "$(env_value WAYNODE_DEPLOYMENT)" != hosted ]] \
    || die "The self-host installer refuses WAYNODE_DEPLOYMENT=hosted."

  "${COMPOSE[@]}" config --quiet
  say "Configuration OK."
  say "GitHub callback: $app_url/auth/github/callback"
  say "GitLab callback:  $app_url/auth/gitlab/callback"
  say "Model: $provider/$model"
  if [[ -n "$bootstrap_key" ]]; then
    say "First boot will encrypt PI_PROVIDER_API_KEY as $key_name."
  else
    say "No bootstrap key present; expecting an existing encrypted $key_name secret."
  fi
}

prompt() {
  local label=$1 default=${2-} value
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " value
    REPLY=${value:-$default}
  else
    read -r -p "$label: " REPLY
  fi
  [[ -n "$REPLY" ]] || die "$label cannot be empty."
}

secret_prompt() {
  local label=$1
  read -r -s -p "$label: " REPLY
  printf '\n'
  [[ -n "$REPLY" ]] || die "$label cannot be empty."
}

safe_env_value() {
  [[ "$2" != *[$' \t\r\n']* ]] || die "$1 cannot contain whitespace."
}

setup() {
  need_docker
  need_command openssl
  [[ ! -e "$ENV_FILE" ]] || die ".env already exists; refusing to overwrite it. Run check instead."
  [[ -t 0 ]] || die "Setup is interactive and needs a terminal."

  local app_url bind_address oauth oauth_id oauth_secret gitlab_base
  local provider model api_key key_name session_secret encryption_key
  prompt "Public Waynode URL" "http://localhost:3000"; app_url=${REPLY%/}
  validate_url "$app_url"
  prompt "Bind address" "127.0.0.1"; bind_address=$REPLY

  say "Create an OAuth app with one of these exact callbacks:"
  say "  GitHub: $app_url/auth/github/callback"
  say "  GitLab:  $app_url/auth/gitlab/callback"
  prompt "Login provider (github or gitlab)" "github"; oauth=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')
  case "$oauth" in github|gitlab) ;; *) die "Login provider must be github or gitlab." ;; esac
  prompt "OAuth client ID"; oauth_id=$REPLY
  secret_prompt "OAuth client secret"; oauth_secret=$REPLY
  gitlab_base=https://gitlab.com
  if [[ "$oauth" == gitlab ]]; then
    prompt "GitLab base URL" "$gitlab_base"; gitlab_base=${REPLY%/}
  fi

  prompt "Model provider (anthropic, openai, google, or openrouter)" "anthropic"
  provider=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')
  key_name=$(provider_key_name "$provider")
  prompt "Default model ID (as listed by pi for $provider)"; model=$REPLY
  secret_prompt "$key_name"; api_key=$REPLY
  for item in app_url bind_address oauth_id oauth_secret gitlab_base provider model api_key; do
    safe_env_value "$item" "${!item}"
  done

  session_secret=$(openssl rand -hex 32)
  encryption_key=$(openssl rand -hex 32)
  umask 077
  {
    printf 'PORT=3000\nNODE_ENV=production\nWAYNODE_BIND_ADDRESS=%s\nAPP_URL=%s\n' "$bind_address" "$app_url"
    printf 'SESSION_SECRET=%s\nENCRYPTION_KEY=%s\n' "$session_secret" "$encryption_key"
    if [[ "$oauth" == github ]]; then
      printf 'GITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\n' "$oauth_id" "$oauth_secret"
      printf 'GITLAB_CLIENT_ID=\nGITLAB_CLIENT_SECRET=\nGITLAB_BASE_URL=https://gitlab.com\n'
    else
      printf 'GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\n'
      printf 'GITLAB_CLIENT_ID=%s\nGITLAB_CLIENT_SECRET=%s\nGITLAB_BASE_URL=%s\n' "$oauth_id" "$oauth_secret" "$gitlab_base"
    fi
    printf 'PI_DEFAULT_PROVIDER=%s\nPI_DEFAULT_MODEL=%s\nPI_PROVIDER_API_KEY=%s\n' "$provider" "$model" "$api_key"
    printf 'LLM_BASE_URL=\nLLM_API_KEY=\nLLM_MODEL=\n'
    printf 'WAYNODE_DEPLOYMENT=self-hosted\n'
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  WAYNODE_REQUIRE_PROVIDER_KEY=1 check_config
  if [[ ${WAYNODE_SKIP_START:-0} == 1 ]]; then
    say "Configuration written; start skipped."
    return
  fi
  say "Starting Waynode. Docker will show build progress below."
  "${COMPOSE[@]}" up -d --build --wait --wait-timeout 120
  say "Waynode started. Follow logs with: docker compose logs -f waynode"
  say "Open: $app_url"
  say "First run: clone a worktree and send a small prompt to verify model access."
  say "Later per-worktree key overrides belong in Settings -> Secrets as $key_name."
}

was_running() {
  "${COMPOSE[@]}" ps --status running --services | awk '$0 == "waynode" { found=1 } END { exit !found }'
}

backup() {
  need_docker
  [[ -f "$ENV_FILE" ]] || die ".env is required."
  local target=${1:-"$ROOT_DIR/backups/waynode-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"}
  local dir base restart=0
  mkdir -p "$(dirname "$target")"
  dir=$(cd "$(dirname "$target")" && pwd); base=$(basename "$target")
  was_running && restart=1
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" stop waynode
  trap '[[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d' EXIT
  "${COMPOSE[@]}" run --rm --no-deps -v "$dir:/backup" --entrypoint sh waynode \
    -c 'tar -czf "/backup/$1" -C /data .' backup "$base"
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d
  trap - EXIT
  chmod 600 "$dir/$base"
  say "Backup written: $dir/$base"
  say "Keep .env separately; the archive does not contain deployment secrets."
}

restore() {
  need_docker
  local source=${1-} dir base restart=0 confirmation
  [[ -n "$source" && -f "$source" ]] || die "Usage: ./scripts/self-host.sh restore BACKUP.tar.gz"
  dir=$(cd "$(dirname "$source")" && pwd); base=$(basename "$source")
  if [[ ${WAYNODE_CONFIRM_RESTORE:-0} != 1 ]]; then
    read -r -p "This replaces all Waynode data. Type RESTORE: " confirmation
    [[ "$confirmation" == RESTORE ]] || die "Restore cancelled."
  fi
  was_running && restart=1
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" stop waynode
  trap '[[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d' EXIT
  "${COMPOSE[@]}" run --rm --no-deps -v "$dir:/backup:ro" --entrypoint sh waynode \
    -c 'tar -tzf "/backup/$1" >/dev/null && find /data -mindepth 1 -delete && tar -xzf "/backup/$1" -C /data' restore "$base"
  [[ $restart -eq 0 ]] || "${COMPOSE[@]}" up -d
  trap - EXIT
  say "Restore complete. Start with: docker compose up -d"
}

usage() {
  say "Usage: ./scripts/self-host.sh setup|check|backup [FILE]|restore FILE"
}

cd "$ROOT_DIR"
case ${1-} in
  setup) setup ;;
  check) check_config ;;
  backup) backup "${2-}" ;;
  restore) restore "${2-}" ;;
  *) usage; exit 2 ;;
esac
