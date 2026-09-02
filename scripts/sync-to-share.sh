#!/usr/bin/env bash
# Mirror the home-filesystem build back to the host-visible vboxsf share so the
# user can see all source, docs, tests, and results from the host. node_modules
# and .git are intentionally NOT synced (huge / vboxsf-hostile; the git repo
# lives only in home).
set -euo pipefail
# Maintainer defaults (VirtualBox guest); override with SRC=/DST= in the environment.
SRC="${SRC:-$HOME/sysprose/}"
DST="${DST:-/media/sf_Projects/Sysprose/}"
rsync -a \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.vite' \
  --exclude 'playwright-report/data' \
  "$SRC" "$DST"
echo "Synced home build -> share ($DST)"
