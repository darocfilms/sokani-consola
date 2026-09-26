/* sw.js — la consola funciona sin conexión.
   En un set no siempre hay wifi: una vez abierta con red, todo lo necesario
   queda guardado en el dispositivo.
   · Navegación: red primero, caché si no hay red — con wifi siempre llega la
     última versión; sin wifi, la última que se guardó.
   · Recursos: caché primero y se refrescan por detrás, así la consola abre al
     instante aunque la red sea lenta. */
const VERSION = 'sokani-38';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/brands.js', 'js/protocols.js', 'js/lights.js', 'js/native-bridge.js',
  'js/effects.js', 'js/ble.js', 'js/app.js', 'js/pwa.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// La página pide activar la versión nueva cuando el usuario acepta recargar.
self.addEventListener('message', (e) => { if (e.data === 'activar') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copia = r.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copia));
          return r;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Los recursos van versionados con ?v=N; se guardan sin la consulta para que
  // una versión nueva sustituya a la vieja en vez de acumularse.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const guardado = await c.match(req, { ignoreSearch: true });
    const red = fetch(req)
      .then((r) => { if (r.ok) c.put(req.url.split('?')[0], r.clone()); return r; })
      .catch(() => guardado);
    return guardado || red;
  }));
});
