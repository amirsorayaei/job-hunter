#!/bin/bash
# Install (or remove) Job Hunter's background jobs on this Mac (launchd).
#
#   bash scripts/install-agents.sh            install / update
#   bash scripts/install-agents.sh --remove   uninstall everything
#
# The dashboard and database are online (Vercel + Convex cloud); only the
# agents run here. They talk to the cloud through AGENT_INGEST_URL in
# ~/.config/job-hunter/agent.env.
# Scheduled (Mac local time):
#   collector  every hour at :50   reads job boards, no tokens
#   frontend   every hour at :00   scores new frontend postings 
#   fullstack  every hour at :00   scores new full-stack postings 
#   explore    every hour at :15   web search for both tracks, only at the hours chosen in Settings
#   (company finder is not scheduled: add companies with `pnpm companies:import <list>`)
#   startups   daily at 18:00      searches for early-stage startups and small teams hiring
#   prep       every hour at :30   tailors resumes, writes emails for queued roles (no tokens when empty)
#
# The agents use your Claude Code login (Max plan). Pause them any time from
# the app's Settings page. Logs: agent/logs/.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(dirname "$(command -v node)")"
PREFIX="com.example.jobhunter"
ALL=(collector frontend fullstack explore companies prep startups)
# Jobs from earlier versions of this script (local backend and web included).
OLD=(agent.frontend agent.fullstack agent.prep backend web)

unload() {
  local plist="$AGENTS_DIR/$PREFIX.$1.plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
}

if [[ "${1:-}" == "--remove" ]]; then
  for name in "${ALL[@]}" "${OLD[@]}"; do unload "$name"; done
  echo "Removed all Job Hunter jobs."
  exit 0
fi

for name in "${OLD[@]}"; do unload "$name"; done
mkdir -p "$AGENTS_DIR" "$REPO/agent/logs"

# write_job NAME SCHEDULE_XML KEEPALIVE(true|false) WRAP(caffeinate|plain) ARGS...
write_job() {
  local name="$1" schedule="$2" keepalive="$3" wrap="$4"
  shift 4
  local plist="$AGENTS_DIR/$PREFIX.$name.plist"
  local args=""
  if [[ "$wrap" == "caffeinate" ]]; then
    args+="    <string>/usr/bin/caffeinate</string>"$'\n'"    <string>-i</string>"$'\n'
  fi
  for arg in "$@"; do args+="    <string>$arg</string>"$'\n'; done
  local keep=""
  if [[ "$keepalive" == "true" ]]; then
    keep="  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>"
  fi
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PREFIX.$name</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>CONVEX_AGENT_MODE</key><string>anonymous</string>
  </dict>
$schedule
$keep
  <key>StandardOutPath</key><string>$REPO/agent/logs/launchd-$name.out</string>
  <key>StandardErrorPath</key><string>$REPO/agent/logs/launchd-$name.err</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "  $name"
}

every_hour_at() {
  echo "  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>$1</integer></dict>"
}
daily_at() {
  echo "  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$1</integer><key>Minute</key><integer>0</integer></dict>"
}

echo "Installing jobs:"
write_job collector "$(every_hour_at 50)" false caffeinate "$NODE_BIN/pnpm" agent:collect
write_job frontend "$(every_hour_at 0)" false caffeinate "$NODE_BIN/pnpm" agent:score --track frontend
write_job fullstack "$(every_hour_at 0)" false caffeinate "$NODE_BIN/pnpm" agent:score --track fullstack
write_job explore "$(every_hour_at 15)" false caffeinate "$NODE_BIN/pnpm" agent:explore
write_job startups "$(daily_at 18)" false caffeinate "$NODE_BIN/pnpm" agent:startups
write_job prep "$(every_hour_at 30)" false caffeinate "$NODE_BIN/pnpm" agent:prep

cat <<'NOTE'

Done. Dashboard: https://job-hunter-lemon-seven.vercel.app
Pause or resume the agents from Settings. Logs are in agent/logs/.
NOTE
