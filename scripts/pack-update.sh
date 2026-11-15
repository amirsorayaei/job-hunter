#!/bin/bash
# Run on the Mac. Packs only the files that changed since the Windows copy was made.
#
#   bash scripts/pack-update.sh <base-commit>
#
# <base-commit> is the commit that was current when job-hunting-for-windows.zip was built.
# Output: backups/job-hunter-update.zip, laid out like the full zip (job-hunter/...), plus
# UPDATE-FILES.txt listing what to copy over and what to do afterwards.
set -euo pipefail
BASE="${1:?usage: pack-update.sh <base-commit>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/backups/job-hunter-update.zip"
cd "$REPO"
files="$(git diff --name-only --diff-filter=AMR "$BASE" HEAD | grep -v '^agent/state/' || true)"
deleted="$(git diff --name-only --diff-filter=D "$BASE" HEAD || true)"
[ -n "$files$deleted" ] || { echo "Nothing changed since $BASE"; exit 0; }
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/job-hunter"
printf '%s\n' "$files" | while IFS= read -r f; do [ -n "$f" ] && mkdir -p "$stage/job-hunter/$(dirname "$f")" && cp "$f" "$stage/job-hunter/$f"; done
{
  echo "Changed since $BASE (copy over the same paths inside ~/job-hunting/job-hunter):"
  printf '%s\n' "$files"
  if [ -n "$deleted" ]; then echo; echo "Delete these:"; printf '%s\n' "$deleted"; fi
  echo
  echo "Then run: pnpm install   (only if package.json changed), and  bash scripts/install-agents-linux.sh   (refreshes the cron schedule)"
} > "$stage/UPDATE-FILES.txt"
(cd "$stage" && zip -rq "$OUT" .)
ls -lh "$OUT"
cat "$stage/UPDATE-FILES.txt"
