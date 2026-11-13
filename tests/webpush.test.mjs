import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createDecipheriv, hkdfSync, verify, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { generateVAPIDKeys } from 'web-push';
import { sendPush, validateSubscription, TRACKER_URL } from '../alerts/webpush.mjs';

const receiver = createECDH('prime256v1');
receiver.generateKeys();
const auth = randomBytes(16);
const vapid = generateVAPIDKeys();
const now = Date.now();
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
  keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
};
const payload = {
  version: 1,
  eventId: 'btc-price-crossing-123',
  title: 'Crypto-Watch price alert',
  body: 'BTC crossed above your USD 100,000 threshold. Observed price: USD 100,010.',
  observedAt: now - 1000,
  expiresAt: now + 120_000,
};
const baseOptions = { ...vapid, subject: 'https://jfaread.github.io/wealth-transfer-crypto-tracker/', now };

// Independent RFC 8291/RFC 8188 receiver: it does not use web-push or its
// encryption dependency to establish that the real request can be decrypted.
function decryptPush(body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keySize = body[20];
  assert.equal(keySize, 65);
  const senderKey = body.subarray(21, 21 + keySize);
  const encrypted = body.subarray(21 + keySize);
  assert.ok(encrypted.length <= recordSize, 'small alerts use a single record');
  const sharedSecret = receiver.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderKey]);
  const inputKey = Buffer.from(hkdfSync('sha256', sharedSecret, auth, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  let delimiter = plain.length - 1;
  while (plain[delimiter] === 0) delimiter--;
  assert.equal(plain[delimiter], 2, 'final record delimiter');
  return JSON.parse(plain.subarray(0, delimiter).toString('utf8'));
}

test('validates standard Google, Mozilla and documented Apple endpoints', () => {
  const endpoints = [
    subscription.endpoint,
    'https://fcm.googleapis.com/wp/test-subscription',
    'https://updates.push.services.mozilla.com/wpush/v2/test-subscription',
    'https://web.push.apple.com/test-subscription',
    'https://region.web.push.apple.com/test-subscription',
  ];
  for (const endpoint of endpoints) assert.equal(validateSubscription({ ...subscription, endpoint }).endpoint, endpoint);
  assert.deepEqual(validateSubscription({ ...subscription, arbitrary: 'discard' }), subscription);
});

test('rejects private, unapproved, deceptive, malformed and redirect-shaped endpoints', () => {
  const endpoints = [
    'http://fcm.googleapis.com/fcm/send/test',
    'https://127.0.0.1/fcm/send/test',
    'https://[::1]/fcm/send/test',
    'https://10.0.0.1/fcm/send/test',
    'https://localhost/fcm/send/test',
    'https://fcm.googleapis.com.evil.example/fcm/send/test',
    'https://evilpush.apple.com/test',
    'https://push.apple.com.evil.example/test',
    'https://apple.com/test',
    'https://push.apple.com/test',
    'https://fcm.googleapis.com./fcm/send/test',
    'https://user:secret@fcm.googleapis.com/fcm/send/test',
    'https://fcm.googleapis.com:444/fcm/send/test',
    'https://fcm.googleapis.com/fcm/send/test#private',
    'https://fcm.googleapis.com/fcm/send/test#',
    'https://fcm.googleapis.com/not-a-push-endpoint',
    'https://updates.push.services.mozilla.com/not-a-push-endpoint',
    ' https://fcm.googleapis.com/fcm/send/test',
    'https://fcm.googleapis.com/fcm/send/te\nst',
    'https://fcm.googleapis.com\\@evil.example/fcm/send/test',
  ];
  for (const endpoint of endpoints) {
    assert.throws(() => validateSubscription({ ...subscription, endpoint }), /valid HTTPS subscription/, endpoint);
  }
});

test('validates canonical base64url keys and rejects off-curve P-256 points', () => {
  const invalidKeys = [
    { ...subscription.keys, p256dh: `${subscription.keys.p256dh}=` },
    { ...subscription.keys, p256dh: randomBytes(64).toString('base64url') },
    { ...subscription.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') },
    { ...subscription.keys, p256dh: Buffer.concat([Buffer.from([3]), receiver.getPublicKey().subarray(1)]).toString('base64url') },
    { ...subscription.keys, auth: randomBytes(15).toString('base64url') },
    { ...subscription.keys, auth: `${subscription.keys.auth}=` },
  ];
  for (const keys of invalidKeys) assert.throws(() => validateSubscription({ ...subscription, keys }), /key is invalid/);
  assert.throws(() => validateSubscription(null), /subscription is required/);
  assert.throws(() => validateSubscription({ endpoint: subscription.endpoint }), /keys are missing/);
});

test('sends an independently decryptable aes128gcm payload and correctly signed VAPID token', async () => {
  let request;
  const result = await sendPush(subscription, { ...payload, url: 'https://untrusted.example/', arbitrary: 'not-forwarded' }, {
    ...baseOptions,
    fetchImpl: async (url, init) => {
      request = { url, ...init };
      return new Response(null, { status: 201 });
    },
  });
  assert.deepEqual(result, { status: 'accepted', httpStatus: 201 });
  assert.equal(request.url, subscription.endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'manual');
  const headers = new Headers(request.headers);
  assert.equal(headers.get('Content-Encoding'), 'aes128gcm');
  assert.equal(headers.get('Urgency'), 'high');
  assert.equal(Number(headers.get('TTL')), 120);
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.signal.aborted, false);
  assert.ok(Buffer.isBuffer(request.body));
  assert.ok(!request.body.includes(Buffer.from(payload.body)));

  const decoded = decryptPush(request.body);
  assert.deepEqual(decoded, { ...payload, url: TRACKER_URL });

  const authorization = headers.get('Authorization');
  const matched = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authorization);
  assert.ok(matched, 'uses VAPID authorisation');
  assert.equal(matched[2], vapid.publicKey);
  const [head, claims, signature] = matched[1].split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'ES256');
  const jwt = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(jwt.aud, 'https://fcm.googleapis.com');
  assert.equal(jwt.sub, baseOptions.subject);
  assert.equal(jwt.exp, Math.floor(now / 1000) + 12 * 3600);
  const keyBytes = Buffer.from(vapid.publicKey, 'base64url');
  const signingKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: keyBytes.subarray(1, 33).toString('base64url'), y: keyBytes.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: signingKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('bounds delivery TTL by both five minutes and the event expiry', async () => {
  for (const [ttl, expiresAt, expected] of [[900, now + 300_000, 300], [120, now + 17_900, 17], [0, now + 120_000, 0]]) {
    let observedTTL;
    const result = await sendPush(subscription, { ...payload, expiresAt }, {
      ...baseOptions, ttl,
      fetchImpl: async (_url, init) => { observedTTL = Number(new Headers(init.headers).get('TTL')); return new Response(null, { status: 201 }); },
    });
    assert.equal(result.status, 'accepted');
    assert.equal(observedTTL, expected);
  }
});

test('uses the supplied clock for both VAPID expiry and event freshness on Apple', async () => {
  const clock = now - 3600_000;
  let request;
  const appleSubscription = { ...subscription, endpoint: 'https://web.push.apple.com/opaque-subscription-token' };
  const result = await sendPush(appleSubscription, { ...payload, observedAt: clock, expiresAt: clock + 120_000 }, {
    ...baseOptions, now: () => clock,
    fetchImpl: async (url, init) => { request = { url, ...init }; return new Response(null, { status: 201 }); },
  });
  assert.equal(result.status, 'accepted');
  assert.equal(request.url, appleSubscription.endpoint);
  const token = /^vapid t=([^,]+),/.exec(new Headers(request.headers).get('Authorization'))[1];
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.exp, Math.floor(clock / 1000) + 12 * 3600);
  assert.equal(decryptPush(request.body).observedAt, clock);
});

