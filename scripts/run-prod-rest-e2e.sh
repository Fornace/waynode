#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
Production DEV_AUTH_TOKEN automation has been retired.

Use ./scripts/run-rest-e2e-nonprod.sh against an isolated staging/local
deployment. Production authenticated smoke testing must use a real OAuth
browser session and a dedicated test organization; readiness is available at
https://waynode.fornace.net/api/health/ready.
EOF
exit 2
