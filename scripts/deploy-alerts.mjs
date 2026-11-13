import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {generateVAPIDKeys} from 'web-push';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = 'alerts/wrangler.jsonc';
const SITE = 'https://jfaread.github.io/wealth-transfer-crypto-tracker/';
const NAME = 'crypto-watch-alerts';
const SECRETS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
const MAX_OUTPUT = 256 * 1024;
const require = createRequire(import.meta.url);
class DeploymentError extends Error {}

function configuration(text) {
  let value;
  // The versioned .jsonc file deliberately uses strict JSON. Reject ambiguous
  // input instead of rewriting or generating another deployment configuration.
  try { value = JSON.parse(text); } catch { throw new DeploymentError('Keep alerts/wrangler.jsonc valid strict JSON before deployment.'); }
  const binding = value?.durable_objects?.bindings;
  const migration = value?.migrations;
  if (value?.name !== NAME || value.main !== 'worker.mjs' || value.workers_dev !== true ||
      value.vars?.ALLOWED_ORIGIN !== 'https://jfaread.github.io' || value.vars?.PUBLIC_SITE_URL !== SITE ||
      !['true', 'false'].includes(value.vars?.ALERTS_ENABLED) ||
      !Array.isArray(binding) || binding.length !== 1 || binding[0]?.name !== 'ALERT_MONITOR' ||
      binding[0].class_name !== 'CryptoAlertMonitor' || Object.keys(binding[0]).some(key => !['name', 'class_name'].includes(key)) ||
      !Array.isArray(migration) || migration.length !== 1 || migration[0]?.tag !== 'v1' ||
      JSON.stringify(migration[0].new_sqlite_classes) !== '["CryptoAlertMonitor"]' ||
      Object.keys(migration[0]).some(key => !['tag', 'new_sqlite_classes'].includes(key)) ||
      value.env || value.keep_vars === true || value.route || value.routes ||
      SECRETS.some(key => Object.hasOwn(value.vars, key))) {
    throw new DeploymentError('The versioned Worker name, site, activation flag or SQLite binding does not match this deployment helper. Nothing was deployed.');
  }
  return {enabled: value.vars.ALERTS_ENABLED === 'true'};
}

export function deploymentUrl(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) throw new DeploymentError('The deployment address could not be verified.');
  const urls = new Set(stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim()).filter(line =>
    /^https:\/\/crypto-watch-alerts\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev\/?$/.test(line)
  ).map(line => new URL(line).origin));
  if (urls.size !== 1) throw new DeploymentError('Wrangler did not return one exact crypto-watch-alerts Workers address. Check the Worker dashboard before retrying.');
  return [...urls][0];
}

function secretState(output) {
  let entries;
  try { entries = JSON.parse(output); } catch { throw new DeploymentError('Secret metadata could not be parsed. Deployment stopped without any further key changes.'); }
  if (!Array.isArray(entries) || entries.length > 100) throw new DeploymentError('Secret metadata was unexpected. Deployment stopped without any further key changes.');
  const names = new Set();
  for (const item of entries) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name) ||
        names.has(item.name) || (SECRETS.includes(item.name) && item.type !== 'secret_text')) {
      throw new DeploymentError('Secret metadata was unexpected. Deployment stopped without any further key changes.');
    }
    names.add(item.name);
  }
  return SECRETS.filter(name => names.has(name)).length;
}

