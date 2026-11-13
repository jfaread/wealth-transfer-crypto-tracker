import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import worker, {CryptoAlertMonitor} from '../alerts/worker.mjs';

const ORIGIN = 'https://jfaread.github.io';
const initialNow = Date.parse('2026-11-13T16:00:00.000Z');
const RULE_ID = '11111111-1111-4111-8111-111111111111';
const copy = value => value === undefined ? undefined : structuredClone(value);

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.failTransaction = false; }
  async list() { return new Map(Array.from(this.data, ([k, v]) => [k, copy(v)])); }
  async get(key) { return copy(this.data.get(key)); }
  async put(key, value) { this.data.set(key, copy(value)); }
  async delete(key) { return this.data.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(fn) {
    const old = await this.list();
    try { const result = await fn(this); if (this.failTransaction) throw new Error('Synthetic commit failure'); return result; }
    catch (error) { this.data = old; throw error; }
  }
}
function subscription(index = 1) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return {endpoint: `https://fcm.googleapis.com/fcm/send/test-${index}`, keys: {
    p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}};
}
function setup(overrides = {}) {
  let time = initialNow;
  const storage = overrides.storage || new Storage();
  const sent = [], background = [];
  const ctx = {storage, blockConcurrencyWhile: fn => fn(), waitUntil: promise => background.push(promise)};
  const env = {ALERTS_ENABLED: 'true', VAPID_PUBLIC_KEY: 'test-public', VAPID_PRIVATE_KEY: 'test-private',
    VAPID_SUBJECT: 'mailto:alerts@example.test', ALLOWED_ORIGIN: ORIGIN, ...overrides.env};
  const object = new CryptoAlertMonitor(ctx, env, {now: () => time,
    connectKraken: async options => { options.onOpen?.(); return {close() {}}; },
    sendPush: async (sub, payload, options) => { sent.push({sub, payload, options}); return overrides.sendResult || {status: 'accepted', httpStatus: 201}; }});
  return {object, storage, sent, background, env, now: () => time,
    advance: amount => { time += amount; }, settle: async () => { await Promise.all(background.splice(0)); }};
}
async function request(h, path, {method = 'GET', body, token, origin = ORIGIN} = {}) {
  const headers = {Origin: origin};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await h.object.fetch(new Request(`https://alerts.example.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)}));
  return {status: response.status, body: await response.json()};
}
async function register(h, index = 1, extra = {}) {
  const result = await request(h, '/v1/devices', {method: 'POST', body: {
    subscription: subscription(index), consentVersion: '2026-11-13', operationId: crypto.randomUUID(), ...extra}});
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
function quote(h, price = '100', extra = {}) {
  return {coin: 'BTC', source: 'Kraken BTC/USD', timestamp: h.now(), receivedAt: h.now(), price, ...extra};
}
async function enableRule(h, device, changes = {}) {
  await h.object.processQuotes([quote(h)]);
  return request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0,
    rules: [{id: RULE_ID, coin: 'BTC', direction: 'above', threshold: '101', repeat: false, enabled: true, ...changes}]}});
}

test('disabled deployment has honest config and cannot register or send', async () => {
  const h = setup({env: {ALERTS_ENABLED: 'false'}});
  const config = await request(h, '/v1/config');
  assert.equal(config.body.enabled, false); assert.equal(config.body.vapidPublicKey, null);
  assert.equal(config.body.coins.length, 8); assert(config.body.coins.every(c => !c.enabled));
  const result = await request(h, '/v1/devices', {method: 'POST', body: {}});
  assert.equal(result.status, 503); assert.equal(h.sent.length, 0);
});

test('registration stores only token hash; auth and origin protect private records', async () => {
  const h = setup(), device = await register(h);
  assert.match(device.token, /^[a-f\d-]{36}\.[a-f\d]{64}$/);
  const saved = await h.storage.get(`device:${device.deviceId}`);
  assert.equal(saved.token, undefined); assert.match(saved.tokenHash, /^[a-f\d]{64}$/);
  assert(!JSON.stringify([...h.storage.data]).includes(device.token.split('.')[1]));
  assert.equal((await request(h, '/v1/device')).status, 401);
  assert.equal((await request(h, '/v1/device', {token: `${device.deviceId}.${'0'.repeat(64)}`})).status, 401);
  const own = await request(h, '/v1/device', {token: device.token});
  assert.equal(own.status, 200); assert.equal(own.body.subscription, undefined); assert.equal(own.body.tokenHash, undefined);
  assert.equal((await request(h, '/v1/device', {token: device.token, origin: 'https://attacker.example'})).status, 403);
  await h.settle();
});

test('registration replays and endpoint takeover cannot duplicate or replace a device', async () => {
  const h = setup(), sub = subscription(), operationId = crypto.randomUUID();
  const device = await register(h, 1, {subscription: sub, operationId});
  for (const op of [operationId, crypto.randomUUID()]) {
    const duplicate = await request(h, '/v1/devices', {method: 'POST', body: {subscription: sub, consentVersion: '2026-11-13', operationId: op}});
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'registration_already_created');
  }
  assert.equal(h.object.devices.size, 1);
  assert.equal((await request(h, '/v1/device', {token: device.token})).status, 200);
  await h.settle();
});

test('CAS rejects stale saves and unknown live feeds remain disabled', async () => {
  const h = setup(), device = await register(h);
  assert.equal((await enableRule(h, device)).status, 200);
  const stale = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0, rules: []}});
  assert.equal(stale.status, 409);
  const unsupported = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 1,
    rules: [{id: RULE_ID, coin: 'CREPE', direction: 'above', threshold: '0.00001', enabled: true}]}});
  assert.equal(unsupported.status, 400); assert.equal(unsupported.body.error.code, 'feed_not_ready');
  const draft = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 1,
    rules: [{id: RULE_ID, coin: 'CREPE', direction: 'above', threshold: '0.00001', enabled: false}]}});
  assert.equal(draft.status, 200); assert.equal(draft.body.rules[0].enabled, false);
  await h.settle();
});

test('one crossing commits completed rule and outbox before one external dispatch', async () => {
  const h = setup(), device = await register(h);
  assert.equal((await enableRule(h, device)).status, 200);
  h.advance(1000);
  await Promise.all([h.object.processQuotes([quote(h, '102')]), h.object.processQuotes([quote(h, '102')])]);
  assert.equal(h.sent.length, 0);
  const committed = await h.storage.get(`device:${device.deviceId}`);
  assert.equal(committed.rules[0].enabled, false); assert.equal(committed.revision, 2);
  assert.equal(h.object.pending.size, 1); assert.equal(committed.events[0].status, 'queued');
  await Promise.all([h.object.drainOutbox(), h.object.drainOutbox()]);
  assert.equal(h.sent.length, 1); assert.equal(h.object.pending.size, 0);
  const current = await request(h, '/v1/device', {token: device.token});
  assert.equal(current.body.events[0].status, 'accepted');
  assert.equal(current.body.events[0].price, '102');
  assert.equal(h.sent[0].payload.url, 'https://jfaread.github.io/wealth-transfer-crypto-tracker/');
  await h.settle();
});

test('failed atomic commit never produces an external notification', async () => {
  const h = setup(), device = await register(h);
  await enableRule(h, device); h.advance(1000); h.storage.failTransaction = true;
  await assert.rejects(h.object.processQuotes([quote(h, '102')]), /Synthetic commit/);
  assert.equal(h.object.pending.size, 0); assert.equal(h.sent.length, 0);
  const saved = await h.storage.get(`device:${device.deviceId}`);
  assert.equal(saved.rules[0].enabled, true); assert.equal(saved.events.length, 0);
  h.storage.failTransaction = false; await h.settle();
});

test('stale and reconnect snapshots cannot create historical threshold alerts', async () => {
  const h = setup(), device = await register(h);
  await enableRule(h, device);
  h.advance(61_000);
  await h.object.processQuotes([quote(h, '102', {timestamp: initialNow})]);
  assert.equal(h.object.pending.size, 0);
  await h.object.processQuotes([quote(h, '102', {snapshot: true})]);
  h.advance(1000); await h.object.processQuotes([quote(h, '103')]);
  assert.equal(h.object.pending.size, 0); assert.equal(h.sent.length, 0);
  await h.settle();
});

test('test rate limit, Retry-After and notification expiry prevent repeated or stale sends', async () => {
  const h = setup({sendResult: {status: 'retry', httpStatus: 429, retryAfterSeconds: 300}}), device = await register(h);
  const first = await request(h, '/v1/test', {method: 'POST', token: device.token, body: {}});
  assert.equal(first.status, 202);
  assert.equal((await request(h, '/v1/test', {method: 'POST', token: device.token, body: {}})).status, 429);
  await h.settle();
  assert.equal(h.sent.length, 1); assert.equal(h.object.pending.size, 0);
  const current = await request(h, '/v1/device', {token: device.token});
  assert.equal(current.body.events[0].status, 'expired');
});

test('expired subscriptions disable rules and expose a reconnect status', async () => {
  const h = setup({sendResult: {status: 'expired', httpStatus: 410}}), device = await register(h);
  await enableRule(h, device); h.advance(1000); await h.object.processQuotes([quote(h, '102')]);
  await h.object.drainOutbox();
  const current = await request(h, '/v1/device', {token: device.token});
  assert.equal(current.body.subscriptionExpired, true);
  assert(current.body.rules.every(r => !r.enabled));
  assert.equal(current.body.events[0].status, 'subscription_expired');
  await h.settle();
});

test('deletion removes queued work and private records before dispatch', async () => {
  const h = setup(), device = await register(h);
  await enableRule(h, device); h.advance(1000); await h.object.processQuotes([quote(h, '102')]);
  assert.equal(h.object.pending.size, 1);
  assert.equal((await request(h, '/v1/device', {method: 'DELETE', token: device.token})).status, 200);
  await h.object.drainOutbox(); assert.equal(h.sent.length, 0);
  assert.equal(h.object.pending.size, 0); assert.equal(h.object.devices.size, 0);
  assert.equal((await request(h, '/v1/device', {token: device.token})).status, 401);
  assert(!JSON.stringify([...h.storage.data]).includes(device.deviceId));
  await h.settle();
});

test('device notification quota is persistent across a monitor restart', async () => {
  const h = setup(), device = await register(h);
  const record = h.object.devices.get(device.deviceId);
  record.pushUsage = {day: '2026-11-13', count: 20};
  await h.storage.put(`device:${record.id}`, record);
  const restarted = setup({storage: h.storage}); await restarted.object.ready;
  const response = await request(restarted, '/v1/test', {method: 'POST', token: device.token, body: {}});
  assert.equal(response.status, 429); assert.equal(response.body.error.code, 'daily_limit');
  assert.equal(restarted.sent.length, 0); await h.settle();
});

test('outer worker uses exact CORS origin and one fixed singleton', async () => {
  let name;
  const env = {ALERT_MONITOR: {getByName(value) { name = value; return {fetch: async req => {
    assert.match(req.headers.get('X-Alert-IP-Bucket'), /^[a-f\d]{64}$/);
    return new Response('{}', {headers: {'Content-Type': 'application/json'}});
  }}; }}};
  const good = await worker.fetch(new Request('https://alerts.example.test/v1/config', {headers: {Origin: ORIGIN}}), env);
  assert.equal(good.status, 200); assert.equal(name, 'crypto-watch-monitor-v1');
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const bad = await worker.fetch(new Request('https://alerts.example.test/v1/config', {headers: {Origin: 'https://attacker.example'}}), env);
  assert.equal(bad.status, 403);
});

test('identical rule UUIDs on different devices still create two independent events', async () => {
  const h = setup(), first = await register(h, 1), second = await register(h, 2);
  await enableRule(h, first); await enableRule(h, second);
  h.advance(1000); await h.object.processQuotes([quote(h, '102')]);
  assert.equal(h.object.pending.size, 2);
  const ids = Array.from(h.object.pending.keys());
  assert.equal(new Set(ids).size, 2); assert(ids.every(id => id.length <= 128));
  await h.object.drainOutbox(); assert.equal(h.sent.length, 2);
  await h.settle();
});

test('restart and a reconnect snapshot retain the last repeat alert cooldown', async () => {
  const h = setup(), device = await register(h);
  await enableRule(h, device, {repeat: true});
  h.advance(1000); await h.object.processQuotes([quote(h, '102')]);
  await h.object.drainOutbox(); assert.equal(h.sent.length, 1);
  const restarted = setup({storage: h.storage}); restarted.advance(2000); await restarted.object.ready;
  await restarted.object.processQuotes([quote(restarted, '100', {snapshot: true})]);
  restarted.advance(1000); await restarted.object.processQuotes([quote(restarted, '102')]);
  assert.equal(restarted.object.pending.size, 0); assert.equal(restarted.sent.length, 0);
  assert.equal(restarted.object.states.get(device.deviceId)[RULE_ID].lastEventAt, initialNow + 1000);
  await h.settle();
});

test('an anonymous capability probe shuts down within five minutes', async () => {
  const h = setup();
  await request(h, '/v1/config'); await h.settle();
  assert(h.object.socket); assert(h.storage.alarm);
  h.advance(300_001); h.storage.alarm = null;
  await h.object.alarm();
  assert.equal(h.object.socket, null); assert.equal(h.storage.alarm, null);
  assert.equal(h.object.devices.size, 0);
});

test('streaming request body is cancelled at the byte cap without trusting Content-Length', async () => {
  const h = setup(); let cancelled = false;
  const body = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(24_001)); }, cancel() { cancelled = true; }});
  const response = await h.object.fetch(new Request('https://alerts.example.test/v1/devices', {
    method: 'POST', headers: {Origin: ORIGIN, 'Content-Type': 'application/json'}, body, duplex: 'half'}));
  assert.equal(response.status, 413); assert.equal(cancelled, true);
  assert.equal(h.object.devices.size, 0);
});

test('frame cap closes the feed, persists across restart and wakes once at next UTC day', async () => {
  const h = setup({env: {MAX_FEED_FRAMES_PER_DAY: '3'}}), device = await register(h);
  await enableRule(h, device); await h.settle();
  const generation = h.object.connectionGeneration;
  for (let i = 0; i < 3; i++) await h.object.acceptFrame(JSON.stringify({channel: 'heartbeat'}), generation);
  assert.equal(h.object.socket, null); assert.equal(h.object.monitor().status, 'budget_paused');
  assert(h.object.config().coins.every(coin => !coin.enabled));
  assert.equal((await h.storage.get('feedBudget')).reserved, 3);
  assert.equal(h.storage.alarm, Date.parse('2026-11-14T00:00:00Z'));
  const restarted = setup({storage: h.storage, env: {MAX_FEED_FRAMES_PER_DAY: '3'}});
  await restarted.object.ready;
  assert.equal(restarted.object.monitor().status, 'budget_paused');
  await restarted.object.ensureFeed(); assert.equal(restarted.object.socket, null);
  restarted.advance(Date.parse('2026-11-14T00:00:00Z') - initialNow + 1000);
  restarted.storage.alarm = null;
  await restarted.object.alarm();
  assert.equal(restarted.object.budgetPaused(), false); assert(restarted.object.socket);
  assert.equal(restarted.object.states.get(device.deviceId)[RULE_ID].needsBaseline, true);
  assert.equal((await restarted.storage.get('feedBudget')).day, '2026-11-14');
});

test('frame reservations are conservative after restart and cannot exceed one million via config', async () => {
  const h = setup({env: {MAX_FEED_FRAMES_PER_DAY: '2000'}}); await request(h, '/v1/config'); await h.settle();
  await h.object.acceptFrame('{}', h.object.connectionGeneration);
  assert.equal((await h.storage.get('feedBudget')).reserved, 1000);
  const restarted = setup({storage: h.storage, env: {MAX_FEED_FRAMES_PER_DAY: '2000'}});
  await restarted.object.ready;
  assert.equal(restarted.object.frameAllowance, 0);
  assert.equal(restarted.object.monitor().frameBudgetRemaining, 1000);
  const excessive = setup({env: {MAX_FEED_FRAMES_PER_DAY: '9999999'}}); await excessive.object.ready;
  assert.equal(excessive.object.config().limits.maxFeedFramesPerDay, 1_000_000);
});

test('a registered device with no active rules cannot keep the feed running indefinitely', async () => {
  const h = setup(); await register(h); await h.settle();
  assert(h.object.socket); h.advance(300_001); h.storage.alarm = null;
  await h.object.alarm();
  assert.equal(h.object.socket, null); assert.equal(h.storage.alarm, null);
  assert.equal(h.object.devices.size, 1);
});

test('activating a rule after idle shutdown restarts a bounded freshness probe', async () => {
  const h = setup(), device = await register(h); await h.settle();
  h.advance(300_001); h.storage.alarm = null; await h.object.alarm();
  const result = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0,
    rules: [{id: RULE_ID, coin: 'BTC', direction: 'above', threshold: '101', enabled: true}]}});
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'price_not_ready');
  await h.settle(); assert(h.object.socket);
  assert(h.object.probeUntil > h.now());
});
