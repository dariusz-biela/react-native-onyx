#!/bin/bash
# Baseline against candidate, at every scale of the run.
#
# Usage: ab.sh [--baseline-ref REF | --baseline-dir DIR] [--candidate-ref REF | --candidate-dir DIR]
#              [--scales small,large,heavy] [--scale NAME] [--rounds N] [--filter pattern] [--files pattern]
#              [--aa] [--classic]
#
# The baseline is lib/ as committed at --baseline-ref (default HEAD), the candidate is the working tree's
# lib/, so an uncommitted change is measured against the commit it sits on. --candidate-ref measures a
# committed candidate instead, and --baseline-dir / --candidate-dir take any prebuilt dist, a published
# npm build for one. See scripts/build-arm.sh.
#
# The default is hot-swap mode: both arms load into ONE Jest process per scale and are measured
# iteration by iteration in lockstep, see harness/hotswap/. Each arm's samples are split into --rounds
# consecutive blocks (default 4) and every block is written as a round, so the report reads the same as
# a multi-process run. One process per scale, one scale after the other: never run suite processes in
# parallel, they would contend for cores and memory.
#
# --classic is the older mode: one Jest process per arm and round, in ABBA order (default 2 rounds),
# one scale after the other. It is several times slower and carries the between-process spread.
#
# --scales takes a comma-separated list of profiles from harness/scale.ts; --scale NAME is a shortcut for
# a single one. --filter narrows the scenarios a suite file registers; --files is a regular expression over
# suite file paths, so only the matching suite files are loaded at all.
#
# --aa replaces the candidate with a second copy of the baseline, which turns the report into a
# noise floor: every scenario should land near 0%.
#
# The script takes the machine-wide queue slot (agent-queue/queue.sh) for its whole run.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/queue.sh"
hold_queue_slot "$0" "$@"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ROUNDS=""
IS_CLASSIC=false
BASELINE_REF="HEAD"
BASELINE_DIR_OVERRIDE=""
CANDIDATE_REF=""
CANDIDATE_DIR_OVERRIDE=""
FILTER=""
FILES=""
SCALES="small,large,heavy"
IS_AA=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rounds)
            ROUNDS="$2"
            shift 2
            ;;
        --filter)
            FILTER="$2"
            shift 2
            ;;
        --files)
            FILES="$2"
            shift 2
            ;;
        --scale | --scales)
            SCALES="$2"
            shift 2
            ;;
        --aa)
            IS_AA=true
            shift
            ;;
        --classic)
            IS_CLASSIC=true
            shift
            ;;
        --baseline-ref)
            BASELINE_REF="$2"
            shift 2
            ;;
        --candidate-ref)
            CANDIDATE_REF="$2"
            shift 2
            ;;
        --baseline-dir)
            BASELINE_DIR_OVERRIDE="$2"
            shift 2
            ;;
        --candidate-dir)
            CANDIDATE_DIR_OVERRIDE="$2"
            shift 2
            ;;
        *)
            echo "ab: unknown option $1" >&2
            exit 2
            ;;
    esac
done

if [[ -z "$ROUNDS" ]]; then
    if [[ "$IS_CLASSIC" == true ]]; then
        ROUNDS=2
    else
        ROUNDS=4
    fi
fi

IFS=',' read -r -a SCALE_LIST <<< "$SCALES"

if [[ -n "$BASELINE_DIR_OVERRIDE" ]]; then
    BASELINE_DIR="$BASELINE_DIR_OVERRIDE"
else
    echo "== Building baseline ($BASELINE_REF) =="
    BASELINE_DIR="$("$HERE/scripts/build-arm.sh" baseline --ref "$BASELINE_REF" | tail -n 1)"
fi

if [[ "$IS_AA" == true ]]; then
    CANDIDATE_DIR="$BASELINE_DIR"
    echo "== A/A run: both arms are $BASELINE_DIR =="
elif [[ -n "$CANDIDATE_DIR_OVERRIDE" ]]; then
    CANDIDATE_DIR="$CANDIDATE_DIR_OVERRIDE"
elif [[ -n "$CANDIDATE_REF" ]]; then
    echo "== Building candidate ($CANDIDATE_REF) =="
    CANDIDATE_DIR="$("$HERE/scripts/build-arm.sh" candidate --ref "$CANDIDATE_REF" | tail -n 1)"
else
    echo "== Building candidate (working tree) =="
    CANDIDATE_DIR="$("$HERE/scripts/build-arm.sh" candidate | tail -n 1)"
fi

echo "== baseline $BASELINE_DIR vs candidate $CANDIDATE_DIR =="

