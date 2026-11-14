import test from 'node:test';
import assert from 'node:assert/strict';
import {pollPoolPrices, POOL_COINS, POOL_SOURCES, POOL_POLL_MS, MAX_RPC_REQUESTS_PER_POLL} from '../alerts/pool-feeds.mjs';

const NOW = Date.parse('2026-11-14T01:00:00Z');
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const ETH_FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
const BSC_FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const FIXTURES = {
  KISHU: {network: 'ethereum', pool: '0xf82d8ec196fb0d56c6b82a8b1870f09502a49f88',
    token: '0xa2b4c0af19cc16a6cfacce81f192b024d625817d', quote: WETH, factory: ETH_FACTORY,
    decimals: 9, token0: '0xa2b4c0af19cc16a6cfacce81f192b024d625817d', token1: WETH,
    reserve0: 10n ** 24n, reserve1: 2n * 10n ** 18n},
  WKC: {network: 'bsc', pool: '0x933477eba23726ca95a957cb85dbb1957267ef85',
    token: '0x6ec90334d89dbdc89e08a133271be3d104128edb', quote: WBNB, factory: BSC_FACTORY,
    decimals: 18, token0: '0x6ec90334d89dbdc89e08a133271be3d104128edb', token1: WBNB,
    reserve0: 10n ** 27n, reserve1: 2n * 10n ** 18n},
  CREPE: {network: 'bsc', pool: '0x7d90deedb9f15c1f8fdaccc3b6bc52dc208e9c9a',
    token: '0xeb2b7d5691878627eff20492ca7c9a71228d931d', quote: WBNB, factory: BSC_FACTORY,
    decimals: 9, token0: WBNB, token1: '0xeb2b7d5691878627eff20492ca7c9a71228d931d',
    reserve0: 3n * 10n ** 18n, reserve1: 10n ** 18n},
};
const hex = value => `0x${BigInt(value).toString(16)}`;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const address = value => `0x${value.slice(2).padStart(64, '0')}`;
const hash = value => `0x${word(value)}`;
const block = (number = 256, timestamp = NOW) => ({number: hex(number), timestamp: hex(Math.floor(timestamp / 1000)), hash: hash(BigInt(number) + 1000n)});
const native = (coin, price, time = NOW, receivedAt = time) => ({coin, price, source: `Kraken ${coin}/USD`, timestamp: time, receivedAt});
const conversions = (time = NOW) => ({ETH: native('ETH', '2000', time), BNB: native('BNB', '600', time)});
const response = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});

/** Closed local fixture: no fallback to fetch, and only public read-only methods. */
function fixture({time = NOW, number = 256, previous = [], change, pools = {}, advance} = {}) {
  const requests = [], stages = {ethereum: 0, bsc: 0};
  const records = Object.fromEntries(Object.entries(FIXTURES).map(([coin, info]) => [coin, {...info, ...pools[coin]}]));
  const current = block(number, time);
  const old = new Map(previous.map(header => [header.number, header]));
  const fetchImpl = async (url, options) => {
    const network = url === 'https://eth.drpc.org' ? 'ethereum'
      : url === 'https://bsc-dataseed.bnbchain.org' ? 'bsc' : assert.fail('Unexpected RPC endpoint.');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined);
    const calls = JSON.parse(options.body), stage = ++stages[network];
    assert(calls.length <= 20);
    requests.push({network, stage, calls, signal: options.signal});
    const results = calls.map(call => {
      let result;
      assert.equal(call.jsonrpc, '2.0');
      if (call.method === 'eth_chainId') result = network === 'ethereum' ? '0x1' : '0x38';
      else if (call.method === 'eth_getBlockByNumber') {
        assert.equal(call.params[1], false);
        result = call.params[0] === 'latest' || call.params[0] === current.number ? {...current} : old.get(call.params[0]);
        assert(result, `No fixture for block ${call.params[0]}`);
      } else {
        assert.equal(call.method, 'eth_call');
        assert.equal(call.params[1], current.number, 'All state reads must use the initial explicit block.');
        const {to, data} = call.params[0];
        const pool = Object.values(records).find(item => item.pool === to);
        const token = Object.values(records).find(item => item.token === to);
        if (data === '0x313ce567') {
          assert(token || [WETH, WBNB].includes(to));
          result = `0x${word(token ? token.decimals : 18)}`;
        } else if (data.startsWith('0xe6a43905')) {
          assert([ETH_FACTORY, BSC_FACTORY].includes(to));
          const requested = `0x${data.slice(10, 74).slice(-40)}`;
          const info = Object.values(records).find(item => item.token === requested);
          assert(info); assert.equal(to, info.network === 'ethereum' ? ETH_FACTORY : BSC_FACTORY);
          assert.equal(`0x${data.slice(74).slice(-40)}`, info.quote);
          result = address(info.pair || info.pool);
        } else {
          assert(pool, 'Unknown pool address.');
          if (data === '0x0dfe1681') result = address(pool.token0);
          else if (data === '0xd21220a7') result = address(pool.token1);
          else if (data === '0xc45a0155') result = address(pool.factory);
          else {
            assert.equal(data, '0x0902f1ac');
            result = `0x${word(pool.reserve0)}${word(pool.reserve1)}${word(pool.changedAt ?? Math.floor(time / 1000) - 900)}`;
          }
        }
      }
      return {jsonrpc: '2.0', id: call.id, result};
    });
    const altered = change?.({network, stage, calls, results, current});
    advance?.({network, stage});
    return altered instanceof Response ? altered : response(altered ?? results);
  };
  return {fetchImpl, requests, current};
}
const poll = (mock, options = {}) => pollPoolPrices({fetchImpl: mock.fetchImpl, now: () => NOW, conversionQuotes: conversions(), ...options});

