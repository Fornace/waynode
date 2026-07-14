#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/native-app/Waynode.xcodeproj"
DERIVED="$ROOT/_tmp/native-signed-gates"

rm -rf "$DERIVED"
mkdir -p "$DERIVED"

echo "[1/3] WaynodeCore tests"
swift test --package-path "$ROOT/native-app/WaynodeCore"

echo "[2/3] Signed physical-iOS build"
xcodebuild \
  -project "$PROJECT" \
  -scheme Waynode \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED/ios" \
  build

echo "[3/3] Signed Mac Catalyst build"
xcodebuild \
  -project "$PROJECT" \
  -scheme Waynode \
  -configuration Debug \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$DERIVED/mac" \
  build

for app in \
  "$DERIVED/ios/Build/Products/Debug-iphoneos/Waynode.app" \
  "$DERIVED/mac/Build/Products/Debug-maccatalyst/Waynode.app"; do
  test -d "$app"
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=2 "$app" 2>&1 \
    | grep -E '^(Identifier|Authority|TeamIdentifier)='
done

echo "DONE: core tests and both signed platform builds passed"
