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

# 3. Native OAuth is cookie-free and carries a signed, provider-bound state
# through the provider redirect. Browser OAuth owns the session-cookie path.
echo "[3] /auth/github?native=1 uses signed cookie-free state"
headers=$(curl -sS -D - -o /dev/null "$BASE/auth/github?native=1")
location=$(printf '%s' "$headers" | awk 'BEGIN { IGNORECASE=1 } /^location:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }')
if ! echo "$headers" | grep -iq '^set-cookie:.*connect.sid'; then
  ok "does not set a browser session cookie"
else
  no "native OAuth unexpectedly set connect.sid"
fi
if [[ "$location" == https://github.com/login/oauth/authorize* ]]; then
  ok "redirects to GitHub OAuth"
else
  no "no GitHub redirect"
fi
state=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(u.searchParams.get("state") || "")' "$location")
if node -e '
  const [payload, signature, extra] = process.argv[1].split(".");
  if (!payload || !signature || extra) process.exit(1);
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (parsed.native !== true || parsed.provider !== "github") process.exit(1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(parsed.nonce)) process.exit(1);
  if (!Number.isFinite(parsed.iat) || parsed.exp - parsed.iat !== 600000 || parsed.exp <= Date.now()) process.exit(1);
' "$state"; then
  ok "carries a current signed-state envelope"
else
  no "missing or malformed native OAuth state"
fi

# 4. /api/tokens without auth → 401
echo "[4] /api/tokens without auth → 401"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/tokens")
if [ "$code" = "401" ]; then ok "tokens endpoint protected"; else no "expected 401, got $code"; fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