test('all three verified pools use six fixed, bounded read-only batches and correct reserve orientation', async () => {
  const mock = fixture(), result = await poll(mock);
  assert.deepEqual(POOL_COINS, ['KISHU', 'WKC', 'CREPE']);
  assert.equal(POOL_POLL_MS, 15_000); assert.equal(MAX_RPC_REQUESTS_PER_POLL, 6);
  assert.equal(mock.requests.length, 6); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.quotes.map(q => [q.coin, q.price]), [
    ['KISHU', '0.000000000004'], ['WKC', '0.0000012'], ['CREPE', '0.0000018'],
  ]);
  for (const q of result.quotes) {
    assert.equal(q.snapshot, true); assert.equal(q.timestamp, NOW); assert.equal(q.receivedAt, NOW);
    assert.equal(q.freshUntil, NOW + 30_000); assert.equal(q.source, POOL_SOURCES[q.coin]);
    assert.match(q.source, /indicative/i); assert(q.source.length <= 100); assert(!/[eE]/.test(q.price));
    const proof = result.evidence[q.coin];
    assert.equal(proof.token, FIXTURES[q.coin].token); assert.equal(proof.pool, FIXTURES[q.coin].pool);
    assert.equal(proof.blockTimestamp, NOW); assert.equal(proof.reserveChangedAt, NOW - 900_000);
    assert.equal(proof.indicative, true);
  }
  assert.equal(result.heads.bsc.healthy, true); assert.equal(result.heads.ethereum.healthy, true);
});

test('BigInt pricing retains tiny ordinary decimals and truncates only at 24 decimal places', async () => {
  const tiny = fixture({pools: {KISHU: {reserve0: 10n ** 30n, reserve1: 10n ** 18n}}});
  const result = await poll(tiny, {coins: ['KISHU'], conversionQuotes: {ETH: native('ETH', '1234.567890123456789012345678')}});
  assert.equal(result.quotes[0].price, '0.000000000000000001234567');
  const thirds = fixture({pools: {KISHU: {reserve0: 3n * 10n ** 9n, reserve1: 10n ** 18n}}});
  const repeating = await poll(thirds, {coins: ['KISHU'], conversionQuotes: {ETH: native('ETH', '2')}});
  assert.equal(repeating.quotes[0].price, '0.666666666666666666666666');
});

test('composite timestamps retain both clocks and expire at the earliest component deadline', async () => {
  const mock = fixture({time: NOW - 10_000});
  const result = await poll(mock, {coins: ['KISHU'], conversionQuotes: {ETH: native('ETH', '2000', NOW - 2000, NOW - 1000)}});
  const q = result.quotes[0], evidence = result.evidence.KISHU;
  assert.equal(q.timestamp, NOW - 2000); assert.equal(q.freshUntil, NOW + 29_000);
  assert.equal(evidence.blockTimestamp, NOW - 10_000);
  assert.equal(evidence.conversionTimestamp, NOW - 2000); assert.equal(evidence.conversionReceivedAt, NOW - 1000);
  assert.equal(evidence.observedAt, NOW); assert.equal(evidence.reserveChangedAt, NOW - 910_000);
});

