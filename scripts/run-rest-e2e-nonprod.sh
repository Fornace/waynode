#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CREDENTIALS=${WAYNODE_BROWSER_CREDENTIALS:-$HOME/.agent_credentials/tokens/browser-mcp-tomasipromo.env}
: "${BASE_URL:?Set BASE_URL to an isolated non-production Waynode deployment}"
: "${DEV_TOKEN:?Set DEV_TOKEN from that non-production deployment}"
: "${WAYNODE_NONPROD_CONFIRMED:?Set WAYNODE_NONPROD_CONFIRMED=1 after verifying the target is isolated}"
[[ "$WAYNODE_NONPROD_CONFIRMED" == 1 ]] || {
  printf 'WAYNODE_NONPROD_CONFIRMED must equal 1.\n' >&2
  exit 2
}

target_host=$(node -e '
  const target = new URL(process.argv[1]);
  if (!new Set(["http:", "https:"]).has(target.protocol)) process.exit(2);
  process.stdout.write(target.hostname);
' "$BASE_URL") || {
  printf 'BASE_URL must be a valid HTTP(S) URL.\n' >&2
  exit 2
}

case "$target_host" in
  waynode.fornace.net|95.216.37.30)
    printf 'Refusing DEV_AUTH_TOKEN automation against production.\n' >&2
    exit 2
    ;;
esac

if [[ -f "$CREDENTIALS" ]]; then
  # shellcheck disable=SC1090
  source "$CREDENTIALS"
fi
export BROWSER_TOKEN="${BROWSER_TOKEN:-${BROWSER_MCP_TOKEN:-}}"
: "${BROWSER_TOKEN:?Set BROWSER_TOKEN for browser.fornace.net}"
export BASE_URL DEV_TOKEN BROWSER_TOKEN

cd "$ROOT/e2e"
node run-rest.mjs
