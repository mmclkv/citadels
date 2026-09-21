const CACHE_NAME = 'citadels-shell-v27';
// 语音 SDK（vendor/livekit-client.umd.min.js，近 600KB）故意不放进预缓存清单：
// 它只在第一次点「语音」时才动态加载，下面的运行时缓存会在那次请求后把它存下来。
// 放进 APP_SHELL 会让每个单机玩家都白白下载一遍。
const APP_SHELL = [
  './', './index.html', './manifest.json', './style.css',
  './themes/neon/theme.css', './themes/neon/manifest.js', './themes/theme-manager.js',
  './src/cards.js', './src/engine.js', './src/ai.js', './app.js',
  './icons/citadels.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // 房间列表和游戏状态不能使用离线缓存；WebSocket 也不会进入这里。
  if (new URL(request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then(cached => cached || caches.match('./index.html'))));
});
