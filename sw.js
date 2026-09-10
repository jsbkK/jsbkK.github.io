/**
 * Service Worker —— gamezone-v6
 *
 * 关键背景：旧站 8/9 个页面注册过 /sw.js（gamezone-cache-v5，缓存优先）。
 * 如果新站不在根路径提供 /sw.js，浏览器不会卸载旧 SW，用户可能一直看到旧页面。
 * 所以本文件必须存在，并在 activate 阶段清掉所有非当前版本的缓存。
 *
 * 策略：
 *  - /_astro/*（带内容哈希的构建产物）与 /fonts/* ：Cache-First
 *  - HTML 导航请求：Network-First，离线时回退缓存，再回退 /offline/
 */

const VERSION = 'gamezone-v6';
const OFFLINE_URL = '/offline/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // 预缓存离线兜底页；失败不影响安装
      await Promise.allSettled([cache.add(OFFLINE_URL)]);
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== VERSION)
          // 重点：删掉旧站遗留的 gamezone-cache-v5 等全部旧缓存
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 构建产物与字体：内容不可变，缓存优先
  if (url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // HTML 导航：网络优先，离线兜底
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached;
          const offline = await cache.match(OFFLINE_URL);
          return offline || Response.error();
        }
      })()
    );
  }
});