# The hot-swap runtime requires the arms by the paths handed over, so relative overrides are made absolute here.
BASELINE_DIR="$(cd "$BASELINE_DIR" && pwd -P)"
CANDIDATE_DIR="$(cd "$CANDIDATE_DIR" && pwd -P)"

# Jest's module registry is keyed by path, so two hot-swap arms at the same path would share one Onyx
# instance and the candidate's reset would wipe the baseline's subscriptions. An A/A gets a clone instead.
# Two refs that resolve to one commit share one cached build, so they get the same treatment.
if [[ "$CANDIDATE_DIR" == "$BASELINE_DIR" && "$IS_CLASSIC" == false ]]; then
    CANDIDATE_DIR="$BASELINE_DIR-aa"
    rm -rf "$CANDIDATE_DIR"
    cp -Rc "$BASELINE_DIR" "$CANDIDATE_DIR"
    echo "== Same build on both arms: candidate is a clone at $CANDIDATE_DIR =="
fi

# A third, unmeasured copy takes the import-time Onyx traffic of the harness, so neither measured arm carries
# its type feedback; see LOADER_ARM in harness/hotswap/runtime.js. Any build works, the baseline is at hand.
LOADER_DIR="$BASELINE_DIR-loader"
if [[ "$IS_CLASSIC" == false ]]; then
    rm -rf "$LOADER_DIR"
    cp -Rc "$BASELINE_DIR" "$LOADER_DIR"
fi

RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
if [[ "$IS_AA" == true ]]; then
    RUN_ID="$RUN_ID-aa"
fi
if [[ "$IS_CLASSIC" == true ]]; then
    RUN_ID="$RUN_ID-classic"
fi
RUN_DIR="$HERE/results/$RUN_ID"
mkdir -p "$RUN_DIR"

arm_args() {
    local scale="$1"
    local args=(--scale "$scale")

    if [[ -n "$FILTER" ]]; then
        args+=(--filter "$FILTER")
    fi
    if [[ -n "$FILES" ]]; then
        args+=(--files "$FILES")
    fi

    printf '%s\n' "${args[@]}"
}

# Jest's own output goes to a log per arm, scale and round, so the terminal only shows progress.
run_arm() {
    local label="$1"
    local arm_dir="$2"
    local round="$3"
    local scale="$4"
    local log="$RUN_DIR/$label-$scale-round$round.log"
    local args=()

    while IFS= read -r arg; do
        args+=("$arg")
    done < <(arm_args "$scale")

    if ! ONYX_PERF_ARM_LABEL="$label" caffeinate -i "$HERE/scripts/run-arm.sh" "$arm_dir" "$round" "$RUN_ID" "${args[@]}" >/dev/null 2>"$log"; then
        echo "ab: $label, $scale, round $round failed, see $log" >&2
        tail -n 40 "$log" >&2
        return 1
    fi
}

run_hotswap_scale() {
    local scale="$1"
    local started_at=$SECONDS

    ONYX_PERF_HOTSWAP_ARMS="$(printf '{"loader":"%s","baseline":"%s","candidate":"%s"}' "$LOADER_DIR" "$BASELINE_DIR" "$CANDIDATE_DIR")" \
    ONYX_PERF_HOTSWAP_ROUNDS="$ROUNDS" \
        run_arm hotswap "$BASELINE_DIR" 1 "$scale"

    echo "-- $scale done in $((SECONDS - started_at)) s --"
}

run_classic_scale() {
    local scale="$1"

    # ABBA: the order flips every round so a warm-up or thermal drift hits both arms equally.
    for ((round = 1; round <= ROUNDS; round++)); do
        echo "-- $scale, round $round --"
        if ((round % 2 == 1)); then
            run_arm baseline "$BASELINE_DIR" "$round" "$scale"
            run_arm candidate "$CANDIDATE_DIR" "$round" "$scale"
        else
            run_arm candidate "$CANDIDATE_DIR" "$round" "$scale"
            run_arm baseline "$BASELINE_DIR" "$round" "$scale"
        fi
    done
}

STARTED_AT=$SECONDS

if [[ "$IS_CLASSIC" == true ]]; then
    for scale in "${SCALE_LIST[@]}"; do
        run_classic_scale "$scale"
    done
else
    echo "-- hotswap, $ROUNDS blocks, scales ${SCALE_LIST[*]} --"
    for scale in "${SCALE_LIST[@]}"; do
        run_hotswap_scale "$scale"
    done
fi

echo "== Comparing ($((SECONDS - STARTED_AT)) s measured) =="
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$HERE/scripts/compare.ts" "$RUN_ID"
