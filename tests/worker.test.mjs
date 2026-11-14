import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import worker, {CryptoAlertMonitor} from '../alerts/worker.mjs';
import {COINS} from '../alerts/core.mjs';
import {POOL_COINS, POOL_POLL_MS, POOL_SOURCES} from '../alerts/pool-feeds.mjs';

const ORIGIN = 'https://jfaread.github.io';
const initialNow = Date.parse('2026-11-13T16:00:00.000Z');
const RULE_ID = '11111111-1111-4111-8111-111111111111';
const copy = value => value === undefined ? undefined : structuredClone(value);

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.failTransaction = false; this.writes = new Map(); this.alarmWrites = 0; }
  async list() { return new Map(Array.from(this.data, ([k, v]) => [k, copy(v)])); }
  async get(key) { return copy(this.data.get(key)); }
  async put(key, value) { this.writes.set(key, (this.writes.get(key) || 0) + 1); this.data.set(key, copy(value)); }
  async delete(key) { return this.data.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarmWrites++; this.alarm = value; }
  async deleteAlarm() { this.alarmWrites++; this.alarm = null; }
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
  let time = overrides.initialTime || initialNow;
  const storage = overrides.storage || new Storage();
  const sent = [], background = [], poolCalls = [];
  const ctx = {storage, blockConcurrencyWhile: fn => fn(), waitUntil: promise => background.push(promise)};
  const env = {ALERTS_ENABLED: 'true', VAPID_PUBLIC_KEY: 'test-public', VAPID_PRIVATE_KEY: 'test-private',
    VAPID_SUBJECT: 'mailto:alerts@example.test', ALLOWED_ORIGIN: ORIGIN, ...overrides.env};
  const object = new CryptoAlertMonitor(ctx, env, {now: () => time,
    connectKraken: async options => { options.onOpen?.(); return {close() {}}; },
    fetchImpl: overrides.fetchImpl || (async () => {throw new Error('Unexpected network request blocked by the unit test.');}),
    pollPoolPrices: async options => {
      poolCalls.push({coins: [...options.coins], heads: copy(options.heads), at: options.now()});
      return overrides.pollPoolPrices ? overrides.pollPoolPrices(options) : {quotes: [], heads: {}, evidence: {}, resetCoins: options.coins,
        errors: [...new Set(options.coins.map(coin => COINS[coin].network))].map(network => ({network, reason: 'test_source_unavailable'}))};
    },
    sendPush: async (sub, payload, options) => {
      sent.push({sub, payload, options});
      return overrides.sendPush ? overrides.sendPush(sub, payload, options) : overrides.sendResult || {status: 'accepted', httpStatus: 201};
    }});
  return {object, storage, sent, background, poolCalls, env, now: () => time,
    advance: amount => { time += amount; }, settle: async () => { while (background.length) await Promise.all(background.splice(0)); }};
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
  assert.equal(config.body.coins.length, 9); assert(config.body.coins.every(c => !c.enabled));
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

test('CAS rejects stale saves and pool sources without fresh observations remain disabled', async () => {
  const h = setup(), device = await register(h);
  assert.equal((await enableRule(h, device)).status, 200);
  const stale = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0, rules: []}});
  assert.equal(stale.status, 409);
  const unsupported = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 1,
    rules: [{id: RULE_ID, coin: 'CREPE', direction: 'above', threshold: '0.00001', enabled: true}]}});
  assert.equal(unsupported.status, 409); assert.equal(unsupported.body.error.code, 'price_not_ready');
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