async function capturePushAt(clock, overrides = {}, sender = sendPush) {
  const { endpoint = 'https://web.push.apple.com/cache-test-recipient', ...signing } = overrides;
  let request;
  const result = await sender({ ...subscription, endpoint }, {
    ...payload, observedAt: clock, expiresAt: clock + 120_000,
  }, {
    ...baseOptions, ...signing, now: clock,
    fetchImpl: async (url, init) => { request = { url, ...init }; return new Response(null, { status: 201 }); },
  });
  return { result, request, authorization: request && new Headers(request.headers).get('Authorization') };
}

function vapidClaims(authorization) {
  const token = /^vapid t=([^,]+),/.exec(authorization)[1];
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
}

test('reuses one VAPID token across recipients while encrypting every payload afresh', async () => {
  const identity = generateVAPIDKeys();
  const first = await capturePushAt(now, identity);
  const second = await capturePushAt(now + 1500, { ...identity, endpoint: 'https://web.push.apple.com/another-recipient' });
  assert.equal(first.result.status, 'accepted');
  assert.equal(second.result.status, 'accepted');
  assert.equal(second.authorization, first.authorization, 'recipient paths and observation times must not rotate the provider JWT');
  assert.notDeepEqual(second.request.body, first.request.body, 'reuse authorisation, not encrypted message bytes');
  assert.equal(decryptPush(first.request.body).observedAt, now);
  assert.equal(decryptPush(second.request.body).observedAt, now + 1500);
});

