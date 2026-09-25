#!/bin/bash
# Runs the perf suite once, for one arm and one round, into one NDJSON file.
#
# Usage: run-arm.sh <arm-dir> <round> <run-id> [--filter pattern] [--files pattern] [--scale small|medium|large|heavy]
#
# <arm-dir> is a built Onyx dist (scripts/build-arm.sh prints one). The arm label in the results is the
# directory's parent folder name unless ONYX_PERF_ARM_LABEL sets it.
# --filter narrows the scenarios a suite file registers; every suite file is still loaded.
# --files is a regular expression over suite file paths, so only the matching suite files are loaded at all.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/queue.sh"
hold_queue_slot "$0" "$@"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 3 ]]; then
    echo "Usage: run-arm.sh <arm-dir> <round> <run-id> [--filter pattern] [--files pattern] [--scale small|medium|large|heavy]" >&2
    exit 2
fi

ARM_DIR="$(cd "$1" && pwd -P)"
ROUND="$2"
RUN_ID="$3"
shift 3

FILTER=""
FILES=""
SCALE="${ONYX_PERF_SCALE:-medium}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --filter)
            FILTER="$2"
            shift 2
            ;;
        --files)
            FILES="$2"
            shift 2
            ;;
        --scale)
            SCALE="$2"
            shift 2
            ;;
        *)
            echo "run-arm: unknown option $1" >&2
            exit 2
            ;;
    esac
done

# ab.sh --aa points both arms at the same build, so the label has to be settable on its own.
ARM="${ONYX_PERF_ARM_LABEL:-$(basename "$(dirname "$ARM_DIR")")}"

if [[ ! -f "$ARM_DIR/index.js" ]]; then
    echo "run-arm: $ARM_DIR/index.js is missing. Build the arm with scripts/build-arm.sh first." >&2
    exit 1
fi

# One worker, recycled once a test file leaves it above the memory limit. In-band, every test file's
# module registry stayed reachable and the heap grew to 5-6 GB over a run, so every collection between
# iterations and every full collection after a warm-up got slower file after file.
# ONYX_PERF_WORKER_MEMORY=0 restores the in-band run.
WORKER_MEMORY="${ONYX_PERF_WORKER_MEMORY:-1500MB}"
if [[ "$WORKER_MEMORY" == "0" ]]; then
    WORKER_ARGS=(--runInBand)
else
    WORKER_ARGS=(--maxWorkers 1)
fi

RESULTS_FILE="$HERE/results/$RUN_ID/$ARM-$SCALE-round$ROUND.ndjson"
mkdir -p "$(dirname "$RESULTS_FILE")"

cd "$HERE"

# --expose-gc for the harness. ONYX_PERF_NODE_FLAGS appends V8 flags, for experiments with the JIT tiers.
TZ=utc \
NODE_OPTIONS="--expose-gc --experimental-vm-modules --max_old_space_size=8192 ${ONYX_PERF_NODE_FLAGS:-}" \
ONYX_PERF_ARM="$ARM" \
ONYX_PERF_WORKER_MEMORY="$WORKER_MEMORY" \
ONYX_PERF_ARM_DIR="$ARM_DIR" \
ONYX_PERF_ROUND="$ROUND" \
ONYX_PERF_RUN_ID="$RUN_ID" \
ONYX_PERF_SCALE="$SCALE" \
ONYX_PERF_FILTER="$FILTER" \
ONYX_PERF_FILES="$FILES" \
ONYX_PERF_RESULTS_FILE="$RESULTS_FILE" \
    "$HERE/../node_modules/.bin/jest" --config "$HERE/jest.config.js" "${WORKER_ARGS[@]}" --silent --json --outputFile "${RESULTS_FILE%.ndjson}.jest.json"

echo "$RESULTS_FILE"