async function nativeQuotes(h) {
  await h.object.processQuotes(['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'SHIB'].map(coin => quote(h, '100', {coin, source: `Kraken ${coin}/USD`})));
}

function poolResult(options, {price = '100', errors = [], resetCoins = [], snapshot} = {}) {
  const now = options.now(), heads = copy(options.heads), evidence = {}, quotes = [];
  for (const coin of options.coins) {
    const network = COINS[coin].network;
    if (errors.some(error => error.network === network)) continue;
    const native = options.conversionQuotes[network === 'ethereum' ? 'ETH' : 'BNB'];
    const freshUntil = Math.min(now + 30_000, native.receivedAt + 30_000, native.timestamp + 60_000, native.freshUntil ?? Infinity);
    const head = {number: String(Math.floor(now / 1000)), hash: '0x' + '1'.repeat(64), timestamp: now, observedAt: now,
      healthy: true, coinObservedAt: {...heads[network]?.coinObservedAt, [coin]: now}};
    const baseline = snapshot ?? (!options.heads[network]?.healthy || resetCoins.includes(coin));
    heads[network] = head;
    quotes.push({coin, price, source: POOL_SOURCES[coin], timestamp: now, receivedAt: now, freshUntil, snapshot: baseline});
    evidence[coin] = {network, chainId: network === 'ethereum' ? 1 : 56, pool: '0x' + '2'.repeat(40),
      token: COINS[coin].contract, quoteToken: '0x' + '3'.repeat(40), tokenDecimals: coin === 'WKC' ? 18 : 9, quoteDecimals: 18,
      blockNumber: head.number, blockHash: head.hash, blockTimestamp: now, reserveChangedAt: now - 1000, observedAt: now,
      conversionCoin: native.coin, conversionSource: native.source, conversionPrice: native.price,
      conversionTimestamp: native.timestamp, conversionReceivedAt: native.receivedAt, freshUntil, indicative: true};
  }
  for (const error of errors) heads[error.network] = {...heads[error.network], healthy: false};
  return {quotes, heads, evidence, errors, resetCoins};
}

async function savePoolRules(h, device, coins = POOL_COINS, changes = {}) {
  const rules = coins.map((coin, index) => ({id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    coin, direction: 'above', threshold: '101', repeat: false, enabled: true, ...changes}));
  const response = await request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0, rules}});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return rules;
}

test('all three indicative pool sources support one-shot crossings with independently fresh evidence', async () => {
  let price = '100';
  const h = setup({pollPoolPrices: options => poolResult(options, {price})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  const config = h.object.config();
  assert(config.coins.every(coin => coin.enabled));
  assert.equal(config.limits.maxPoolPollsPerDay, 6000); assert.equal(config.limits.maxPoolRpcRequestsPerPoll, 6);
  for (const coin of config.coins.filter(item => POOL_COINS.includes(item.id))) {
    assert.equal(coin.indicative, true); assert.equal(coin.samplingMs, 15_000);
    assert.equal(coin.evidence.token, COINS[coin.id].contract); assert.match(coin.source, /Indicative/);
    assert.equal(coin.evidence.freshUntil, initialNow + 30_000);
  }
  await savePoolRules(h, device);
  h.advance(POOL_POLL_MS); await nativeQuotes(h); price = '102';
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.sent.length, 3);
  assert(h.object.devices.get(device.deviceId).rules.every(rule => !rule.enabled));
  assert(h.sent.every(item => /Indicative/.test(item.payload.body)));
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.sent.length, 3); assert.equal(h.poolCalls.length, 2);
  assert.equal((await h.storage.get('poolBudget')).reserved, 2);
});

