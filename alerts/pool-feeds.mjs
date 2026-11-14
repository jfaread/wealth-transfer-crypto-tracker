import {validateQuote, QUOTE_MAX_AGE_MS, RECEIPT_MAX_AGE_MS, BASELINE_GAP_MS} from './core.mjs';

export const POOL_COINS = Object.freeze(['KISHU', 'WKC', 'CREPE']);
export const POOL_POLL_MS = 15_000;
export const MAX_RPC_REQUESTS_PER_POLL = 6;
export const POOL_SOURCES = Object.freeze({
  KISHU: 'Indicative Uniswap v2 KISHU/WETH + Kraken ETH/USD',
  WKC: 'Indicative PancakeSwap v2 WKC/WBNB + Kraken BNB/USD',
  CREPE: 'Indicative PancakeSwap v2 CREPE/WBNB + Kraken BNB/USD',
});

const NETWORKS = Object.freeze({
  ethereum: Object.freeze({
    endpoint: 'https://eth.drpc.org', chainId: 1,
    factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
    quoteToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', conversionCoin: 'ETH',
  }),
  bsc: Object.freeze({
    endpoint: 'https://bsc-dataseed.bnbchain.org', chainId: 56,
    factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
    quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', conversionCoin: 'BNB',
  }),
});
const POOLS = Object.freeze({
  KISHU: Object.freeze({network: 'ethereum', pool: '0xf82d8ec196fb0d56c6b82a8b1870f09502a49f88',
    token: '0xa2b4c0af19cc16a6cfacce81f192b024d625817d', decimals: 9, tokenIndex: 0}),
  WKC: Object.freeze({network: 'bsc', pool: '0x933477eba23726ca95a957cb85dbb1957267ef85',
    token: '0x6ec90334d89dbdc89e08a133271be3d104128edb', decimals: 18, tokenIndex: 0}),
  CREPE: Object.freeze({network: 'bsc', pool: '0x7d90deedb9f15c1f8fdaccc3b6bc52dc208e9c9a',
    token: '0xeb2b7d5691878627eff20492ca7c9a71228d931d', decimals: 9, tokenIndex: 1}),
});
const SELECTORS = Object.freeze({token0: '0x0dfe1681', token1: '0xd21220a7',
  reserves: '0x0902f1ac', factory: '0xc45a0155', decimals: '0x313ce567', getPair: '0xe6a43905'});
const MAX_RESPONSE_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 8_000;
const FUTURE_TOLERANCE_MS = 5_000;
const MAX_UINT112 = (1n << 112n) - 1n;
const UINT32_MODULUS = 1n << 32n;
const HASH = /^0x[0-9a-f]{64}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/i;
const PRICE_SCALE = 10n ** 24n;

class FeedError extends Error {
  constructor(reason, retryAt) { super(reason); this.reason = reason; this.retryAt = retryAt; }
}
const fail = reason => { throw new FeedError(reason); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const clockValue = now => {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('The pool monitor needs a valid clock.');
  return value;
};

function quantity(value, max = (1n << 64n) - 1n) {
  if (typeof value !== 'string' || value.length > 66 || !QUANTITY.test(value)) fail('malformed_rpc_value');
  const parsed = BigInt(value);
  if (parsed > max) fail('malformed_rpc_value');
  return parsed;
}
function addressWord(value) {
  if (typeof value !== 'string' || !ADDRESS_WORD.test(value)) fail('malformed_rpc_value');
  return `0x${value.slice(-40).toLowerCase()}`;
}
function uintWord(value) {
  if (typeof value !== 'string' || !WORD.test(value)) fail('malformed_rpc_value');
  return BigInt(value);
}
function parseHeader(value) {
  if (!record(value) || typeof value.hash !== 'string' || !HASH.test(value.hash)) fail('invalid_block');
  const number = quantity(value.number);
  const seconds = quantity(value.timestamp, BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)));
  if (!number || !seconds) fail('invalid_block');
  return {number: number.toString(), hash: value.hash.toLowerCase(), timestamp: Number(seconds) * 1000};
}
function checkBlockAge(header, now) {
  if (header.timestamp > now + FUTURE_TOLERANCE_MS) fail('future_block');
  if (now - header.timestamp > QUOTE_MAX_AGE_MS) fail('stale_block');
}
function priorHead(value, now) {
  if (!record(value) || typeof value.number !== 'string' || !/^[1-9]\d{0,19}$/.test(value.number)
      || BigInt(value.number) > (1n << 64n) - 1n || typeof value.hash !== 'string' || !HASH.test(value.hash)
      || !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0 || value.timestamp > now + FUTURE_TOLERANCE_MS
      || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0 || value.observedAt > now + FUTURE_TOLERANCE_MS) return null;
  const coinObservedAt = {};
  for (const coin of POOL_COINS) {
    const observed = value.coinObservedAt?.[coin];
    if (Number.isSafeInteger(observed) && observed > 0 && observed <= now + FUTURE_TOLERANCE_MS) coinObservedAt[coin] = observed;
  }
  return {number: value.number, hash: value.hash.toLowerCase(), timestamp: value.timestamp,
    observedAt: value.observedAt, healthy: value.healthy === true, coinObservedAt};
}
function retryAfter(value, now) {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const result = now + seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(result) ? result : undefined;
  }
  const date = Date.parse(trimmed);
  return Number.isSafeInteger(date) && date > 0 ? Math.max(now, date) : undefined;
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
}

