// Service worker：讓 App 在沒有網路時也能開啟。
// 採「網路優先」：有網路時永遠取得最新版本，沒網路才使用快取。
// 這裡只快取程式檔案；信用卡資料存在 localStorage，不經過 service worker。

const CACHE = 'credit-card-app-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './billing.js',
  './calendar.js',
  './store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request, { ignoreSearch: true })
          .then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined))
          .then((cached) => cached || Response.error()),
      ),
  );
});
