import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const SITE = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const NOW = Date.UTC(2026, 10, 13, 18);
const plain = value => JSON.parse(JSON.stringify(value));

function harness(windowClients = [], {notificationFails = false} = {}) {
  const listeners = new Map();
  const calls = {shown: [], posted: [], opened: [], focused: [], matched: [], closed: 0, skipWaiting: 0, cache: 0, network: 0};
  class Clock extends Date { static now() { return NOW; } }
  const cache = new Proxy({}, {get() { calls.cache++; throw new Error('Push worker must not access caches.'); }});
  const network = () => { calls.network++; throw new Error('Push worker must not make background requests.'); };
  const self = {
    location: {href: SITE + 'sw.js'},
    caches: cache,
    fetch: network,
    addEventListener(name, listener) {
      const handlers = listeners.get(name) || [];
      handlers.push(listener);
      listeners.set(name, handlers);
    },
    async skipWaiting() { calls.skipWaiting++; },
    registration: {
      async showNotification(title, options) {
        calls.shown.push({title, options: plain(options)});
        if (notificationFails) throw new Error('OS notification unavailable');
      }
    },
    clients: {
      async matchAll(options) {
        calls.matched.push(plain(options));
        return windowClients.map(client => ({...client,
          async focus() { calls.focused.push(client.id); },
          postMessage(message) {
            if (client.throwOnPost) throw new Error('Page closed');
            calls.posted.push({id: client.id, message: plain(message)});
          }
        }));
      },
      async openWindow(url) { calls.opened.push(url); }
    }
  };
  vm.runInNewContext(source, {self, URL, Date: Clock, caches: cache, fetch: network}, {filename: 'sw.js', timeout: 1000});

  async function dispatch(name, event = {}) {
    const pending = [];
    for (const listener of listeners.get(name) || []) {
      listener({...event, waitUntil(promise) { pending.push(promise); }});
    }
    await Promise.all(pending);
    assert.equal(calls.cache, 0, 'No cache storage access');
    assert.equal(calls.network, 0, 'No background network requests');
  }
  return {
    calls, listeners, dispatch,
    push: value => dispatch('push', {data: {text: () => JSON.stringify(value)}}),
    click: url => dispatch('notificationclick', {notification: {data: {url}, close() { calls.closed++; }}})
  };
}

function message(changes = {}) {
  return {
    version: 1,
    eventId: 'crossing:BTC-123',
    title: 'BTC crossed your threshold',
    body: 'Observed price US$123456.7890123. Check Crypto-Watch before acting.',
    url: SITE,
    observedAt: NOW - 1000,
    expiresAt: NOW + 299000,
    ...changes
  };
}

test('installation updates the push worker without intercepting or caching chart requests', async () => {
  const h = harness();
  assert.equal(h.listeners.has('fetch'), false);
  assert.equal(h.listeners.has('periodicsync'), false);
  assert.equal(h.listeners.has('sync'), false);
  await h.dispatch('install');
  assert.equal(h.calls.skipWaiting, 1);
  assert.deepEqual(h.calls.shown, []);
  assert.equal(h.calls.cache, 0);
  assert.equal(h.calls.network, 0);
});

test('fresh alerts use the project icon and canonical URL, with a stable non-renotifying tag', async () => {
  const h = harness();
  const payload = message({
    url: SITE + 'index.html',
    icon: 'https://untrusted.example/icon.png',
    data: {url: 'https://untrusted.example/'},
    renotify: true
  });
  await h.push(payload);
  await h.push(payload);
  assert.equal(h.calls.shown.length, 2);
  const shown = h.calls.shown[0];
  assert.equal(shown.title, payload.title);
  assert.equal(shown.options.body, payload.body);
  assert.equal(shown.options.icon, SITE + 'icons/cw-192.png');
  assert.equal(shown.options.badge, SITE + 'icons/cw-192.png');
  assert.equal(shown.options.timestamp, payload.observedAt);
  assert.deepEqual(shown.options.data, {url: SITE, eventId: payload.eventId, expiresAt: payload.expiresAt});
  assert.equal(shown.options.tag, h.calls.shown[1].options.tag);
  assert.equal(shown.options.renotify, false);
});

test('late valid pushes remain visible but never repeat an expired price or threshold', async () => {
  for (const changes of [
    {observedAt: NOW - 360000, expiresAt: NOW - 60000},
    {observedAt: NOW - 5000, expiresAt: NOW - 1}
  ]) {
    const h = harness();
    await h.push(message(changes));
    assert.equal(h.calls.shown.length, 1);
    const shown = h.calls.shown[0];
    assert.match(shown.title, /expired/i);
    assert.match(shown.options.body, /arrived too late/i);
    assert.match(shown.options.body, /check the latest data/i);
    assert.doesNotMatch(shown.title + shown.options.body, /123456|crossed your threshold|US\$/);
    assert.equal(shown.options.timestamp, NOW);
    assert.equal(shown.options.data.url, SITE);
  }
});

