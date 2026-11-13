'use strict';

// Push only: no fetch handler, caching, background polling or request interception.
const PROJECT_URL = new URL('./', self.location.href);
const MAX_ALERT_AGE_MS = 5 * 60 * 1000;

function projectTarget(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const target = new URL(value, PROJECT_URL);
    if (target.origin !== PROJECT_URL.origin || target.username || target.password ||
        ![PROJECT_URL.pathname, PROJECT_URL.pathname + 'index.html'].includes(target.pathname) ||
        target.search || target.hash) return null;
    return PROJECT_URL.href;
  } catch (_) { return null; }
}

function notificationPayload(raw, now = Date.now()) {
  if (!raw || raw.version !== 1 || typeof raw.eventId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.eventId) ||
      typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 120 ||
      typeof raw.body !== 'string' || !raw.body.trim() || raw.body.length > 600 ||
      !Number.isSafeInteger(raw.observedAt) || raw.observedAt <= 0 || !Number.isSafeInteger(raw.expiresAt) ||
      raw.observedAt > now + 30000 || raw.expiresAt < raw.observedAt ||
      raw.expiresAt - raw.observedAt > MAX_ALERT_AGE_MS) return null;
  const url = projectTarget(raw.url);
  if (!url) return null;
  const clean = value => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  const title = clean(raw.title), body = clean(raw.body);
  if (!title || !body) return null;
  const expired = raw.expiresAt <= now || now - raw.observedAt > MAX_ALERT_AGE_MS;
  // Every valid push remains visible, as Safari requires. Expired prices are never presented as current.
  return { ...raw, title: expired ? 'An earlier Crypto-Watch alert expired' : title,
    body: expired ? 'This alert arrived too late to show a current price. Open Crypto-Watch to check the latest data.' : body,
    expired, url };
}

function projectWindow(client) {
  try {
    const url = new URL(client.url);
    return url.origin === PROJECT_URL.origin &&
      [PROJECT_URL.pathname, PROJECT_URL.pathname + 'index.html'].includes(url.pathname);
  } catch (_) { return false; }
}

async function updateOpenPages(payload) {
  const windows = (await self.clients.matchAll({type: 'window', includeUncontrolled: true})).filter(projectWindow);
  const visible = windows.filter(client => client.visibilityState === 'visible');
  const message = {type: 'wtct-price-alert', version: 1, eventId: payload.eventId,
    title: payload.title, body: payload.body, url: PROJECT_URL.href,
    observedAt: payload.observedAt, expiresAt: payload.expiresAt, expired: payload.expired};
  for (const client of visible.length ? visible : windows) {
    try { client.postMessage(message); } catch (_) { /* A closing page must not block other recipients. */ }
  }
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));

self.addEventListener('push', event => {
  let payload;
  try {
    const text = event.data?.text();
    if (!text || text.length > 8192) return;
    payload = notificationPayload(JSON.parse(text));
  } catch (_) { return; }
  if (!payload) return;
  const systemNotice = Promise.resolve().then(() => self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: new URL('icons/cw-192.png', PROJECT_URL).href,
      badge: new URL('icons/cw-192.png', PROJECT_URL).href,
      tag: 'wtct-alert-' + payload.eventId,
      renotify: false,
      timestamp: payload.expired ? Date.now() : payload.observedAt,
      data: { url: payload.url, eventId: payload.eventId, expiresAt: payload.expiresAt }
    }));
  // Both surfaces are attempted independently, including when the chart is open.
  event.waitUntil(Promise.allSettled([systemNotice, updateOpenPages(payload)]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = projectTarget(event.notification.data?.url);
  if (!target) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (projectWindow(client)) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