test('stale, expired, future or incorrectly named conversions consume no RPC quota', async () => {
  const examples = [
    [native('ETH', '2000', NOW - 60_001, NOW), 'conversion_stale_quote'],
    [native('ETH', '2000', NOW - 31_000, NOW - 30_001), 'conversion_stale_receipt'],
    [native('ETH', '2000', NOW + 5001, NOW), 'conversion_future_quote'],
    [{...native('ETH', '2000'), source: 'Unverified ETH/USD'}, 'wrong_conversion'],
    [native('BNB', '600'), 'wrong_conversion'],
    [{...native('ETH', '2000'), freshUntil: NOW}, 'conversion_stale_quote'],
  ];
  for (const [quote, reason] of examples) {
    const mock = fixture(), result = await poll(mock, {coins: ['KISHU'], conversionQuotes: {ETH: quote}});
    assert.equal(mock.requests.length, 0); assert.deepEqual(result.quotes, []);
    assert.equal(result.errors[0].reason, reason); assert.deepEqual(result.resetCoins, ['KISHU']);
    assert.equal(result.heads.ethereum.healthy, false);
  }
});

test('a fresh conversion cannot rescue an old or future chain head', async () => {
  for (const [time, reason] of [[NOW - 61_000, 'stale_block'], [NOW + 6000, 'future_block']]) {
    const mock = fixture({time}), result = await poll(mock, {coins: ['KISHU']});
    assert.equal(result.errors[0].reason, reason); assert.equal(mock.requests.length, 1); assert.equal(result.quotes.length, 0);
  }
});

test('a conversion is rechecked after the final response, so slow RPC work cannot mint a fresh quote', async () => {
  let clock = NOW;
  const mock = fixture({advance: ({stage}) => { if (stage === 3) clock += 30_001; }});
  const result = await poll(mock, {coins: ['KISHU'], now: () => clock});
  assert.equal(result.quotes.length, 0); assert.equal(result.errors[0].reason, 'conversion_stale_receipt');
});

test('a slower parallel chain cannot return another chain’s already-expired composite quote', async () => {
  let clock = NOW, releaseBsc;
  const gate = new Promise(resolve => { releaseBsc = resolve; });
  const base = fixture();
  const mock = {fetchImpl: async (url, options) => {
    if (url === 'https://bsc-dataseed.bnbchain.org') await gate;
    const result = await base.fetchImpl(url, options);
    const calls = JSON.parse(options.body);
    if (url === 'https://eth.drpc.org' && calls[0].method === 'eth_getBlockByNumber'
        && calls[0].params[0] !== 'latest') setImmediate(() => { clock += 2000; releaseBsc(); });
    return result;
  }};
  const result = await poll(mock, {now: () => clock,
    conversionQuotes: {...conversions(), ETH: native('ETH', '2000', NOW - 29_000)}});
  assert.deepEqual(result.quotes.map(q => q.coin), ['WKC', 'CREPE']);
  assert.deepEqual(result.errors, [{network: 'ethereum', coins: ['KISHU'], reason: 'source_expired'}]);
  assert.equal(result.heads.ethereum.healthy, false);
});

test('wrong chain, token contracts, factory registration or decimals fail closed', async () => {
  const wrong = '0x1111111111111111111111111111111111111111';
  const examples = [
    [{change: ({stage, results}) => stage === 1 ? results.map((item, i) => i === 0 ? {...item, result: '0x38'} : item) : results}, 'wrong_chain'],
    [{pools: {KISHU: {token0: wrong}}}, 'wrong_token'],
    [{pools: {KISHU: {factory: wrong}}}, 'wrong_factory'],
    [{pools: {KISHU: {pair: wrong}}}, 'wrong_factory'],
    [{pools: {KISHU: {decimals: 18}}}, 'wrong_decimals'],
  ];
  for (const [options, reason] of examples) {
    const result = await poll(fixture(options), {coins: ['KISHU']});
    assert.equal(result.errors[0].reason, reason); assert.equal(result.quotes.length, 0);
  }
});

