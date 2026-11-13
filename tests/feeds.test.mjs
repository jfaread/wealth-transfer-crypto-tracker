import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKrakenMessage, krakenSubscription, reconnectDelay, connectKraken, KRAKEN_WS_URL} from '../alerts/feeds.mjs';

const now = Date.parse('2026-11-13T16:00:00.000Z');
const frame = (data, type = 'update') => JSON.stringify({channel: 'ticker', type, data});
const tick = (symbol = 'BTC/USD', last = 100) => ({symbol, last, timestamp: new Date(now).toISOString()});

test('stream subscription requests exactly five true-USD instruments', () => {
  const request = krakenSubscription();
  assert.deepEqual(request.params.symbol, ['BTC/USD', 'ETH/USD', 'BNB/USD', 'XRP/USD', 'SOL/USD']);
  assert.equal(request.params.event_trigger, 'trades');
  assert.equal(request.params.snapshot, true);
});

test('fresh ticks retain provider timestamp, venue, decimal value and snapshot flag', () => {
  const parsed = parseKrakenMessage(frame([tick('XRP/USD', 1.01234567)], 'snapshot'), now + 10);
  assert.deepEqual(parsed.quotes, [{coin: 'XRP', price: '1.01234567', source: 'Kraken XRP/USD', timestamp: now, receivedAt: now + 10, snapshot: true}]);
});

test('stale, malformed, unsupported and USDT quotes cannot enter the monitor', () => {
  const rows = [tick('BTC/USDT'), tick('KISHU/USD'), tick('BTC/USD', -1), tick('ETH/USD', '10'),
    {...tick(), timestamp: new Date(now - 60_001).toISOString()},
    {...tick(), timestamp: new Date(now + 5_001).toISOString()}, {...tick(), timestamp: 'yesterday'}, tick('BTC/USD', 1e-100)];
  assert.deepEqual(parseKrakenMessage(frame(rows), now).quotes, []);
  assert.deepEqual(parseKrakenMessage('{broken', now).quotes, []);
  assert.deepEqual(parseKrakenMessage('x'.repeat(64_001), now).quotes, []);
  assert.equal(parseKrakenMessage(JSON.stringify({method: 'subscribe', success: false}), now).reason, 'subscription_rejected');
});

test('reconnect backoff is bounded', () => {
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(3), 8000);
  assert.equal(reconnectDelay(100), 60000);
  assert.equal(reconnectDelay(-1), 1000);
});

test('outbound handshake cannot be redirected to a client-chosen URL', async () => {
  const handlers = {}, sent = [];
  let accepted = 0, opened = 0, messages = 0, closed = 0;
  const socket = {accept() { accepted++; }, addEventListener(name, fn) { handlers[name] = fn; }, send(value) { sent.push(JSON.parse(value)); }};
  const result = await connectKraken({fetchImpl: async (url, options) => {
    assert.equal(url, KRAKEN_WS_URL); assert.equal(options.headers.Upgrade, 'websocket');
    return {status: 101, webSocket: socket};
  }, onOpen: () => opened++, onMessage: () => messages++, onClose: () => closed++});
  assert.equal(result, socket); assert.equal(accepted, 1); assert.equal(opened, 1);
  assert.deepEqual(sent, [krakenSubscription()]);
  handlers.message({data: '{}'}); handlers.close();
  assert.equal(messages, 1); assert.equal(closed, 1);
  await assert.rejects(connectKraken({fetchImpl: async () => ({status: 200})}), /unavailable/);
});