test('isolates cached authorisation by origin, signing key pair and subject', async () => {
  const identity = generateVAPIDKeys();
  const original = await capturePushAt(now, identity);
  const differentOrigin = await capturePushAt(now, { ...identity, endpoint: 'https://region.push.apple.com/recipient' });
  const differentSubject = await capturePushAt(now, { ...identity, subject: 'mailto:alerts@example.com' });
  const differentKeys = await capturePushAt(now, generateVAPIDKeys());
  for (const attempt of [differentOrigin, differentSubject, differentKeys]) {
    assert.equal(attempt.result.status, 'accepted');
    assert.notEqual(attempt.authorization, original.authorization);
  }
  assert.equal(vapidClaims(differentOrigin.authorization).aud, 'https://region.push.apple.com');
  assert.equal(vapidClaims(differentSubject.authorization).sub, 'mailto:alerts@example.com');
  const invalidPrivateKey = await capturePushAt(now, { ...identity, privateKey: 'invalid-private-key' });
  assert.deepEqual(invalidPrivateKey.result, { status: 'failed', httpStatus: 0 });
  assert.equal(invalidPrivateKey.request, undefined, 'a previously cached public key must not conceal a changed invalid private key');
});

test('renews cached tokens near expiry and never sends an expired cached token', async () => {
  const clock = now - 13 * 3600_000;
  const identity = generateVAPIDKeys();
  const first = await capturePushAt(clock, identity);
  const oneHourLater = await capturePushAt(clock + 3600_000, identity);
  const beforeRenewal = await capturePushAt(clock + 12 * 3600_000 - 301_000, identity);
  assert.equal(oneHourLater.authorization, first.authorization);
  assert.equal(beforeRenewal.authorization, first.authorization);
  const renewalTime = clock + 12 * 3600_000 - 300_000;
  const renewed = await capturePushAt(renewalTime, identity);
  assert.equal(renewed.result.status, 'accepted');
  assert.notEqual(renewed.authorization, first.authorization);
  assert.equal(vapidClaims(renewed.authorization).exp, Math.floor(renewalTime / 1000) + 12 * 3600);

  const idleIdentity = generateVAPIDKeys();
  const beforeIdle = await capturePushAt(clock, idleIdentity);
  const afterIdle = await capturePushAt(now, idleIdentity);
  assert.equal(afterIdle.result.status, 'accepted');
  assert.notEqual(afterIdle.authorization, beforeIdle.authorization);
  assert.ok(vapidClaims(afterIdle.authorization).exp > Math.floor(now / 1000));
});

test('keeps a valid token on clock rollback but discards one beyond the 24-hour future limit', async () => {
  const identity = generateVAPIDKeys();
  const first = await capturePushAt(now, identity);
  const smallRollback = await capturePushAt(now - 3600_000, identity);
  assert.equal(smallRollback.authorization, first.authorization);
  const rolledBackTime = now - 13 * 3600_000;
  const largeRollback = await capturePushAt(rolledBackTime, identity);
  assert.equal(largeRollback.result.status, 'accepted');
  assert.notEqual(largeRollback.authorization, first.authorization);
  assert.equal(vapidClaims(largeRollback.authorization).exp, Math.floor(rolledBackTime / 1000) + 12 * 3600);
});

