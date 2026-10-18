/* Service worker de Soles.
 * Estrategia "red primero": siempre intenta traer la versión más nueva de la app y de los datos;
 * solo si no hay internet usa la última copia guardada (modo offline).
 * Solo maneja peticiones GET del mismo sitio: nunca guarda nada de terceros. */
'use strict';
const VERSION = 'soles-v2';
const SHELL = [
  './', './index.html', './css/styles.css', './js/app.js', './manifest.webmanifest',
  './data/data.json', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
