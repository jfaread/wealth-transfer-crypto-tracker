import { Buffer } from 'node:buffer';
import { ECDH, createHash } from 'node:crypto';
import { generateRequestDetails, getVapidHeaders } from 'web-push';

export const TRACKER_URL = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const MAX_PAYLOAD_BYTES = 1600;
const MAX_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VAPID_LIFETIME_SECONDS = 12 * 3600;
const VAPID_REFRESH_MARGIN_SECONDS = 5 * 60;
const VAPID_MIN_REUSE_SECONDS = 3600;
const VAPID_CACHE_LIMIT = 64;
const vapidHeaderCache = new Map();

function cachedVapidHeaders(origin, subject, publicKey, privateKey, nowMs) {
  if (typeof subject !== 'string' || subject.length > 2048 || typeof publicKey !== 'string' || publicKey.length > 128
    || typeof privateKey !== 'string' || privateKey.length > 128) throw new Error('The push signing configuration is invalid.');
  // Cache by the complete signing identity and audience, never by a recipient's
  // private endpoint. Only a digest of the private key appears in the map key.
  const cacheKey = createHash('sha256').update(JSON.stringify([origin, subject, publicKey, privateKey])).digest('hex');
  const nowSeconds = Math.floor(nowMs / 1000);
  const previous = vapidHeaderCache.get(cacheKey);
  if (previous && previous.expiresAt > nowSeconds + VAPID_REFRESH_MARGIN_SECONDS
    && previous.expiresAt <= nowSeconds + 24 * 3600) {
    vapidHeaderCache.delete(cacheKey);
    vapidHeaderCache.set(cacheKey, previous);
    return previous.headers;
  }

  // Apple explicitly says not to refresh VAPID JWTs more than once an hour:
  // https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.md
  // A 12-hour token is reused until five minutes before expiry. Clock rollback
  // invalidates a cached token only if its expiry would exceed the 24-hour limit.
  for (const [key, entry] of vapidHeaderCache) {
    if (entry.expiresAt <= nowSeconds || entry.expiresAt > nowSeconds + 24 * 3600) vapidHeaderCache.delete(key);
  }
  if (!vapidHeaderCache.has(cacheKey) && vapidHeaderCache.size >= VAPID_CACHE_LIMIT) {
    // Do not evict a recently issued token merely to admit another identity:
    // that could force an Apple token to be regenerated inside the same hour.
    const evictable = Array.from(vapidHeaderCache).find(([, entry]) => entry.issuedAt <= nowSeconds - VAPID_MIN_REUSE_SECONDS);
    if (!evictable) throw new Error('The push signing cache is temporarily full.');
    vapidHeaderCache.delete(evictable[0]);
  }
  const expiresAt = nowSeconds + VAPID_LIFETIME_SECONDS;
  const headers = Object.freeze({ ...getVapidHeaders(origin, subject, publicKey, privateKey, 'aes128gcm', expiresAt) });
  vapidHeaderCache.set(cacheKey, { headers, issuedAt: nowSeconds, expiresAt });
  return headers;
}

function decodeKey(value, byteLength, message) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw new Error(message);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== byteLength || bytes.toString('base64url') !== value) throw new Error(message);
  return bytes;
}

function validateEndpoint(endpoint) {
  const message = 'Use a valid HTTPS subscription from a supported browser push service.';
  if (typeof endpoint !== 'string' || endpoint.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(endpoint) || endpoint.includes('#')) {
    throw new Error(message);
  }
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error(message); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) throw new Error(message);

  const host = parsed.hostname;
  const path = parsed.pathname;
  const google = host === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/[^/]+$/.test(path);
  const mozilla = host === 'updates.push.services.mozilla.com' && /^\/wpush\/v2\/[^/]+$/.test(path);
  // Apple explicitly documents allowing https://*.push.apple.com for Web Push:
  // https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
  // Limit the wildcard to that exact suffix and ordinary DNS labels, never *.apple.com.
  const apple = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+push\.apple\.com$/.test(host) && path.length > 1;
  if (!google && !mozilla && !apple) throw new Error(message);
  return parsed.href;
}