test('bounds the signing cache without evicting tokens less than an hour old', async () => {
  // A fresh module instance isolates this resource-limit test from other tests;
  // production still exports only the normal validation and send operations.
  const { sendPush: isolatedSend } = await import('../alerts/webpush.mjs?cache-capacity-test');
  const identity = generateVAPIDKeys();
  const scope = slot => ({ ...identity, endpoint: `https://slot-${slot}.push.apple.com/recipient` });
  let first;
  for (let slot = 0; slot < 64; slot++) {
    const attempt = await capturePushAt(now, scope(slot), isolatedSend);
    assert.equal(attempt.result.status, 'accepted');
    if (slot === 0) first = attempt;
  }
  const overCapacity = await capturePushAt(now, scope(64), isolatedSend);
  assert.deepEqual(overCapacity.result, { status: 'failed', httpStatus: 0 });
  assert.equal(overCapacity.request, undefined);
  const firstAgain = await capturePushAt(now + 1000, scope(0), isolatedSend);
  assert.equal(firstAgain.authorization, first.authorization, 'capacity pressure must not cause an early provider-token refresh');
  const afterOneHour = await capturePushAt(now + 3600_000, scope(64), isolatedSend);
  assert.equal(afterOneHour.result.status, 'accepted', 'an old entry can be evicted after the minimum reuse interval');
});

test('rejects stale, expired, oversize or malformed messages before any network call', async () => {
  const invalid = [
    { ...payload, version: 2 },
    { ...payload, eventId: '../bad-event' },
    { ...payload, title: '' },
    { ...payload, body: 'bad\u0000message' },
    { ...payload, title: 'x'.repeat(101) },
    { ...payload, body: 'x'.repeat(801) },
    { ...payload, body: '£'.repeat(799) },
    { ...payload, observedAt: now - 300_001 },
    { ...payload, observedAt: now + 5001 },
    { ...payload, expiresAt: now },
    { ...payload, expiresAt: now + 300_001 },
  ];
  for (const body of invalid) {
    const result = await sendPush(subscription, body, { ...baseOptions, fetchImpl: () => { assert.fail('invalid payload must not send'); } });
    assert.deepEqual(result, { status: 'failed', httpStatus: 0 });
  }
});

test('classifies provider responses and retains rate-limit delay without response text', async () => {
  for (const [httpStatus, status] of [[200, 'accepted'], [202, 'accepted'], [404, 'expired'], [410, 'expired'], [408, 'retry'], [429, 'retry'], [500, 'retry'], [503, 'retry'], [400, 'failed'], [401, 'failed'], [403, 'failed'], [302, 'failed']]) {
    const result = await sendPush(subscription, payload, {
      ...baseOptions,
      fetchImpl: async () => new Response('private provider details', { status: httpStatus }),
    });
    assert.deepEqual(result, { status, httpStatus });
  }
  for (const [header, expected] of [['45', 45], [new Date(now + 45_000).toUTCString(), 45], ['bad value', undefined], ['-30', undefined]]) {
    const result = await sendPush(subscription, payload, {
      ...baseOptions,
      fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': header } }),
    });
    assert.equal(result.status, 'retry');
    assert.equal(result.retryAfterSeconds, expected);
  }
});

test('sanitises encryption failures and network exceptions', async () => {
  const invalidResult = await sendPush(subscription, payload, {
    ...baseOptions, privateKey: 'secret-not-a-valid-private-key',
    fetchImpl: () => { assert.fail('invalid encryption configuration must not send'); },
  });
  assert.deepEqual(invalidResult, { status: 'failed', httpStatus: 0 });
  const networkResult = await sendPush(subscription, payload, {
    ...baseOptions,
    fetchImpl: async () => { throw new Error(`Network failed for ${subscription.endpoint}; secret=${vapid.privateKey}`); },
  });
  assert.deepEqual(networkResult, { status: 'retry', httpStatus: 0 });
  const redirectedResult = await sendPush(subscription, payload, {
    ...baseOptions,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    },
  });
  assert.deepEqual(redirectedResult, { status: 'failed', httpStatus: 302 });
});

test('aborts a hanging request after ten seconds without exposing its error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = sendPush(subscription, payload, {
    ...baseOptions,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`private ${subscription.endpoint}`)), { once: true }));
    },
  });
  assert.ok(signal);
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await pending, { status: 'retry', httpStatus: 0 });
});
