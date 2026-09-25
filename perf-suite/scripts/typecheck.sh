#!/bin/bash
# Type checks the suite against the declarations of the working tree's lib/, the way Expensify/App reads
# Onyx through `dist/*.d.ts` with skipLibCheck. Checking lib/ sources directly would check them under the
# suite's CustomTypeOptions augmentation, which lib/ is not written for.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ONYX_ROOT="$(cd "$HERE/.." && pwd)"
TSC="$ONYX_ROOT/node_modules/.bin/tsc"
TYPES_DIR="$HERE/.build/types"

rm -rf "$TYPES_DIR"
"$TSC" -p "$ONYX_ROOT/tsconfig.build.json" --outDir "$TYPES_DIR" --emitDeclarationOnly --noCheck
"$TSC" -p "$HERE/tsconfig.json" --noEmit
