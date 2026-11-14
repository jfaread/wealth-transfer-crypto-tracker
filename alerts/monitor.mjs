import {COINS, normaliseRule, evaluateRule, validateQuote} from './core.mjs';
import {LIVE_COINS, parseKrakenMessage, connectKraken, reconnectDelay} from './feeds.mjs';
import {POOL_COINS, POOL_POLL_MS, MAX_RPC_REQUESTS_PER_POLL, POOL_SOURCES, pollPoolPrices} from './pool-feeds.mjs';
import {validateSubscription, sendPush} from './webpush.mjs';

const SITE_URL = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const SITE_ORIGIN = 'https://jfaread.github.io';
const CONSENT_VERSION = '2026-11-13';
const SINGLETON = 'crypto-watch-monitor-v1';
const MAX_RULES = 16;
const MAX_BODY = 24_000;
const EVENT_TTL = 120_000;
const DEVICE_TTL = 90 * 86_400_000;
const DEFAULT_FRAME_CAP = 1_000_000;
const MAX_POOL_POLLS = 6_000;
const ALL_COINS = [...LIVE_COINS, ...POOL_COINS];
const POOL_NETWORKS = {ethereum: ['KISHU'], bsc: ['WKC', 'CREPE']};
const CONVERSION_COINS = {ethereum: 'ETH', bsc: 'BNB'};
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
});
const dayKey = now => new Date(now).toISOString().slice(0, 10);
const clone = value => structuredClone(value);
const boundedInt = (value, fallback, max) => Number.isInteger(Number(value)) && Number(value) > 0
  ? Math.min(Number(value), max) : fallback;

function cleanHead(value, network, now) {
  if (!value || !/^\d{1,32}$/.test(value.number || '') || !/^0x[a-f\d]{64}$/i.test(value.hash || '') ||
      !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0 || value.timestamp > now + 5_000 ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0 || value.observedAt > now + 5_000) return null;
  return {number: value.number, hash: value.hash, timestamp: value.timestamp, observedAt: value.observedAt,
    healthy: value.healthy === true,
    coinObservedAt: Object.fromEntries(POOL_NETWORKS[network].filter(coin => Number.isSafeInteger(value.coinObservedAt?.[coin]) &&
      value.coinObservedAt[coin] > 0 && value.coinObservedAt[coin] <= now + 5_000).map(coin => [coin, value.coinObservedAt[coin]]))};
}

function cleanEvidence(value, coin, now) {
  const network = COINS[coin].network, conversion = CONVERSION_COINS[network];
  if (!value || value.indicative !== true || value.network !== network || value.conversionCoin !== conversion ||
      value.chainId !== (network === 'ethereum' ? 1 : 56) ||
      value.token?.toLowerCase() !== COINS[coin].contract.toLowerCase() ||
      !/^0x[a-f\d]{40}$/i.test(value.pool || '') || !/^0x[a-f\d]{40}$/i.test(value.quoteToken || '') ||
      !/^\d{1,32}$/.test(value.blockNumber || '') || !/^0x[a-f\d]{64}$/i.test(value.blockHash || '') ||
      value.conversionSource !== `Kraken ${conversion}/USD` ||
      !Number.isInteger(value.tokenDecimals) || value.tokenDecimals < 0 || value.tokenDecimals > 36 ||
      !Number.isInteger(value.quoteDecimals) || value.quoteDecimals < 0 || value.quoteDecimals > 36 ||
      !Number.isSafeInteger(value.freshUntil) || !/^\d{1,18}(?:\.\d{1,24})?$/.test(value.conversionPrice || '')) return null;
  const fields = ['blockTimestamp', 'reserveChangedAt', 'observedAt', 'conversionTimestamp', 'conversionReceivedAt'];
  if (fields.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > now + 5_000)) return null;
  return Object.fromEntries(['network', 'chainId', 'pool', 'token', 'quoteToken', 'tokenDecimals', 'quoteDecimals',
    'blockNumber', 'blockHash', ...fields, 'conversionCoin', 'conversionSource', 'conversionPrice', 'freshUntil', 'indicative']
    .map(key => [key, key === 'chainId' ? (network === 'ethereum' ? 1 : 56) : value[key]]));
}

function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
function randomSecret() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
function isActive(env) {
  return env.ALERTS_ENABLED === 'true' && !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY && !!env.VAPID_SUBJECT
    && (!env.PUBLIC_SITE_URL || env.PUBLIC_SITE_URL === SITE_URL)
    && (!env.ALLOWED_ORIGIN || env.ALLOWED_ORIGIN === SITE_ORIGIN);
}
function cors(response, request) {
  const result = new Response(response.body, response);
  result.headers.set('Vary', 'Origin');
  result.headers.set('Access-Control-Allow-Origin', SITE_ORIGIN);
  result.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  result.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  result.headers.set('Access-Control-Max-Age', '600');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Cache-Control', 'no-store');
  return result;
}
function checkOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== SITE_ORIGIN) throw new ApiError(403, 'wrong_origin', 'Use the Crypto-Watch website to manage alerts.');
  if (!['GET', 'OPTIONS'].includes(request.method) && origin !== SITE_ORIGIN) {
    throw new ApiError(403, 'origin_required', 'Open Crypto-Watch to make this change.');
  }
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'json_required', 'The request must contain JSON.');
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw new ApiError(413, 'request_too_large', 'The alert settings are too large.');
  let text = '', bytes = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json', 'Check the alert settings and try again.');
  const decoder = new TextDecoder();
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new ApiError(413, 'request_too_large', 'The alert settings are too large.');
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  throw new ApiError(400, 'invalid_json', 'Check the alert settings and try again.');
}
function publicError(error) {
  return error instanceof ApiError ? json({error: {code: error.code, message: error.message}}, error.status)
    : json({error: {code: 'temporarily_unavailable', message: 'Alerts are temporarily unavailable. Please try again shortly.'}}, 503);
}
function publicDevice(device, monitor) {
  return {deviceId: device.id, rules: device.rules, revision: device.revision,
    events: device.events || [], subscriptionExpired: !!device.subscriptionExpired, monitor};
}

