/** Exact decimal threshold evaluation. No timer, network or secret belongs here. */
export const COINS = Object.freeze({
  BTC: Object.freeze({id:'BTC', name:'Bitcoin', geckoId:'bitcoin', source:'Kraken BTC/USD', pair:'BTC/USD'}),
  ETH: Object.freeze({id:'ETH', name:'Ethereum', geckoId:'ethereum', source:'Kraken ETH/USD', pair:'ETH/USD'}),
  BNB: Object.freeze({id:'BNB', name:'BNB', geckoId:'binancecoin', source:'Kraken BNB/USD', pair:'BNB/USD'}),
  XRP: Object.freeze({id:'XRP', name:'XRP', geckoId:'ripple', source:'Kraken XRP/USD', pair:'XRP/USD'}),
  SOL: Object.freeze({id:'SOL', name:'Solana', geckoId:'solana', source:'Kraken SOL/USD', pair:'SOL/USD'}),
  KISHU: Object.freeze({id:'KISHU', name:'KISHU', geckoId:'kishu-inu', network:'ethereum', contract:'0xA2b4C0Af19cC16a6CfAcCe81F192B024d625817D', source:null}),
  WKC: Object.freeze({id:'WKC', name:'Wiki Cat', geckoId:'wiki-cat', network:'bsc', contract:'0x6ec90334d89dbdc89e08a133271be3d104128edb', source:null}),
  CREPE: Object.freeze({id:'CREPE', name:'CREPE', geckoId:'crepe-2', network:'bsc', contract:'0xeb2b7d5691878627eff20492ca7c9a71228d931d', source:null})
});

export const QUOTE_MAX_AGE_MS = 60_000;
export const RECEIPT_MAX_AGE_MS = 30_000;
export const BASELINE_GAP_MS = 120_000;
export const REPEAT_COOLDOWN_MS = 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decimal(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new TypeError('Use an ordinary positive decimal, without an exponent.');
  }
  let [integer, fraction = ''] = value.trim().split('.');
  integer = integer.replace(/^0+(?=\d)/, '');
  if (integer.length > 18 || fraction.length > 24) throw new RangeError('Use at most 18 integer digits and 24 decimal places.');
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

export function compareDecimals(left, right) {
  const [li, lf = ''] = decimal(left).split('.');
  const [ri, rf = ''] = decimal(right).split('.');
  const scale = Math.max(lf.length, rf.length);
  const a = BigInt(li + lf.padEnd(scale, '0'));
  const b = BigInt(ri + rf.padEnd(scale, '0'));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Expand the precision actually present in a provider's JSON number; do not invent extra precision. */
export function decimalFromNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError('Invalid source price.');
  const raw = String(value);
  if (!/[eE]/.test(raw)) return decimal(raw);
  const [mantissa, exponentText] = raw.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const point = whole.length + exponent;
  let result;
  if (point <= 0) result = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) result = digits + '0'.repeat(point - digits.length);
  else result = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return decimal(result);
}

export function normaliseRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid alert rule.');
  if (typeof input.id !== 'string' || !UUID.test(input.id)) throw new TypeError('Each alert needs a valid rule identifier.');
  if (typeof input.coin !== 'string' || !Object.hasOwn(COINS, input.coin)) throw new TypeError('Choose a supported cryptocurrency.');
  if (input.direction !== 'above' && input.direction !== 'below') throw new TypeError('Choose above or below.');
  const threshold = decimal(input.threshold);
  if (compareDecimals(threshold, '0') <= 0) throw new RangeError('The threshold must be greater than zero.');
  if (input.repeat !== undefined && typeof input.repeat !== 'boolean') throw new TypeError('Invalid repeat setting.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TypeError('Invalid enabled setting.');
  return {id:input.id.toLowerCase(), coin:input.coin, direction:input.direction, threshold, repeat:input.repeat ?? false, enabled:input.enabled ?? true};
}

