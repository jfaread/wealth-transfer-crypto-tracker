import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createWranglerRunner, deployAlerts, deploymentUrl} from '../scripts/deploy-alerts.mjs';

const savedConfig = JSON.parse(await readFile(new URL('../alerts/wrangler.jsonc', import.meta.url), 'utf8'));
const WORKER_URL = 'https://crypto-watch-alerts.example.workers.dev';
const SITE = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const NAMES = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
const metadata = names => JSON.stringify(names.map(name => ({name, type: 'secret_text'})));
const complete = metadata(NAMES);
const deployed = 'Uploaded crypto-watch-alerts\nDeployed crypto-watch-alerts triggers\n  ' + WORKER_URL + '\n';
const keys = {publicKey: 'B' + 'a'.repeat(86), privateKey: 'b'.repeat(43)}; // Synthetic fixture only.
const allowed = {CRYPTO_ALERTS_FREE_PLAN_CONFIRMED: 'true'};
const config = enabled => ({...structuredClone(savedConfig), vars: {...savedConfig.vars, ALERTS_ENABLED: String(enabled)}});

function fixture(outputs, {enabled = false, env = {}, value = config(enabled), generator} = {}) {
  const calls = [], messages = [];
  let generations = 0;
  return {calls, messages, get generations() {return generations;},
    run: () => deployAlerts({env: {...allowed, ...env}, loadConfig: async () => JSON.stringify(value),
      runWrangler: async (args, options) => {
        calls.push({args, input: options.input});
        const result = outputs[calls.length - 1];
        if (result instanceof Error) throw result;
        return result;
      },
      generateKeys: () => {generations++; return generator ? generator() : keys;}, log: message => messages.push(message)
    })};
}
const operations = item => item.calls.map(call => call.args.slice(0, -2).join(' '));

test('the explicit Free-plan attestation gates configuration, keys and every Wrangler call', async () => {
  for (const flag of [undefined, 'false', 'TRUE', 'true ', true]) {
    let calls = 0;
    const unexpected = () => {calls++; throw Error('Must not be called');};
    await assert.rejects(deployAlerts({env: {CRYPTO_ALERTS_FREE_PLAN_CONFIRMED: flag}, loadConfig: unexpected,
      runWrangler: unexpected, generateKeys: unexpected, log: unexpected}), /owner attestation/);
    assert.equal(calls, 0);
  }
});

test('first inactive deployment creates one in-memory key pair through stdin and verifies metadata', async () => {
  const h = fixture([deployed, '[]', 'Untrusted secret command output ' + keys.privateKey, complete]);
  assert.deepEqual(await h.run(), {url: WORKER_URL, enabled: false, createdKeys: true});
  assert.deepEqual(operations(h), ['deploy', 'secret list --format json', 'secret bulk', 'secret list --format json']);
  assert.equal(h.generations, 1);
  assert(h.calls.every(call => call.args.slice(-2).join(' ') === '--config alerts/wrangler.jsonc'));
  assert.deepEqual(JSON.parse(h.calls[2].input), {VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: SITE});
  assert(h.calls.filter((_, index) => index !== 2).every(call => call.input === ''));
  assert(!JSON.stringify(h.calls.map(call => call.args)).includes(keys.privateKey));
  assert(!h.messages.join('\n').includes(keys.privateKey));
  assert(!h.messages.join('\n').includes('Untrusted'));
  assert.match(h.messages.join('\n'), /Alerts remain paused/);
  assert.equal(h.messages.at(-1), WORKER_URL);
});

test('existing keys are retained and a versioned pause survives a conflicting environment flag', async () => {
  const h = fixture([deployed, metadata([...NAMES, 'OTHER_SECRET'])], {env: {ALERTS_ENABLED: 'true'}});
  assert.deepEqual(await h.run(), {url: WORKER_URL, enabled: false, createdKeys: false});
  assert.deepEqual(operations(h), ['deploy', 'secret list --format json']);
  assert.equal(h.generations, 0);
  assert.match(h.messages.join('\n'), /Existing notification keys retained\. Alerts remain paused/);
  assert(h.calls.every(call => !call.args.includes('--var')));
});

