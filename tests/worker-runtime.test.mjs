import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { generateVAPIDKeys } from 'web-push';

// Build first with npm run check:worker. A dedicated run can select an isolated
// bundle with CRYPTO_WATCH_RUNTIME_BUNDLE; no production credentials are used.
const bundle = resolve(process.env.CRYPTO_WATCH_RUNTIME_BUNDLE || '.worker-build/worker.js');
const skip = existsSync(bundle) ? false : 'Build the Worker with npm run check:worker to run the actual Workerd smoke test.';
const siteUrl = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const siteOrigin = 'https://jfaread.github.io';

function makeRuntime(bindings, outboundService, extraWorkers = []) {
  return new Miniflare(convertV4MiniflareOptions({
    workers: [{
    name: 'crypto-watch-runtime',
    // Load exactly Wrangler's deployment artifact. Automatic source discovery
    // incorrectly attempts to resolve an unused, optional dynamic Kerberos
    // import from https-proxy-agent; this application never uses proxy agents.
    modules: [{ type: 'ESModule', path: bundle }],
    modulesRoot: dirname(bundle),
    compatibilityDate: '2026-11-13',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ALERT_MONITOR: { className: 'CryptoAlertMonitor', useSQLite: true } },
    bindings: {
      ALERTS_ENABLED: 'false',
      ALLOWED_ORIGIN: siteOrigin,
      PUBLIC_SITE_URL: siteUrl,
      MAX_DEVICES: '50',
      ...bindings,
    },
    outboundService,
    }, ...extraWorkers],
    durableObjectsPersist: false,
    log: new Log(LogLevel.ERROR),
  }));
}

function networkMockWorker(endpointPath) {
  // Keep WebSocket-handshake mocks inside Workerd. Miniflare 5's Node function
  // bridge can stall later requests after a mocked failed Upgrade handshake.
  // This worker never calls fetch, so no public network request is possible.
  return {
    name: 'closed-network-mock',
    modules: [{ type: 'ESModule', path: resolve('tests/closed-network-mock.mjs'), contents: `
      let pushCount = 0, feedCount = 0, blockedCount = 0, capturedPush = null;
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.href === 'https://runtime-capture.invalid/state') {
          return Response.json({pushCount,feedCount,blockedCount,capturedPush});
        }
        if (request.method === 'GET' && url.href === 'https://ws.kraken.com/v2') {
          feedCount++;
          return new Response(null, {status:503});
        }
        if (request.method === 'POST' && url.href === ${JSON.stringify(`https://fcm.googleapis.com${endpointPath}`)} && pushCount === 0) {
          pushCount++;
          capturedPush = {headers:Array.from(request.headers),body:Array.from(new Uint8Array(await request.arrayBuffer()))};
          return new Response(null, {status:201});
        }
        blockedCount++;
        return new Response('Unexpected outbound request blocked by the runtime test.', {status:502});
      }};
    ` }],
    modulesRoot: resolve('tests'),
    compatibilityDate: '2026-11-13',
    outboundService: async () => { throw new Error('The closed mock cannot access a network.'); },
  };
}

async function call(mf, path, { method = 'GET', token, body } = {}) {
  const headers = { Origin: siteOrigin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return mf.dispatchFetch(`https://runtime-test.invalid${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function decodeEncryptedRequest(request, receiver, authSecret) {
  const body = request.body;
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keySize = body[20];
  assert.equal(keySize, 65, 'Workerd produced a P-256 sender key');
  const senderKey = body.subarray(21, 21 + keySize);
  const encrypted = body.subarray(21 + keySize);
  assert.ok(encrypted.length <= recordSize, 'the alert fits in a single encrypted record');
  const shared = receiver.computeSecret(senderKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderKey]);
  const inputKey = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const key = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'the final Web Push record delimiter is valid');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

test('Workerd: disabled service exposes honest configuration and refuses registration', { skip, timeout: 20_000 }, async () => {
  let outboundCount = 0;
  const mf = makeRuntime({}, async () => {
    outboundCount++;
    throw new Error('Unexpected outbound request blocked by the runtime test.');
  });
  try {
    const response = await call(mf, '/v1/config');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), siteOrigin);
    const config = await response.json();
    assert.equal(config.enabled, false);
    assert.equal(config.vapidPublicKey, null);
    assert.equal(config.monitor.status, 'disabled');
    assert.equal(config.coins.length, 8);
    assert.ok(config.coins.every(coin => coin.enabled === false));
    const registration = await call(mf, '/v1/devices', { method: 'POST', body: {} });
    assert.equal(registration.status, 503);
    assert.equal((await registration.json()).error.code, 'alerts_disabled');
    assert.equal(outboundCount, 0);
  } finally {
    await mf.dispose();
  }
});