async function limitedJson(response, signal) {
  const declared = response.headers?.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) fail('response_too_large');
  const reader = response.body?.getReader();
  if (!reader) fail('malformed_response');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const abort = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', abort, {once: true});
  let text = '', bytes = 0;
  try {
    while (true) {
      if (signal.aborted) fail('rpc_timeout');
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { abort(); fail('response_too_large'); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { fail('malformed_response'); }
  } catch (error) {
    if (error instanceof FeedError) throw error;
    fail(signal.aborted ? 'rpc_timeout' : 'malformed_response');
  } finally {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch {}
  }
}

/** A request is bounded by bytes and wall-clock time, including a stalled body. */
async function rpcBatch(network, calls, fetchImpl, now) {
  if (!calls.length || calls.length > 20) fail('invalid_batch');
  const requests = calls.map((call, index) => ({jsonrpc: '2.0', id: index + 1, ...call}));
  const controller = new AbortController();
  let timer, response;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(); cancelBody(response);
      reject(new FeedError('rpc_timeout'));
    }, RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, (async () => {
      response = await fetchImpl(NETWORKS[network].endpoint, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(requests),
      });
      if (controller.signal.aborted) { cancelBody(response); fail('rpc_timeout'); }
      if (response.redirected || (response.status >= 300 && response.status < 400)) fail('redirect_rejected');
      if (response.status === 429) throw new FeedError('rate_limited', retryAfter(response.headers?.get('Retry-After'), clockValue(now)));
      if (response.status !== 200) fail('http_error');
      const values = await limitedJson(response, controller.signal);
      if (!Array.isArray(values) || values.length !== requests.length) fail('malformed_response');
      const byId = new Map();
      for (const item of values) {
        if (!record(item) || item.jsonrpc !== '2.0' || !Number.isInteger(item.id)
            || item.id < 1 || item.id > requests.length || byId.has(item.id)
            || Object.hasOwn(item, 'result') === Object.hasOwn(item, 'error')) fail('malformed_response');
        if (Object.hasOwn(item, 'error')) fail('rpc_error');
        byId.set(item.id, item.result);
      }
      return requests.map(request => byId.get(request.id));
    })()]);
  } catch (error) {
    controller.abort(); cancelBody(response);
    if (error instanceof FeedError) throw error;
    throw new FeedError('network_error');
  } finally { clearTimeout(timer); }
}

function conversionQuote(network, input, now) {
  const coin = NETWORKS[network].conversionCoin;
  const checked = validateQuote(input, now);
  if (!checked.valid) fail(`conversion_${checked.reason}`);
  if (checked.quote.coin !== coin || checked.quote.source !== `Kraken ${coin}/USD`) fail('wrong_conversion');
  return checked.quote;
}
function reserveValues(value, header) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{192}$/i.test(value)) fail('invalid_reserves');
  const words = value.slice(2).match(/.{64}/g).map(word => BigInt(`0x${word}`));
  if (words[0] <= 0n || words[0] > MAX_UINT112 || words[1] <= 0n || words[1] > MAX_UINT112
      || words[2] >= UINT32_MODULUS) fail('invalid_reserves');
  // Uniswap's update clock is uint32. Recover its most recent possible epoch;
  // this is the last reserve update, never a claim that a trade just occurred.
  const blockSeconds = BigInt(header.timestamp / 1000);
  let changed = blockSeconds / UINT32_MODULUS * UINT32_MODULUS + words[2];
  if (changed > blockSeconds) changed -= UINT32_MODULUS;
  if (changed < 0n) fail('invalid_reserves');
  return {reserve0: words[0], reserve1: words[1], reserveChangedAt: Number(changed) * 1000};
}
function usdPrice(tokenReserve, quoteReserve, decimals, conversion) {
  const [whole, fraction = ''] = conversion.split('.');
  const native = BigInt(whole + fraction);
  const numerator = quoteReserve * (10n ** BigInt(decimals)) * native * PRICE_SCALE;
  const denominator = tokenReserve * (10n ** 18n) * (10n ** BigInt(fraction.length));
  // Truncate once at the supported 24-place boundary; never use binary floats.
  const value = numerator / denominator;
  if (value <= 0n) fail('price_below_precision');
  const integer = (value / PRICE_SCALE).toString();
  if (integer.length > 18) fail('price_out_of_range');
  const remainder = (value % PRICE_SCALE).toString().padStart(24, '0').replace(/0+$/, '');
  return remainder ? `${integer}.${remainder}` : integer;
}

