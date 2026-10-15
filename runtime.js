// Code injected at the top of every mini-app. It runs inside the sandboxed
// iframe and gives the app `window.host`, which proxies to Conjure over postMessage.

function runtimeMain(appInfo) {
  const pending = new Map();
  const listeners = {};
  let seq = 0;

  const call = (method, args) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    parent.postMessage({ __conjure: 1, id: seq, method, args }, '*');
  });

  const report = (message) => {
    parent.postMessage({ __conjure: 1, report: String(message).slice(0, 2000) }, '*');
  };

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== parent || !m || !m.__conjure) return;
    if (m.event) {
      for (const fn of listeners[m.event] || []) {
        try {
          fn(m.data);
        } catch (err) {
          console.error(`host.on('${m.event}') handler failed:`, err);
        }
      }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  });

  addEventListener('error', (e) => {
    report(`${e.message} (line ${e.lineno}:${e.colno})${e.error && e.error.stack ? '\n' + e.error.stack : ''}`);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report(`Unhandled promise rejection: ${r && r.stack ? r.stack : r}`);
  });
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    report(args.map((a) => (a && a.stack) || String(a)).join(' '));
    originalError(...args);
  };

  window.host = {
    app: Object.freeze(appInfo),
    ai: (opts) => call('ai', opts || {}),
    pickFiles: (opts) => call('pickFiles', opts || {}),
    speak: (text, opts) => call('speak', { ...(opts || {}), text: String(text) }),
    prefetchSpeech: (text, opts) => {
      call('prefetchSpeech', { ...(opts || {}), text: String(text) }).catch((err) => console.warn('prefetchSpeech failed:', err));
    },
    stopSpeaking: () => call('stopSpeaking', {}),
    voices: () => call('voices', {}),
    listen: (opts) => call('listen', opts || {}),
    stopListening: () => call('stopListening', {}),
    keepAwake: (on) => call('keepAwake', { on: on !== false }),
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return () => {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
      };
    },
    storage: {
      get: (key) => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      remove: (key) => call('storage.remove', { key }),
      keys: () => call('storage.keys', {}),
    },
  };

  // Web storage throws in an opaque-origin iframe. Swap in an in-memory
  // stand-in so a stray localStorage call degrades instead of crashing the app.
  const memoryStorage = () => {
    const data = new Map();
    return {
      getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
      setItem: (k, v) => data.set(String(k), String(v)),
      removeItem: (k) => data.delete(String(k)),
      clear: () => data.clear(),
      key: (i) => [...data.keys()][i] ?? null,
      get length() { return data.size; },
    };
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void window[name].length;
    } catch (err) {
      console.warn(`${name} is unavailable in Conjure apps (use host.storage); using a temporary in-memory copy.`, err.name);
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
    }
  }
}

export function buildRuntimeScript(appInfo) {
  return `<script>(${runtimeMain.toString()})(${JSON.stringify(appInfo).replace(/</g, '\\u003c')});</script>`;
}

// Inserts the runtime as the first thing in <head> so it runs before app code,
// without putting anything ahead of the doctype (which would force quirks mode).
export function injectRuntime(html, appInfo) {
  const script = buildRuntimeScript(appInfo);
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], () => head[0] + script);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], () => htmlTag[0] + '<head>' + script + '</head>');
  return script + html;
}
