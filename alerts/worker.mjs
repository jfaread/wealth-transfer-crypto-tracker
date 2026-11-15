import worker, {CryptoAlertMonitor as Monitor} from './monitor.mjs';
import {REST_POLL_MS, createKrakenRestFeed} from './rest-feed.mjs';
import {connectKraken, probeKrakenStream} from './feeds.mjs';

/**
 * Preserve the existing Durable Object identity, VAPID keys and stored rules.
 * HTTP trade polling remains live while an occasional bounded WebSocket probe
 * waits for a genuinely fresh Kraken ticker observation. No new subscription or
 * notification is emitted merely because the transport recovers.
 */
export class CryptoAlertMonitor extends Monitor {
  constructor(ctx, env, dependencies = {}) {
    let instance;
    super(ctx, env, {...dependencies,
      connectKraken: dependencies.connectKraken || (options => connectKraken({...options,
        restConnector: async settings => {
          let restSocket;
          restSocket = await createKrakenRestFeed({...settings,
            loadCooldown: () => ctx.storage.get('krakenRestRetryAfter'),
            saveCooldown: until => ctx.storage.put('krakenRestRetryAfter', until),
            loadProbeAt: () => ctx.storage.get('krakenWsNextProbeAt'),
            saveProbeAt: until => ctx.storage.put('krakenWsNextProbeAt', until),
            probeStream: () => probeKrakenStream({
              fetchImpl: options.fetchImpl,
              onMessage: options.onMessage,
              onClose: options.onClose,
              now: options.now || (() => Date.now()),
            }),
            onUpgrade: socket => {
              // Only the still-active REST connection may be replaced.
              // A closed or superseded monitor must never revive an old probe.
              if (!instance || instance.socket !== restSocket || instance.connectionGeneration < 1)
                return false;
              instance.socket = socket;
              instance.feedStatus = 'waiting_for_prices';
              return true;
            },
          });
          return restSocket;
        },
      })),
    });
    instance = this;
  }
  monitor() {
    const result = super.monitor();
    const fallback = this.socket?.transport === 'rest';
    return {...result,
      transport: fallback ? 'timestamped-trade-polling' : this.socket ? 'websocket' : 'connecting',
      tradePollingIntervalMs: fallback ? REST_POLL_MS : null,
      ...(fallback && !['disabled', 'budget_paused'].includes(result.status) ? {
        message: (result.freshCoins.length
          ? 'Kraken USD trade polling is active, approximately every 15 seconds. '
          : 'Waiting for fresh Kraken USD trades through the backup polling feed. ') +
          'The streaming connection is rechecked periodically without interrupting polling. ' +
          'Coins without fresh, validated prices are paused. Notification delivery is best effort.',
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