test('Workerd: actual Durable Object registers, saves drafts, encrypts a mocked push and deletes access', { skip, timeout: 30_000 }, async () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = randomBytes(16);
  const vapid = generateVAPIDKeys();
  const endpointPath = '/fcm/send/crypto-watch-local-runtime-test-only';
  const mf = makeRuntime({
    ALERTS_ENABLED: 'true',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: siteUrl,
  }, 'closed-network-mock', [networkMockWorker(endpointPath)]);

  try {
    const configResponse = await call(mf, '/v1/config');
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.enabled, true);
    assert.equal(config.vapidPublicKey, vapid.publicKey);
    assert.ok(config.coins.every(coin => coin.enabled === false), 'a failed mocked feed must not be labelled live');

    const subscription = {
      endpoint: `https://fcm.googleapis.com${endpointPath}`,
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    };
    const registration = await call(mf, '/v1/devices', {
      method: 'POST',
      body: { subscription, consentVersion: config.consentVersion, operationId: `runtime_${randomUUID()}` },
    });
    assert.equal(registration.status, 201);
    const device = await registration.json();
    assert.match(device.token, /^[a-f0-9-]{36}\.[a-f0-9]{64}$/);
    assert.equal(device.revision, 0);
    const unauthorised = await call(mf, '/v1/device');
    assert.equal(unauthorised.status, 401);

    const draft = {
      id: randomUUID(), coin: 'KISHU', direction: 'above',
      threshold: '0.0000000001', repeat: false, enabled: false,
    };
    const save = await call(mf, '/v1/rules', { method: 'PUT', token: device.token, body: { revision: 0, rules: [draft] } });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.rules, [draft]);
    const staleSave = await call(mf, '/v1/rules', { method: 'PUT', token: device.token, body: { revision: 0, rules: [] } });
    assert.equal(staleSave.status, 409);

    const send = await call(mf, '/v1/test', { method: 'POST', token: device.token, body: {} });
    assert.equal(send.status, 202);
    const queued = await send.json();
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    let event;
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await call(mf, '/v1/device', { token: device.token });
      assert.equal(state.status, 200);
      event = (await state.json()).events.find(item => item.id === queued.eventId);
      if (event?.status === 'accepted' || event?.status === 'failed') break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    const mockWorker = await mf.getWorker('closed-network-mock');
    const stats = await (await mockWorker.fetch('https://runtime-capture.invalid/state')).json();
    const {pushCount, feedCount, blockedCount} = stats;
    assert.equal(event?.status, 'accepted', `the real Workerd encryption and mocked provider request must succeed (mocked pushes: ${pushCount}, feed requests: ${feedCount}, rejected requests: ${blockedCount})`);
    assert.equal(pushCount, 1);
    const capturedPush = {headers: new Headers(stats.capturedPush.headers), body: Buffer.from(stats.capturedPush.body)};
    assert.equal(capturedPush.headers.get('Content-Encoding'), 'aes128gcm');
    assert.equal(capturedPush.headers.get('Urgency'), 'high');
    assert.ok(Number(capturedPush.headers.get('TTL')) <= 120);
    assert.ok(!capturedPush.body.includes(Buffer.from('Phone alerts are connected')));
    const decoded = decodeEncryptedRequest(capturedPush, receiver, authSecret);
    assert.equal(decoded.version, 1);
    assert.equal(decoded.eventId, queued.eventId);
    assert.equal(decoded.url, siteUrl);
    assert.equal(decoded.title, 'Crypto-Watch test');
    assert.ok(decoded.expiresAt > decoded.observedAt);
    assert.ok(decoded.expiresAt - decoded.observedAt <= 120_000);

    const authorization = capturedPush.headers.get('Authorization');
    const match = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authorization);
    assert.ok(match, 'Workerd generated VAPID authorisation');
    assert.equal(match[2], vapid.publicKey);
    const [head, claims, signature] = match[1].split('.');
    const jwt = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(jwt.aud, 'https://fcm.googleapis.com');
    assert.equal(jwt.sub, siteUrl);
    assert.ok(jwt.exp > Math.floor(Date.now() / 1000));
    const publicBytes = Buffer.from(vapid.publicKey, 'base64url');
    const publicKey = createPublicKey({ format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url'),
    } });
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));

    const removal = await call(mf, '/v1/device', { method: 'DELETE', token: device.token });
    assert.equal(removal.status, 200);
    assert.deepEqual(await removal.json(), { deleted: true });
    const deletedAccess = await call(mf, '/v1/device', { token: device.token });
    assert.equal(deletedAccess.status, 401);
    assert.ok(feedCount >= 1, 'the production live feed connection used the closed mock');
    assert.equal(blockedCount, 0, 'no unexpected external requests were attempted');
  } finally {
    await mf.dispose();
  }
});

