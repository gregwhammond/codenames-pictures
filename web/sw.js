// Service worker: keeps the app shell and card pictures available offline so
// the game loads instantly on repeat visits. Game state always comes live
// from the server.
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;
const CARDS = 'cards-v1';
const LARGE = 'cards-large-v1';
const LARGE_MAX = 150; // zoom pictures are big: keep only the most recent
const SHELL_FILES = [
  '/',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== CARDS && k !== LARGE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // The dev harness page is a navigation too; keep it out of the shell cache.
  if (url.pathname === '/dev' || url.pathname === '/dev.html') return;

  // Pictures never change for a given name: cache first.
  if (url.pathname.startsWith('/cards/')) {
    event.respondWith(
      caches.open(CARDS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Zoom-size pictures: cache first too, in their own trimmed cache.
  if (url.pathname.startsWith('/cards-large/')) {
    event.respondWith(
      caches.open(LARGE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache, LARGE_MAX)));
        return res;
      }),
    );
    return;
  }

  // App shell: network first so updates land right away, cache when offline.
  const key = req.mode === 'navigate' ? '/' : req;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(key, res.clone()));
        return res;
      })
      .catch(() => caches.match(key)),
  );
});

// Drop the oldest entries (cache keys come back in insertion order).
async function trim(cache, max) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}
