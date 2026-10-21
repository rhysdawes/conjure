#!/bin/zsh
# Installs the Conjure server as a login item on this Mac: it starts at login,
# restarts if it crashes, and keeps the Mac from idle-sleeping while it runs.
# Re-run after changing conjure-server.mjs. Uninstall with: ./install-mac.sh --uninstall
set -euo pipefail

LABEL=com.conjure.server
DIR="$HOME/.conjure-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"
  echo "Conjure server removed."
  exit 0
fi

NODE=$(command -v node)
CLAUDE=$(command -v claude)
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
# launchd can't always read OneDrive folders, so run a copy from the home folder.
cp "${0:A:h}/conjure-server.mjs" "$DIR/conjure-server.mjs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>$DIR/conjure-server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONJURE_CLAUDE</key><string>$CLAUDE</string>
    <key>PATH</key><string>${CLAUDE:h}:${NODE:h}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/server.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -fsS http://127.0.0.1:8766/health >/dev/null && echo "Conjure server running. Log: $DIR/server.log"
HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "Your Claude Code link (paste into Conjure settings):"
echo "https://$HOST/#$(cat "$DIR/token")"
