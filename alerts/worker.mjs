import {COINS, normaliseRule, evaluateRule, validateQuote} from './core.mjs';
import {LIVE_COINS, parseKrakenMessage, connectKraken, reconnectDelay} from './feeds.mjs';
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
          if (!this.hasActiveRules() && this.probeUntil <= this.now()) this.probeUntil = this.now() + 300_000;
          this.background(this.ensureFeed());
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
        if (isActive(this.env)) this.background(this.ensureFeed());
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
    const fresh = paused ? [] : LIVE_COINS.filter(coin => {
      const q = this.quotes.get(coin);
      return q && validateQuote(q, now).valid;
    });
    return {status: !isActive(this.env) ? 'disabled' : paused ? 'budget_paused' : fresh.length === LIVE_COINS.length ? 'live'
      : fresh.length ? 'partial' : this.feedStatus,
    source: 'Kraken USD spot ticker', lastObservedAt: Math.max(0, ...Array.from(this.quotes.values(), q => q.timestamp)) || null,
    freshCoins: fresh, unavailableCoins: ['KISHU', 'WKC', 'CREPE'],
    frameBudgetRemaining: this.feedBudget?.day === dayKey(now)
      ? Math.max(0, this.frameCap() - this.feedBudget.reserved + this.frameAllowance) : this.frameCap(),
    message: !isActive(this.env) ? 'The alert service has not been activated.'
      : paused ? 'The free live-price allowance has been reached. Monitoring resumes after 00:00 UTC with a fresh baseline.'
      : fresh.length === LIVE_COINS.length ? 'Monitoring fresh USD quotes. Delivery is best effort.'
      : 'Waiting for fresh prices. Alerts are paused for coins without a fresh quote.'};
  }

  config() {
    const active = isActive(this.env), now = this.now(), paused = this.budgetPaused();
    const coins = Object.entries(COINS).map(([id, info]) => {
      const supported = LIVE_COINS.includes(id), quote = this.quotes.get(id);
      const fresh = quote && validateQuote(quote, now).valid;
      return {id, name: info.name || id, enabled: !!(active && !paused && supported && fresh),
        source: supported ? `Kraken ${id}/USD` : null, maxAgeMs: supported ? 60_000 : null,
        reason: !supported ? 'A dependable live feed for this exact token is still being verified. You can save a disabled draft.'
          : !active ? 'The alert service is not live yet.' : paused ? 'The free live-price allowance has been reached. Monitoring resumes after 00:00 UTC.'
            : !fresh ? 'Waiting for a fresh price from the live feed.' : null};
    });
    return {version: 1, enabled: active, vapidPublicKey: active ? this.env.VAPID_PUBLIC_KEY : null,
      siteUrl: SITE_URL, consentVersion: CONSENT_VERSION, coins,
      capabilities: Object.fromEntries(coins.map(c => [c.id, {available: c.enabled, reason: c.reason, source: c.source}])),
      limits: {maxDevices: boundedInt(this.env.MAX_DEVICES, 50, 50), maxRules: MAX_RULES,
        maxPushesPerDevicePerDay: 20, maxPushesPerDay: 200, maxFeedFramesPerDay: this.frameCap()}, monitor: this.monitor()};
  }

  hasActiveRules() { return Array.from(this.devices.values()).some(device => device.rules.some(rule => rule.enabled)); }
  needsFeed() { return this.hasActiveRules() || this.probeUntil > this.now(); }
  frameCap() { return boundedInt(this.env.MAX_FEED_FRAMES_PER_DAY, DEFAULT_FRAME_CAP, DEFAULT_FRAME_CAP); }
  budgetPaused() {
    return this.feedBudget?.day === dayKey(this.now()) && this.feedBudget.reserved >= this.frameCap() && this.frameAllowance <= 0;
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
    if (parsed.quotes.length) { await this.processQuotes(parsed.quotes); await this.drainOutbox(); }
  }

  async planWake() {
    const now = this.now();
    const targets = Array.from(this.pending.values(), job => Math.min(job.nextAttemptAt, job.expiresAt));
    if (this.budgetPaused() && (this.hasActiveRules() || this.needsFeed())) targets.push(Date.parse(`${dayKey(now)}T00:00:00.000Z`) + 86_400_000);
    else if (this.needsFeed()) targets.push(now + 15_000);
    if (!targets.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(now + 250, Math.min(...targets)));
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
    this.probeUntil = this.now() + 300_000;
    await this.scheduleAlarm(now + 15_000);
    this.background(this.ensureFeed());
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
      if (rule.enabled && !LIVE_COINS.includes(rule.coin)) throw new ApiError(400, 'feed_not_ready', 'This token’s live feed is still being verified. Save the alert as a disabled draft.');
      if (rule.enabled && this.budgetPaused()) throw new ApiError(409, 'feed_budget_paused', 'The free live-price allowance has been reached. Save a disabled draft or try again after 00:00 UTC.');
      if (rule.enabled && !validateQuote(this.quotes.get(rule.coin), this.now()).valid) {
        if (!this.needsFeed()) this.probeUntil = this.now() + 300_000;
        this.background(this.ensureFeed());
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
    if (!this.devices.size) { this.closeFeed(); await this.ctx.storage.deleteAlarm(); }
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
          this.nextReconnectAt = this.now() + reconnectDelay(this.reconnectAttempts++);
          this.background(this.scheduleAlarm(this.nextReconnectAt));
        }});
      if (generation !== this.connectionGeneration) { try { socket.close(); } catch {} return; }
      this.socket = socket; this.reconnectAttempts = 0; this.feedStatus = 'waiting_for_prices';
    } catch {
      this.feedStatus = 'recovering';
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
  }

  async processQuotes(quotes) {
    await this.ready;
    if (!isActive(this.env)) return;
    await this.locked(async () => {
      const now = this.now();
      for (const input of quotes) {
        const checked = validateQuote(input, now);
        if (!checked.valid || !LIVE_COINS.includes(input.coin)) continue;
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
      await this.ensureFeed();
      await this.drainOutbox();
    } finally {
      await this.planWake();
    }
  }
}
