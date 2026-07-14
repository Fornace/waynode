#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDENTIALS="${WAYNODE_BROWSER_CREDENTIALS:-$HOME/.agent_credentials/tokens/browser-mcp-tomasipromo.env}"
SSH_KEY="${WAYNODE_DEPLOY_SSH_KEY:-$HOME/.agent_credentials/ssh/frapposerver.pkey}"
DEPLOY_HOST="${WAYNODE_DEPLOY_HOST:-root@95.216.37.30}"

set -a
# shellcheck disable=SC1090
source "$CREDENTIALS"
set +a

export BROWSER_TOKEN="${BROWSER_TOKEN:-${BROWSER_MCP_TOKEN:?Missing browser token}}"
export DEV_TOKEN="${DEV_TOKEN:-$(ssh -i "$SSH_KEY" -o BatchMode=yes "$DEPLOY_HOST" \
  'docker exec $(docker ps -q --filter name=waynode) printenv DEV_AUTH_TOKEN')}"

cd "$ROOT/e2e"
node run-rest.mjs
