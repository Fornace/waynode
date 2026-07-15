#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export WAYNODE_UI_ONLY="${WAYNODE_UI_ONLY:-WaynodeUITests/testCoreWorkbenchPassesFocusedAccessibilityAudit,WaynodeUITests/testLongContentAtAccessibilityTextSizeKeepsCoreActionsAvailable}"
export WAYNODE_UI_RESULTS="${WAYNODE_UI_RESULTS:-$ROOT/_tmp/native-ui-accessibility}"

exec "$ROOT/scripts/run-native-ui-matrix.sh"
