import worker, {CryptoAlertMonitor as Monitor} from './monitor.mjs';
import {REST_POLL_MS, createKrakenRestFeed} from './rest-feed.mjs';
import {connectKraken} from './feeds.mjs';

/** Retain the storage class identity and existing monitor, exposing fallback timing. */
export class CryptoAlertMonitor extends Monitor {
  constructor(ctx, env, dependencies = {}) {
    super(ctx, env, {...dependencies, connectKraken: dependencies.connectKraken || (options => connectKraken({...options,
      restConnector: settings => createKrakenRestFeed({...settings,
        loadCooldown: () => ctx.storage.get('krakenRestRetryAfter'),
        saveCooldown: until => ctx.storage.put('krakenRestRetryAfter', until),
      }),
    }))});
  }
  monitor() {
    const result = super.monitor();
    const fallback = this.socket?.transport === 'rest';
    return {...result, transport: fallback ? 'timestamped-trade-polling' : 'websocket',
      tradePollingIntervalMs: fallback ? REST_POLL_MS : null,
      ...(fallback && !['disabled', 'budget_paused'].includes(result.status) ? {
        message: 'The streaming feed is unavailable. Kraken USD trades are checked about every 15 seconds; pool prices are also sampled. Stale coins are paused. Delivery is best effort, not instantaneous.',
      } : {})};
  }
  config() {
    const result = super.config();
    if (this.socket?.transport === 'rest') {
      for (const coin of result.coins) if (!coin.indicative) coin.samplingMs = REST_POLL_MS;
    }
    return result;
  }
}
export default worker;
