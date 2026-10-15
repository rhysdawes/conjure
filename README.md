# Conjure

Describe what you're trying to do; Conjure builds a small app for it with Claude and keeps it on your phone.

- Installable web app (Safari → Share → Add to Home Screen). No build step.
- Generated apps run in a sandboxed iframe and reach the mic, speaker, camera, AI and storage through `window.host` (see `prompts.js` for the API the generator is told about, `host.js` for the implementation).
- API keys and apps are stored only in the browser's IndexedDB on your device.

Run locally: `python3 -m http.server 8765` and open http://127.0.0.1:8765.
