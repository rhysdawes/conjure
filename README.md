# Conjure

Describe what you're trying to do; Conjure builds a small app for it with Claude and keeps it on your phone.

- Installable web app (Safari → Share → Add to Home Screen). No build step.
- Generated apps run in a sandboxed iframe and reach the mic, speaker, camera, AI and storage through `window.host` (see `prompts.js` for the API the generator is told about, `host.js` for the implementation).
- API keys and apps are stored only in the browser's IndexedDB on your device.

Run locally: `python3 -m http.server 8765` and open http://127.0.0.1:8765.

## Run on your Claude Code login (no API key)

`server/conjure-server.mjs` answers Conjure's Claude requests with `claude -p` on your computer, so builds use your Claude plan.

1. `./server/install-mac.sh`: starts it now and at every login, keeping the Mac awake while it runs.
2. `tailscale funnel --bg 8766`: gives it a public HTTPS address.
3. Paste the printed link (`https://<mac>.ts.net/#<token>`) into Conjure → Settings → Claude Code link.

The token in the link is the only thing protecting your machine, so keep it to yourself. Uninstall with `./server/install-mac.sh --uninstall`.
