#!/bin/bash
# Installs the Conjure server on a Linux box with Caddy: a systemd service on
# 127.0.0.1:8766 running as the current user (who must be logged in to Claude
# Code), plus a Caddy site for it on an sslip.io name, so it gets HTTPS without
# any DNS changes. Run from this folder: ./install-linux.sh
#
# Conjure gets its own Claude Code login (in ~/.claude-conjure), separate from
# the one you use on this box. Sign it in once with:
#   CLAUDE_CONFIG_DIR=~/.claude-conjure claude-local auth login
set -euo pipefail

DIR="$HOME/conjure-server"
# On the fdb boxes `claude` is a shim that runs calls on the credential box with
# the pipeline's pooled logins; `claude-local` is the genuine CLI on this box.
CLAUDE=$(command -v claude-local || command -v claude)
NODE=$(command -v node)
IP=$(curl -4 -fsS -m 10 ifconfig.me)
HOST="conjure.${IP//./-}.sslip.io"
CADDYFILE=/etc/caddy/Caddyfile

mkdir -p "$DIR"
cp "$(dirname "$0")/conjure-server.mjs" "$DIR/conjure-server.mjs"

sudo tee /etc/systemd/system/conjure-server.service >/dev/null <<EOF
[Unit]
Description=Conjure server (claude -p behind a Messages API)
After=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/conjure-server.mjs
Environment=CONJURE_CLAUDE=$CLAUDE
Environment=CLAUDE_CONFIG_DIR=$HOME/.claude-conjure
Environment=PATH=$(dirname "$CLAUDE"):$(dirname "$NODE"):/usr/bin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now conjure-server
sudo systemctl restart conjure-server

if ! grep -q "^$HOST" "$CADDYFILE"; then
  sudo cp "$CADDYFILE" "$CADDYFILE.bak-conjure-$(date +%s)"
  sudo tee -a "$CADDYFILE" >/dev/null <<EOF

# Conjure server (server/conjure-server.mjs); token-protected, see ~/.conjure-server/token
$HOST {
    reverse_proxy 127.0.0.1:8766
}
EOF
  sudo caddy validate --config "$CADDYFILE" --adapter caddyfile
  sudo systemctl reload caddy
fi

sleep 2
curl -fsS http://127.0.0.1:8766/health >/dev/null && echo "Conjure server running (journalctl -u conjure-server -f)"
echo "Your Claude Code link (paste into Conjure settings):"
echo "https://$HOST/#$(cat "$HOME/.conjure-server/token")"
