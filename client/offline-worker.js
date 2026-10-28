/* Build injects SHELL and ASSETS. Only application assets are cached here.
 * Authenticated JSON lives in the actor/workspace-scoped IndexedDB repository. */
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
// Task reminders reach installed browsers here even with every tab closed.
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() }; }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Dovun';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : 'dovun',
    icon: '/push-icon-192.png', badge: '/push-icon-192.png',
    data: { url },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      await client.focus();
      if (target !== '/') client.postMessage({ type: 'dovun-push-open', url: target });
      return;
    }
    await self.clients.openWindow(new URL(target, self.location.origin).href);
  })());
});
const META = 'dovun-offline-client-scopes';
const scopeKey = id => new URL('/__dovun_client_scope/' + id, self.location.origin).href;
self.addEventListener('message', event => {
  if (event.data?.type === 'dovun-offline-file-status' && event.source?.id && event.ports[0]) {
    event.waitUntil((async () => {
      const url = new URL(event.data.url, self.location.origin);
      const identity = await (await caches.open(META)).match(scopeKey(event.source.id));
      const found = identity && url.origin === self.location.origin && isFile(url.pathname) ? await (await caches.open((await identity.json()).name)).match(url.href) : null;
      event.ports[0].postMessage({ available: Boolean(found) });
    })()); return;
  }
  if (event.data?.type !== 'dovun-offline-scope' || !event.source?.id || new URL(event.source.url).origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const metadata = await caches.open(META), key = scopeKey(event.source.id);
    if (!event.data.scope) { await metadata.delete(key); return; }
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(event.data.scope)));
    const name = 'dovun-files-' + Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    await metadata.put(key, Response.json({ name }));
  })());
});
const isFile = path => /^\/api\/(?:tasks\/[^/]+\/images\/[^/]+|v1\/knowledge\/materials\/[^/]+\/versions\/\d+\/attachment|v1\/library\/materials\/[^/]+\/versions\/\d+\/source)$/.test(path);
async function fileResponse(event) {
  const metadata = await caches.open(META), identity = await metadata.match(scopeKey(event.clientId));
  const cache = identity ? await caches.open((await identity.json()).name) : null;
  try {
    const response = await fetch(event.request);
    // A rejected login or permission check can never fall back to private cached content.
    if (response.status === 401 || response.status === 403) { await metadata.delete(scopeKey(event.clientId)); return response; }
    if (response.ok && cache && Number(response.headers.get('content-length') ?? 0) <= 24 * 1024 * 1024) {
      await cache.put(event.request, response.clone());
      const client = await self.clients.get(event.clientId); client?.postMessage({ type: 'dovun-offline-file-saved' });
      const headers = new Headers(response.headers); headers.set('X-Dovun-Offline-Available', '1');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  } catch {
    const saved = cache ? await cache.match(event.request) : null;
    if (saved) { const headers = new Headers(saved.headers); headers.set('X-Dovun-Offline-Available', '1'); headers.set('X-Dovun-Offline', '1'); return new Response(saved.body, { status: saved.status, headers }); }
    return new Response('此附件尚未下载，需要联网 / This attachment has not been downloaded.', { status: 503, headers: { 'content-type': 'text/plain;charset=utf-8' } });
  }
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === self.location.origin && isFile(url.pathname) && !event.request.headers.has('authorization')) { event.respondWith(fileResponse(event)); return; }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(SHELL)).match('/index.html')));
    return;
  }
  if (ASSETS.includes(url.pathname)) event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
});
