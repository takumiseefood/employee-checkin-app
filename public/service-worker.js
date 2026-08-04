// 極簡 Service Worker：快取 App 外殼，讓打卡系統可安裝到主畫面
// 注意：打卡與查詢資料一律走網路（fetch），不快取，避免資料不同步或過期
//
// 快取策略：改為「網路優先，離線才退回快取」，並在每次成功取得網路回應時
// 順便更新快取。原本是「快取優先」，缺點是每次改版靜態檔案（style.css、app.js
// 等）後，只要使用者瀏覽器已經裝過舊版 Service Worker，就會一直讀到改版前的
// 舊快取，除非手動變更 CACHE 版本號才會生效——實務上很容易忘記更新版本號，
// 導致「程式碼已部署成功，但畫面看起來還是舊的」。改成網路優先後，只要使用者
// 裝置能連上網路，就一定拿到最新版本，只有離線時才會退回上一次成功快取的版本。
const CACHE = 'checkin-shell-v2';
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
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
