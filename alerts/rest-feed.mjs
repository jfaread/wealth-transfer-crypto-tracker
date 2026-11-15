/** A paced, timestamp-preserving fallback for a rate-limited Kraken WebSocket. */
export const REST_POLL_MS = 15_000;
// A failed streaming connection is rechecked occasionally, not at polling speed.
export const STREAM_REPROBE_MS = 30 * 60_000;
const COINS = Object.freeze(['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'SHIB']);
const ROOT = 'https://api.kraken.com/0/public/Trades';

export function parseRestTrade(packet, coin, now = Date.now()) {
  if (!COINS.includes(coin) || !packet || !Array.isArray(packet.error) || packet.error.length) return null;
  const rows = packet.result?.[`${coin}/USD`];
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) return null;
  let latest = null;
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d{1,18}(?:\.\d{1,24})?$/.test(row[0]) ||
        typeof row[2] !== 'number' || !Number.isFinite(row[2])) continue;
    const timestamp = Math.trunc(row[2] * 1000), price = Number(row[0]);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now + 5000 || now - timestamp > 60000 ||
        !Number.isFinite(price) || price <= 0) continue;
    if (!latest || timestamp >= latest.timestamp) latest = {symbol: `${coin}/USD`, last: price, timestamp};
  }
  return latest;
}

export function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 60000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(60000, Math.min(2147483647, delay)) : 60000;
}

async function readPacket(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty trade response');
  let text = '', size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > 24000) { await reader.cancel(); throw new Error('Trade response too large'); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return JSON.parse(text);
}

export async function createKrakenRestFeed({fetchImpl = globalThis.fetch, onMessage, onClose, onOpen,
  now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
  pace = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  loadCooldown = async () => 0, saveCooldown = async () => {},
  probeStream = null, onUpgrade = null, probeIntervalMs = STREAM_REPROBE_MS,
  loadProbeAt = async () => 0, saveProbeAt = async () => {}} = {}) {
  let stopped = false, timer = null, controller = null, failures = 0, probeInFlight = false;
  const baseline = new Set(COINS), seen = new Map();
  const savedCooldown = await loadCooldown();
  let nextRoundAt = Number.isSafeInteger(savedCooldown) && savedCooldown > 0 ? savedCooldown : 0;
  const probePeriod = Math.max(15 * 60_000, Math.min(24 * 60 * 60_000, Number(probeIntervalMs) || STREAM_REPROBE_MS));
  let nextProbeAt = Infinity;
  if (typeof probeStream === 'function' && typeof onUpgrade === 'function') {
    let recorded = 0;
    try { recorded = await loadProbeAt(); } catch {}
    nextProbeAt = Number.isSafeInteger(recorded) && recorded > 0 && recorded < now() + 7 * 86_400_000
      ? recorded : now() + probePeriod;
    if (!recorded) try { await saveProbeAt(nextProbeAt); } catch {}
  }
  const socket = {transport: 'rest', samplingMs: REST_POLL_MS,
    close() { stopped = true; if (timer !== null) cancel(timer); controller?.abort(); }};
  const frame = value => { if (!stopped) onMessage?.(JSON.stringify(value)); };
  const fail = () => { socket.close(); onClose?.(); };
  function startStreamProbe() {
    if (stopped || probeInFlight || now() < nextProbeAt || typeof probeStream !== 'function') return;
    probeInFlight = true;
    // Reserve the next probe before any network operation; an eviction must not
    // cause a reconnect storm. The REST feed keeps polling during the probe.
    nextProbeAt = now() + probePeriod;
    Promise.resolve().then(async () => {
      await saveProbeAt(nextProbeAt);
      return probeStream();
    }).then(candidate => {
      if (!candidate?.socket || typeof candidate.activate !== 'function') return;
      if (stopped) { try { candidate.socket.close(); } catch {} return; }
      let approved = false;
      try { approved = onUpgrade(candidate.socket) === true; } catch {}
      if (approved) {
        socket.close();   // Do not emit onClose: monitor now owns the new socket.
        candidate.activate(); // Replays only validated, real provider frames.
      } else try { candidate.socket.close(); } catch {}
    }).catch(() => {/* Keep the existing timestamped REST feed. */})
      .finally(() => { probeInFlight = false; });
  }
  async function poll() {
    if (stopped) return;
    const started = now();
    startStreamProbe();
    let cooldown = 0, hadError = false;
    frame({channel: 'heartbeat', transport: 'rest'});
    if (started < nextRoundAt) {
      timer = schedule(() => poll().catch(fail), Math.min(REST_POLL_MS, nextRoundAt - started));
      return;
    }
    for (const [index, coin] of COINS.entries()) {
      if (index > 0) await pace(1000);
      if (stopped) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetchImpl(`${ROOT}?pair=${coin}USD&count=1&assetVersion=1`, {
          headers: {Accept: 'application/json'}, signal: controller.signal, redirect: 'manual',
        });
        if (response.status === 429) {
          cooldown = retryDelay(response.headers.get('Retry-After'), now());
          try { await response.body?.cancel(); } catch {}
          COINS.forEach(c => baseline.add(c));
          break;
        }
        if (!response.ok) { try { await response.body?.cancel(); } catch {} throw new Error('Trade feed unavailable'); }
        const packet = await readPacket(response);
        if (Array.isArray(packet.error) && packet.error.some(message => /rate limit|throttl/i.test(String(message)))) {
          cooldown = 60000; COINS.forEach(c => baseline.add(c)); break;
        }
        if (!Array.isArray(packet.error) || packet.error.length) throw new Error('Trade feed rejected request');
        const trade = parseRestTrade(packet, coin, now());
        if (!trade) { baseline.add(coin); continue; }
        if (trade.timestamp <= (seen.get(coin) || 0)) continue;
        seen.set(coin, trade.timestamp);
        const snapshot = baseline.has(coin); baseline.delete(coin);
        frame({channel: 'ticker', type: snapshot ? 'snapshot' : 'update', transport: 'rest',
          data: [{symbol: trade.symbol, last: trade.last, timestamp: new Date(trade.timestamp).toISOString()}]});
      } catch {
        if (stopped) return;
        hadError = true; baseline.add(coin);
      } finally { clearTimeout(timeout); controller = null; }
    }
    failures = hadError ? Math.min(5, failures + 1) : 0;
    if (!stopped) {
      nextRoundAt = cooldown ? now() + cooldown : started + Math.min(300000, REST_POLL_MS * 2 ** failures);
      if (cooldown) await saveCooldown(nextRoundAt);
      // Health frames keep transport alive during back-off, without renewing any price.
      timer = schedule(() => poll().catch(fail), Math.min(REST_POLL_MS, Math.max(1000, nextRoundAt - now())));
    }
  }
  onOpen?.();
  await poll();
  return socket;
}