test('invalid reserves, overflowing ABI integers and below-precision prices cannot generate alerts', async () => {
  const examples = [
    [{reserve0: 0n}, 'invalid_reserves'], [{reserve1: 1n << 112n}, 'invalid_reserves'],
    [{changedAt: (1n << 32n)}, 'invalid_reserves'], [{changedAt: NOW / 1000 + 1}, 'invalid_reserves'],
    [{reserve0: (1n << 112n) - 1n, reserve1: 1n}, 'price_below_precision'],
  ];
  for (const [values, reason] of examples) {
    const result = await poll(fixture({pools: {KISHU: values}}), {coins: ['KISHU']});
    assert.equal(result.errors[0].reason, reason); assert.equal(result.quotes.length, 0);
  }
});

test('current block hash changes during state reads reject the entire mixed snapshot', async () => {
  const mock = fixture({change: ({stage, results}) => stage === 3
    ? results.map((item, i) => i === 0 ? {...item, result: {...item.result, hash: hash(999)}} : item) : results});
  const result = await poll(mock, {coins: ['KISHU']});
  assert.equal(result.errors[0].reason, 'block_changed'); assert.equal(result.quotes.length, 0);
  assert.deepEqual(result.resetCoins, ['KISHU']);
});

test('healthy consecutive observations keep monitoring, while a previous block reorganisation rebaselines', async () => {
  const initial = fixture(), first = await poll(initial, {coins: ['KISHU']});
  const follow = fixture({time: NOW + 15_000, number: 257, previous: [initial.current]});
  const second = await poll(follow, {coins: ['KISHU'], now: () => NOW + 15_000,
    conversionQuotes: conversions(NOW + 15_000), heads: first.heads});
  assert.equal(second.quotes[0].snapshot, false); assert.deepEqual(second.resetCoins, []);
  assert.equal(follow.requests[2].calls.length, 3, 'Previous observed block must be checked.');
  const fork = fixture({time: NOW + 15_000, number: 257, previous: [{...initial.current, hash: hash(9999)}]});
  const changed = await poll(fork, {coins: ['KISHU'], now: () => NOW + 15_000,
    conversionQuotes: conversions(NOW + 15_000), heads: first.heads});
  assert.equal(changed.quotes[0].snapshot, true); assert.deepEqual(changed.resetCoins, ['KISHU']);
  assert.equal(changed.heads.ethereum.healthy, true); assert.deepEqual(changed.errors, []);
});

test('failure, recovery, first observation of another token and extended gaps produce safe baselines', async () => {
  const mock = fixture(), first = await poll(mock, {coins: ['WKC']});
  const bad = await poll({fetchImpl: async () => new Response(null, {status: 503})}, {coins: ['WKC'], heads: first.heads});
  assert.equal(bad.heads.bsc.healthy, false); assert.deepEqual(bad.resetCoins, ['WKC']);
  const recovered = await poll(fixture(), {coins: ['WKC'], heads: bad.heads});
  assert.equal(recovered.quotes[0].snapshot, true);
  const expanded = await poll(fixture(), {coins: ['WKC', 'CREPE'], heads: first.heads});
  assert.equal(expanded.quotes.find(q => q.coin === 'WKC').snapshot, false);
  assert.equal(expanded.quotes.find(q => q.coin === 'CREPE').snapshot, true);
  const oldHeads = {bsc: {...first.heads.bsc, observedAt: NOW - 120_001}};
  const gap = await poll(fixture(), {coins: ['WKC'], heads: oldHeads});
  assert.equal(gap.quotes[0].snapshot, true);
});

test('a regressed healthy head pauses, and a same-height replacement is recognised as a reorganisation', async () => {
  const first = await poll(fixture(), {coins: ['KISHU']});
  const lower = await poll(fixture({number: 255}), {coins: ['KISHU'], heads: first.heads});
  assert.equal(lower.errors[0].reason, 'chain_regressed'); assert.equal(lower.quotes.length, 0);
  const sameHeight = fixture({change: ({stage, results}) => [1, 3].includes(stage) ? results.map(item =>
    item.result?.hash ? {...item, result: {...item.result, hash: hash(999)}} : item) : results});
  const replacement = await poll(sameHeight, {coins: ['KISHU'], heads: first.heads});
  assert.equal(replacement.quotes[0].snapshot, true); assert.deepEqual(replacement.resetCoins, ['KISHU']);
});

