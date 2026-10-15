// Network-first for the app shell so updates land immediately; the cache keeps
// Conjure opening when the connection is poor.
const CACHE = 'conjure-shell-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'host.js', 'runtime.js', 'prompts.js', 'db.js',
  'vendor/anthropic.mjs', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('conjure-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async (err) => {
        const hit = await caches.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        console.warn('Offline and not cached:', url.pathname, err);
        throw err;
      }),
  );
});