/** Return only the subscription fields used for encryption and delivery. */
export function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new Error('A browser push subscription is required.');
  }
  const endpoint = validateEndpoint(subscription.endpoint);
  const keys = subscription.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('The browser push encryption keys are missing.');
  const keyMessage = 'The browser push public key is invalid. Please enable notifications again.';
  const publicKey = decodeKey(keys.p256dh, 65, keyMessage);
  decodeKey(keys.auth, 16, 'The browser push authentication key is invalid. Please enable notifications again.');
  if (publicKey[0] !== 4) throw new Error(keyMessage);
  // Length alone does not establish that an untrusted public key lies on P-256.
  try {
    const checked = ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
    if (!checked.equals(publicKey)) throw new Error(keyMessage);
  } catch { throw new Error(keyMessage); }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function safeText(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`The push notification ${name} is invalid.`);
  }
  return value;
}

function serialisePayload(payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1) throw new Error('The push notification is invalid.');
  if (typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payload.eventId)) throw new Error('The push notification event identifier is invalid.');
  const observedAt = payload.observedAt;
  const expiresAt = payload.expiresAt;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + 5000 || observedAt < now - MAX_TTL_SECONDS * 1000) {
    throw new Error('The push notification price observation is no longer fresh.');
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt <= observedAt || expiresAt > now + MAX_TTL_SECONDS * 1000) {
    throw new Error('The push notification expiry is invalid.');
  }
  const clean = {
    version: 1,
    eventId: payload.eventId,
    title: safeText(payload.title, 100, 'title'),
    body: safeText(payload.body, 800, 'body'),
    // A subscription or request must never choose where a notification navigates.
    url: TRACKER_URL,
    observedAt,
    expiresAt,
  };
  const text = JSON.stringify(clean);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('The push notification is too large.');
  return { text, expiresAt };
}

function retryAfter(value, now) {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  let seconds;
  if (/^\d+$/.test(value.trim())) seconds = Number(value.trim());
  else {
    const date = Date.parse(value);
    if (Number.isFinite(date)) seconds = Math.ceil((date - now) / 1000);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Encrypt with the maintained web-push implementation, then use native fetch.
 * Requires Workers nodejs_compat. Never log subscriptions, keys or provider bodies.
 * "accepted" means accepted by the push service, not delivered to a handset.
 */
export async function sendPush(subscription, payload, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { status: 'failed', httpStatus: 0 };
  const { publicKey, privateKey, subject, fetchImpl = fetch, ttl = 120, now = Date.now() } = options;
  let details;
  let timestamp;
  try {
    timestamp = typeof now === 'function' ? now() : now;
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(ttl) || ttl < 0 || typeof fetchImpl !== 'function') {
      return { status: 'failed', httpStatus: 0 };
    }
    const cleanSubscription = validateSubscription(subscription);
    const cleanPayload = serialisePayload(payload, timestamp);
    const timeToLive = Math.max(0, Math.min(MAX_TTL_SECONDS, Math.floor(ttl), Math.floor((cleanPayload.expiresAt - timestamp) / 1000)));
    details = generateRequestDetails(cleanSubscription, cleanPayload.text, {
      // Build VAPID separately with the same clock as event expiry. This avoids
      // the library's implicit wall clock when replaying deterministic tests.
      vapidDetails: null,
      contentEncoding: 'aes128gcm',
      urgency: 'high',
      TTL: timeToLive,
    });
    Object.assign(details.headers, cachedVapidHeaders(
      new URL(cleanSubscription.endpoint).origin,
      subject,
      publicKey,
      privateKey,
      timestamp,
    ));
  } catch {
    // Library errors can contain private endpoints or keys; never return them.
    return { status: 'failed', httpStatus: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(details.endpoint, {
      method: 'POST',
      headers: details.headers,
      body: details.body,
      signal: controller.signal,
      // Workerd supports only "manual" and "follow". Never follow redirects;
      // every 3xx response is classified as failed below.
      redirect: 'manual',
    });
    const httpStatus = response.status;
    // Provider response bodies are neither required nor safe to forward to users.
    if (response.body?.cancel) await response.body.cancel().catch(() => {});
    if (response.redirected) return { status: 'failed', httpStatus };
    if (httpStatus >= 200 && httpStatus < 300) return { status: 'accepted', httpStatus };
    if (httpStatus === 404 || httpStatus === 410) return { status: 'expired', httpStatus };
    if (httpStatus === 408 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
      const retryAfterSeconds = retryAfter(response.headers?.get('retry-after'), timestamp);
      return { status: 'retry', httpStatus, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
    }
    return { status: 'failed', httpStatus: Number.isInteger(httpStatus) ? httpStatus : 0 };
  } catch {
    return { status: 'retry', httpStatus: 0 };
  } finally {
    clearTimeout(timeout);
  }
}