test('one network failure leaves the independently verified other network available', async () => {
  const mock = fixture({change: ({network, results}) => network === 'ethereum'
    ? new Response(null, {status: 429, headers: {'Retry-After': '120'}}) : results});
  const result = await poll(mock);
  assert.deepEqual(result.quotes.map(q => q.coin), ['WKC', 'CREPE']);
  assert.deepEqual(result.resetCoins, ['KISHU']);
  assert.deepEqual(result.errors, [{network: 'ethereum', coins: ['KISHU'], reason: 'rate_limited', retryAt: NOW + 120_000}]);
  assert.equal(mock.requests.length, 4);
});

test('429 Retry-After seconds and HTTP dates are preserved without internal retries or body disclosure', async () => {
  for (const header of ['120', new Date(NOW + 120_000).toUTCString()]) {
    let calls = 0;
    const result = await poll({fetchImpl: async () => {
      calls++; return new Response('Do not disclose: provider debug details', {status: 429, headers: {'Retry-After': header}});
    }}, {coins: ['CREPE']});
    assert.equal(calls, 1); assert.equal(result.errors[0].retryAt, NOW + 120_000);
    assert(!JSON.stringify(result).includes('provider debug details'));
  }
});

test('HTTP redirects and oversized streamed responses fail closed', async () => {
  for (const [make, reason] of [
    [() => new Response(null, {status: 302, headers: {Location: 'https://example.invalid/'}}), 'redirect_rejected'],
    [() => new Response(' '.repeat(64 * 1024 + 1)), 'response_too_large'],
  ]) {
    let calls = 0;
    const result = await poll({fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.redirect, 'manual'); return make();
    }}, {coins: ['KISHU']});
    assert.equal(calls, 1); assert.equal(result.errors[0].reason, reason);
  }
});

test('JSON-RPC response IDs, cardinality, errors and malformed JSON are rejected strictly', async () => {
  const samples = [
    () => response([]), () => response({}), () => new Response('{broken'),
    results => response([{...results[0], id: '1'}, results[1]]),
    results => response([results[0], results[0]]),
    results => response([{...results[0], id: 3}, results[1]]),
    results => response([{...results[0], jsonrpc: '1.0'}, results[1]]),
    results => response([{...results[0], error: {code: -1}}, results[1]]),
  ];
  for (const make of samples) {
    const result = await poll(fixture({change: ({results}) => make(results)}), {coins: ['KISHU']});
    assert.equal(result.errors[0].reason, 'malformed_response'); assert.equal(result.quotes.length, 0);
  }
  const rpcError = await poll(fixture({change: ({results}) => response([
    {jsonrpc: '2.0', id: 1, error: {code: -32000, message: 'private provider details'}}, results[1],
  ])}), {coins: ['KISHU']});
  assert.equal(rpcError.errors[0].reason, 'rpc_error'); assert(!JSON.stringify(rpcError).includes('private provider details'));
});

test('a stalled request is aborted at its bound, even if fetch ignores the abort signal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal, lateResponse, cancelled = false;
  const pending = poll({fetchImpl: (_url, options) => {
    signal = options.signal; return new Promise(resolve => { lateResponse = resolve; });
  }}, {coins: ['KISHU']});
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(signal.aborted, true); assert.equal(result.errors[0].reason, 'rpc_timeout');
  lateResponse(new Response(new ReadableStream({cancel() { cancelled = true; }})));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true, 'A response arriving after the timeout must still release its body.');
});

test('a stalled response body is cancelled within the same timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let cancelled = false;
  const body = new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('[')); }, cancel() { cancelled = true; }});
  const pending = poll({fetchImpl: async () => new Response(body)}, {coins: ['KISHU']});
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(cancelled, true); assert.equal(result.errors[0].reason, 'rpc_timeout');
});

test('empty selections make no requests and unknown selections cannot choose arbitrary endpoints', async () => {
  const mock = fixture();
  const empty = await poll(mock, {coins: []});
  assert.deepEqual(empty.quotes, []); assert.equal(mock.requests.length, 0);
  await assert.rejects(poll(mock, {coins: ['BTC']}), /supported pool feeds/);
  assert.equal(mock.requests.length, 0);
});