test('conversion expiry invalidates a composite before an otherwise short-gap replacement', async () => {
  let price = '100';
  const h = setup({pollPoolPrices: options => poolResult(options, {price, snapshot: false})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  const [rule] = await savePoolRules(h, device, ['KISHU']);
  h.advance(15_000); await h.object.ensurePools(); await h.settle();
  assert.equal(h.object.quotes.get('KISHU').freshUntil, initialNow + 30_000, 'pool polling cannot extend the conversion deadline');
  h.advance(15_000);
  assert.equal(h.object.config().coins.find(coin => coin.id === 'KISHU').enabled, false);
  await h.object.ensurePools();
  assert.equal(h.poolCalls.length, 2, 'expired conversions consume no RPC round');
  assert.equal(h.object.states.get(device.deviceId)[rule.id].needsBaseline, true);
  h.advance(15_000); await nativeQuotes(h); price = '102';
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.sent.length, 0, 'recovery establishes a baseline despite a gap shorter than 120 seconds');
});

test('reorganisation and a native reconnect snapshot establish new pool baselines', async () => {
  let price = '100', reorganised = false;
  const h = setup({pollPoolPrices: options => poolResult(options, {price, resetCoins: reorganised ? ['KISHU'] : []})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  await savePoolRules(h, device, ['KISHU'], {repeat: true});
  for (const [value, reorg] of [['102', true], ['103', false], ['100', false], ['102', false]]) {
    h.advance(15_000); await nativeQuotes(h); price = value; reorganised = reorg;
    await h.object.ensurePools(); await h.settle();
  }
  assert.equal(h.sent.length, 1, 'only the genuinely observed later crossing fires');
  h.advance(1000);
  await h.object.processQuotes([quote(h, '100', {coin: 'ETH', source: 'Kraken ETH/USD', snapshot: true})]);
  assert.equal(h.object.quotes.has('KISHU'), false);
  assert.equal(h.object.quotes.has('WKC'), true, 'an ETH reconnect does not invalidate the BNB chain');
  h.advance(14_000); await nativeQuotes(h); price = '103';
  await h.object.ensurePools(); await h.settle(); assert.equal(h.sent.length, 1);
});

test('a native snapshot between pool result application and evaluation cannot reinstate an old conversion baseline', async () => {
  let price = '100';
  const h = setup({pollPoolPrices: options => poolResult(options, {price})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  await savePoolRules(h, device, ['KISHU']);
  const original = h.object.processQuotes.bind(h.object);
  h.object.processQuotes = async (quotes, generations) => {
    if (generations) await original([quote(h, '200', {coin: 'ETH', source: 'Kraken ETH/USD', snapshot: true})]);
    return original(quotes, generations);
  };
  h.advance(15_000); await nativeQuotes(h);
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.object.quotes.has('KISHU'), false); assert.equal(h.sent.length, 0);
  h.object.processQuotes = original;
  h.advance(15_000); await nativeQuotes(h); price = '198';
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.sent.length, 0, 'the corrected conversion is a recovery baseline');
});

test('inactive and idle monitors do not poll; a missing-pool probe also works alongside a BTC rule and then expires', async () => {
  const disabled = setup({env: {ALERTS_ENABLED: 'false'}, pollPoolPrices: poolResult});
  await request(disabled, '/v1/config'); await disabled.object.alarm(); await disabled.settle();
  assert.equal(disabled.poolCalls.length, 0);
  const idle = setup({pollPoolPrices: poolResult}); await nativeQuotes(idle);
  await idle.object.ensurePools(); await idle.object.alarm(); assert.equal(idle.poolCalls.length, 0);
  const h = setup({pollPoolPrices: poolResult}); await nativeQuotes(h);
  const device = await register(h); await h.settle(); await enableRule(h, device, {threshold: '1000'});
  h.advance(300_001); await nativeQuotes(h); h.storage.alarm = null; await h.object.alarm(); await h.settle();
  assert.equal(h.poolCalls.length, 1, 'BTC alone does not keep the pool probe alive');
  await nativeQuotes(h);
  await request(h, '/v1/config'); await h.settle();
  assert.deepEqual(h.poolCalls.at(-1).coins, POOL_COINS);
  const until = h.object.probeUntil;
  for (let i = 0; i < 10; i++) await request(h, '/v1/config');
  await h.settle(); assert.equal(h.object.probeUntil, until); assert.equal(h.poolCalls.length, 2);
  h.advance(300_001); await nativeQuotes(h); h.storage.alarm = null; await h.object.alarm(); await h.settle();
  assert.equal(h.poolCalls.length, 2);
});

test('pool polling is single-flight and interval reservations survive a restart and repeated public probes', async () => {
  let release, pending;
  const h = setup({pollPoolPrices: options => new Promise(resolve => {pending = options; release = () => resolve(poolResult(options));})});
  await nativeQuotes(h); await register(h);
  for (let attempt = 0; !release && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert(release);
  await Promise.all(Array.from({length: 20}, () => h.object.ensurePools()));
  assert.equal(h.poolCalls.length, 1); assert.equal((await h.storage.get('poolBudget')).reserved, 1);
  assert(pending.coins.length === 3); release(); await h.settle();
  const restarted = setup({storage: h.storage, initialTime: h.now() + 1, pollPoolPrices: poolResult});
  await nativeQuotes(restarted);
  await Promise.all(Array.from({length: 10}, () => request(restarted, '/v1/config'))); await restarted.settle();
  assert.equal(restarted.poolCalls.length, 0); assert.equal(restarted.object.poolBudget.reserved, 1);
  restarted.advance(15_000); await nativeQuotes(restarted); await restarted.object.ensurePools(); await restarted.settle();
  assert.equal(restarted.poolCalls.length, 1); assert.equal(restarted.object.poolBudget.reserved, 2);
});

test('a chain Retry-After pauses only that network and persists across restart', async () => {
  let failure = false;
  const poll = options => poolResult(options, {errors: failure && options.coins.includes('KISHU') ?
    [{network: 'ethereum', coins: ['KISHU'], reason: 'rate_limited', retryAt: initialNow + 120_000}] : []});
  const h = setup({pollPoolPrices: poll}); await nativeQuotes(h); await register(h); await h.settle();
  h.advance(15_000); await nativeQuotes(h); failure = true; await h.object.ensurePools(); await h.settle();
  assert.equal(h.object.poolNetworks.ethereum.nextPollAt, initialNow + 120_000);
  assert.equal(h.object.quotes.has('KISHU'), false); assert(h.object.quotes.has('WKC'));
  const restarted = setup({storage: h.storage, initialTime: initialNow + 30_000, pollPoolPrices: poll});
  await nativeQuotes(restarted); await request(restarted, '/v1/config'); await restarted.settle();
  assert.deepEqual(restarted.poolCalls[0].coins, ['WKC', 'CREPE']);
  assert.equal(restarted.object.poolNetworks.ethereum.nextPollAt, initialNow + 120_000);
  assert.equal(restarted.object.poolBudget.reserved, 3);
});

test('pool reservations stop before outbound traffic on commit failure and cap only pool monitoring across restarts', async () => {
  let price = '100';
  const h = setup({env: {MAX_POOL_POLLS_PER_DAY: '2'}, pollPoolPrices: options => poolResult(options, {price})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  await savePoolRules(h, device, ['KISHU']);
  h.advance(15_000); await nativeQuotes(h); h.storage.failTransaction = true;
  await assert.rejects(h.object.ensurePools(), /Synthetic commit/);
  assert.equal(h.poolCalls.length, 1); assert.equal((await h.storage.get('poolBudget')).reserved, 1);
  h.storage.failTransaction = false; price = '102';
  await h.object.ensurePools(); await h.settle();
  assert.equal(h.sent.length, 1, 'the final reserved round can still evaluate an existing crossing');
  assert.equal(h.object.poolBudget.reserved, 2);
  assert(h.object.config().coins.filter(coin => POOL_COINS.includes(coin.id)).every(coin => !coin.enabled));
  assert(h.object.config().coins.find(coin => coin.id === 'BTC').enabled);
  const restarted = setup({storage: h.storage, initialTime: h.now() + 15_000, env: {MAX_POOL_POLLS_PER_DAY: '2'}, pollPoolPrices: poolResult});
  await nativeQuotes(restarted); await request(restarted, '/v1/config'); await restarted.settle();
  assert.equal(restarted.poolCalls.length, 0); assert.equal(restarted.object.poolBudget.reserved, 2);
  const oversized = setup({env: {MAX_POOL_POLLS_PER_DAY: '9999999'}}); await oversized.object.ready;
  assert.equal(oversized.object.config().limits.maxPoolPollsPerDay, 6000);
});

test('slow push delivery cannot hold the pool polling guard', async () => {
  let releaseSend;
  const h = setup({pollPoolPrices: poolResult, sendPush: () => new Promise(resolve => {releaseSend = () => resolve({status: 'accepted'});})});
  await nativeQuotes(h); const device = await register(h); await h.settle();
  await request(h, '/v1/test', {method: 'POST', token: device.token, body: {}});
  for (let attempt = 0; !releaseSend && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert(releaseSend);
  h.advance(15_000); await nativeQuotes(h); await h.object.ensurePools();
  assert.equal(h.object.poolPolling, false); assert.equal(h.poolCalls.length, 2);
  h.advance(15_000); await nativeQuotes(h); await h.object.ensurePools();
  assert.equal(h.poolCalls.length, 3);
  releaseSend(); await h.settle();
});

test('frequent native ticks and capability reads do not rewrite pool state or alarms before the reserved deadline', async () => {
  const h = setup({pollPoolPrices: poolResult}); await nativeQuotes(h); await register(h); await h.settle();
  const writes = h.storage.writes.get('poolState'), alarmWrites = h.storage.alarmWrites;
  for (let i = 0; i < 30; i++) {
    h.advance(10);
    await h.object.acceptFrame(JSON.stringify({channel: 'ticker', type: 'update', data: [
      {symbol: 'ETH/USD', last: 100, timestamp: new Date(h.now()).toISOString()}
    ]}), h.object.connectionGeneration);
    await request(h, '/v1/config'); await h.settle();
  }
  assert.equal(h.storage.writes.get('poolState'), writes);
  assert.equal(h.storage.alarmWrites, alarmWrites);
  assert.equal(h.poolCalls.length, 1); assert.equal(h.object.poolBudget.reserved, 1);
});

test('a closed native connection cannot reuse its earlier conversion to establish a pool recovery baseline', async () => {
  const h = setup({pollPoolPrices: poolResult}); await nativeQuotes(h); const device = await register(h); await h.settle();
  await savePoolRules(h, device, ['KISHU']);
  h.advance(1000); h.object.closeFeed();
  assert.equal(h.object.quotes.has('ETH'), false); assert.equal(h.object.quotes.has('BNB'), false);
  h.advance(14_000); await h.object.ensurePools();
  assert.equal(h.poolCalls.length, 1, 'a pre-close conversion cannot consume another RPC round');
  assert.equal(h.object.quotes.has('KISHU'), false);
  h.advance(15_000);
  await h.object.processQuotes([quote(h, '200', {coin: 'ETH', source: 'Kraken ETH/USD', snapshot: true})]);
  await h.object.ensurePools(); await h.settle();
  assert.deepEqual(h.poolCalls.at(-1).coins, ['KISHU']); assert.equal(h.sent.length, 0);
});

test('an unchanged unavailable pool rule does not block adding, deleting or reordering unrelated rules', async () => {
  const h = setup({pollPoolPrices: poolResult}); await nativeQuotes(h); const device = await register(h); await h.settle();
  const [kishu] = await savePoolRules(h, device, ['KISHU']);
  h.advance(31_000); await nativeQuotes(h);
  const preserved = copy(h.object.states.get(device.deviceId)[kishu.id]);
  const eth = {...kishu, id: '22222222-2222-4222-8222-222222222222', coin: 'ETH'};
  const save = (revision, rules) => request(h, '/v1/rules', {method: 'PUT', token: device.token, body: {revision, rules}});
  assert.equal((await save(1, [kishu, eth])).status, 200);
  assert.deepEqual(h.object.states.get(device.deviceId)[kishu.id], preserved);
  assert.equal((await save(2, [eth, kishu])).status, 200);
  assert.equal((await save(3, [kishu])).status, 200);
  const changed = await save(4, [{...kishu, threshold: '103'}]);
  assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'price_not_ready');
  await h.settle();
  h.object.invalidateCoins(['KISHU']);
  assert.equal((await save(4, [{...kishu, enabled: false}])).status, 200);
  const resumed = await save(5, [kishu]);
  assert.equal(resumed.status, 409); assert.equal(resumed.body.error.code, 'price_not_ready');
  await h.settle();
  h.object.poolBudget.reserved = h.object.poolCap();
  assert.equal((await save(5, [])).status, 200, 'deleting a paused rule remains possible at the pool cap');
});
