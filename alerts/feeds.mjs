import {decimalFromNumber} from './core.mjs';
import {createKrakenRestFeed} from './rest-feed.mjs';

export const KRAKEN_WS_URL = 'https://ws.kraken.com/v2';
export const KRAKEN_SYMBOLS = Object.freeze({
  'BTC/USD': 'BTC', 'ETH/USD': 'ETH', 'BNB/USD': 'BNB',
  'XRP/USD': 'XRP', 'SOL/USD': 'SOL', 'SHIB/USD': 'SHIB',
});
export const LIVE_COINS = Object.freeze(Object.values(KRAKEN_SYMBOLS));

export function krakenSubscription() {
  return {method: 'subscribe', params: {
    channel: 'ticker', symbol: Object.keys(KRAKEN_SYMBOLS),
    event_trigger: 'trades', snapshot: true,
  }};
}

/** Only exact USD instruments and provider timestamps; never static chart history. */
export function parseKrakenMessage(raw, receivedAt = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 64_000) return {quotes: [], reason: 'invalid_frame'};
  let message;
  try { message = JSON.parse(raw); } catch { return {quotes: [], reason: 'invalid_json'}; }
  if (!message || typeof message !== 'object') return {quotes: [], reason: 'invalid_frame'};
  if (message.method === 'subscribe' && message.success === false) {
    return {quotes: [], reason: 'subscription_rejected'};
  }
  if (message.channel !== 'ticker' || !['snapshot', 'update'].includes(message.type) || !Array.isArray(message.data)) {
    return {quotes: [], reason: 'control_frame'};
  }
  const quotes = [];
  for (const item of message.data.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const coin = KRAKEN_SYMBOLS[item.symbol];
    if (!coin || typeof item.last !== 'number' || !Number.isFinite(item.last) || item.last <= 0) continue;
    if (typeof item.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(item.timestamp)) continue;
    const timestamp = Date.parse(item.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp > receivedAt + 5_000 || receivedAt - timestamp > 60_000) continue;
    let price;
    try { price = decimalFromNumber(item.last); } catch { continue; }
    quotes.push({coin, price, source: `Kraken ${item.symbol}`,
      timestamp, receivedAt, snapshot: message.type === 'snapshot'});
  }
  return {quotes, reason: quotes.length ? 'quotes' : 'no_fresh_quotes'};
}

export function reconnectDelay(attempt) {
  return Math.min(60_000, 1_000 * (2 ** Math.max(0, Math.min(6, Math.trunc(attempt) || 0))));
}

/** Prefer the stream; use paced HTTPS trades when its endpoint rate-limits or returns a gateway error. */
export async function connectKraken({fetchImpl = globalThis.fetch, onMessage, onClose, onOpen, timeoutMs = 10_000,
  restConnector = createKrakenRestFeed} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(10_000, timeoutMs)));
  let response;
  try {
    response = await fetchImpl(KRAKEN_WS_URL, {
      headers: {Upgrade: 'websocket'}, signal: controller.signal, redirect: 'manual',
    });
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      try { await response.body?.cancel(); } catch {}
      controller.abort();
      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        clearTimeout(timeout);
        return await restConnector({fetchImpl, onMessage, onClose, onOpen});
      }
      throw new Error('The live price connection is unavailable.');
    }
    socket.accept();
    socket.addEventListener('message', event => onMessage?.(event.data));
    socket.addEventListener('close', () => onClose?.());
    socket.addEventListener('error', () => onClose?.());
    socket.send(JSON.stringify(krakenSubscription()));
    onOpen?.();
    return socket;
  } catch {
    controller.abort();
    throw new Error('The live price connection is unavailable.');
  } finally { clearTimeout(timeout); }
}


/**
 * Low-frequency recovery probe for an existing REST fallback. It never starts
 * another REST poller. It promotes a WebSocket only after receiving a genuine,
 * timestamp-validated Kraken ticker observation. Until activation, incoming
 * frames stay buffered and cannot create a spurious threshold crossing.
 */
export async function probeKrakenStream({
  fetchImpl = globalThis.fetch, onMessage, onClose,
  now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
  timeoutMs = 9000,
} = {}) {
  const deadline = Math.max(1, Math.min(10000, Math.trunc(timeoutMs) || 9000));
  return new Promise(resolve => {
    let socket = null, settled = false, activated = false, firstValid = false;
    const pending = [];
    const timer = schedule(() => finish(null), deadline);
    function finish(result) {
      if (settled) return;
      settled = true;
      cancel(timer);
      if (!result) {
        try { socket?.close(); } catch {}
        resolve(null);
        return;
      }
      resolve({
        socket,
        activate() {
          if (activated) return;
          activated = true;
          for (const frame of pending.splice(0)) onMessage?.(frame);
        },
      });
    }
    const options = {
      fetchImpl, timeoutMs: deadline,
      // A probe is not allowed to spawn a second polling transport.
      restConnector: async () => { throw new Error('Streaming probe rate-limited'); },
      onOpen: () => {},
      onMessage: raw => {
        if (settled && !firstValid) return;
        if (activated) { onMessage?.(raw); return; }
        const parsed = parseKrakenMessage(raw, now());
        if (parsed.reason === 'subscription_rejected') { finish(null); return; }
        if (!parsed.quotes.length) return;
        firstValid = true;
        if (pending.length < 20) pending.push(raw);
        if (socket) finish(socket);
      },
      onClose: () => { if (activated) onClose?.(); else finish(null); },
    };
    Promise.resolve().then(() => connectKraken(options)).then(connected => {
      socket = connected;
      if (settled && !activated) { try {socket.close();}catch{}; return; }
      if (firstValid) finish(socket);
    }).catch(() => finish(null));
  });
}