export function validateQuote(input, now = Date.now()) {
  if (!Number.isSafeInteger(now) || !input || typeof input !== 'object' || !Object.hasOwn(COINS, input.coin)) return {valid:false, reason:'invalid_quote'};
  let price;
  try { price = decimal(input.price); if (compareDecimals(price, '0') <= 0) throw new Error(); }
  catch { return {valid:false, reason:'invalid_price'}; }
  const {timestamp, receivedAt, source} = input;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 || typeof source !== 'string' || source.length < 1 || source.length > 100 || /[\u0000-\u001f\u007f]/.test(source)) return {valid:false, reason:'invalid_quote'};
  if (timestamp > now + FUTURE_TOLERANCE_MS || receivedAt > now + FUTURE_TOLERANCE_MS || timestamp > receivedAt + FUTURE_TOLERANCE_MS) return {valid:false, reason:'future_quote'};
  if (now - timestamp > QUOTE_MAX_AGE_MS) return {valid:false, reason:'stale_quote'};
  if (now - receivedAt > RECEIPT_MAX_AGE_MS) return {valid:false, reason:'stale_receipt'};
  return {valid:true, reason:'fresh', quote:{coin:input.coin, price, source, timestamp, receivedAt}};
}

function keyFor(rule) { return [rule.id,rule.coin,rule.direction,rule.threshold,rule.repeat ? 1 : 0].join('|'); }
function triggering(rule, side) { return rule.direction === 'above' ? side > 0 : side < 0; }
function baseline(rule, previous, quote, side) {
  return {
    version:1, ruleKey:keyFor(rule), lastTimestamp:quote.timestamp, lastReceivedAt:quote.receivedAt,
    lastSource:quote.source, lastPrice:quote.price, lastSide:side, armed:!triggering(rule, side),
    fired:previous?.ruleKey === keyFor(rule) && previous?.fired === true,
    lastEventAt:previous?.ruleKey === keyFor(rule) && Number.isSafeInteger(previous?.lastEventAt) ? previous.lastEventAt : 0,
    needsBaseline:false
  };
}

/**
 * A rule fires on a fresh observed crossing, never simply because a stale snapshot
 * is already beyond its threshold. State must be committed before dispatching
 * the event. After a gap/source change/edited rule, one fresh observation becomes
 * the new baseline. An observation at the threshold is on the non-trigger side.
 */
export function evaluateRule(inputRule, previous = null, inputQuote, now = Date.now()) {
  const rule = normaliseRule(inputRule);
  const original = previous ? {...previous} : null;
  if (!rule.enabled) return {state:original, event:null, reason:'disabled'};
  if (inputQuote?.coin !== rule.coin) return {state:original, event:null, reason:'coin_mismatch'};
  if (original?.ruleKey === keyFor(rule) && original.fired && !rule.repeat) return {state:original, event:null, reason:'completed'};
  // Late/repeated packets do not reset or move an existing baseline backwards.
  if (original && inputQuote?.source === original.lastSource && Number.isSafeInteger(inputQuote?.timestamp) && inputQuote.timestamp <= original.lastTimestamp) {
    return {state:original, event:null, reason:inputQuote.timestamp === original.lastTimestamp ? 'duplicate_quote' : 'out_of_order'};
  }
  const checked = validateQuote(inputQuote, now);
  if (!checked.valid) return {state:original ? {...original, needsBaseline:true} : null, event:null, reason:checked.reason};
  const quote = checked.quote;
  const side = compareDecimals(quote.price, rule.threshold);
  let reason = !original ? 'baseline' : original.ruleKey !== keyFor(rule) ? 'rule_changed' : original.lastSource !== quote.source ? 'source_changed' : null;
  if (!reason && (original.needsBaseline || quote.timestamp - original.lastTimestamp > BASELINE_GAP_MS || quote.receivedAt - original.lastReceivedAt > BASELINE_GAP_MS || now - original.lastReceivedAt > BASELINE_GAP_MS)) reason = 'gap_rebaseline';
  if (reason) return {state:baseline(rule, original, quote, side), event:null, reason};

  const state = {...original, lastTimestamp:quote.timestamp, lastReceivedAt:quote.receivedAt, lastSource:quote.source, lastPrice:quote.price, lastSide:side, needsBaseline:false};
  if (!triggering(rule, side)) {
    state.armed = true;
    return {state, event:null, reason:'observed'};
  }
  if (!original.armed || triggering(rule, original.lastSide)) return {state, event:null, reason:'observed'};
  state.armed = false;
  if (rule.repeat && original.lastEventAt && now - original.lastEventAt < REPEAT_COOLDOWN_MS) return {state, event:null, reason:'cooldown'};
  state.lastEventAt = now;
  state.fired = !rule.repeat;
  const event = {
    id:`${rule.id}:${quote.timestamp}:${rule.direction}`, ruleId:rule.id, coin:rule.coin,
    direction:rule.direction, threshold:rule.threshold, price:quote.price, source:quote.source, observedAt:quote.timestamp
  };
  return {state, event, reason:'crossing'};
}
