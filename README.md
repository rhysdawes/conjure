# Conjure

Describe what you're trying to do; Conjure builds a small app for it with Claude and keeps it on your phone.

- Installable web app (Safari → Share → Add to Home Screen). No build step.
- Generated apps run in a sandboxed iframe and reach the mic, speaker, camera, AI and storage through `window.host` (see `prompts.js` for the API the generator is told about, `host.js` for the implementation).
- API keys and apps are stored only in the browser's IndexedDB on your device.

Run locally: `python3 -m http.server 8765` and open http://127.0.0.1:8765.

## Run on your Claude Code login (no API key)

`server/conjure-server.mjs` answers Conjure's Claude requests with `claude -p`, so builds use your Claude plan. It runs on any machine that's logged in to Claude Code.

- **Linux box with Caddy** (what Conjure uses now): copy `server/` over and run `./install-linux.sh`. It sets up a systemd service and a Caddy site at `conjure.<ip-with-dashes>.sslip.io`, so no DNS changes are needed.
- **Mac**: run `./server/install-mac.sh`, then `tailscale funnel --bg 8766`.

Either script prints a link (`https://…/#<token>`) to paste into Conjure → Settings → Claude Code link. The token is the only thing protecting the machine, so keep it to yourself.
