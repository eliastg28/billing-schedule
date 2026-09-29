/**
 * =============================================================================
 *  CICLO DE TARJETAS · sw.js (Service Worker)
 * -----------------------------------------------------------------------------
 *  - Permite instalar la app en el celular y abrirla sin conexión.
 *  - Estrategia "red primero": con internet siempre carga la última versión;
 *    sin internet usa la copia guardada.
 *  - Abre la app al tocar una notificación de aviso.
 *  Sube CACHE_VERSION cuando cambie la lista de archivos.
 * =============================================================================
 */
const CACHE_VERSION = 'ciclo-tarjetas-v1';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/engine.js',
  './js/plan.js',
  './js/store.js',
  './js/backend.js',
  './js/notify.js',
  './js/config.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Solo archivos propios; Supabase, Mercado Pago y el CDN van directo a la red.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#inicio', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => c.url.startsWith(self.registration.scope));
      if (client) {
        client.navigate(target).catch(() => {});
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
