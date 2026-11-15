#!/bin/bash
# Run on the Mac. Packs everything the agents need into one zip for the Windows laptop.
# Leaves out: node_modules, .next, git history, logs, run state, backups, local data, and every
# .env file (secrets). The one secret the agents need is ~/.config/job-hunter/agent.env:
# copy it yourself by USB, not through cloud storage.
set -euo pipefail
WORKSPACE="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$WORKSPACE/job-hunter/backups/job-hunting-for-windows.zip"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
cd "$WORKSPACE"
# Only what the agents read or write: the app code, resume sources, tools, rules, dedupe history.
zip -rq "$OUT" job-hunter resume-source tools applications CLAUDE.md REMOTE-ONLY-RULES.md job-search-history.json \
  -x "job-hunter/node_modules/*" "job-hunter/.next/*" "job-hunter/.git/*" "job-hunter/agent/logs/*" "job-hunter/agent/state/*" \
     "job-hunter/backups/*" "job-hunter/data/*" "job-hunter/.convex/*" "job-hunter/.vercel/*" "*/.env*" "*.DS_Store" "*.bak-*" "*/.venv/*"
ls -lh "$OUT"
echo "Copy that zip to the Windows laptop, then follow job-hunter/windows/README-FA.md"
