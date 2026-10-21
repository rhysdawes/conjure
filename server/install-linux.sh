#!/bin/bash
# Installs the Conjure server on a Linux box with Caddy, fully walled off from
# everything else on it:
#   * a dedicated unprivileged `conjure` user (no sudo, no ssh keys) that owns
#     its own Claude Code install and login under /home/conjure
#   * a systemd service on 127.0.0.1:8766 that can't see any other home folder
#   * a Caddy site on an sslip.io name, so it gets HTTPS without DNS changes
# Run from this folder as a sudo-capable user: ./install-linux.sh
# Then sign Conjure in once with: sudo -iu conjure .local/bin/claude auth login
set -euo pipefail

SVC_USER=conjure
HOME_DIR=/home/$SVC_USER
CLAUDE=$HOME_DIR/.local/bin/claude
IP=$(curl -4 -fsS -m 10 ifconfig.me)
HOST="conjure.${IP//./-}.sslip.io"
CADDYFILE=/etc/caddy/Caddyfile

if ! id "$SVC_USER" >/dev/null 2>&1; then
  sudo useradd --create-home --shell /bin/bash "$SVC_USER"
fi
sudo chmod 700 "$HOME_DIR"

if ! sudo test -x "$CLAUDE"; then
  sudo -iu "$SVC_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

sudo install -d -o "$SVC_USER" -g "$SVC_USER" -m 700 "$HOME_DIR/conjure-server"
sudo install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$(dirname "$0")/conjure-server.mjs" "$HOME_DIR/conjure-server/conjure-server.mjs"

sudo tee /etc/systemd/system/conjure-server.service >/dev/null <<EOF
[Unit]
Description=Conjure server (claude -p behind a Messages API)
After=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$HOME_DIR/conjure-server
ExecStart=$(command -v node) $HOME_DIR/conjure-server/conjure-server.mjs
Environment=CONJURE_CLAUDE=$CLAUDE
Environment=PATH=$HOME_DIR/.local/bin:/usr/bin:/bin
Restart=always
RestartSec=3
# Walls: only its own home is visible and writable, no privilege escalation.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=tmpfs
BindPaths=$HOME_DIR
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable conjure-server
sudo systemctl restart conjure-server

if ! grep -q "^$HOST" "$CADDYFILE"; then
  sudo cp "$CADDYFILE" "$CADDYFILE.bak-conjure-$(date +%s)"
  sudo tee -a "$CADDYFILE" >/dev/null <<EOF

# Conjure server (server/conjure-server.mjs); token-protected, runs as user conjure
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
echo "https://$HOST/#$(sudo cat "$HOME_DIR/.conjure-server/token")"