export function createWranglerRunner({env = process.env, spawnImpl = spawn, timeoutMs = 120000, maxOutputBytes = MAX_OUTPUT} = {}) {
  // Resolve the installed CLI without importing it or accepting an executable
  // from a command argument. The inherited environment supplies authorisation.
  const entry = require.resolve('wrangler');
  const childEnv = {...env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0',
    WRANGLER_LOG: 'log', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false'};
  return (args, {input = ''} = {}) => new Promise((resolveResult, reject) => {
    let child, timer, done = false, bytes = 0;
    const chunks = [];
    const finish = (error, output) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolveResult(output);
    };
    const stop = message => {
      child?.kill('SIGKILL');
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      finish(new DeploymentError(message));
    };
    try {
      child = spawnImpl(process.execPath, [entry, ...args], {
        cwd: ROOT, env: childEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
    } catch { finish(new DeploymentError('Wrangler could not start.')); return; }
    timer = setTimeout(() => stop('Wrangler exceeded the deployment time limit.'), timeoutMs);
    const collect = (chunk, keep) => {
      if (done) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxOutputBytes) { stop('Wrangler exceeded the output limit.'); return; }
      if (keep) chunks.push(buffer);
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', () => finish(new DeploymentError('Wrangler could not start.')));
    child.once('close', code => finish(code === 0 ? null : new DeploymentError('Wrangler did not complete successfully.'), Buffer.concat(chunks).toString('utf8')));
    child.stdin.once('error', () => stop('Wrangler could not receive its input.'));
    child.stdin.end(input);
  });
}

export async function deployAlerts({env = process.env, runWrangler,
  loadConfig = () => readFile(new URL('../' + CONFIG, import.meta.url), 'utf8'),
  generateKeys = generateVAPIDKeys, log = console.log} = {}) {
  if (env.CRYPTO_ALERTS_FREE_PLAN_CONFIRMED !== 'true') {
    throw new DeploymentError('Deployment stopped. The owner must confirm a Workers Free plan by setting CRYPTO_ALERTS_FREE_PLAN_CONFIRMED=true. This is an owner attestation, not an API verification.');
  }
  if (env.WORKERS_CI === '1' && env.WORKERS_CI_BRANCH !== 'main') {
    throw new DeploymentError('Production alert deployment is restricted to the main branch in Workers Builds.');
  }
  if (env.CLOUDFLARE_ENV || (env.WRANGLER_CI_OVERRIDE_NAME && env.WRANGLER_CI_OVERRIDE_NAME !== NAME)) {
    throw new DeploymentError('Deployment stopped because the environment would override the fixed Worker configuration.');
  }
  let text;
  try { text = await loadConfig(); } catch { throw new DeploymentError('The versioned alerts/wrangler.jsonc could not be read. Nothing was deployed.'); }
  const {enabled} = configuration(text);
  const run = runWrangler || createWranglerRunner({env});
  async function step(args, message, input = '') {
    try {
      const output = await run([...args, '--config', CONFIG], {input});
      if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) throw new Error();
      return output;
    } catch { throw new DeploymentError(message); }
  }
  const list = async () => secretState(await step(['secret', 'list', '--format', 'json'], 'Secret metadata could not be checked. Deployment stopped without any further key changes.'));
  log('Owner Free-plan confirmation accepted; the account billing plan has not been verified by this helper.');
  if (enabled && await list() !== 3) {
    throw new DeploymentError('Active deployment requires all three existing VAPID secrets. No keys were generated and nothing was deployed.');
  }
  const url = deploymentUrl(await step(['deploy'], 'The Worker deployment did not complete successfully. Check the Worker dashboard before retrying.'));
  let createdKeys = false;
  if (!enabled) {
    log('Deployed with alerts paused by the versioned configuration.');
    const count = await list();
    if (count !== 0 && count !== 3) throw new DeploymentError('A partial notification key set exists. No keys were generated or replaced. Alerts remain paused.');
    if (count === 0) {
      let input;
      try {
        const keys = await generateKeys();
        if (!/^[A-Za-z0-9_-]{87}$/.test(keys?.publicKey || '') || !/^[A-Za-z0-9_-]{43}$/.test(keys?.privateKey || '')) throw new Error();
        input = JSON.stringify({VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: SITE});
      } catch { throw new DeploymentError('The notification key pair could not be prepared. Alerts remain paused.'); }
      try { await step(['secret', 'bulk'], 'Notification key upload could not be confirmed. Alerts remain paused; no automatic retry or key rotation was attempted.', input); }
      finally { input = undefined; }
      if (await list() !== 3) throw new DeploymentError('The complete notification key set could not be verified after upload. Alerts remain paused; no automatic retry was attempted.');
      createdKeys = true;
    }
    log(createdKeys ? 'Notification key metadata verified. Alerts remain paused.' : 'Existing notification keys retained. Alerts remain paused.');
  } else log('Deployed the active versioned configuration using the existing notification keys.');
  log(url);
  return {url, enabled, createdKeys};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new DeploymentError('This helper takes no command-line options. Activation is controlled only by alerts/wrangler.jsonc.');
    await deployAlerts();
  } catch (error) {
    console.error(error instanceof DeploymentError ? error.message : 'Deployment stopped unexpectedly. Check the Worker dashboard before retrying.');
    process.exitCode = 1;
  }
}
