#!/usr/bin/env bash
# Smoke test the deployed native auth flow against production.
# Run: bash e2e/verify-prod.sh
set -euo pipefail

BASE="${BASE_URL:-https://waynode.fornace.net}"
PASS=0; FAIL=0
ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
no() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "Testing $BASE …"

# 1. /api/auth/me unauthenticated returns providers (new code)
echo "[1] /api/auth/me unauthenticated → providers"
body=$(curl -sS "$BASE/api/auth/me")
if echo "$body" | grep -q '"providers"'; then
  ok "returns providers object"
else
  no "missing providers (still old code): $body"
fi

# 2. /api/auth/me with bad bearer → 401 (new code)
echo "[2] /api/auth/me with invalid bearer → 401"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wn_invalidtoken12345678901234567890' "$BASE/api/auth/me")
if [ "$code" = "401" ]; then ok "returns 401 for invalid token"; else no "expected 401, got $code"; fi

# 3. /auth/github?native=1 sets session cookie + redirects to github
echo "[3] /auth/github?native=1 sets connect.sid"
headers=$(curl -sS -D - -o /dev/null "$BASE/auth/github?native=1")
if echo "$headers" | grep -iq 'set-cookie.*connect.sid'; then
  ok "sets connect.sid cookie"
else
  no "no connect.sid cookie"
fi
if echo "$headers" | grep -iq 'location.*github.com'; then ok "redirects to github OAuth"; else no "no github redirect"; fi

# 4. /api/tokens without auth → 401
echo "[4] /api/tokens without auth → 401"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/tokens")
if [ "$code" = "401" ]; then ok "tokens endpoint protected"; else no "expected 401, got $code"; fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