test('active deployment checks all existing secrets first and never generates new keys', async () => {
  const h = fixture([complete, deployed], {enabled: true});
  assert.deepEqual(await h.run(), {url: WORKER_URL, enabled: true, createdKeys: false});
  assert.deepEqual(operations(h), ['secret list --format json', 'deploy']);
  assert.equal(h.generations, 0);
  for (const output of ['[]', metadata([NAMES[0]]), metadata(NAMES.slice(0, 2)), '{bad', new Error('Sensitive auth diagnostic')]) {
    const blocked = fixture([output], {enabled: true});
    await assert.rejects(blocked.run());
    assert.deepEqual(operations(blocked), ['secret list --format json']);
    assert.equal(blocked.generations, 0);
    assert(!blocked.messages.join('\n').includes('Sensitive'));
  }
});

test('inactive failure paths stop without retries, key rotation or an activation deployment', async t => {
  const sensitive = new Error('Do not display private credentials ' + keys.privateKey);
  const cases = [
    ['deployment failure', [sensitive], 1, 0],
    ['secret listing or authentication failure', [deployed, sensitive], 2, 0],
    ['invalid metadata JSON', [deployed, '{bad'], 2, 0],
    ['unexpected metadata shape', [deployed, '{}'], 2, 0],
    ['partial existing keys', [deployed, metadata([NAMES[0]])], 2, 0],
    ['duplicated secret metadata', [deployed, metadata([...NAMES, NAMES[0]])], 2, 0],
    ['wrong secret type', [deployed, JSON.stringify([{name: NAMES[0], type: 'plain_text'}])], 2, 0],
    ['bulk upload failure', [deployed, '[]', sensitive], 3, 1],
    ['verification request failure', [deployed, '[]', '', sensitive], 4, 1],
    ['invalid verification JSON', [deployed, '[]', '', '{bad'], 4, 1],
    ['partial verification', [deployed, '[]', '', metadata(NAMES.slice(0, 2))], 4, 1],
    ['missing verification', [deployed, '[]', '', '[]'], 4, 1]
  ];
  for (const [name, outputs, count, generations] of cases) await t.test(name, async () => {
    const h = fixture(outputs);
    await assert.rejects(h.run(), error => !error.message.includes(keys.privateKey));
    assert.equal(h.calls.length, count);
    assert.equal(h.generations, generations);
    assert.equal(operations(h).filter(value => value === 'deploy').length, 1);
    assert(!h.messages.join('\n').includes(keys.privateKey));
    assert(!h.messages.join('\n').includes('active versioned'));
  });
  const failedKeys = fixture([deployed, '[]'], {generator: () => {throw sensitive;}});
  await assert.rejects(failedKeys.run(), /key pair could not be prepared/);
  assert.equal(failedKeys.calls.length, 2);
  assert.equal(failedKeys.generations, 1);
});

test('changed identity, non-SQLite storage, plaintext keys or environment overrides block deployment', async () => {
  const edits = [
    value => value.name = 'another-worker',
    value => value.vars.PUBLIC_SITE_URL = 'https://example.test/',
    value => value.vars.ALLOWED_ORIGIN = 'https://example.test',
    value => value.vars.ALERTS_ENABLED = true,
    value => value.vars.VAPID_PRIVATE_KEY = keys.privateKey,
    value => value.durable_objects.bindings[0].class_name = 'OtherMonitor',
    value => value.durable_objects.bindings[0].script_name = 'other-worker',
    value => value.migrations[0] = {tag: 'v1', new_classes: ['CryptoAlertMonitor']},
    value => value.keep_vars = true,
    value => value.env = {production: {vars: {ALERTS_ENABLED: 'true'}}}
  ];
  for (const edit of edits) {
    const value = config(false); edit(value);
    const h = fixture([], {value});
    await assert.rejects(h.run(), /does not match/); assert.equal(h.calls.length, 0);
  }
  for (const env of [{CLOUDFLARE_ENV: 'production'}, {WRANGLER_CI_OVERRIDE_NAME: 'another-worker'}]) {
    const h = fixture([], {env});
    await assert.rejects(h.run(), /override/); assert.equal(h.calls.length, 0);
  }
  const matchingBuild = fixture([deployed, complete], {env: {WRANGLER_CI_OVERRIDE_NAME: 'crypto-watch-alerts'}});
  await matchingBuild.run();
});

