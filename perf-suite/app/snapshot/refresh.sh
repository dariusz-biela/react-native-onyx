#!/bin/bash
# Regenerates perf-suite/app/generated/ from an Expensify/App checkout.
#
# Usage: refresh.sh <path-to-Expensify-App-checkout>
#
# The snapshot test is copied into the App's tests/unit for one Jest run, because only the App's own
# Jest setup can load ONYXKEYS, CONST and the derived configs with their path aliases. It is removed again
# whatever the run's outcome. Run it through the queue: agent-queue/queue.sh run -- perf-suite/app/snapshot/refresh.sh <app>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(cd "$HERE/../generated" && pwd)"
APP_DIR="$(cd "${1:?Usage: refresh.sh <path-to-Expensify-App-checkout>}" && pwd)"
TEST_FILE="$APP_DIR/tests/unit/PerfSuiteAppModelSnapshotTest.ts"

cp "$HERE/appModel.snapshot.ts" "$TEST_FILE"
trap 'rm -f "$TEST_FILE"' EXIT

SOURCE="$(git -C "$APP_DIR" rev-parse --short=12 HEAD) ($(git -C "$APP_DIR" log -1 --format=%cs))"

ONYX_ROOT="$(cd "$HERE/../../.." && pwd)"

# A checkout of this repo inside the App (the App's gitignored repo/ scratch folder, for one) carries a second
# package named react-native-onyx, which fails jest-haste-map's duplicate check. The flag replaces the App's
# own patterns, so they are restated.
(cd "$APP_DIR" && PERF_SUITE_SNAPSHOT_DIR="$OUT_DIR" PERF_SUITE_SNAPSHOT_SOURCE="$SOURCE" npx jest "$TEST_FILE" --silent     --modulePathIgnorePatterns '<rootDir>/.worktrees/' '<rootDir>/.claude/worktrees/' '<rootDir>/repo/' "$ONYX_ROOT/")

npx --prefix "$ONYX_ROOT" prettier --write "$OUT_DIR"/*.ts >/dev/null
echo "Wrote $OUT_DIR from Expensify/App $SOURCE"
