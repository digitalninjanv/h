const CACHE_NAME = 'png-to-svg-local-first-v1';
const RUNTIME_CACHE = 'png-to-svg-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        './',
        './manifest.webmanifest',
        './icon.svg',
      ]).catch(() => undefined),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/_next/webpack-hmr')) return;

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response && response.status === 200) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    } catch {
      const fallback = await caches.match('./');
      return fallback || Response.error();
    }
  })());
});
