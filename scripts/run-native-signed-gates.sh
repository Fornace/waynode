#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/native-app/Waynode.xcodeproj"
DERIVED="$ROOT/_tmp/native-signed-gates"
EXPECTED_TEAM_ID="2V6YSU4HFB"
EXPECTED_KEYCHAIN_GROUP="$EXPECTED_TEAM_ID.com.waynode.app"

# Xcode can create/refresh a development profile without a signed-in GUI
# account when App Store Connect API credentials are supplied by the caller.
# Keep credential paths and identifiers out of the repository itself.
AUTH_ARGS=()
if [[ -n "${ASC_KEY_PATH:-}" || -n "${ASC_KEY_ID:-}" || -n "${ASC_ISSUER_ID:-}" ]]; then
  : "${ASC_KEY_PATH:?ASC_KEY_PATH is required when using App Store Connect authentication}"
  : "${ASC_KEY_ID:?ASC_KEY_ID is required when using App Store Connect authentication}"
  : "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required when using App Store Connect authentication}"
  test -f "$ASC_KEY_PATH"
  AUTH_ARGS=(
    -authenticationKeyPath "$ASC_KEY_PATH"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  )
fi

verify_keychain_group() {
  local app="$1"
  local entitlements
  local actual_group
  entitlements="$(mktemp)"

  if ! codesign -d --entitlements :- "$app" >"$entitlements" 2>/dev/null; then
    rm -f "$entitlements"
    echo "ERROR: could not read signed entitlements from $app" >&2
    return 1
  fi
  if ! plutil -lint "$entitlements" >/dev/null; then
    rm -f "$entitlements"
    echo "ERROR: signed entitlements for $app are not a plist" >&2
    return 1
  fi

  actual_group="$(
    plutil -extract keychain-access-groups.0 raw \
      "$entitlements" 2>/dev/null || true
  )"
  if [[ "$actual_group" != "$EXPECTED_KEYCHAIN_GROUP" ]]; then
    rm -f "$entitlements"
    echo "ERROR: $app has keychain group '${actual_group:-missing}'; expected '$EXPECTED_KEYCHAIN_GROUP'" >&2
    return 1
  fi
  if plutil -extract keychain-access-groups.1 raw \
      "$entitlements" >/dev/null 2>&1; then
    rm -f "$entitlements"
    echo "ERROR: $app contains more than the single expected keychain group" >&2
    return 1
  fi

  rm -f "$entitlements"
  echo "KeychainAccessGroup=$actual_group"
}

rm -rf "$DERIVED"
mkdir -p "$DERIVED"

echo "[1/4] WaynodeCore tests"
swift test --package-path "$ROOT/native-app/WaynodeCore"

echo "[2/4] Signed physical-iOS build"
xcodebuild \
  -project "$PROJECT" \
  -scheme Waynode \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED/ios" \
  build

echo "[3/4] Signed Mac Catalyst build"
xcodebuild \
  -project "$PROJECT" \
  -scheme Waynode \
  -configuration Debug \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$DERIVED/mac" \
  build

echo "[4/4] Signed native macOS build"
run_native_mac_build() {
  xcodebuild \
    -project "$PROJECT" \
    -scheme WaynodeMac \
    -configuration Debug \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED/native-mac" \
    -allowProvisioningUpdates \
    "$@" \
    build
}

# macOS still ships Bash 3.2, where expanding an empty array under `set -u`
# raises "unbound variable". Keep the no-credential path explicit so the
# signed gate works both with an existing Xcode team session and ASC API auth.
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  run_native_mac_build "${AUTH_ARGS[@]}"
else
  run_native_mac_build
fi

for app in \
  "$DERIVED/ios/Build/Products/Debug-iphoneos/Waynode.app" \
  "$DERIVED/mac/Build/Products/Debug-maccatalyst/Waynode.app" \
  "$DERIVED/native-mac/Build/Products/Debug/Waynode.app"; do
  test -d "$app"
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=2 "$app" 2>&1 \
    | grep -E '^(Identifier|Authority|TeamIdentifier)='
  verify_keychain_group "$app"
done

echo "DONE: core tests and all three signed platform builds passed"
