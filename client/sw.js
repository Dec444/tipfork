/* TipFork service worker — offline shell caching for the PWA */
const CACHE = 'tipfork-v1';
const ASSETS = ['./index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API / payment / geocoding calls — always hit the network.
  if (url.pathname.startsWith('/api/') || url.host.includes('googleapis') || url.host.includes('braintree')) {
    return; // default network handling
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
