// 極簡 Service Worker：快取 App 外殼，讓打卡系統可安裝到主畫面
// 注意：打卡與查詢資料一律走網路（fetch），不快取，避免資料不同步或過期
const CACHE = 'checkin-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
          caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/')) return;
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
