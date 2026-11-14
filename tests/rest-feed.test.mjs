import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRestTrade, retryDelay, createKrakenRestFeed, REST_POLL_MS} from '../alerts/rest-feed.mjs';
import {connectKraken} from '../alerts/feeds.mjs';
const START = Date.parse('2026-11-14T12:00:00Z');
const packet = (coin, when = START, price = '100.12345000') => ({error: [], result: {[`${coin}/USD`]: [[price, '1', when / 1000, 'b', 'l', '', 1]], last: '1'}});
async function setup(provider = (coin, time) => Response.json(packet(coin, time)), saved = 0) {
  const state = {time: START, frames: [], calls: [], waits: [], queue: [], cooldown: saved, opened: 0, closed: 0};
  const options = {now: () => state.time, onMessage: text => state.frames.push(JSON.parse(text)),
    onOpen: () => state.opened++, onClose: () => state.closed++,
    schedule: (fn, ms) => { const task = {fn, at: state.time + ms}; state.queue.push(task); return task; },
    cancel: task => { state.queue = state.queue.filter(t => t !== task); },
    pace: async ms => { state.waits.push(ms); state.time += ms; },
    loadCooldown: async () => state.cooldown,
    saveCooldown: async until => { state.cooldown = until; },
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.kraken.com');
      assert.equal(new URL(url).searchParams.get('count'), '1');
      assert.equal(new URL(url).searchParams.get('assetVersion'), '1');
      assert.equal(options.redirect, 'manual');
      assert(options.signal instanceof AbortSignal);
      const coin = new URL(url).searchParams.get('pair').replace(/USD$/, '');
      state.calls.push({coin, at: state.time});
      return provider(coin, state.time, state);
    }};
  state.socket = await createKrakenRestFeed(options);
  state.next = async () => { const task = state.queue.shift(); assert(task); state.time = task.at; await task.fn(); };
  return state;
}
test('REST parser uses real trade time and exact USD pair, rejecting stale and malformed prices', () => {
  assert.deepEqual(parseRestTrade(packet('BTC'), 'BTC', START + 500), {symbol: 'BTC/USD', last: 100.12345, timestamp: START});
  for (const p of [packet('ETH'), {error: ['error']}, packet('BTC', START - 60001), packet('BTC', START + 5001), packet('BTC', START, '1e-9'), packet('BTC', START, '-1')]) {
    assert.equal(parseRestTrade(p, 'BTC', START), null);
  }
});
test('Retry-After seconds and dates cannot shorten the minimum cooldown', () => {
  assert.equal(retryDelay('120', START), 120000);
  assert.equal(retryDelay(new Date(START + 90000).toUTCString(), START), 90000);
  assert.equal(retryDelay('1', START), 60000);
  assert.equal(retryDelay(null, START), 60000);
});
test('fallback spaces all five requests and starts with snapshots, then genuine updates', async () => {
  const s = await setup();
  assert.equal(s.opened, 1);
  assert.equal(s.socket.transport, 'rest');
  assert.equal(s.socket.samplingMs, REST_POLL_MS);
  assert.deepEqual(s.calls.map(c => c.coin), ['BTC', 'ETH', 'BNB', 'XRP', 'SOL']);
  assert.deepEqual(s.calls.map(c => c.at - START), [0, 1000, 2000, 3000, 4000]);
  assert.equal(s.frames.filter(f => f.type === 'snapshot').length, 5);
  await s.next();
  assert.equal(s.calls[5].at, START + REST_POLL_MS);
  assert.equal(s.frames.filter(f => f.type === 'update').length, 5);
  s.socket.close(); assert.equal(s.queue.length, 0);
});
test('duplicate observations never renew their timestamps or remove request pacing', async () => {
  const s = await setup(coin => Response.json(packet(coin, START)));
  await s.next();
  assert.equal(s.calls.length, 10);
  assert.equal(s.frames.filter(f => f.channel === 'ticker').length, 5);
  assert.equal(s.waits.length, 8);
  for (const f of s.frames.filter(f => f.channel === 'ticker')) assert.equal(f.data[0].timestamp, new Date(START).toISOString());
  s.socket.close();
});
test('HTTP 429 stops remaining requests, persists cooldown, and emits only health frames meanwhile', async () => {
  const s = await setup(() => new Response('', {status: 429, headers: {'Retry-After': '120'}}));
  assert.equal(s.calls.length, 1);
  assert.equal(s.cooldown, START + 120000);
  await s.next(); await s.next(); await s.next(); await s.next();
  assert.equal(s.calls.length, 1);
  assert.equal(s.frames.filter(f => f.channel === 'ticker').length, 0);
  assert(s.frames.length >= 5);
  s.socket.close();
});
test('persisted server cooldown survives a new fallback instance', async () => {
  const s = await setup(undefined, START + 60000);
  assert.equal(s.calls.length, 0);
  await s.next(); await s.next(); await s.next();
  assert.equal(s.calls.length, 0);
  await s.next(); assert.equal(s.calls.length, 5);
  s.socket.close();
});
test('provider errors force a recovery baseline rather than an invented crossing', async () => {
  let bad = false;
  const s = await setup((coin, time) => bad && coin === 'BTC' ? new Response('', {status: 503}) : Response.json(packet(coin, time)));
  bad = true; await s.next();
  bad = false; await s.next(); await s.next();
  const btc = s.frames.filter(f => f.channel === 'ticker' && f.data[0].symbol === 'BTC/USD');
  assert.equal(btc.length, 2); assert.equal(btc[1].type, 'snapshot');
  s.socket.close();
});
test('empty and stale trade lists do not create current observations', async () => {
  const s = await setup(coin => Response.json(packet(coin, START - 120000)));
  assert.equal(s.calls.length, 5);
  assert.equal(s.waits.length, 4);
  assert.equal(s.frames.filter(f => f.channel === 'ticker').length, 0);
  s.socket.close();
});
test('closing the fallback prevents further network calls', async () => {
  const s = await setup(); const pending = s.queue[0];
  s.socket.close(); s.time += 60000; await pending.fn();
  assert.equal(s.calls.length, 5);
});
test('rate-limited stream selects a single fallback, without retrying the rejected socket', async () => {
  let calls = 0, cancelled = false, started = false;
  const socket = {transport: 'rest', close() {}};
  const result = await connectKraken({fetchImpl: async () => {
    calls++; return {status: 429, body: {async cancel() {cancelled = true;}}};
  }, restConnector: async () => {started = true; return socket;}});
  assert.equal(result, socket); assert.equal(calls, 1); assert(cancelled); assert(started);
});
