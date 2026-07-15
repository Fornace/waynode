#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
E2E_DRIVER=${WAYNODE_E2E_DRIVER:-rest}
LOCAL_PORT=${WAYNODE_E2E_LOCAL_PORT:-47312}
PUBLIC_BASE_URL=${WAYNODE_E2E_PUBLIC_BASE_URL:-}
DEV_TOKEN=${WAYNODE_E2E_DEV_TOKEN:-$(openssl rand -hex 24)}
REPO_URL=${WAYNODE_E2E_REPO_URL:-https://github.com/octocat/Spoon-Knife.git}
DATA_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/waynode-browser-e2e.XXXXXX")
SERVER_LOG="$DATA_ROOT/server.log"
SERVER_PID=""
TUNNEL_PID=""

case "$E2E_DRIVER" in
  rest|local) ;;
  *) echo "[browser-e2e] WAYNODE_E2E_DRIVER must be 'rest' or 'local'" >&2; exit 2 ;;
esac

cleanup() {
  status=$?
  if [[ "$status" != 0 && -f "$SERVER_LOG" ]]; then
    echo "[browser-e2e] server log tail after failure" >&2
    tail -n 80 "$SERVER_LOG" >&2
  fi
  if [[ -n "$TUNNEL_PID" ]]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_E2E_DATA:-0}" != 1 ]]; then rm -rf "$DATA_ROOT"; fi
  return "$status"
}
trap cleanup EXIT INT TERM

export PORT="$LOCAL_PORT"
export DATA_DIR="$DATA_ROOT/data"
export APP_URL="http://127.0.0.1:$LOCAL_PORT"
export DEV_AUTH_TOKEN="$DEV_TOKEN"
export DEV_USER_NAME="Waynode Browser E2E"
export NODE_ENV=production
export WAYNODE_DEPLOYMENT=self-hosted
export WAYNODE_REVISION=isolated-browser-e2e

mkdir -p "$DATA_DIR"
echo "[browser-e2e] starting isolated server on local port $LOCAL_PORT"
node "$ROOT/server.js" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

LOCAL_BASE="http://127.0.0.1:$LOCAL_PORT"
ready=0
for attempt in $(seq 1 40); do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      "$LOCAL_BASE/api/health/live" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  echo "[browser-e2e] isolated server did not become live" >&2
  tail -n 80 "$SERVER_LOG" >&2
  exit 1
fi
echo "[browser-e2e] server is live"

if [[ "$E2E_DRIVER" == "rest" ]]; then
if [[ -z "$PUBLIC_BASE_URL" ]]; then
  command -v cloudflared >/dev/null || {
    echo "[browser-e2e] cloudflared is required without WAYNODE_E2E_PUBLIC_BASE_URL" >&2
    exit 1
  }
  TUNNEL_LOG="$DATA_ROOT/cloudflared.log"
  cloudflared tunnel --no-autoupdate --url "$LOCAL_BASE" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  for attempt in $(seq 1 60); do
    PUBLIC_BASE_URL=$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
    if [[ -n "$PUBLIC_BASE_URL" ]]; then break; fi
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if [[ -z "$PUBLIC_BASE_URL" ]]; then
    echo "[browser-e2e] ephemeral tunnel did not become ready" >&2
    tail -n 40 "$TUNNEL_LOG" >&2
    exit 1
  fi
  echo "[browser-e2e] ephemeral browser tunnel is ready"
