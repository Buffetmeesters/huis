// Minimale service worker: maakt installeren als app mogelijk. Alles komt gewoon live van de server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
