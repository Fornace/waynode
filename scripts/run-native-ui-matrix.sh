#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/native-app/Waynode.xcodeproj"
SCHEME="WaynodeUITests"
DESTINATION="${WAYNODE_UI_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0}"
RESULTS="${WAYNODE_UI_RESULTS:-$ROOT/_tmp/native-ui-matrix}"
TEST_ALLOWANCE="${WAYNODE_UI_TEST_TIMEOUT_SECONDS:-90}"
COMMAND_TIMEOUT="${WAYNODE_UI_COMMAND_TIMEOUT_SECONDS:-75}"

run_bounded() {
  local timeout_seconds="$1"
  shift
  python3 - "$timeout_seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
process = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    code = process.wait(timeout=timeout_seconds)
except subprocess.TimeoutExpired:
    print(f"TIMEOUT: command exceeded {timeout_seconds:.0f}s", flush=True)
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    raise SystemExit(124)
raise SystemExit(code)
PY
}

tests=(
  "SignedKeychainUITests/testSignedAppCanWriteReadAndDeleteKeychainItem"
  "WaynodeUITests/testSignedOutAuthAndServerConfiguration"
  "WaynodeUITests/testCloneCreatesAWorktreeAndDismisses"
  "WaynodeUITests/testWorktreeDeletionCanCancelAndConfirm"
  "WaynodeUITests/testAccountSheetOpensAndClosesFromWorkbench"
  "WaynodeUITests/testAccountBillingAndTokenCreationUseProductionSheets"
  "WaynodeUITests/testAccountSelfHostedBillingIsExplicit"
  "WaynodeUITests/testTokenRevocationCanCancelAndConfirm"
  "WaynodeUITests/testLogoutCanCancelAndConfirm"
  "WaynodeUITests/testNewSessionSupportsCancelAndCreation"
  "WaynodeUITests/testSessionListDeletionCanCancelAndConfirm"
  "WaynodeUITests/testSessionSettingsSupportsCloseAndDeleteConfirmation"
  "WaynodeUITests/testGitFileDiffCommitAndBranchSwitch"
  "WaynodeUITests/testGitSheetOpensAndClosesFromSession"
  "WaynodeUITests/testTerminalFailureAndExitStatesAreRecoverable"
)

if [[ -n "${WAYNODE_UI_ONLY:-}" ]]; then
  IFS=',' read -r -a tests <<< "$WAYNODE_UI_ONLY"
fi

rm -rf "$RESULTS"
mkdir -p "$RESULTS"

echo "Running signed native UI matrix build"
run_bounded 600 xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -parallel-testing-enabled NO \
  build-for-testing

passed=0
failed=0
for index in "${!tests[@]}"; do
  test_name="${tests[$index]}"
  safe_name="${test_name//\//-}"
  result="$RESULTS/$safe_name.xcresult"
  log="$RESULTS/$safe_name.log"
  echo "Running test $((index + 1))/${#tests[@]}: $test_name"
  if run_bounded "$COMMAND_TIMEOUT" xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "$DESTINATION" \
      -parallel-testing-enabled NO \
      -collect-test-diagnostics never \
      -test-timeouts-enabled YES \
      -default-test-execution-time-allowance "$TEST_ALLOWANCE" \
      -maximum-test-execution-time-allowance "$TEST_ALLOWANCE" \
      -only-testing:"WaynodeUITests/$test_name" \
      -resultBundlePath "$result" \
      test-without-building 2>&1 | tee "$log"; then
    passed=$((passed + 1))
    echo "PASS $passed/${#tests[@]}: $test_name"
  else
    failed=$((failed + 1))
    echo "FAIL $failed: $test_name"
  fi
done

echo "DONE: signed native UI matrix passed $passed/${#tests[@]}, failed $failed"
test "$failed" -eq 0
