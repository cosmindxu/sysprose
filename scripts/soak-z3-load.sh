#!/usr/bin/env bash
# The z3 soak's load case, as the header of test/campaign/z3-soak.soak.ts
# describes it: N copies of the soak at once on the drone-swarm v9 model, beside
# busy loops that take the cores. Only a loaded machine meets the finalizer race
# the soak looks for, so a lone `npm run soak:z3` does not show it.
#
#   scripts/soak-z3-load.sh              # 5 soaks, 12 busy loops, 1000 checks, 25 iterations
#   PROCS=2 LOOPS=4 ITERATIONS=3 CHECKS=200 scripts/soak-z3-load.sh   # a short try
#
# Exits 0 when every soak passed, else the number of soaks that failed. Each
# soak's output is kept in $OUT (default: a fresh directory under $TMPDIR).
# The loops are killed by PID on exit, never with `pkill -f`, which would take
# other node processes with them.
set -uo pipefail

PROCS=${PROCS:-5}
LOOPS=${LOOPS:-12}
CHECKS=${CHECKS:-1000}
ITERATIONS=${ITERATIONS:-25}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/z3-soak-load.XXXXXX")}
P=SurveillanceDroneSwarm
MEASURES="$P::LA::areaUnderWatchFraction,$P::PA::areaUnderWatchFraction,$P::LA::coverageUnderMeshJammingFraction,$P::PA::coverageLossAfterMemberLossFraction"

LOAD=()
SOAKS=()
cleanup() { [[ ${#LOAD[@]} -gt 0 ]] && kill "${LOAD[@]}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT"
for _ in $(seq "$LOOPS"); do
  timeout 7200 node -e 'for(;;){}' &
  LOAD+=($!)
done
echo "load: $LOOPS busy loops (PIDs ${LOAD[*]}); $PROCS soaks of $CHECKS checks x $ITERATIONS iterations; logs in $OUT"
for i in $(seq "$PROCS"); do
  SYSPROSE_SOAK=1 NODE_OPTIONS=--expose-gc SYSPROSE_SOAK_CHECKS="$CHECKS" SYSPROSE_SOAK_ITERATIONS="$ITERATIONS" \
    SYSPROSE_SOAK_MODEL=test/fixtures/drone-swarm-v9.sysml.txt SYSPROSE_SOAK_MEASURES="$MEASURES" \
    npx vitest run test/campaign/z3-soak.soak.ts >"$OUT/soak-$i.log" 2>&1 &
  SOAKS+=($!)
done
failed=0
for pid in "${SOAKS[@]}"; do wait "$pid" || failed=$((failed + 1)); done
echo "soaks failed: $failed of $PROCS (logs in $OUT)"
exit "$failed"
