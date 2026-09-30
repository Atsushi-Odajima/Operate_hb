/* Operate service worker.
 * - App shell (HTML/JS/CSS/icons) is cached so the PWA opens offline.
 * - API responses are NEVER cached here: document data for offline use is stored explicitly in IndexedDB
 *   by the app, only for classifications the organization allows (see src/offline.ts).
 */
const SHELL = 'operate-shell-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/logo-horizontal.svg', '/app-icon-192.png', '/app-icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname) || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
