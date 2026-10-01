#!/usr/bin/env bash
# Run E2E specs on a machine kept busy on purpose. Some flakes only show up in a
# loaded full-suite run: a click racing React Flow's scroll reset, a layout
# landing late. N busy loops take N cores while Playwright runs the given specs
# 8 times each, which provokes them in minutes instead of once a week in CI.
#
#   scripts/e2e-under-load.sh 12 diagram-control-nodes diagram-create-connect
#   REPEAT=4 scripts/e2e-under-load.sh 12 deep-modeling-workflow
#
# The preview on :4173 must already be up (`npm run build && npm run preview`).
# With nothing there, Playwright's webServer runs `npm run build`, which wipes
# a dist/model/ copied in by hand. The loops are killed by PID on exit, never
# with `pkill -f`, which would take other node processes with them.
set -euo pipefail

if [[ $# -lt 2 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <busy-loops> <spec>..." >&2
  exit 2
fi
LOOPS=$1
shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! curl -sf -o /dev/null http://localhost:4173; then
  echo "No preview on :4173. Start it first: npm run build && npm run preview" >&2
  exit 1
fi

LOAD=()
cleanup() { [[ ${#LOAD[@]} -gt 0 ]] && kill "${LOAD[@]}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# `timeout` caps each loop in case this script is killed before its trap runs.
for _ in $(seq "$LOOPS"); do
  timeout 3600 node -e 'for(;;){}' &
  LOAD+=($!)
done
echo "load: $LOOPS busy loops (PIDs ${LOAD[*]}); $(uptime)"

cd "$ROOT"
status=0
npx playwright test --config="$ROOT/playwright.config.ts" --repeat-each "${REPEAT:-8}" "$@" || status=$?
echo "after: $(uptime)"
exit "$status"
