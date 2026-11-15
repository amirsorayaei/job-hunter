#!/bin/bash
# Install (or remove) Job Hunter's background jobs on Linux / WSL (cron).
# Same schedule as scripts/install-agents.sh does on the Mac, in this machine's local time.
#
#   bash scripts/install-agents-linux.sh            install / update
#   bash scripts/install-agents-linux.sh --remove   uninstall
#
# Never run this on two machines at once: both would spend your Claude limit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(dirname "$(command -v node)")"
BEGIN="# >>> job-hunter agents (managed by install-agents-linux.sh) >>>"
END="# <<< job-hunter agents <<<"

current="$(crontab -l 2>/dev/null || true)"
# Drop any previous managed block.
cleaned="$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} !skip{print} $0==e{skip=0}')"

if [[ "${1:-}" == "--remove" ]]; then
  printf '%s\n' "$cleaned" | crontab -
  echo "Removed Job Hunter jobs from cron."
  exit 0
fi

mkdir -p "$REPO/agent/logs"
job() { # MINUTE HOUR NAME ARGS...
  local minute="$1" hour="$2" name="$3"
  shift 3
  echo "$minute $hour * * * cd \"$REPO\" && PATH=\"$NODE_BIN:/usr/local/bin:/usr/bin:/bin\" CONVEX_AGENT_MODE=anonymous timeout 3h $NODE_BIN/pnpm $* >> agent/logs/cron-$name.log 2>&1"
}

block="$BEGIN
$(job 50 '2,5,8,11,14,17,20,23' collector agent:collect)
$(job 0 '0,3,6,9,12,15,18,21' frontend agent:score --track frontend)
$(job 0 '0,3,6,9,12,15,18,21' fullstack agent:score --track fullstack)
$(job 15 '*' explore agent:explore)
$(job 0 11 startups agent:startups)
$(job 30 '0,3,6,9,12,15,18,21' prep agent:prep)
$END"

printf '%s\n%s\n' "$cleaned" "$block" | crontab -
echo "Installed (system time zone: $(date +%Z)):"
crontab -l | sed -n "/$BEGIN/,/$END/p" | grep -v '^#' | awk '{print "  " $1 " " $2 "  " $NF}' | sed 's|>> agent/logs/cron-||; s|.log 2>&1||'