export default {
  async fetch(request, env) {
    try {
      checkOrigin(request);
      if (request.method === 'OPTIONS') return cors(new Response(null, {status: 204}), request);
      if (!new URL(request.url).pathname.startsWith('/v1/')) return cors(json({error: {code: 'not_found', message: 'Not found.'}}, 404), request);
      if (!env.ALERT_MONITOR) return cors(json({error: {code: 'not_configured', message: 'The alert service has not been connected yet.'}}, 503), request);
      const stub = env.ALERT_MONITOR.getByName ? env.ALERT_MONITOR.getByName(SINGLETON)
        : env.ALERT_MONITOR.get(env.ALERT_MONITOR.idFromName(SINGLETON));
      const forwarded = new Request(request);
      // Cloudflare supplies this address. Never accept a client-provided internal bucket.
      forwarded.headers.set('X-Alert-IP-Bucket', await hash(request.headers.get('CF-Connecting-IP') || 'unidentified'));
      return cors(await stub.fetch(forwarded), request);
    } catch (error) { return cors(publicError(error), request); }
  },
};

/** One object shares eight observations; phone numbers and wallet access are not collected. */
export class CryptoAlertMonitor {
  constructor(ctx, env, dependencies = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = dependencies.now || (() => Date.now());
    this.send = dependencies.sendPush || sendPush;
    this.connect = dependencies.connectKraken || connectKraken;
    this.poll = dependencies.pollPoolPrices || pollPoolPrices;
    this.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    this.devices = new Map();
    this.states = new Map();
    this.quotes = new Map();
    this.pending = new Map();
    this.operations = new Map();
    this.ipBuckets = new Map();
    this.serial = Promise.resolve();
    this.socket = null;
    this.connecting = false;
    this.connectionGeneration = 0;
    this.reconnectAttempts = 0;
    this.nextReconnectAt = 0;
    this.lastFrameAt = 0;
    this.probeUntil = 0;
    this.frameAllowance = 0;
    this.lastCheckpoint = 0;
    this.draining = false;
    this.feedStatus = 'waiting';
    this.poolPolling = false;
    this.poolGeneration = {ethereum: 0, bsc: 0};
    this.poolHeads = {};
    this.poolEvidence = {};
    this.poolNetworks = Object.fromEntries(Object.keys(POOL_NETWORKS).map(network => [network, {nextPollAt: 0, failures: 0, reason: null}]));
    this.ready = this.load();
    if (ctx.blockConcurrencyWhile) ctx.blockConcurrencyWhile(() => this.ready);
  }

  async load() {
    const saved = await this.ctx.storage.list();
    for (const [key, value] of saved) {
      if (key.startsWith('device:')) {
        this.devices.set(value.id, value);
        // Preserve completed/cooldown metadata, but rebaseline every recovered rule.
        this.states.set(value.id, Object.fromEntries(Object.entries(value.states || {})
          .map(([id, state]) => [id, state ? {...state, needsBaseline: true} : null])));
      } else if (key.startsWith('outbox:')) this.pending.set(value.eventId, value);
      else if (key.startsWith('operation:')) this.operations.set(key.slice(10), value);
      else if (key.startsWith('ip:')) this.ipBuckets.set(key.slice(3), value);
    }
    this.usage = saved.get('usage') || {day: dayKey(this.now()), count: 0};
    this.feedBudget = saved.get('feedBudget') || {day: dayKey(this.now()), reserved: 0};
    const poolBudget = saved.get('poolBudget');
    this.poolBudget = poolBudget && /^\d{4}-\d{2}-\d{2}$/.test(poolBudget.day || '') && Number.isSafeInteger(poolBudget.reserved) && poolBudget.reserved >= 0
      ? {day: poolBudget.day, reserved: Math.min(MAX_POOL_POLLS, poolBudget.reserved)}
      : {day: dayKey(this.now()), reserved: poolBudget ? MAX_POOL_POLLS : 0};
    const poolState = saved.get('poolState');
    if (poolState?.version === 1) {
      this.probeUntil = Number.isSafeInteger(poolState.probeUntil) ? Math.min(this.now() + 300_000, poolState.probeUntil) : 0;
      for (const network of Object.keys(POOL_NETWORKS)) {
        const state = poolState.networks?.[network];
        if (state) this.poolNetworks[network] = {
          nextPollAt: Number.isSafeInteger(state.nextPollAt) && state.nextPollAt > 0 ? state.nextPollAt : 0,
          failures: Number.isInteger(state.failures) ? Math.min(10, Math.max(0, state.failures)) : 0,
          reason: /^[a-z_]{1,64}$/.test(state.reason || '') ? state.reason : null};
        const head = cleanHead(poolState.heads?.[network], network, this.now());
        if (head) this.poolHeads[network] = {...head, healthy: false};
      }
      for (const coin of POOL_COINS) {
        const evidence = cleanEvidence(poolState.evidence?.[coin], coin, this.now());
        if (evidence) this.poolEvidence[coin] = evidence;
      }
    }
    if (this.budgetPaused()) this.feedStatus = 'budget_paused';
  }

