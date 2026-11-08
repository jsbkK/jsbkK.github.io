/**
 * Service Worker —— gamezone-v12
 *
 * 关键背景：旧站 8/9 个页面注册过 /sw.js（gamezone-cache-v5，缓存优先）。
 * 如果新站不在根路径提供 /sw.js，浏览器不会卸载旧 SW，用户可能一直看到旧页面。
 * 所以本文件必须存在，并在 activate 阶段清掉所有非当前版本的缓存。
 *
 * 策略：
 *  - /_astro/*、/fonts/*、/guides/*、/images/*、/screenshots/*（不可变静态资源）：Cache-First
 *  - /search-index.json：Stale-While-Revalidate（命中即返，后台用 waitUntil 刷新）
 *  - HTML 导航请求：Network-First（有网取最新版并写回缓存，断网回退缓存再回退 /offline/）
 *  - 绝不对 HTML 导航 / *.html / *.json 用 Cache-First（文章页与索引必须能更新）
 */

const VERSION = 'gamezone-v12';
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

  // 构建产物、字体与不可变静态图片：内容不可变，缓存优先。
  // isDoc 保护：HTML 导航与 *.html / *.json 绝不进 Cache-First，否则 /guides/xxx/
  // 这类文章页（navigate）会被缓存优先挡住，每天发文后用户永远看到旧页面。
  const isAsset =
    url.pathname.startsWith('/_astro/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/guides/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.startsWith('/screenshots/');
  const isDoc =
    request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json');
  if (isAsset && !isDoc) {
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

  // /search-index.json（构建期生成，单文件约 647KB）：Stale-While-Revalidate。
  // 命中缓存立即返回，同时后台刷新；未命中走网络并写回；断网无缓存交给前端兜底文案。
  // ★ 历史坑：后台刷新必须包在 event.waitUntil 里。项目之前用过裸的
  //   fetch().then(cache.put)：respondWith 一旦兑现，浏览器随时可能回收 SW，
  //   cache.put 被打断，缓存永不更新，于是每天发文后用户一直拿到旧索引。
  //   waitUntil 会延长 SW 生命周期直到后台写入完成，绝不能省。
  if (url.pathname === '/search-index.json') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const hit = await cache.match(request);
        if (hit) {
          event.waitUntil(
            fetch(request)
              .then(function (res) {
                if (res.ok) return cache.put(request, res.clone());
              })
              .catch(function () {
                /* 断网 / 刷新失败：保留旧缓存，等下次访问再试 */
              })
          );
          return hit;
        }
        try {
          const res = await fetch(request);
          if (res.ok) {
            // 同样用 waitUntil 保住生命周期，确保首次缓存写入完成
            event.waitUntil(cache.put(request, res.clone()).catch(function () {}));
          }
          return res;
        } catch (err) {
          // 断网且从未缓存过：前端已有「加载失败」兜底文案
          return Response.error();
        }
      })()
    );
    return;
  }

  // HTML 导航：Network-First —— 有网始终取最新版并写回缓存，断网/失败才回退缓存与离线页。
  // 旧的 Stale-While-Revalidate 会先返回旧页；后台刷新没有被 waitUntil 保护，SW 在
  // respondWith 兑现后即被回收，cache.put 常被打断，内容站每天发文后移动端一直看到上一版。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const res = await fetch(request);
          if (res.ok) {
            // 用 waitUntil 保住 SW 生命周期，确保缓存写入完成（离线回退才有内容）
            event.waitUntil(cache.put(request, res.clone()));
          }
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