async function pollNetwork(network, coins, previous, conversions, fetchImpl, now) {
  const config = NETWORKS[network];
  // Avoid using RPC quota while the independently required USD source is stale.
  const conversion = conversionQuote(network, conversions?.[config.conversionCoin], clockValue(now));
  const [chainId, block] = await rpcBatch(network, [
    {method: 'eth_chainId', params: []}, {method: 'eth_getBlockByNumber', params: ['latest', false]},
  ], fetchImpl, now);
  if (quantity(chainId) !== BigInt(config.chainId)) fail('wrong_chain');
  const header = parseHeader(block);
  checkBlockAge(header, clockValue(now));
  const gap = !previous || clockValue(now) - previous.observedAt > BASELINE_GAP_MS
    || header.timestamp - previous.timestamp > BASELINE_GAP_MS;
  if (previous?.healthy && !gap && BigInt(header.number) < BigInt(previous.number)) fail('chain_regressed');
  const pinned = `0x${BigInt(header.number).toString(16)}`;
  const callSpecs = [];
  const add = (key, address, data) => callSpecs.push({key,
    call: {method: 'eth_call', params: [{to: address, data}, pinned]}});
  add('quoteDecimals', config.quoteToken, SELECTORS.decimals);
  for (const coin of coins) {
    const info = POOLS[coin];
    for (const field of ['token0', 'token1', 'reserves', 'factory']) add(`${coin}.${field}`, info.pool, SELECTORS[field]);
    add(`${coin}.decimals`, info.token, SELECTORS.decimals);
    add(`${coin}.pair`, config.factory, SELECTORS.getPair + info.token.slice(2).padStart(64, '0')
      + config.quoteToken.slice(2).padStart(64, '0'));
  }
  const results = await rpcBatch(network, callSpecs.map(spec => spec.call), fetchImpl, now);
  const values = Object.fromEntries(callSpecs.map((spec, i) => [spec.key, results[i]]));
  if (uintWord(values.quoteDecimals) !== 18n) fail('wrong_decimals');
  const reserves = {};
  for (const coin of coins) {
    const info = POOLS[coin];
    const expected = info.tokenIndex === 0 ? [info.token, config.quoteToken] : [config.quoteToken, info.token];
    if (addressWord(values[`${coin}.token0`]) !== expected[0] || addressWord(values[`${coin}.token1`]) !== expected[1]) fail('wrong_token');
    if (addressWord(values[`${coin}.factory`]) !== config.factory || addressWord(values[`${coin}.pair`]) !== info.pool) fail('wrong_factory');
    if (uintWord(values[`${coin}.decimals`]) !== BigInt(info.decimals)) fail('wrong_decimals');
    reserves[coin] = reserveValues(values[`${coin}.reserves`], header);
  }
  // Re-read this exact block after the state calls. Also check the previous
  // healthy observation's block, so a reorganisation starts a fresh baseline.
  const checkPrevious = previous?.healthy && !gap && previous.number !== header.number;
  const finalCalls = [{method: 'eth_getBlockByNumber', params: [pinned, false]}, {method: 'eth_chainId', params: []}];
  if (checkPrevious) finalCalls.push({method: 'eth_getBlockByNumber', params: [`0x${BigInt(previous.number).toString(16)}`, false]});
  const checkedBlocks = await rpcBatch(network, finalCalls, fetchImpl, now);
  const finalHeader = parseHeader(checkedBlocks[0]);
  if (quantity(checkedBlocks[1]) !== BigInt(config.chainId)) fail('wrong_chain');
  if (finalHeader.number !== header.number || finalHeader.hash !== header.hash || finalHeader.timestamp !== header.timestamp) fail('block_changed');
  let reorganised = !!(previous?.healthy && !gap && previous.number === header.number && previous.hash !== header.hash);
  if (checkPrevious) {
    const oldHeader = parseHeader(checkedBlocks[2]);
    if (oldHeader.number !== previous.number) fail('invalid_block');
    reorganised = oldHeader.hash !== previous.hash || oldHeader.timestamp !== previous.timestamp;
  }
  const receivedAt = clockValue(now);
  checkBlockAge(header, receivedAt);
  conversionQuote(network, conversion, receivedAt);
  const freshUntil = Math.min(header.timestamp + QUOTE_MAX_AGE_MS, conversion.timestamp + QUOTE_MAX_AGE_MS,
    conversion.receivedAt + RECEIPT_MAX_AGE_MS, receivedAt + RECEIPT_MAX_AGE_MS, conversion.freshUntil ?? Infinity);
  if (freshUntil <= receivedAt) fail('source_expired');
  const timestamp = Math.max(header.timestamp, conversion.timestamp);
  const quotes = [], evidence = {}, coinObservedAt = {...previous?.coinObservedAt};
  for (const coin of coins) {
    const info = POOLS[coin], reserve = reserves[coin];
    const tokenReserve = info.tokenIndex === 0 ? reserve.reserve0 : reserve.reserve1;
    const quoteReserve = info.tokenIndex === 0 ? reserve.reserve1 : reserve.reserve0;
    const price = usdPrice(tokenReserve, quoteReserve, info.decimals, conversion.price);
    const snapshot = !previous?.healthy || gap || reorganised || !previous.coinObservedAt?.[coin]
      || receivedAt - previous.coinObservedAt[coin] > BASELINE_GAP_MS
      || conversions?.[config.conversionCoin]?.snapshot === true;
    quotes.push({coin, price, source: POOL_SOURCES[coin], timestamp, receivedAt, freshUntil, snapshot});
    evidence[coin] = {network, chainId: config.chainId, pool: info.pool, token: info.token, quoteToken: config.quoteToken,
      tokenDecimals: info.decimals, quoteDecimals: 18, blockNumber: header.number, blockHash: header.hash,
      blockTimestamp: header.timestamp, reserveChangedAt: reserve.reserveChangedAt, observedAt: receivedAt,
      conversionCoin: config.conversionCoin, conversionSource: conversion.source, conversionPrice: conversion.price,
      conversionTimestamp: conversion.timestamp, conversionReceivedAt: conversion.receivedAt, freshUntil, indicative: true};
    coinObservedAt[coin] = receivedAt;
  }
  return {quotes, evidence, head: {...header, observedAt: receivedAt, healthy: true, coinObservedAt},
    resetCoins: reorganised ? [...coins] : []};
}