  locked(fn) {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => {});
    return next;
  }

  background(promise) {
    const safe = Promise.resolve(promise).catch(() => { this.feedStatus = 'recovering'; });
    if (this.ctx.waitUntil) this.ctx.waitUntil(safe);
    return safe;
  }

  async fetch(request) {
    try {
      await this.ready;
      checkOrigin(request);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/config') {
        if (isActive(this.env)) {
          await this.locked(async () => {
            if (!this.hasActiveRules() || POOL_COINS.some(coin => !this.freshQuote(coin))) await this.startProbe();
          });
          this.background(this.ensureSources());
        }
        return json(this.config());
      }
      if (request.method === 'POST' && path === '/v1/devices') {
        this.requireActive();
        const body = await readJson(request);
        return await this.locked(() => this.register(body, request.headers.get('X-Alert-IP-Bucket') || 'unidentified'));
      }
      if (!['/v1/device', '/v1/rules', '/v1/test'].includes(path)) throw new ApiError(404, 'not_found', 'Not found.');
      const deviceId = await this.authenticate(request);
      if (request.method === 'GET' && path === '/v1/device') {
        if (isActive(this.env)) this.background(this.ensureSources());
        return json(publicDevice(this.devices.get(deviceId), this.monitor()));
      }
      if (request.method === 'DELETE' && path === '/v1/device') return await this.locked(() => this.remove(deviceId));
      this.requireActive();
      if (request.method === 'PUT' && path === '/v1/rules') {
        const body = await readJson(request);
        return await this.locked(() => this.saveRules(deviceId, body));
      }
      if (request.method === 'POST' && path === '/v1/test') {
        await readJson(request);
        const response = await this.locked(() => this.queueTest(deviceId));
        this.background(this.drainOutbox());
        return response;
      }
      throw new ApiError(405, 'method_not_allowed', 'This action is not supported.');
    } catch (error) { return publicError(error); }
  }

  requireActive() {
    if (!isActive(this.env)) throw new ApiError(503, 'alerts_disabled', 'Phone alerts are not live yet. Your saved drafts have not been activated.');
  }

  monitor() {
    const now = this.now();
    const paused = this.budgetPaused();
    const fresh = paused ? [] : ALL_COINS.filter(coin => this.freshQuote(coin, now));
    return {status: !isActive(this.env) ? 'disabled' : paused ? 'budget_paused' : fresh.length === ALL_COINS.length ? 'live'
      : fresh.length ? 'partial' : this.feedStatus,
    source: 'Kraken USD spot tickers and indicative selected-pool USD prices',
    lastObservedAt: Math.max(0, ...fresh.map(coin => this.quotes.get(coin).timestamp)) || null,
    freshCoins: fresh, unavailableCoins: ALL_COINS.filter(coin => !fresh.includes(coin)),
    frameBudgetRemaining: this.feedBudget?.day === dayKey(now)
      ? Math.max(0, this.frameCap() - this.feedBudget.reserved + this.frameAllowance) : this.frameCap(),
    poolPollsRemaining: this.poolBudget?.day === dayKey(now) ? Math.max(0, this.poolCap() - this.poolBudget.reserved) : this.poolCap(),
    poolPollingIntervalMs: POOL_POLL_MS,
    poolNetworks: clone(this.poolNetworks),
    message: !isActive(this.env) ? 'The alert service has not been activated.'
      : paused ? 'The free live-price allowance has been reached. Monitoring resumes after 00:00 UTC with a fresh baseline.'
      : this.poolBudgetPaused() ? 'The free pool-price allowance has been reached. Pool alerts resume after 00:00 UTC with a fresh baseline; available Kraken alerts continue.'
      : 'Pool prices are indicative USD values from selected pools, sampled about every 15 seconds. Coins without fresh prices are paused. Notification delivery is best effort, not instantaneous.'};
  }

  config() {
    const active = isActive(this.env), now = this.now(), paused = this.budgetPaused();
    const coins = Object.entries(COINS).map(([id, info]) => {
      const pool = POOL_COINS.includes(id), supported = ALL_COINS.includes(id);
      const fresh = this.freshQuote(id, now), schedule = pool ? this.poolNetworks[info.network] : null;
      return {id, name: info.name || id, enabled: !!(active && !paused && supported && fresh),
        source: pool ? POOL_SOURCES[id] : `Kraken ${id}/USD`, maxAgeMs: supported ? 60_000 : null,
        indicative: pool, samplingMs: pool ? POOL_POLL_MS : null,
        ...(pool ? {evidence: this.poolEvidence[id] || null, nextPollAt: schedule.nextPollAt || null} : {}),
        reason: !supported ? 'A dependable price source is not available for this token.'
          : !active ? 'The alert service is not live yet.' : paused ? 'The free live-price allowance has been reached. Monitoring resumes after 00:00 UTC.'
            : pool && this.poolBudgetPaused() ? 'The free pool-price allowance has been reached. Pool monitoring resumes after 00:00 UTC.'
              : pool && !fresh ? 'Waiting for a fresh validated pool observation and its ETH or BNB USD conversion. Pool prices are indicative, sampled about every 15 seconds.'
                : !fresh ? 'Waiting for a fresh price from the live feed.' : null};
    });
    return {version: 1, enabled: active, vapidPublicKey: active ? this.env.VAPID_PUBLIC_KEY : null,
      siteUrl: SITE_URL, consentVersion: CONSENT_VERSION, coins,
      capabilities: Object.fromEntries(coins.map(c => [c.id, {available: c.enabled, reason: c.reason, source: c.source}])),
      limits: {maxDevices: boundedInt(this.env.MAX_DEVICES, 50, 50), maxRules: MAX_RULES,
        maxPushesPerDevicePerDay: 20, maxPushesPerDay: 200, maxFeedFramesPerDay: this.frameCap(),
        maxPoolPollsPerDay: this.poolCap(), maxPoolRpcRequestsPerPoll: MAX_RPC_REQUESTS_PER_POLL}, monitor: this.monitor()};
  }

  freshQuote(coin, now = this.now()) {
    return !this.budgetPaused() && (!POOL_COINS.includes(coin) || !this.poolBudgetPaused()) &&
      validateQuote(this.quotes.get(coin), now).valid;
  }

  hasActiveRules() { return Array.from(this.devices.values()).some(device => device.rules.some(rule => rule.enabled)); }
  needsFeed() {
    return this.probeUntil > this.now() || Array.from(this.devices.values()).some(device =>
      device.rules.some(rule => rule.enabled && (LIVE_COINS.includes(rule.coin) || !this.poolBudgetPaused())));
  }
  frameCap() { return boundedInt(this.env.MAX_FEED_FRAMES_PER_DAY, DEFAULT_FRAME_CAP, DEFAULT_FRAME_CAP); }
  poolCap() { return boundedInt(this.env.MAX_POOL_POLLS_PER_DAY, MAX_POOL_POLLS, MAX_POOL_POLLS); }
  poolBudgetPaused() { return this.poolBudget?.day === dayKey(this.now()) && this.poolBudget.reserved >= this.poolCap(); }
  budgetPaused() {
    return this.feedBudget?.day === dayKey(this.now()) && this.feedBudget.reserved >= this.frameCap() && this.frameAllowance <= 0;
  }

  poolState() {
    return {version: 1, probeUntil: this.probeUntil, networks: this.poolNetworks, heads: this.poolHeads, evidence: this.poolEvidence};
  }

  async startProbe() {
    if (this.probeUntil > this.now()) return;
    const until = this.now() + 300_000;
    await this.ctx.storage.put('poolState', {...this.poolState(), probeUntil: until});
    this.probeUntil = until;
  }

  neededPoolCoins() {
    if (this.probeUntil > this.now()) return [...POOL_COINS];
    const needed = new Set();
    for (const device of this.devices.values()) for (const rule of device.rules) {
      if (rule.enabled && POOL_COINS.includes(rule.coin)) needed.add(rule.coin);
    }
    return [...needed];
  }

  invalidateCoins(coins) {
    const affected = new Set(coins);
    for (const coin of affected) this.quotes.delete(coin);
    for (const [id, device] of this.devices) {
      const states = {...(this.states.get(id) || {})};
      for (const rule of device.rules) if (affected.has(rule.coin) && states[rule.id]) states[rule.id] = {...states[rule.id], needsBaseline: true};
      this.states.set(id, states);
    }
  }

  expirePoolQuotes(now = this.now()) {
    this.invalidateCoins(POOL_COINS.filter(coin => this.quotes.has(coin) && !validateQuote(this.quotes.get(coin), now).valid));
  }

  async resetFrameDay() {
    if (this.feedBudget.day === dayKey(this.now())) return;
    const wasPaused = this.feedBudget.reserved >= this.frameCap() && this.frameAllowance <= 0;
    this.feedBudget = {day: dayKey(this.now()), reserved: 0}; this.frameAllowance = 0;
    await this.ctx.storage.put('feedBudget', this.feedBudget);
    if (wasPaused) {
      this.quotes.clear(); this.feedStatus = 'waiting'; this.nextReconnectAt = 0;
      for (const [id, states] of this.states) this.states.set(id, Object.fromEntries(Object.entries(states)
        .map(([ruleId, state]) => [ruleId, state ? {...state, needsBaseline: true} : null])));
    }
  }

  async acceptFrame(raw, generation) {
    const accepted = await this.locked(async () => {
      if (generation !== this.connectionGeneration) return false;
      await this.resetFrameDay();
      if (this.budgetPaused()) return false;
      // Reserve bounded batches BEFORE consuming them. A restart loses unused
      // allowance rather than silently resetting a daily cap or undercounting it.
      if (!this.frameAllowance) {
        const allowance = Math.min(1_000, this.frameCap() - this.feedBudget.reserved);
        const next = {...this.feedBudget, reserved: this.feedBudget.reserved + allowance};
        await this.ctx.storage.put('feedBudget', next);
        this.feedBudget = next; this.frameAllowance = allowance;
      }
      this.frameAllowance--;
      this.lastFrameAt = this.now();
      if (this.budgetPaused()) {
        this.closeFeed(); this.feedStatus = 'budget_paused';
        await this.planWake();
      }
      return true;
    });
    if (!accepted) return;
    const parsed = parseKrakenMessage(raw, this.now());
    if (parsed.reason === 'subscription_rejected' && !this.budgetPaused()) this.feedStatus = 'unavailable';
    if (parsed.quotes.length) {
      await this.processQuotes(parsed.quotes); await this.drainOutbox();
      if (parsed.quotes.some(quote => ['ETH', 'BNB'].includes(quote.coin))) this.background(this.ensurePools());
    }
  }

  async planWake() {
    const now = this.now();
    const targets = Array.from(this.pending.values(), job => Math.min(job.nextAttemptAt, job.expiresAt));
    const nextDay = Date.parse(`${dayKey(now)}T00:00:00.000Z`) + 86_400_000;
    if (this.budgetPaused() && (this.hasActiveRules() || this.needsFeed())) targets.push(nextDay);
    else {
      if (this.needsFeed()) targets.push(now + 15_000);
      const needed = this.neededPoolCoins();
      if (needed.length && this.poolBudgetPaused()) targets.push(nextDay);
      else for (const [network, coins] of Object.entries(POOL_NETWORKS)) {
        if (coins.some(coin => needed.includes(coin))) {
          const next = this.poolNetworks[network].nextPollAt;
          targets.push(next > now ? next : now + POOL_POLL_MS);
        }
      }
      if (this.probeUntil > now) targets.push(this.probeUntil);
    }
    const existing = await this.ctx.storage.getAlarm();
    if (!targets.length) { if (existing != null) await this.ctx.storage.deleteAlarm(); return; }
    const when = Math.max(now + 250, Math.min(...targets));
    const onlyDailyReset = this.pending.size === 0 && (this.budgetPaused() || (!this.needsFeed() && this.poolBudgetPaused()));
    if (existing == null || existing <= now || when < existing || (onlyDailyReset && existing !== when)) await this.ctx.storage.setAlarm(when);
  }

  async authenticate(request) {
    const value = request.headers.get('Authorization') || '';
    const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/i.exec(value);
    const id = match?.[1], device = id && this.devices.get(id);
    const candidate = await hash(match?.[2] || 'invalid');
    if (!device || !sameHash(device.tokenHash, candidate)) throw new ApiError(401, 'not_authorised', 'This browser is not connected. Enable phone alerts again.');
    return id;
  }

  async register(body, ipKey) {
    const now = this.now();
    if (body.consentVersion !== CONSENT_VERSION) throw new ApiError(400, 'consent_required', 'Read and accept the alert permission before connecting this device.');
    if (typeof body.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.operationId)) throw new ApiError(400, 'operation_id_required', 'Reload the alert panel and try again.');
    let subscription;
    try { subscription = validateSubscription(body.subscription); }
    catch { throw new ApiError(400, 'invalid_subscription', 'Your browser notification subscription is invalid. Enable notifications and try again.'); }
    const fingerprint = await hash(JSON.stringify(subscription));
    const operationKey = await hash(body.operationId);
    if (this.operations.has(operationKey) || Array.from(this.devices.values()).some(d => d.subscription.endpoint === subscription.endpoint)) {
      throw new ApiError(409, 'registration_already_created', 'This browser subscription is already connected. Keep using its saved access key. If registration was interrupted, reset the browser notification subscription and connect again.');
    }
    if (this.devices.size >= boundedInt(this.env.MAX_DEVICES, 50, 50)) throw new ApiError(429, 'pilot_full', 'This free pilot has reached its device limit. Please try again later.');
    const today = dayKey(now), existing = this.ipBuckets.get(ipKey);
    const bucket = existing?.day === today ? {...existing} : {day: today, count: 0};
    if (bucket.count >= 10) throw new ApiError(429, 'registration_limit', 'Too many devices were connected from this network today. Please try again tomorrow.');
    bucket.count++;
    const id = crypto.randomUUID(), secret = randomSecret();
    const device = {id, tokenHash: await hash(secret), subscription, fingerprint,
      consentVersion: CONSENT_VERSION, createdAt: now, updatedAt: now,
      revision: 0, rules: [], events: [], pushUsage: {day: today, count: 0}, lastTestAt: null};
    const operation = {deviceId: id, createdAt: now};
    await this.ctx.storage.transaction(async tx => {
      await tx.put(`device:${id}`, device);
      await tx.put(`operation:${operationKey}`, operation);
      await tx.put(`ip:${ipKey}`, bucket);
    });
    this.devices.set(id, device); this.states.set(id, {});
    this.operations.set(operationKey, operation); this.ipBuckets.set(ipKey, bucket);
    await this.startProbe();
    await this.scheduleAlarm(now + 15_000);
    this.background(this.ensureSources());
    return json({deviceId: id, token: `${id}.${secret}`, rules: [], revision: 0}, 201);
  }

  async saveRules(id, body) {
    const current = this.devices.get(id);
    if (!Number.isSafeInteger(body.revision) || body.revision !== current.revision) {
      throw new ApiError(409, 'revision_conflict', 'Your alerts changed elsewhere. Reload them before saving again.');
    }
    if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) throw new ApiError(400, 'invalid_rules', 'You can save up to 16 alerts per device.');
    const rules = [];
    for (const input of body.rules) {
      let rule;
      try { rule = normaliseRule({...input, id: input?.id || crypto.randomUUID()}); }
      catch (error) { throw new ApiError(400, 'invalid_rule', error.message || 'Check the coin and threshold.'); }
      if (rules.some(existing => existing.id === rule.id)) throw new ApiError(400, 'duplicate_rule', 'Each alert must have a different identifier.');
      const previous = current.rules.find(existing => existing.id === rule.id);
      const activating = rule.enabled && (!previous || JSON.stringify(previous) !== JSON.stringify(rule));
      if (activating && !ALL_COINS.includes(rule.coin)) throw new ApiError(400, 'feed_not_ready', 'A verified price source is not available. Save the alert as a disabled draft.');
      if (activating && this.budgetPaused()) throw new ApiError(409, 'feed_budget_paused', 'The free live-price allowance has been reached. Save a disabled draft or try again after 00:00 UTC.');
      if (activating && POOL_COINS.includes(rule.coin) && this.poolBudgetPaused()) throw new ApiError(409, 'daily_pool_limit', 'The free pool-price allowance has been reached. Available Kraken alerts continue; pool monitoring resumes after 00:00 UTC.');
      if (activating && !this.freshQuote(rule.coin)) {
        await this.startProbe();
        this.background(this.ensureSources());
        throw new ApiError(409, 'price_not_ready', 'A fresh live price is not available yet. Wait a few seconds and try again, or save a disabled draft.');
      }
      rules.push(rule);
    }
    const states = this.states.get(id) || {}, nextStates = {};
    for (const rule of rules) {
      const old = current.rules.find(r => r.id === rule.id);
      if (old && JSON.stringify(old) === JSON.stringify(rule)) nextStates[rule.id] = states[rule.id];
      else if (rule.enabled) nextStates[rule.id] = evaluateRule(rule, null, this.quotes.get(rule.coin), this.now()).state;
    }
    const device = {...current, rules, revision: current.revision + 1, updatedAt: this.now(), states: nextStates};
    await this.ctx.storage.put(`device:${id}`, device);
    this.devices.set(id, device); this.states.set(id, nextStates);
    await this.scheduleAlarm(this.now() + 15_000);
    return json({rules, revision: device.revision});
  }

  async remove(id) {
    const keys = [`device:${id}`];
    for (const [key, operation] of this.operations) if (operation.deviceId === id) keys.push(`operation:${key}`);
    for (const [key, job] of this.pending) if (job.deviceId === id) keys.push(`outbox:${key}`);
    await this.ctx.storage.transaction(async tx => { for (const key of keys) await tx.delete(key); });
    this.devices.delete(id); this.states.delete(id);
    for (const [key, operation] of this.operations) if (operation.deviceId === id) this.operations.delete(key);
    for (const [key, job] of this.pending) if (job.deviceId === id) this.pending.delete(key);
    if (!this.devices.size) {
      this.probeUntil = 0;
      this.closeFeed();
      await this.ctx.storage.put('poolState', this.poolState());
      await this.ctx.storage.deleteAlarm();
    }
    return json({deleted: true});
  }

  async queueTest(id) {
    const now = this.now(), current = this.devices.get(id);
    if (current.lastTestAt != null && now - current.lastTestAt < 60_000) throw new ApiError(429, 'test_limit', 'Wait one minute before sending another test notification.');
    if (this.overBudget(current, now)) throw new ApiError(429, 'daily_limit', 'The free daily notification allowance has been reached. Try again tomorrow.');
    const eventId = crypto.randomUUID();
    const payload = {version: 1, eventId, title: 'Crypto-Watch test',
      body: 'Phone alerts are connected to this browser. Market alert delivery is best effort.',
      url: SITE_URL, observedAt: now, expiresAt: now + EVENT_TTL};
    const job = {eventId, deviceId: id, payload, createdAt: now, expiresAt: payload.expiresAt,
      status: 'queued', attempts: 0, nextAttemptAt: now};
    const device = {...current, lastTestAt: now, events: [{id: eventId, type: 'test', status: 'queued', observedAt: now}, ...current.events].slice(0, 50)};
    await this.ctx.storage.transaction(async tx => { await tx.put(`device:${id}`, device); await tx.put(`outbox:${eventId}`, job); });
    this.devices.set(id, device); this.pending.set(eventId, job);
    await this.scheduleAlarm(now + 1_000);
    return json({eventId, status: 'queued'}, 202);
  }

  async ensureSources() {
    await this.ensureFeed();
    await this.ensurePools();
  }

  async preparePoolRound() {
    const now = this.now(), today = dayKey(now);
    this.expirePoolQuotes(now);
    if (this.poolBudget.day !== today) {
      this.poolBudget = {day: today, reserved: 0};
      await this.ctx.storage.put('poolBudget', this.poolBudget);
      this.invalidateCoins(POOL_COINS);
      for (const network of Object.keys(this.poolHeads)) this.poolHeads[network].healthy = false;
    }
    if (!isActive(this.env) || this.budgetPaused() || this.poolBudgetPaused()) {
      this.invalidateCoins(POOL_COINS);
      return null;
    }
    const needed = this.neededPoolCoins(), coins = [], networks = [], conversions = {};
    let changed = false;
    const schedule = clone(this.poolNetworks);
    for (const [network, candidates] of Object.entries(POOL_NETWORKS)) {
      const selected = candidates.filter(coin => needed.includes(coin));
      if (!selected.length || now < schedule[network].nextPollAt) continue;
      schedule[network].nextPollAt = now + POOL_POLL_MS;
      changed = true;
      const conversion = this.quotes.get(CONVERSION_COINS[network]);
      if (!validateQuote(conversion, now).valid ||
          Math.min(conversion.timestamp + 60_000, conversion.receivedAt + 30_000, conversion.freshUntil ?? Infinity) <= now) {
        this.invalidateCoins(candidates);
        if (this.poolHeads[network]) this.poolHeads[network].healthy = false;
        schedule[network].reason = 'conversion_unavailable';
        continue;
      }
      coins.push(...selected); networks.push(network);
      conversions[CONVERSION_COINS[network]] = clone(conversion);
    }
    if (!coins.length) {
      if (changed) {
        await this.ctx.storage.put('poolState', {...this.poolState(), networks: schedule});
        this.poolNetworks = schedule;
      }
      return null;
    }
    const budget = {...this.poolBudget, reserved: this.poolBudget.reserved + 1};
    // Reserve the round and its next eligible times atomically before HTTP.
    // A terminated attempt consumes its reservation rather than resetting it.
    await this.ctx.storage.transaction(async tx => {
      await tx.put('poolBudget', budget);
      await tx.put('poolState', {...this.poolState(), networks: schedule});
    });
    this.poolBudget = budget; this.poolNetworks = schedule;
    return {coins, networks, conversionQuotes: conversions, heads: clone(this.poolHeads), generations: {...this.poolGeneration}};
  }

  async applyPoolResult(round, result) {
    const now = this.now(), inputs = [];
    this.expirePoolQuotes(now);
    const wanted = this.neededPoolCoins();
    if (!isActive(this.env) || this.budgetPaused() || !wanted.length) {
      this.invalidateCoins(round.coins);
      return inputs;
    }
    const shape = result && Array.isArray(result.quotes) && result.quotes.length <= POOL_COINS.length &&
      Array.isArray(result.errors) && result.errors.length <= 3 && Array.isArray(result.resetCoins);
    const errors = shape ? result.errors : round.networks.map(network => ({network, coins: POOL_NETWORKS[network], reason: 'pool_unavailable'}));
    if (shape) this.invalidateCoins(result.resetCoins.filter(coin => round.coins.includes(coin)));
    for (const network of round.networks) {
      const selected = round.coins.filter(coin => POOL_NETWORKS[network].includes(coin));
      const error = errors.find(item => item?.network === network);
      const head = cleanHead(shape ? result.heads?.[network] : null, network, now);
      const changedConversion = round.generations[network] !== this.poolGeneration[network];
      const accepted = [];
      for (const coin of selected) {
        const input = shape && result.quotes.find(quote => quote?.coin === coin);
        const evidence = shape && cleanEvidence(result.evidence?.[coin], coin, now);
        if (!wanted.includes(coin) || error || !head?.healthy || changedConversion || !input || !evidence ||
            input.source !== POOL_SOURCES[coin] || !Number.isSafeInteger(input.freshUntil) ||
            evidence.freshUntil !== input.freshUntil || !validateQuote(input, now).valid) {
          this.invalidateCoins([coin]);
          continue;
        }
        this.poolEvidence[coin] = evidence;
        accepted.push(input);
      }
      if (head) this.poolHeads[network] = {...head, healthy: head.healthy && !changedConversion && !error};
      if (accepted.length === selected.length && !error) {
        this.poolNetworks[network] = {...this.poolNetworks[network], failures: 0, reason: null};
        inputs.push(...accepted);
      } else {
        // Chain failures never alter the other network's independent interval.
        const failures = Math.min(10, this.poolNetworks[network].failures + 1);
        const retryAt = Number.isSafeInteger(error?.retryAt) && error.retryAt > now ? error.retryAt : 0;
        this.poolNetworks[network] = {failures,
          nextPollAt: Math.max(this.poolNetworks[network].nextPollAt, now + Math.min(300_000, POOL_POLL_MS * 2 ** (failures - 1)), retryAt),
          reason: /^[a-z_]{1,64}$/.test(error?.reason || '') ? error.reason : 'pool_unavailable'};
        this.invalidateCoins(selected);
        if (this.poolHeads[network]) this.poolHeads[network].healthy = false;
      }
    }
    await this.ctx.storage.put('poolState', this.poolState());
    return inputs;
  }

  async ensurePools() {
    await this.ready;
    const needed = this.neededPoolCoins(), now = this.now();
    if (this.poolPolling || !isActive(this.env) || this.budgetPaused() || !needed.length) return;
    if (this.poolBudget.day === dayKey(now) && (this.poolBudgetPaused() ||
        Object.entries(POOL_NETWORKS).every(([network, coins]) => !coins.some(coin => needed.includes(coin)) || this.poolNetworks[network].nextPollAt > now))) return;
    this.poolPolling = true;
    try {
      const round = await this.locked(() => this.preparePoolRound());
      if (!round) return;
      let requests = 0, result;
      const fetchImpl = this.fetchImpl;
      try {
        result = await this.poll({now: this.now, conversionQuotes: round.conversionQuotes, heads: round.heads, coins: round.coins,
          fetchImpl: (...args) => {
            if (++requests > MAX_RPC_REQUESTS_PER_POLL) throw new Error('Pool HTTP request limit reached.');
            return fetchImpl(...args);
          }});
      } catch { result = null; }
      const inputs = await this.locked(() => this.applyPoolResult(round, result));
      if (inputs.length) await this.processQuotes(inputs, round.generations);
      // Provider delivery must not hold the price-source single-flight guard.
      this.background(this.drainOutbox());
    } finally {
      this.poolPolling = false;
      await this.planWake();
    }
  }

  async ensureFeed() {
    await this.locked(() => this.resetFrameDay());
    if (this.budgetPaused()) { this.feedStatus = 'budget_paused'; await this.planWake(); return; }
    if (!isActive(this.env) || !this.needsFeed() || this.socket || this.connecting || this.now() < this.nextReconnectAt) return;
    this.connecting = true; this.feedStatus = 'connecting';
    const generation = ++this.connectionGeneration;
    try {
      const socket = await this.connect({fetchImpl: this.fetchImpl,
        onOpen: () => { this.lastFrameAt = this.now(); },
        onMessage: raw => {
          if (generation !== this.connectionGeneration) return;
          this.background(this.acceptFrame(raw, generation));
        },
        onClose: () => {
          if (generation !== this.connectionGeneration) return;
          this.socket = null; this.feedStatus = 'recovering';
          this.resetPoolConversions();
          this.nextReconnectAt = this.now() + reconnectDelay(this.reconnectAttempts++);
          this.background(this.scheduleAlarm(this.nextReconnectAt));
        }});
      if (generation !== this.connectionGeneration) { try { socket.close(); } catch {} return; }
      this.socket = socket; this.reconnectAttempts = 0; this.feedStatus = 'waiting_for_prices';
    } catch {
      this.feedStatus = 'recovering';
      this.resetPoolConversions();
      this.nextReconnectAt = this.now() + reconnectDelay(this.reconnectAttempts++);
    } finally {
      this.connecting = false;
      await this.scheduleAlarm(Math.min(this.nextReconnectAt || Infinity, this.now() + 15_000));
    }
  }

  closeFeed() {
    ++this.connectionGeneration;
    try { this.socket?.close(1000, 'Monitor paused'); } catch {}
    this.socket = null; this.feedStatus = 'waiting';
    this.resetPoolConversions();
  }

  resetPoolConversions(conversion) {
    for (const [network, coin] of Object.entries(CONVERSION_COINS)) {
      if (conversion && coin !== conversion) continue;
      // A closed native feed must supply a new observation before its pool
      // conversion can establish a recovery baseline, even within 30 seconds.
      if (!conversion) this.quotes.delete(coin);
      this.poolGeneration[network]++;
      this.invalidateCoins(POOL_NETWORKS[network]);
      if (this.poolHeads[network]) this.poolHeads[network].healthy = false;
    }
  }

  async processQuotes(quotes, poolGenerations) {
    await this.ready;
    if (!isActive(this.env)) return;
    await this.locked(async () => {
      const now = this.now();
      // Composite expiry can occur sooner than a rule's ordinary gap window.
      // Invalidate the old baseline before accepting a later fresh composite.
      this.expirePoolQuotes(now);
      for (const input of quotes) {
        const checked = validateQuote(input, now);
        const pool = POOL_COINS.includes(input.coin);
        if (pool && poolGenerations && poolGenerations[COINS[input.coin].network] !== this.poolGeneration[COINS[input.coin].network]) {
          this.invalidateCoins([input.coin]);
          continue;
        }
        if (!checked.valid || !ALL_COINS.includes(input.coin) ||
            (pool && (input.source !== POOL_SOURCES[input.coin] || !Number.isSafeInteger(input.freshUntil)))) {
          if (pool) this.invalidateCoins([input.coin]);
          continue;
        }
        if (input.snapshot && ['ETH', 'BNB'].includes(input.coin)) this.resetPoolConversions(input.coin);
        const quote = checked.quote || input;
        const prior = this.quotes.get(quote.coin);
        if (prior && quote.timestamp <= prior.timestamp) continue;
        this.quotes.set(quote.coin, quote);
        for (const [id, current] of this.devices) {
          const relevant = current.rules.filter(r => r.enabled && r.coin === quote.coin);
          if (!relevant.length) continue;
          const states = {...(this.states.get(id) || {})};
          let device = current;
          const jobs = [];
          for (const rule of relevant) {
            const previous = states[rule.id] || null;
            const result = evaluateRule(rule, input.snapshot && previous ? {...previous, needsBaseline: true} : previous, quote, now);
            states[rule.id] = result.state;
            if (!result.event || input.snapshot) continue;
            const event = result.event;
            const eventId = `${id}:${event.id || crypto.randomUUID()}`;
            if (this.pending.has(eventId) || current.events.some(e => e.id === eventId)) continue;
            const payload = {version: 1, eventId, title: `${rule.coin} price alert`,
              body: `${rule.coin} crossed ${rule.direction} $${rule.threshold}. Observed $${quote.price} on ${quote.source}.`,
              url: SITE_URL, observedAt: quote.timestamp, expiresAt: now + EVENT_TTL};
            jobs.push({eventId, deviceId: id, payload, createdAt: now, expiresAt: payload.expiresAt,
              status: 'queued', attempts: 0, nextAttemptAt: now});
            device = {...device, events: [{...event, id: eventId, type: 'threshold', status: 'queued'}, ...device.events].slice(0, 50)};
            if (!rule.repeat) device = {...device, rules: device.rules.map(r => r.id === rule.id ? {...r, enabled: false} : r), revision: device.revision + 1};
          }
          if (jobs.length) {
            device = {...device, states, updatedAt: now};
            await this.ctx.storage.transaction(async tx => {
              await tx.put(`device:${id}`, device);
              for (const job of jobs) await tx.put(`outbox:${job.eventId}`, job);
            });
            this.devices.set(id, device);
            for (const job of jobs) this.pending.set(job.eventId, job);
          }
          this.states.set(id, states);
        }
      }
      if (this.pending.size) await this.scheduleAlarm(now + 1_000);
    });
  }

  overBudget(device, now) {
    const day = dayKey(now);
    return (device.pushUsage?.day === day && device.pushUsage.count >= 20)
      || (this.usage.day === day && this.usage.count >= 200);
  }

  async drainOutbox() {
    await this.ready;
    if (this.draining || !isActive(this.env)) return;
    this.draining = true;
    try {
      for (let count = 0; count < 25; count++) {
        const reserved = await this.locked(async () => {
          const now = this.now();
          const job = Array.from(this.pending.values()).find(j => j.nextAttemptAt <= now);
          if (!job) return null;
          const device = this.devices.get(job.deviceId);
          if (!device || job.expiresAt <= now || job.attempts >= 3 || this.overBudget(device, now)) {
            await this.finishJob(job, !device ? 'removed' : job.expiresAt <= now ? 'expired'
              : this.overBudget(device, now) ? 'daily_limit' : 'failed');
            return {skip: true};
          }
          const day = dayKey(now);
          const usage = {day, count: (this.usage.day === day ? this.usage.count : 0) + 1};
          const updated = {...device, pushUsage: {day, count: (device.pushUsage?.day === day ? device.pushUsage.count : 0) + 1}};
          const started = {...job, status: 'dispatching', attempts: job.attempts + 1, nextAttemptAt: now + 15_000};
          await this.ctx.storage.transaction(async tx => {
            await tx.put(`device:${device.id}`, updated); await tx.put('usage', usage);
            await tx.put(`outbox:${job.eventId}`, started);
          });
          this.devices.set(device.id, updated); this.usage = usage; this.pending.set(job.eventId, started);
          return {job: started, subscription: clone(device.subscription)};
        });
        if (!reserved) break;
        if (reserved.skip) continue;
        const {job, subscription} = reserved;
        // Check again immediately before the external request, after reservation.
        if (!this.devices.has(job.deviceId)) continue;
        let result;
        try { result = await this.send(subscription, job.payload, {publicKey: this.env.VAPID_PUBLIC_KEY,
          privateKey: this.env.VAPID_PRIVATE_KEY, subject: this.env.VAPID_SUBJECT,
          fetchImpl: this.fetchImpl, ttl: 120, now: this.now()}); }
        catch { result = {status: 'retry', httpStatus: 0}; }
        await this.locked(async () => {
          if (!this.pending.has(job.eventId)) return;
          if (result.status === 'retry' && job.attempts < 3 && this.now() < job.expiresAt) {
            const retryAfter = Number(result.retryAfterSeconds || 0);
            const delay = Math.max(2_000 * (2 ** (job.attempts - 1)), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 0);
            if (this.now() + delay >= job.expiresAt) { await this.finishJob(job, 'expired'); return; }
            const next = {...job, status: 'retry', nextAttemptAt: this.now() + delay};
            await this.ctx.storage.put(`outbox:${job.eventId}`, next); this.pending.set(job.eventId, next);
          } else {
            await this.finishJob(job, result.status === 'accepted' ? 'accepted' : result.status === 'expired' ? 'subscription_expired' : 'failed');
            if (result.status === 'expired' && this.devices.has(job.deviceId)) {
              const current = this.devices.get(job.deviceId);
              const disabled = {...current, rules: current.rules.map(r => ({...r, enabled: false})), revision: current.revision + 1, subscriptionExpired: true};
              await this.ctx.storage.put(`device:${current.id}`, disabled); this.devices.set(current.id, disabled);
            }
          }
        });
      }
    } finally {
      this.draining = false;
      if (this.pending.size) await this.scheduleAlarm(Math.max(this.now() + 1_000, Math.min(...Array.from(this.pending.values(), j => j.nextAttemptAt))));
    }
  }

  async finishJob(job, status) {
    const current = this.devices.get(job.deviceId);
    const device = current ? {...current, events: current.events.map(event => event.id === job.eventId
      ? {...event, status, updatedAt: this.now()} : event)} : null;
    await this.ctx.storage.transaction(async tx => {
      if (device) await tx.put(`device:${device.id}`, device);
      await tx.delete(`outbox:${job.eventId}`);
    });
    if (device) this.devices.set(device.id, device);
    this.pending.delete(job.eventId);
  }

  async scheduleAlarm(when) {
    if (!Number.isFinite(when)) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null || when < existing) await this.ctx.storage.setAlarm(Math.max(this.now() + 250, Math.floor(when)));
  }

  async alarm() {
    await this.ready;
    if (!isActive(this.env)) { this.closeFeed(); await this.ctx.storage.deleteAlarm(); return; }
    try {
      await this.locked(async () => {
        const now = this.now();
        this.expirePoolQuotes(now);
        for (const [key, record] of this.ipBuckets) if (record.day !== dayKey(now)) { await this.ctx.storage.delete(`ip:${key}`); this.ipBuckets.delete(key); }
        for (const [key, record] of this.operations) if (now - record.createdAt > DEVICE_TTL) { await this.ctx.storage.delete(`operation:${key}`); this.operations.delete(key); }
        for (const [id, device] of this.devices) if (now - device.updatedAt > DEVICE_TTL) await this.remove(id);
        if (!this.budgetPaused() && now - this.lastCheckpoint >= 120_000) {
          for (const [id, device] of this.devices) if (device.rules.length) {
            const updated = {...device, states: this.states.get(id) || {}};
            await this.ctx.storage.put(`device:${id}`, updated); this.devices.set(id, updated);
          }
          this.lastCheckpoint = now;
        }
      });
      if (this.socket && this.now() - this.lastFrameAt > 45_000) this.closeFeed();
      if (!this.needsFeed()) this.closeFeed();
      await this.ensureSources();
      await this.drainOutbox();
    } finally {
      await this.planWake();
    }
  }
}
