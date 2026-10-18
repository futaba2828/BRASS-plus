/* BRASS+ Web Push service worker. Keep at the site root on Render. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const title = String(data.title || 'BRASS+のお知らせ');
  const options = {
    body: String(data.body || 'グループに更新があります。'),
    tag: String(data.tag || 'brass-plus-update'),
    renotify: false,
    data: { url: String(data.url || './') }
  };
  if (data.icon) options.icon = String(data.icon);
  if (data.badge) options.badge = String(data.badge);
  if (data.vibrationEnabled !== false) options.vibrate = [150, 80, 150];

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url === target && 'focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
