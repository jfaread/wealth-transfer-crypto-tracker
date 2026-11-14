/* Optional price alerts. Independent of the chart, market caches and news. */
(() => {
  'use strict';
  const KEY = 'wtct-alerts-v1';
  const CONSENT_VERSION = '2026-11-13';
  const MAX_RULES = 16;
  const COINS = [
    ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['BNB', 'BNB'], ['XRP', 'XRP'],
    ['SOL', 'Solana'], ['SHIB', 'Shiba Inu'], ['KISHU', 'Kishu Inu'], ['WKC', 'Wiki Cat'], ['CREPE', 'CREPE']
  ];
  const COIN_IDS = COINS.map(([id]) => id);
  const POOL_COINS = ['KISHU', 'WKC', 'CREPE'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const project = new URL('./', document.baseURI);
  const $ = id => document.getElementById(id);
  const dialog = $('wtct-alerts-dialog');
  if (!dialog || !$('wtct-alerts-open')) return;

  function decimal(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    let text = value.trim();
    if (text.startsWith('.')) text = '0' + text;
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    let [whole, fraction = ''] = text.split('.');
    whole = whole.replace(/^0+(?=\d)/, '');
    fraction = fraction.replace(/0+$/, '');
    if (whole.length > 18 || fraction.length > 24 || !/[1-9]/.test(whole + fraction)) return null;
    return whole + (fraction ? '.' + fraction : '');
  }

  function rule(value) {
    if (!value || !UUID.test(value.id || '') || !COIN_IDS.includes(value.coin) ||
        !['above', 'below'].includes(value.direction) || !decimal(value.threshold) ||
        typeof value.repeat !== 'boolean' || typeof value.enabled !== 'boolean') return null;
    return { id: value.id, coin: value.coin, direction: value.direction,
      threshold: decimal(value.threshold), repeat: value.repeat, enabled: value.enabled };
  }

  function rules(value) {
    if (!Array.isArray(value) || value.length > MAX_RULES) return null;
    const result = value.map(rule);
    return result.every(Boolean) && new Set(result.map(item => item.id)).size === result.length ? result : null;
  }

  function readLocal() {
    const empty = { version: 1, drafts: [], auth: null, attempt: null };
    try {
      const text = localStorage.getItem(KEY);
      if (!text || text.length > 65536) return empty;
      const value = JSON.parse(text);
      if (value?.version !== 1) return empty;
      const drafts = rules(value.drafts) || [];
      const auth = value.auth;
      const validAuth = auth && UUID.test(auth.deviceId || '') &&
        typeof auth.token === 'string' && auth.token.startsWith(auth.deviceId + '.') &&
        /^[A-Za-z0-9_.-]{50,300}$/.test(auth.token) && /^[a-f0-9]{64}$/.test(auth.serviceKey || '');
      const attempt = value.attempt;
      const validAttempt = attempt && UUID.test(attempt.operationId || '') && /^[a-f0-9]{64}$/.test(attempt.serviceKey || '');
      return { version: 1, drafts, auth: validAuth ? { deviceId: auth.deviceId, token: auth.token, serviceKey: auth.serviceKey } : null,
        attempt: validAttempt ? { operationId: attempt.operationId, serviceKey: attempt.serviceKey } : null };
    } catch (_) { return empty; }
  }

  let local = readLocal();
  let apiBase = null, serviceKey = null, config = null;
  let remote = { rules: [], revision: 0, events: [], monitor: null, subscriptionExpired: false };
  let verified = false, busy = false, checked = false, setupConflict = false, serverStopped = false;
  let registration = null, pendingSubscription = null;
  let setupProblem = '';
  const seenPageAlerts = new Set();
  let pageAlert = null, pageAlertExpiry = null;

  function persist(next = local) {
    try { localStorage.setItem(KEY, JSON.stringify(next)); local = next; }
    catch (_) { throw new Error('This browser cannot save alert settings. Allow website storage or use a normal browser window, then try again.'); }
  }

  function notice(message, error = false) {
    $('wa-message').textContent = message;
    $('wa-message').dataset.error = String(error);
    $('wa-message').hidden = !message;
  }

  function ios() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function installed() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function supported() {
    return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function usableAuth() { return Boolean(local.auth && serviceKey && local.auth.serviceKey === serviceKey); }
  function available(coin) { return config?.coins.find(item => item.id === coin)?.enabled === true; }
  function canSaveRemote(coin) { return Boolean(verified && usableAuth() && config?.enabled && !remote.subscriptionExpired && available(coin)); }
  function eligibleDrafts() { return local.drafts.filter(item => available(item.coin)); }

  function time(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 30000) return null;
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }).format(timestamp) + ' UK';
  }

  function renderPageAlert() {
    const banner = $('wtct-alert-banner');
    if (!banner || !pageAlert || banner.hidden) return;
    clearTimeout(pageAlertExpiry);
    const expired = pageAlert.expired || pageAlert.expiresAt <= Date.now() || Date.now() - pageAlert.observedAt > 300000;
    if (expired) pageAlert.expired = true;
    $('wa-banner-title').textContent = expired ? 'An earlier Crypto-Watch alert expired' : pageAlert.title;
    $('wa-banner-body').textContent = expired ? 'This earlier alert has expired. Check the latest chart data before acting, or open Price alerts to review your settings.' : pageAlert.body;
    $('wa-banner-time').dateTime = new Date(pageAlert.observedAt).toISOString();
    $('wa-banner-time').textContent = (expired ? 'Earlier observation: ' : 'Price observation: ') + time(pageAlert.observedAt);
    if (!expired) pageAlertExpiry = setTimeout(renderPageAlert, Math.max(1, Math.min(300000, pageAlert.expiresAt - Date.now())));
  }

  function receivePageAlert(event) {
    // A message from another page or another repository's worker is not an alert.
    if (event.source?.scriptURL !== new URL('sw.js', project).href || (event.origin && event.origin !== project.origin)) return;
    const value = event.data, now = Date.now();
    if (!value || value.type !== 'wtct-price-alert' || value.version !== 1 ||
        typeof value.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.eventId) ||
        typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 ||
        typeof value.body !== 'string' || !value.body.trim() || value.body.length > 600 ||
        value.url !== project.href || typeof value.expired !== 'boolean' ||
        !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0 || value.observedAt > now + 30000 ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt < value.observedAt ||
        value.expiresAt - value.observedAt > 300000 || seenPageAlerts.has(value.eventId)) return;
    const clean = text => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    const title = clean(value.title), body = clean(value.body);
    if (!title || !body) return;
    seenPageAlerts.add(value.eventId);
    if (seenPageAlerts.size > 100) seenPageAlerts.delete(seenPageAlerts.values().next().value);
    pageAlert = { eventId: value.eventId, title, body, observedAt: value.observedAt, expiresAt: value.expiresAt, expired: value.expired };
    const banner = $('wtct-alert-banner');
    if (!banner) return;
    banner.hidden = false;
    renderPageAlert();
  }

  function textElement(tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function action(text, handler, { disabled = false, danger = false } = {}) {
    const button = textElement('button', text, 'wa-button' + (danger ? ' wa-danger' : ''));
    button.type = 'button';
    button.disabled = busy || disabled;
    button.addEventListener('click', handler);
    return button;
  }

  function renderRuleList(target, items, draft) {
    const list = $(target);
    list.replaceChildren();
    if (!items.length) {
      list.append(textElement('li', draft ? 'No inactive drafts saved.' : 'No rules saved with the monitor.', 'wa-empty'));
      return;
    }
    for (const item of items) {
      const entry = textElement('li', '', 'wa-rule');
      entry.append(textElement('p', item.coin + ' crosses ' + item.direction + ' US$' + item.threshold, 'wa-rule-title'));
      const state = draft ? 'Saved on this device - not active' : item.enabled ? 'Enabled rule' : 'Paused or completed';
      entry.append(textElement('span', state + ' · ' + (item.repeat ? 'Repeat on a new crossing, at least 60 seconds apart' : 'Once, then stop'), 'wa-rule-meta'));
      if (draft && config && !available(item.coin)) {
        entry.append(textElement('span', 'Background monitoring is currently unavailable for this coin.', 'wa-rule-meta'));
      }
      const buttons = textElement('div', '', 'wa-actions');
      if (draft) {
        if (canSaveRemote(item.coin)) buttons.append(action('Activate draft', () => perform(() => activateDrafts([item]))));
        buttons.append(action('Delete draft', () => {
          try { persist({ ...local, drafts: local.drafts.filter(value => value.id !== item.id) }); notice('Draft deleted from this device.'); render(); }
          catch (error) { notice(error.message, true); }
        }));
      } else {
        buttons.append(action(item.enabled ? 'Pause' : 'Resume', () => perform(async () => {
          await saveRemoteRules(remote.rules.map(value => value.id === item.id ? { ...value, enabled: !value.enabled } : value));
          notice(item.enabled ? 'Rule paused with the monitor.' : 'Rule saved. It will wait for a future price crossing.');
        }), { disabled: !verified || !config?.enabled || remote.subscriptionExpired || (!item.enabled && !available(item.coin)) }));
        buttons.append(action('Delete rule', () => perform(async () => {
          await saveRemoteRules(remote.rules.filter(value => value.id !== item.id));
          notice('Rule deleted from the monitor.');
        }), { disabled: !verified || !config?.enabled, danger: true }));
      }
      entry.append(buttons);
      list.append(entry);
    }
  }

  function render() {
    const connected = verified && usableAuth();
    const enabledRules = remote.rules.filter(item => item.enabled).length;
    let status = 'Phone alerts are being prepared. Background monitoring is not enabled yet.';
    if (busy && !checked) status = 'Checking the background alert service…';
    else if (local.auth && (!apiBase || !usableAuth())) status = 'This browser remembers an alert registration, but its service cannot be checked here. Existing alerts have not been changed.';
    else if (config && !config.enabled) status = 'Background monitoring is currently paused. Drafts saved on this device do not send notifications.';
    else if (connected && remote.subscriptionExpired) status = 'This device’s notification subscription has expired. Disconnect this device, then enable alerts again. Saved rules cannot send notifications through the expired subscription.';
    else if (connected) status = 'This device is connected. ' + enabledRules + ' enabled ' + (enabledRules === 1 ? 'rule is' : 'rules are') + ' saved with the monitor.';
    else if (usableAuth()) status = 'This device has a saved registration, but its current status has not been verified. Previously saved rules may still be active.';
    else if (config?.enabled) status = 'This device is not connected to phone alerts. Draft thresholds are not active.';
    if (setupProblem && !connected) status += ' ' + setupProblem;
    $('wa-status').textContent = status;
    $('wa-status').dataset.state = connected && config?.enabled && !remote.subscriptionExpired ? 'connected' : 'pending';
    dialog.setAttribute('aria-busy', String(busy));

    const needsInstall = ios() && !installed();
    const canConnect = Boolean(apiBase && config?.enabled && !local.auth && supported() && !needsInstall);
    $('wa-connect').hidden = !canConnect;
    $('wa-connect').disabled = busy || !registration?.active || setupConflict;
    $('wa-connect').textContent = typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Finish enabling alerts' : 'Enable phone alerts';
    $('wa-consent').hidden = !canConnect;
    $('wa-test').hidden = !connected;
    $('wa-test').disabled = busy || !config?.enabled || remote.subscriptionExpired;
    $('wa-disconnect').hidden = !usableAuth();
    $('wa-disconnect').disabled = busy;
    $('wa-refresh').disabled = busy;
    $('wa-reset').hidden = !setupConflict || Boolean(local.auth);
    $('wa-reset').disabled = busy;
    if (config?.enabled && needsInstall) {
      $('wa-install').textContent = 'On this iPhone or iPad, first open Crypto-Watch in Safari, choose Share, then Add to Home Screen. Turn on Open as Web App if shown, tap Add, and reopen the new icon. Return to Price alerts to give permission. iOS or iPadOS 16.4 or later is required.';
      $('wa-help').open = true;
    }

    const coin = $('wa-coin').value;
    const capability = config?.coins.find(item => item.id === coin);
    const coinNote = config && !capability?.enabled ?
      coin + ': draft only. ' + (capability?.reason || 'Background monitoring is currently unavailable for this coin.') :
      canSaveRemote(coin) ? 'This threshold will be saved to the background monitor.' : 'This threshold will be saved on this device only and will not send alerts.';
    $('wa-coin-note').textContent = coinNote + (POOL_COINS.includes(coin) ?
      ' When active, this token uses an indicative pool price in USD, checked about every 15 seconds. It can differ from the chart.' : '');
    $('wa-save-rule').textContent = canSaveRemote(coin) ? 'Save alert with the monitor' : 'Save draft on this device';
    $('wa-rule-form').querySelectorAll('input,select,button').forEach(element => { element.disabled = busy; });
    $('wa-server-section').hidden = !connected;
    renderRuleList('wa-server-rules', connected ? remote.rules : [], false);
    renderRuleList('wa-draft-rules', local.drafts, true);
    $('wa-activate-drafts').hidden = !(connected && config?.enabled && !remote.subscriptionExpired && eligibleDrafts().length);
    $('wa-activate-drafts').disabled = busy;

    $('wa-source-details').hidden = !config;
    $('wa-sources').replaceChildren();
    if (config) for (const item of config.coins) {
      $('wa-sources').append(textElement('li', item.id + ': ' + item.source +
        (item.enabled ? '' : '. Currently unavailable') + (item.reason ? '. ' + item.reason : '')));
    }
    const lastObservation = time(remote.monitor?.lastObservedAt);
    const monitorMessage = typeof remote.monitor?.message === 'string' ? remote.monitor.message.slice(0,400) : '';
    $('wa-monitor').hidden = !connected || (!lastObservation && !monitorMessage);
    $('wa-monitor').textContent = [monitorMessage, lastObservation ? 'Latest market observation: ' + lastObservation + '.' : '', 'A recorded observation does not guarantee notification delivery.'].filter(Boolean).join(' ');
  }

  function validatedBase(value) {
    if (typeof value !== 'string' || !/^https:\/\/crypto-watch-alerts\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev\/?$/.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  }

  async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function publicKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86,88}={0,2}$/.test(value)) throw new Error('The alert service has not supplied a valid notification key. Try Check service later.');
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('The alert service notification key is invalid.');
    return bytes;
  }

  function validConfig(value) {
    if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.coins) || value.coins.length !== COIN_IDS.length) return null;
    const seen = new Set();
    const coins = [];
    for (const item of value.coins) {
      if (!item || !COIN_IDS.includes(item.id) || seen.has(item.id) || typeof item.enabled !== 'boolean' ||
          (item.source != null && (typeof item.source !== 'string' || item.source.length > 180)) ||
          (item.reason != null && (typeof item.reason !== 'string' || item.reason.length > 400))) return null;
      seen.add(item.id);
      coins.push({ id: item.id, enabled: item.enabled, source: item.source || 'Source not connected', reason: item.reason || '', maxAgeMs: item.maxAgeMs });
    }
    if (value.enabled) publicKey(value.vapidPublicKey);
    return { enabled: value.enabled, vapidPublicKey: value.vapidPublicKey, coins };
  }

  async function jsonRequest(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      const text = await response.text();
      if (text.length > 131072) throw new Error('The alert service returned too much information. Try Check service later.');
      let value = null;
      try { value = text ? JSON.parse(text) : {}; } catch (_) { /* Report a plain-language error below. */ }
      if (!response.ok) {
        const error = new Error(response.status === 429 ? 'The alert service is limiting requests. Wait a minute, then try again.' :
          response.status === 401 || response.status === 403 ? 'The alert service did not authorise this device. Your saved access has been kept; try Check service before changing anything.' :
          response.status === 409 ? 'The alert setup changed or this request has already been recorded. Check the current device status before trying again.' :
          response.status === 400 ? 'The alert service could not accept these settings. Check the coin, decimal threshold and rule limit, then try again.' :
          'The alert service could not complete the request. Your saved settings have been kept; try again.');
        error.status = response.status;
        error.code = typeof value?.error === 'string' ? value.error : typeof value?.code === 'string' ? value.code : value?.error?.code;
        if (error.code === 'price_not_ready') error.message = 'A fresh price is not available for one of these coins. No rule was changed. Choose Check service, then try again when its source is ready.';
        if (['daily_feed_limit', 'feed_budget_paused', 'budget_paused'].includes(error.code)) error.message = 'The free pilot has paused monitoring after reaching its daily data allowance. Saved rules remain in place; check the service after the allowance resets.';
        if (error.code === 'daily_pool_limit') error.message = 'The free pilot has paused KISHU, Wiki Cat and CREPE checks after reaching its daily pool-data allowance. Saved rules remain in place; check the service after midnight UTC.';
        if (['daily_limit', 'daily_push_limit', 'device_daily_limit', 'global_daily_limit'].includes(error.code)) error.message = 'The free pilot has reached its daily notification allowance. It allows up to 20 notifications per device and 200 in total per day. Extra alerts are not replayed later.';
        if (error.code === 'pilot_full') error.message = 'The free pilot has reached its 50-device limit. An unused device must be disconnected before another can join.';
        if (error.code === 'registration_limit') error.message = 'This network has reached today’s device-registration allowance. Try again tomorrow; your drafts remain on this device.';
        if (error.code === 'feed_not_ready') error.message = 'This coin’s live feed is not ready. Keep its threshold as an inactive draft and check the service later.';
        throw error;
      }
      if (!value || typeof value !== 'object' || !/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) {
        throw new Error('The alert service returned an unexpected response. Try Check service later.');
      }
      return value;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The alert service did not respond in time. Your saved settings have been kept; try again.');
      if (error instanceof TypeError) throw new Error('This browser could not reach the alert service. Check your connection, then try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function api(path, method = 'GET', body, authenticated = false) {
    if (!apiBase) throw new Error('Background phone alerts have not been configured yet.');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!usableAuth()) throw new Error('This device is not connected to the current alert service.');
      headers.Authorization = 'Bearer ' + local.auth.token;
    }
    return jsonRequest(apiBase + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  async function readConfig() {
    const value = validConfig(await api('/v1/config'));
    if (!value) throw new Error('The alert service configuration is incomplete. Try Check service later.');
    config = value;
  }

  async function readDevice() {
    const value = await api('/v1/device', 'GET', undefined, true);
    const savedRules = rules(value.rules);
    if (value.deviceId !== local.auth.deviceId || !savedRules || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error('The service could not confirm this device’s saved rules. Nothing has been changed.');
    }
    remote = { rules: savedRules, revision: value.revision, events: Array.isArray(value.events) ? value.events.slice(0,20) : [], monitor: value.monitor || null, subscriptionExpired: value.subscriptionExpired === true };
    verified = true;
  }

  async function prepareWorker() {
    if (!supported() || (ios() && !installed()) || !config?.enabled) return;
    const script = new URL('sw.js', project);
    registration = await navigator.serviceWorker.register(script.href, { scope: project.pathname, updateViaCache: 'none' });
    if (registration.scope !== project.href) throw new Error('The notification worker has an unexpected scope. Reload Crypto-Watch and try again.');
    if (!registration.active) {
      const worker = registration.installing || registration.waiting;
      if (!worker) throw new Error('The notification worker is not ready. Try Check service again.');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('The notification worker took too long to start. Try Check service again.')); }, 10000);
        function changed() {
          if (worker.state === 'activated') { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(); }
          else if (worker.state === 'redundant') { clearTimeout(timer); worker.removeEventListener('statechange', changed); reject(new Error('The notification worker could not start. Reload and try again.')); }
        }
        worker.addEventListener('statechange', changed);
        changed();
      });
    }
    pendingSubscription = await registration.pushManager.getSubscription();
    if (pendingSubscription?.options?.applicationServerKey) {
      const oldKey = new Uint8Array(pendingSubscription.options.applicationServerKey);
      const currentKey = publicKey(config.vapidPublicKey);
      if (oldKey.length !== currentKey.length || oldKey.some((byte, index) => byte !== currentKey[index])) {
        if (local.auth) throw new Error('This device uses a different notification key. Disconnect it before enabling alerts again.');
        setupConflict = true;
        throw new Error('An unfinished notification setup uses a different key. Use Reset unfinished setup, then try again.');
      }
    }
  }

  async function currentSubscription() {
    if (pendingSubscription) return pendingSubscription;
    if (!('serviceWorker' in navigator)) return null;
    const current = registration || await navigator.serviceWorker.getRegistration(project.href);
    if (!current || current.scope !== project.href) return null;
    return current.pushManager.getSubscription();
  }

  async function loadSetup() {
    verified = false;
    config = null;
    apiBase = null;
    serviceKey = null;
    setupProblem = '';
    let value;
    try { value = await jsonRequest(new URL('alerts-config.json', project).href); }
    catch (_) { checked = true; return; }
    if (value.version !== 1 || value.apiBase == null) { checked = true; return; }
    apiBase = validatedBase(value.apiBase);
    if (!apiBase) { checked = true; setupProblem = 'The configured service address is invalid; no device access was sent.'; return; }
    serviceKey = await digest(apiBase);
    await readConfig();
    checked = true;
    if (usableAuth()) await readDevice();
    if (local.auth && !usableAuth()) return;
    if (config.enabled && !supported() && !(ios() && !installed())) {
      setupProblem = 'This browser does not support phone notifications. Use an up-to-date supported browser on HTTPS.';
      return;
    }
    await prepareWorker();
  }

  async function saveRemoteRules(next) {
    if (!verified) throw new Error('Check this device’s registration before changing its rules.');
    const valid = rules(next);
    if (!valid) throw new Error('Use no more than 16 valid decimal-price rules.');
    try {
      const value = await api('/v1/rules', 'PUT', { rules: valid, revision: remote.revision }, true);
      const saved = rules(value.rules);
      if (!saved || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('The service did not confirm the saved rules. Use Check service before trying again.');
      remote = { ...remote, rules: saved, revision: value.revision };
    } catch (error) {
      if (error.status === 409 && error.code === 'revision_conflict') {
        await readDevice();
        throw new Error('Another tab changed your rules. The latest list has been loaded; review it and try again.');
      }
      throw error;
    }
  }

  async function activateDrafts(selected = eligibleDrafts()) {
    if (!verified || !config?.enabled || remote.subscriptionExpired) throw new Error('Connect this device to an active alert service first.');
    const known = new Set(remote.rules.map(item => item.id));
    const pending = selected.filter(item => available(item.coin) && !known.has(item.id));
    if (remote.rules.length + pending.length > MAX_RULES) throw new Error('The monitor already has too many rules. Delete a rule before activating another draft.');
    if (pending.length) await saveRemoteRules([...remote.rules, ...pending.map(item => ({ ...item, enabled: true }))]);
    const saved = new Set(remote.rules.map(item => item.id));
    persist({ ...local, drafts: local.drafts.filter(item => !saved.has(item.id)) });
    notice(pending.length ? pending.length + ' ' + (pending.length === 1 ? 'rule saved' : 'rules saved') + ' with the monitor. Each waits for a future crossing. Unavailable coins remain inactive drafts.' : 'Available drafts are already saved with the monitor.');
  }

  async function perform(task) {
    if (busy) return;
    busy = true;
    notice('');
    render();
    try { await task(); }
    catch (error) { notice(error.message || 'The alert request could not be completed. Try again.', true); }
    finally { busy = false; render(); }
  }

  function connect() {
    if (busy || !config?.enabled || !registration?.active || local.auth || setupConflict) return;
    try { persist(); } catch (error) { notice(error.message, true); return; }
    if (Notification.permission === 'denied') {
      notice('Notifications are blocked for Crypto-Watch. Allow them in this device’s notification or browser settings, then return and choose Check service.', true);
      return;
    }
    if (Notification.permission !== 'granted') {
      // Keep the permission request directly inside the user's click handler.
      let permission;
      try { permission = Notification.requestPermission(); }
      catch (_) { notice('This browser could not ask for notification permission. Check its notification settings.', true); return; }
      perform(async () => {
        if (await permission !== 'granted') throw new Error('Permission was not granted. No background alert connection was created.');
        notice('Notification permission is allowed. Tap Finish enabling alerts to connect this device. Drafts are still inactive.');
      });
      return;
    }
    let subscriptionPromise;
    try {
      const operationId = local.attempt?.serviceKey === serviceKey ? local.attempt.operationId : crypto.randomUUID();
      persist({ ...local, attempt: { operationId, serviceKey } });
      // A fresh subscription also starts directly from a user gesture, for iOS.
      subscriptionPromise = pendingSubscription ? Promise.resolve(pendingSubscription) :
        registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(config.vapidPublicKey) });
    } catch (error) { notice(error.message || 'Could not prepare this device for notifications.', true); return; }
    perform(async () => {
      pendingSubscription = await subscriptionPromise;
      let value;
      try {
        value = await api('/v1/devices', 'POST', { subscription: pendingSubscription.toJSON(), consentVersion: CONSENT_VERSION, operationId: local.attempt.operationId });
      } catch (error) {
        if (error.status === 409) {
          setupConflict = true;
          throw new Error('A previous setup may have succeeded without this browser receiving its access key. No draft rules were activated. Use Reset unfinished setup, then enable alerts again to create a new connection.');
        }
        throw error;
      }
      if (!UUID.test(value.deviceId || '') || typeof value.token !== 'string' || !value.token.startsWith(value.deviceId + '.') || !/^[A-Za-z0-9_.-]{50,300}$/.test(value.token)) {
        setupConflict = true;
        throw new Error('The service did not return valid device access. No drafts were activated. Reset unfinished setup before reconnecting.');
      }
      local = { ...local, auth: { deviceId: value.deviceId, token: value.token, serviceKey }, attempt: null };
      serverStopped = false;
      try { persist(); }
      catch (_) { throw new Error('The connection was created, but this browser could not remember its access. Disconnect this device now before closing this page. No drafts were activated.'); }
      await readDevice();
      // The first device may start the live feeds. Recheck which sources are
      // ready before deciding whether its saved drafts can become active rules.
      await readConfig();
      if (eligibleDrafts().length) await activateDrafts();
      else notice('This device is connected. Add an available coin threshold or request a test alert. Unavailable coin drafts remain inactive.');
    });
  }

  function openAlerts() {
    if (!dialog.open) dialog.showModal();
    render();
    perform(loadSetup);
  }
  $('wtct-alerts-open').addEventListener('click', openAlerts);
  $('wa-banner-view')?.addEventListener('click', openAlerts);
  $('wa-banner-dismiss')?.addEventListener('click', () => {
    $('wtct-alert-banner').hidden = true;
    clearTimeout(pageAlertExpiry);
    $('wtct-alerts-open').focus({preventScroll: true});
  });
  navigator.serviceWorker?.addEventListener?.('message', receivePageAlert);
  window.addEventListener('pagehide', () => clearTimeout(pageAlertExpiry));
  window.addEventListener('pageshow', renderPageAlert);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderPageAlert(); });
  $('wa-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  $('wa-refresh').addEventListener('click', () => perform(loadSetup));
  $('wa-connect').addEventListener('click', connect);
  $('wa-coin').addEventListener('change', render);
  $('wa-activate-drafts').addEventListener('click', () => perform(() => activateDrafts()));

  $('wa-rule-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const threshold = decimal($('wa-threshold').value);
    $('wa-threshold').setAttribute('aria-invalid', String(!threshold));
    if (!threshold) {
      notice('Enter a positive USD amount using digits and a decimal point, with up to 24 decimal places. Do not use commas, currency signs or e notation.', true);
      $('wa-threshold').focus();
      return;
    }
    if (local.drafts.length + (verified ? remote.rules.length : 0) >= MAX_RULES) {
      notice('You can save up to 16 rules. Delete an existing rule or draft first.', true);
      return;
    }
    const item = { id: crypto.randomUUID(), coin: $('wa-coin').value, direction: $('wa-direction').value,
      threshold, repeat: $('wa-repeat').value === 'repeat', enabled: true };
    perform(async () => {
      if (canSaveRemote(item.coin)) {
        await saveRemoteRules([...remote.rules, item]);
        notice('Rule saved with the monitor. It starts with the next fresh quote and waits for a future crossing.');
      } else {
        persist({ ...local, drafts: [...local.drafts, item] });
        notice('Saved on this device only - not active. This draft will not send notifications.');
      }
      $('wa-threshold').value = '';
      $('wa-threshold').removeAttribute('aria-invalid');
    });
  });

  $('wa-test').addEventListener('click', () => perform(async () => {
    if (!verified || !config?.enabled) throw new Error('Check this device’s connection before requesting a test.');
    await api('/v1/test', 'POST', {}, true);
    notice('Test notification requested. Check this device’s notifications; this request does not guarantee it will be displayed.');
  }));

  $('wa-disconnect').addEventListener('click', () => perform(async () => {
    // Stop the server registration before touching the browser subscription.
    const result = await api('/v1/device', 'DELETE', {}, true);
    if (result.deleted !== true) throw new Error('The service did not confirm that this registration was removed. Check the service before trying again.');
    // Clear in-memory access immediately: later local cleanup must never imply the server is still connected.
    serverStopped = true;
    local = { ...local, auth: null, attempt: null };
    verified = false;
    remote = { rules: [], revision: 0, events: [], monitor: null, subscriptionExpired: false };
    let subscription = null, removed = true, storageSaved = true;
    try {
      subscription = await currentSubscription();
      if (subscription) removed = await subscription.unsubscribe();
    } catch (_) { removed = false; }
    try { persist(); } catch (_) { storageSaved = false; }
    pendingSubscription = removed ? null : subscription;
    setupConflict = !removed;
    const messages = ['The server alert registration has been stopped.'];
    messages.push(removed ? 'The browser notification subscription was removed.' : 'Browser cleanup could not finish. Use Reset unfinished setup to retry; server alerts are already stopped.');
    messages.push(storageSaved ? 'Inactive drafts remain on this device.' : 'The browser could not save the disconnected status. You can now clear this site’s browser data to remove the old access; doing so also removes local drafts.');
    notice(messages.join(' '), !removed || !storageSaved);
  }));

  $('wa-reset').addEventListener('click', () => perform(async () => {
    if (local.auth) throw new Error('Disconnect the saved registration before resetting browser setup.');
    const subscription = await currentSubscription();
    if (subscription && !(await subscription.unsubscribe())) throw new Error('The browser subscription could not be reset. Reload the page and try again.');
    persist({ ...local, attempt: null });
    pendingSubscription = null;
    setupConflict = false;
    notice(serverStopped ? 'Browser setup was reset. The server registration was already stopped. Your drafts remain inactive; you can enable a new connection when ready.' :
      'Unfinished browser setup was reset. A previous server registration cannot be managed without its lost access key. Your drafts remain inactive; choose Finish enabling alerts to create a fresh connection.');
  }));

  window.addEventListener('storage', event => {
    if (event.key !== KEY || busy) return;
    local = readLocal();
    verified = false;
    if (dialog.open) perform(loadSetup); else render();
  });
  $('wtct-alerts-open').hidden = false;
  render();
})();
