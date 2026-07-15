#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export WAYNODE_UI_DESTINATION="${WAYNODE_UI_DESTINATION:-platform=iOS Simulator,name=iPad Pro 13-inch (M5),OS=27.0}"
export WAYNODE_UI_RESULTS="${WAYNODE_UI_RESULTS:-$ROOT/_tmp/native-ui-ipad-responsive}"
export WAYNODE_UI_ONLY="IPadResponsiveUITests/testRegularWidthWorkbenchSurvivesPortraitAndLandscape,IPadResponsiveUITests/testNewSessionSheetKeepsKeyboardAndActionsReachable,IPadResponsiveUITests/testGitReviewUsesRegularWidthForInlineDiff"

exec "$ROOT/scripts/run-native-ui-matrix.sh"
