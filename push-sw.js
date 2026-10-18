self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const options = {
    body: String(data.body || 'グループに新しいお知らせがあります').slice(0, 180),
    tag: data.tag || 'brass-plus-notification',
    renotify: false,
    data: { url: data.url || './' },
    silent: data.soundEnabled === false,
    vibrate: data.soundEnabled === false || data.vibrationEnabled === false ? [] : [100, 50, 100]
  };
  event.waitUntil(self.registration.showNotification(data.title || 'BRASS+', options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) if (client.url.startsWith(self.registration.scope) && 'focus' in client) return client.focus();
    return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
  }));
});
