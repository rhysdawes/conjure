#!/bin/bash
# Installs the Conjure server on a Linux box with Caddy, fully walled off from
# everything else on it:
#   * a dedicated unprivileged `conjure` user (no sudo, no ssh keys) that owns
#     its own Claude Code install and login under /home/conjure
#   * a systemd service on 127.0.0.1:8766 that can't see any other home folder
#   * a voice service on 127.0.0.1:8767: natural voices (Kokoro) and
#     speech-to-text (Whisper), both on the CPU
#   * a Caddy site on an sslip.io name, so it gets HTTPS without DNS changes
# Run from this folder as a sudo-capable user: ./install-linux.sh
# Then sign Conjure in once with: sudo -iu conjure .local/bin/claude auth login
# For ElevenLabs voices, put CONJURE_ELEVENLABS_KEY=<key> in
# /home/conjure/.conjure-server/voice.env (mode 600, owned by conjure).
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
# Restart a service only when its code changed: a restart kills any build in progress.
RESTART=()
for pair in conjure-server.mjs:conjure-server voice_service.py:conjure-voice; do
  f=${pair%%:*}
  if ! sudo cmp -s "$(dirname "$0")/$f" "$HOME_DIR/conjure-server/$f"; then
    sudo install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$(dirname "$0")/$f" "$HOME_DIR/conjure-server/$f"
    RESTART+=("${pair##*:}")
  fi
done

# Python env and model files for the voice service, owned by the conjure user.
sudo -iu "$SVC_USER" bash -s <<'VOICE'
set -euo pipefail
[ -x ~/.local/bin/uv ] || (curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null)
cd ~/conjure-server
[ -d .venv ] || ~/.local/bin/uv venv -q --python 3.12 .venv
~/.local/bin/uv pip install -q --python .venv/bin/python kokoro-onnx faster-whisper
mkdir -p ~/voice-models && cd ~/voice-models
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -fsSL -o kokoro-v1.0.onnx "$BASE/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ] || curl -fsSL -o voices-v1.0.bin "$BASE/voices-v1.0.bin"
VOICE

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
sudo tee /etc/systemd/system/conjure-voice.service >/dev/null <<EOF
[Unit]
Description=Conjure voice service (Kokoro voices, Whisper transcription)
After=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$HOME_DIR/conjure-server
ExecStart=$HOME_DIR/conjure-server/.venv/bin/python $HOME_DIR/conjure-server/voice_service.py
Environment=HOME=$HOME_DIR
# Optional: CONJURE_ELEVENLABS_KEY=... turns on ElevenLabs voices (Kokoro otherwise).
EnvironmentFile=-$HOME_DIR/.conjure-server/voice.env
Restart=always
RestartSec=3
MemoryMax=4G
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
sudo systemctl enable --now conjure-server conjure-voice
if [ ${#RESTART[@]} -gt 0 ]; then sudo systemctl restart "${RESTART[@]}"; fi

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