test('an open project page receives an in-page alert as well as the OS notification', async () => {
  const h = harness([
    {id: 'sibling', url: 'https://jfaread.github.io/another-project/', visibilityState: 'visible'},
    {id: 'lookalike', url: 'https://jfaread.github.io/wealth-transfer-crypto-tracker-other/', visibilityState: 'visible'},
    {id: 'foreign', url: 'https://untrusted.example/wealth-transfer-crypto-tracker/', visibilityState: 'visible'},
    {id: 'hidden-project', url: SITE, visibilityState: 'hidden'},
    {id: 'visible-project', url: SITE + '?coins=BTC', visibilityState: 'visible'},
    {id: 'other-visible-project', url: SITE + 'index.html', visibilityState: 'visible'}
  ]);
  const payload = message({extra: 'This field must not reach a page', token: 'not-a-real-token'});
  await h.push(payload);
  assert.equal(h.calls.shown.length, 1, 'An open tab must not suppress the OS notification');
  assert.deepEqual(h.calls.posted.map(value => value.id), ['visible-project', 'other-visible-project']);
  assert.deepEqual(h.calls.posted[0].message, {
    type: 'wtct-price-alert', version: 1, eventId: payload.eventId,
    title: payload.title, body: payload.body, url: SITE,
    observedAt: payload.observedAt, expiresAt: payload.expiresAt, expired: false
  });
});

test('hidden project pages receive a safe late notice when no project page is visible', async () => {
  const h = harness([
    {id: 'visible-sibling', url: 'https://jfaread.github.io/another-project/', visibilityState: 'visible'},
    {id: 'hidden-project', url: SITE, visibilityState: 'hidden'}
  ]);
  await h.push(message({observedAt: NOW - 360000, expiresAt: NOW - 60000}));
  assert.equal(h.calls.shown.length, 1);
  assert.deepEqual(h.calls.posted.map(value => value.id), ['hidden-project']);
  const foreground = h.calls.posted[0].message;
  assert.equal(foreground.expired, true);
  assert.equal(foreground.url, SITE);
  assert.match(foreground.title, /expired/i);
  assert.doesNotMatch(foreground.title + foreground.body, /123456|crossed your threshold|US\$/);
});

test('foreground delivery survives an OS error or a project window closing during delivery', async () => {
  const h = harness([
    {id: 'closing', url: SITE, visibilityState: 'visible', throwOnPost: true},
    {id: 'open', url: SITE, visibilityState: 'visible'}
  ], {notificationFails: true});
  await h.push(message());
  assert.equal(h.calls.shown.length, 1, 'OS display was still attempted');
  assert.deepEqual(h.calls.posted.map(value => value.id), ['open']);
});

test('invalid, oversized and malformed push data never displays a notification', async () => {
  const h = harness();
  const invalid = [null, {}, [], message({version: 2}), message({eventId: '../unsafe'}),
    message({eventId: 'a'.repeat(129)}), message({title: {text: 'wrong type'}}),
    message({title: '\u0000'}), message({body: ' '}), message({body: 'x'.repeat(601)}),
    message({observedAt: NOW + 30001}), message({observedAt: -1}),
    message({observedAt: String(NOW)}), message({expiresAt: NOW - 2000}),
    message({expiresAt: NOW + 300000}), message({padding: 'x'.repeat(8193)})];
  for (const value of invalid) await h.push(value);
  await h.dispatch('push', {data: {text: () => '{invalid json'}});
  await h.dispatch('push', {data: {text() { throw new Error('Unreadable payload'); }}});
  await h.dispatch('push', {data: null});
  assert.deepEqual(h.calls.shown, []);
  assert.deepEqual(h.calls.posted, []);
});

test('foreign origins, sibling repositories, nested paths and query-bearing targets are rejected', async () => {
  const h = harness();
  const invalidTargets = [
    'https://untrusted.example/',
    'http://jfaread.github.io/wealth-transfer-crypto-tracker/',
    'https://jfaread.github.io/another-project/',
    'https://jfaread.github.io/wealth-transfer-crypto-tracker-lookalike/',
    SITE + 'icons/cw.svg',
    SITE + '../another-project/',
    SITE + '%2e%2e/another-project/',
    SITE + '?token=not-a-real-token',
    SITE + '?view=price',
    SITE + '#somewhere',
    'https://someone:password@jfaread.github.io/wealth-transfer-crypto-tracker/',
    'javascript:alert(1)',
    null
  ];
  for (const url of invalidTargets) {
    await h.push(message({url}));
    await h.click(url);
  }
  assert.deepEqual(h.calls.shown, []);
  assert.deepEqual(h.calls.posted, []);
  assert.deepEqual(h.calls.focused, []);
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.matched, []);
});

test('notification clicks focus an existing project window without touching sibling projects', async () => {
  for (const projectPath of [SITE + '?coins=BTC&view=price', SITE + 'index.html']) {
    const h = harness([
      {id: 'sibling', url: 'https://jfaread.github.io/another-project/'},
      {id: 'foreign', url: 'https://untrusted.example/'},
      {id: 'unreadable', url: 'not a URL'},
      {id: 'nested', url: SITE + 'other.html'},
      {id: 'tracker', url: projectPath}
    ]);
    await h.click(SITE);
    assert.equal(h.calls.closed, 1);
    assert.deepEqual(h.calls.focused, ['tracker']);
    assert.deepEqual(h.calls.opened, []);
    assert.deepEqual(h.calls.matched, [{type: 'window', includeUncontrolled: true}]);
  }
});

test('a click opens only the fixed project URL when no matching project window exists', async () => {
  const h = harness([
    {id: 'sibling', url: 'https://jfaread.github.io/another-project/'},
    {id: 'foreign', url: 'https://untrusted.example/wealth-transfer-crypto-tracker/'}
  ]);
  await h.click(SITE + 'index.html');
  assert.equal(h.calls.closed, 1);
  assert.deepEqual(h.calls.focused, []);
  assert.deepEqual(h.calls.opened, [SITE]);
});