test('Workerd: genuine adapter code validates both mocked chains and enables all three pool alert rules', {skip, timeout: 45_000}, async () => {
  const vapid = generateVAPIDKeys();
  const mf = makeRuntime({ALERTS_ENABLED: 'true', VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: siteUrl, MAX_POOL_POLLS_PER_DAY: '6000'}, 'pool-network-mock', [{
    name: 'pool-network-mock',
    modules: [{type: 'ESModule', path: resolve('tests/pool-runtime-mock.mjs')}],
    modulesRoot: resolve('tests'), compatibilityDate: '2026-11-13',
    outboundService: async () => {throw new Error('The pool fixture cannot access a public network.');}
  }]);
  try {
    let config = await (await call(mf, '/v1/config')).json();
    const mockWorker = await mf.getWorker('pool-network-mock');
    const deadline = Date.now() + 25_000;
    // Exercise the real 15-second alarm interval. Only the fixture sends native
    // ticker observations; all JSON-RPC batches stay inside the closed runtime.
    while (!config.coins.every(coin => coin.enabled) && Date.now() < deadline) {
      await mockWorker.fetch('https://runtime-capture.invalid/tick');
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      config = await (await call(mf, '/v1/config')).json();
    }
    const stats = await (await mockWorker.fetch('https://runtime-capture.invalid/state')).json();
    assert(config.coins.every(coin => coin.enabled), JSON.stringify({coins: config.coins.map(coin => [coin.id, coin.enabled]), monitor: config.monitor, stats}));
    assert.equal(stats.rpcCount, 6); assert.equal(stats.blockedCount, 0);
    assert.equal(config.monitor.poolPollsRemaining, 5999);
    assert.equal(config.monitor.poolPollingIntervalMs, 15_000);
    for (const coin of config.coins.filter(coin => ['KISHU', 'WKC', 'CREPE'].includes(coin.id))) {
      assert.equal(coin.indicative, true); assert.equal(coin.samplingMs, 15_000);
      assert.match(coin.source, /Indicative/); assert(coin.evidence.freshUntil > Date.now());
      assert.equal(coin.evidence.conversionPrice, coin.id === 'KISHU' ? '2000' : '600');
      assert.equal(coin.evidence.chainId, coin.id === 'KISHU' ? 1 : 56);
    }
    const registration = await call(mf, '/v1/devices', {method: 'POST', body: {
      subscription: {endpoint: 'https://fcm.googleapis.com/fcm/send/pool-runtime-fixture-only',
        keys: {p256dh: vapid.publicKey, auth: randomBytes(16).toString('base64url')}},
      consentVersion: config.consentVersion, operationId: `pool_runtime_${randomUUID()}`
    }});
    assert.equal(registration.status, 201); const device = await registration.json();
    const rules = ['KISHU', 'WKC', 'CREPE'].map(coin => ({id: randomUUID(), coin, direction: 'above',
      threshold: coin === 'KISHU' ? '0.000000000005' : '0.000002', repeat: false, enabled: true}));
    const saved = await call(mf, '/v1/rules', {method: 'PUT', token: device.token, body: {revision: 0, rules}});
    assert.equal(saved.status, 200); assert.deepEqual((await saved.json()).rules, rules);
    const state = await (await call(mf, '/v1/device', {token: device.token})).json();
    assert.equal(state.events.length, 0, 'first observations establish baselines');
    for (let i = 0; i < 3; i++) await call(mf, '/v1/config');
    const finalStats = await (await mockWorker.fetch('https://runtime-capture.invalid/state')).json();
    assert.equal(finalStats.rpcCount, 6, 'configuration reads cannot defeat the reserved poll interval');
    assert.equal(finalStats.blockedCount, 0);
    assert.equal((await call(mf, '/v1/device', {method: 'DELETE', token: device.token})).status, 200);
  } finally {await mf.dispose();}
});
