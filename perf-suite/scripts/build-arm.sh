#!/bin/bash
# Builds one arm of the perf suite.
#
# Usage: build-arm.sh <name>              the working tree's lib/, uncommitted changes included
#        build-arm.sh <name> --ref <ref>  lib/ as committed at <ref>, into .build/ref-<sha>/dist, cached per commit
#
# Prints the built directory on the last line. The build skips type checking (`--noCheck`) and declarations:
# the arm only has to run, and a type error in an old ref must not block a benchmark of it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ONYX_ROOT="$(cd "$HERE/.." && pwd)"
TSC="$ONYX_ROOT/node_modules/.bin/tsc"

if [[ $# -lt 1 ]]; then
    echo "Usage: build-arm.sh <name> [--ref <ref>]" >&2
    exit 2
fi

NAME="$1"
shift
REF=""


while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)
            REF="$2"
            shift 2
            ;;
        *)
            echo "build-arm: unknown option $1" >&2
            exit 2
            ;;
    esac
done

build() {
    local tsconfig="$1"
    local out_dir="$2"

    rm -rf "$out_dir"
    "$TSC" -p "$tsconfig" --outDir "$out_dir" --noCheck --declaration false

    if [[ ! -f "$out_dir/index.js" ]]; then
        echo "build-arm: $out_dir/index.js is missing after the build" >&2
        exit 1
    fi
}

if [[ -z "$REF" ]]; then
    TARGET="$HERE/.build/$NAME/dist"
    build "$ONYX_ROOT/tsconfig.build.json" "$TARGET"
    echo "Built the working tree -> $TARGET" >&2
    echo "$TARGET"
    exit 0
fi

SHA="$(git -C "$ONYX_ROOT" rev-parse --verify "$REF^{commit}")"
REF_DIR="$HERE/.build/ref-$SHA"
TARGET="$REF_DIR/dist"

if [[ ! -f "$TARGET/index.js" ]]; then
    rm -rf "$REF_DIR"
    mkdir -p "$REF_DIR/src"
    git -C "$ONYX_ROOT" archive "$SHA" lib tsconfig.json tsconfig.build.json | tar -x -C "$REF_DIR/src"
    build "$REF_DIR/src/tsconfig.build.json" "$TARGET"
    echo "Built $REF ($SHA) -> $TARGET" >&2
else
    echo "Reusing $REF ($SHA) -> $TARGET" >&2
fi

echo "$TARGET"
