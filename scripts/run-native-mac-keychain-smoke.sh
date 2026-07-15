#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${WAYNODE_MAC_APP:-$ROOT/_tmp/native-signed-gates/native-mac/Build/Products/Debug/Waynode.app}"
EXECUTABLE="$APP/Contents/MacOS/Waynode"
LOG="$(mktemp)"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

test -x "$EXECUTABLE"
codesign --verify --deep --strict "$APP"

echo "Running signed native macOS Keychain round-trip"
"$EXECUTABLE" -ui-test-keychain-headless >"$LOG" 2>&1 &
PID="$!"

for _ in {1..100}; do
  if grep -Fqx "WAYNODE_KEYCHAIN_SMOKE=passed" "$LOG"; then
    echo "DONE: signed native macOS Keychain round-trip passed"
    exit 0
  fi
  if grep -Fqx "WAYNODE_KEYCHAIN_SMOKE=failed" "$LOG"; then
    echo "FAIL: signed native macOS Keychain round-trip failed" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "FAIL: signed native macOS app exited before reporting Keychain status" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 0.2
done

echo "FAIL: signed native macOS app did not report Keychain status within 20 seconds" >&2
tail -40 "$LOG" >&2
exit 1
