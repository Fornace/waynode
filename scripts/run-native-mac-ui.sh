#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/native-app/Waynode.xcodeproj"
DESTINATION="${WAYNODE_MAC_UI_DESTINATION:-platform=macOS,arch=arm64}"
RESULT="${WAYNODE_MAC_UI_RESULT:-$ROOT/_tmp/native-mac-ui.xcresult}"
TIMEOUT_SECONDS="${WAYNODE_MAC_UI_TIMEOUT_SECONDS:-900}"

rm -rf "$RESULT"
mkdir -p "$(dirname "$RESULT")"

python3 - "$TIMEOUT_SECONDS" \
  xcodebuild \
    -project "$PROJECT" \
    -scheme WaynodeMacUITests \
    -destination "$DESTINATION" \
    -parallel-testing-enabled NO \
    -collect-test-diagnostics never \
    -test-timeouts-enabled YES \
    -default-test-execution-time-allowance 120 \
    -maximum-test-execution-time-allowance 180 \
    -resultBundlePath "$RESULT" \
    test <<'PY'
import os
import signal
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
process = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    raise SystemExit(process.wait(timeout=timeout_seconds))
except subprocess.TimeoutExpired:
    print(f"TIMEOUT: native Mac UI gate exceeded {timeout_seconds:.0f}s", flush=True)
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    raise SystemExit(124)
PY