test('Workers Builds permits only the explicitly selected main branch', async () => {
  for (const branch of [undefined, '', 'preview', 'feature/phone-price-alerts', 'Main']) {
    const h = fixture([], {env: {WORKERS_CI: '1', WORKERS_CI_BRANCH: branch}});
    await assert.rejects(h.run(), /restricted to the main branch/);
    assert.equal(h.calls.length, 0); assert.equal(h.generations, 0);
  }
  const main = fixture([deployed, complete], {env: {WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main'}});
  await main.run();
  assert.deepEqual(operations(main), ['deploy', 'secret list --format json']);
});

test('only the exact dedicated deployment URL is returned or displayed', async () => {
  assert.equal(deploymentUrl(deployed), WORKER_URL);
  assert.equal(deploymentUrl('  ' + WORKER_URL + '/\n'), WORKER_URL);
  for (const address of [
    'https://another-worker.example.workers.dev', WORKER_URL + '/extra', WORKER_URL + '?secret=value', WORKER_URL + '#fragment',
    WORKER_URL + ':443', 'https://person@crypto-watch-alerts.example.workers.dev', WORKER_URL + '.example.test',
    'http://crypto-watch-alerts.example.workers.dev', 'prefix' + WORKER_URL,
    WORKER_URL + '\nhttps://crypto-watch-alerts.second.workers.dev', ''
  ]) {
    assert.throws(() => deploymentUrl(address));
    const h = fixture([address]);
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
    assert.equal(h.generations, 0);
    assert(!h.messages.includes(address));
  }
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => {child.signals.push(signal); return true;};
  return child;
}

test('the runner uses installed Wrangler with piped input, no shell and forced private logging settings', async () => {
  const child = fakeProcess();
  let command, args, options, received = '';
  child.stdin.on('data', chunk => received += chunk.toString());
  const run = createWranglerRunner({env: {SYNTHETIC_AUTH: 'inherited', WRANGLER_LOG: 'debug', WRANGLER_WRITE_LOGS: 'true',
    WRANGLER_LOG_SANITIZE: 'false', WRANGLER_SEND_METRICS: 'true', WRANGLER_SEND_ERROR_REPORTS: 'true'},
    spawnImpl: (...value) => {[command, args, options] = value; return child;}});
  const result = run(['secret', 'bulk', '--config', 'alerts/wrangler.jsonc'], {input: keys.privateKey});
  child.stderr.write('Sensitive authentication diagnostic'); child.stdout.write('success'); child.emit('close', 0);
  assert.equal(await result, 'success'); assert.equal(command, process.execPath);
  assert.match(args[0], /node_modules\/wrangler\/wrangler-dist\/cli\.js$/);
  assert.equal(received, keys.privateKey); assert(!args.includes(keys.privateKey));
  assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.env.SYNTHETIC_AUTH, 'inherited');
  for (const name of ['WRANGLER_WRITE_LOGS', 'WRANGLER_SEND_METRICS', 'WRANGLER_SEND_ERROR_REPORTS']) assert.equal(options.env[name], 'false');
  assert.equal(options.env.WRANGLER_LOG, 'log'); assert.equal(options.env.WRANGLER_LOG_SANITIZE, 'true');
  assert.equal(options.env.CI, 'true');
});

test('subprocess output, errors and runtime are bounded without exposing child diagnostics', async () => {
  const noisy = fakeProcess();
  const output = createWranglerRunner({spawnImpl: () => noisy, maxOutputBytes: 8})(['secret', 'list']);
  noisy.stderr.write('private-secret-too-large');
  await assert.rejects(output, /output limit/); assert.deepEqual(noisy.signals, ['SIGKILL']);
  const stalled = fakeProcess();
  await assert.rejects(createWranglerRunner({spawnImpl: () => stalled, timeoutMs: 5})(['deploy']), /time limit/);
  assert.deepEqual(stalled.signals, ['SIGKILL']);
  const failed = fakeProcess();
  const failure = createWranglerRunner({spawnImpl: () => failed})(['secret', 'list']);
  failed.stderr.write(keys.privateKey); failed.emit('close', 1);
  await assert.rejects(failure, error => /did not complete/.test(error.message) && !error.message.includes(keys.privateKey));
});