/**
 * Read only fixed, verified pools. Scheduling, daily quotas and notification
 * state belong to the shared monitor. There are no retries or background timers
 * here; a failed chain invalidates its requested coins and recovers as a snapshot.
 */
export async function pollPoolPrices({fetchImpl = globalThis.fetch, now = () => Date.now(), conversionQuotes = {},
  heads = {}, coins = POOL_COINS} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Array.isArray(coins)
      || coins.some(coin => !POOL_COINS.includes(coin))) throw new TypeError('Choose only the supported pool feeds.');
  const startedAt = clockValue(now);
  const selected = POOL_COINS.filter(coin => coins.includes(coin));
  const nextHeads = {};
  for (const network of Object.keys(NETWORKS)) {
    const prior = priorHead(heads?.[network], startedAt);
    if (prior) nextHeads[network] = prior;
  }
  const networks = Object.keys(NETWORKS).filter(network => selected.some(coin => POOLS[coin].network === network));
  const results = await Promise.allSettled(networks.map(async network => {
    const requested = selected.filter(coin => POOLS[coin].network === network);
    try { return {network, requested, ...await pollNetwork(network, requested, nextHeads[network], conversionQuotes, fetchImpl, now)}; }
    catch (error) { return {network, requested, error: error instanceof FeedError ? error : new FeedError('invalid_response')}; }
  }));
  const quotes = [], evidence = {}, resetCoins = new Set(), errors = [];
  const completedAt = clockValue(now);
  for (let index = 0; index < results.length; index++) {
    const item = results[index];
    const result = item.status === 'fulfilled' ? item.value : {network: networks[index],
      requested: selected.filter(coin => POOLS[coin].network === networks[index]), error: new FeedError('invalid_response')};
    // A slower parallel network can outlast the other network's remaining USD
    // freshness window. Never return an already-expired composite observation.
    if (!result.error && result.quotes.some(quote => !validateQuote(quote, completedAt).valid)) result.error = new FeedError('source_expired');
    if (result.error) {
      nextHeads[result.network] = {...nextHeads[result.network], healthy: false};
      result.requested.forEach(coin => resetCoins.add(coin));
      errors.push({network: result.network, coins: result.requested, reason: result.error.reason,
        ...(Number.isSafeInteger(result.error.retryAt) ? {retryAt: result.error.retryAt} : {})});
    } else {
      nextHeads[result.network] = result.head;
      quotes.push(...result.quotes); Object.assign(evidence, result.evidence);
      result.resetCoins.forEach(coin => resetCoins.add(coin));
    }
  }
  return {quotes, heads: nextHeads, evidence, resetCoins: [...resetCoins], errors};
}