fi
public_ready=0
public_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$PUBLIC_BASE_URL")
[[ -n "$TUNNEL_PID" ]] && sleep 8
for attempt in $(seq 1 90); do
  resolve_args=()
  if [[ -n "$TUNNEL_PID" ]]; then
    public_ip=$(dig +short @1.1.1.1 A "$public_host" | head -1 || true)
    [[ -n "$public_ip" ]] && resolve_args=(--resolve "$public_host:443:$public_ip")
  fi
  if [[ -z "$TUNNEL_PID" || ${#resolve_args[@]} -gt 0 ]] && \
      curl --fail --silent --connect-timeout 3 --max-time 8 "${resolve_args[@]}" \
        "$PUBLIC_BASE_URL/api/health/live" >/dev/null 2>&1; then
    public_ready=1
    break
  fi
  if [[ -n "$TUNNEL_PID" ]] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$public_ready" != 1 ]]; then
  echo "[browser-e2e] public staging health did not become reachable" >&2
  [[ -n "${TUNNEL_LOG:-}" ]] && tail -n 40 "$TUNNEL_LOG" >&2
  exit 1
fi
echo "[browser-e2e] public staging health probe passed"

# The temporary public origin is not known until cloudflared allocates it.
# Restart once with that exact APP_URL so CORS, CSRF and terminal-origin checks
# exercise the same strict-origin behavior used in production.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
export APP_URL="$PUBLIC_BASE_URL"
node "$ROOT/server.js" >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
ready=0
for attempt in $(seq 1 40); do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      "$LOCAL_BASE/api/health/live" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  echo "[browser-e2e] strict-origin server restart failed" >&2
  tail -n 80 "$SERVER_LOG" >&2
  exit 1
fi
echo "[browser-e2e] strict public origin is configured"
E2E_BASE_URL="$PUBLIC_BASE_URL"
else
  E2E_BASE_URL="$LOCAL_BASE"
  echo "[browser-e2e] local Playwright driver selected; public tunnel is not needed"
fi

org_id=$(
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    -H "x-dev-token: $DEV_TOKEN" "$LOCAL_BASE/api/orgs" |
    node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const orgs = JSON.parse(input);
        if (!Array.isArray(orgs) || !orgs[0]?.id) process.exit(2);
        process.stdout.write(orgs[0].id);
      });
    '
)
echo "[browser-e2e] default organization is ready"

space_id=$(
  curl --fail --silent --show-error --connect-timeout 3 --max-time 20 \
    -H "x-dev-token: $DEV_TOKEN" -H "content-type: application/json" \
    -X POST "$LOCAL_BASE/api/spaces" \
    --data "{\"repoUrl\":\"$REPO_URL\",\"branch\":\"main\",\"orgId\":\"$org_id\"}" |
    node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const space = JSON.parse(input);
        if (!space?.id) process.exit(2);
        process.stdout.write(space.id);
      });
    '
)
echo "[browser-e2e] clone accepted; waiting for the worktree"

cloned=0
for attempt in $(seq 1 90); do
  clone_events=$(curl --silent --connect-timeout 1 --max-time 2 \
    "$LOCAL_BASE/api/spaces/$space_id/clone-events?t=$DEV_TOKEN" || true)
  if [[ "$clone_events" == *'"type":"error"'* ]]; then
    echo "[browser-e2e] worktree clone reported an error" >&2
    printf '%s\n' "$clone_events" | tail -n 8 >&2
    tail -n 80 "$SERVER_LOG" >&2
    exit 1
  fi
  if [[ "$clone_events" == *'"type":"done"'* ]] && \
      git -C "$DATA_DIR/repos/$space_id" rev-parse --verify HEAD >/dev/null 2>&1; then
    cloned=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$cloned" != 1 ]]; then
  echo "[browser-e2e] worktree clone did not finish" >&2
  tail -n 80 "$SERVER_LOG" >&2
  exit 1
fi
echo "[browser-e2e] worktree is ready; launching $E2E_DRIVER browser driver"

export BASE_URL="$E2E_BASE_URL"
export DEV_TOKEN
export WAYNODE_NONPROD_CONFIRMED=1
export ONLY=${ONLY:-auth,open-session,chat-send,model-switch}
if [[ "$E2E_DRIVER" == "local" ]]; then
  node "$ROOT/e2e/run.mjs"
else
  "$ROOT/scripts/run-rest-e2e-nonprod.sh"
fi

echo "[browser-e2e] isolated $E2E_DRIVER browser flows passed"
