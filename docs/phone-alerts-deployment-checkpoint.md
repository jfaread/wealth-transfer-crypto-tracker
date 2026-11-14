# Phone alert deployment checkpoint

Updated **14 November 2026, 14:01 UTC**. This supersedes the earlier account-setup checkpoint.

## Current status

The Cloudflare background service is deployed and enabled, and the existing public website is connected to it. **At 14:01:43 UTC, a fresh production capability check reported `status: live`, all nine coins enabled, and no unavailable coins.** This is a point-in-time observation, not a continuous-availability or instantaneous-delivery guarantee.

- Existing website, unchanged: https://jfaread.github.io/wealth-transfer-crypto-tracker/
- Alert service: https://crypto-watch-alerts.jfaread-crypto-watch.workers.dev
- Public capability endpoint: `/v1/config`.
- Coins: BTC, ETH, BNB, XRP, SOL, SHIB, KISHU, WKC and CREPE.
- `alerts-config.json` now points to that service; the deployed site's content security policy admits its exact origin.
- The service's public route is enabled and preview routes remain disabled.
- The owner supplied a Cloudflare billing screenshot showing **Workers Free - Active**. No plan upgrade, payment method or paid messaging provider was configured.
- The authorised Crypto-Watch Cloudflare Connection works. No further plugin installation or account-plan screenshot is required for this launch.

## Deployment and verification evidence

Latest deployed backend source: `94dc8d829af336481efc6f34a532fc784e49346b`.

Exact deployed bundle:

- SHA-256: `801a232599b3f42a3dff0d8f14470827f6fe623482e45220f64c1702fdc2774c`.
- Size: 181,942 bytes.
- Manifest: `deploy/alerts-94dc8d829af3/deployment-artifacts/manifest.json`.
- Build runtime: Node `26.13.1`.
- Successful final backend, runtime, chart and alert-browser verification: https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43602432570
- Successful preceding three-call batch verification: https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43601916875
- Successful website publication: https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43602171647
- Website connection commit: `6aea35919c6cbf47a1156ac6e4f9d5331a7ae918`.

The Cloudflare upload checked the entire bundle's byte count and SHA-256 before deployment. The existing Durable Object namespace, exported class identity and all three VAPID secrets were preserved. No private key or account credential was copied to this repository.

The temporary `crypto-watch-feed-probe` Worker was identity-checked, deleted, and verified absent. The primary alert Worker remained present. Other projects were not changed.

## Production feed fixes

The Kraken streaming endpoint returned rate-limit/gateway errors from the deployed environment. The service now falls back to timestamped HTTPS USD trades, with request pacing, persistent rate-limit cooldowns, genuine provider timestamps and recovery baselines. It does not use historical chart observations as live alert prices and does not weaken TLS validation.

KISHU uses its exact Ethereum contract and selected Uniswap v2 pool. Wiki Cat and CREPE use their exact BNB Chain contracts and selected PancakeSwap v2 pools. Their native-token reserves are converted using independently fresh Kraken ETH/USD or BNB/USD observations. These are indicative selected-pool USD prices, not guaranteed executable prices or identical chart quotes.

The Ethereum public provider permits a maximum of three calls per batch. The adapter now respects that limit using bounded sequential chunks, without removing any contract, factory, decimal, block-pinning or reorganisation checks. All chunks in the state-read phase share the original eight-second deadline. The maximum number of pool HTTP requests per round is eight.

Real Ethereum block responses can exceed the original 64 KiB allowance because they include transaction hashes. The response cap is now 1 MiB, with existing stream cancellation, timeout and validation protections retained. Regression tests cover both valid larger responses and rejection above the cap.

At **14:01:43 UTC** the final production response contained:

```json
{
  "enabled": true,
  "status": "live",
  "freshCoins": ["BTC", "ETH", "BNB", "XRP", "SOL", "SHIB", "KISHU", "WKC", "CREPE"],
  "unavailableCoins": [],
  "transport": "timestamped-trade-polling",
  "tradePollingIntervalMs": 15000,
  "poolPollingIntervalMs": 15000,
  "ethereumFailures": 0,
  "bscFailures": 0
}
```

Individual coins can subsequently become unavailable when observations are stale or a provider fails. This pauses affected alert activation/evaluation rather than inventing a price. An idle service uses a bounded freshness probe; ongoing monitoring is driven by enabled device rules.

## Preserved tracker behaviour

The existing shared address, Crypto-Watch branding, theme, chart controls, price-refresh fixes, small-number formatting, news, Jon George section and UK/Eastern Time display remain in place. All nine coins, including SHIB, remain in the chart. Regression checks for chart refresh, tiny decimals, selections and mobile layouts passed. The historical-data cron is separate from the alert monitor; scheduled historical executions were not reverified during this launch.

## Free pilot limits and timing

- Up to 50 registered devices and 16 rules per device.
- Up to 20 notification attempts per device per day and 200 overall, including tests/retries.
- At most 6,000 pool-poll rounds per day and the existing 1,000,000 feed-frame allowance.
- Current fallback sampling is approximately 15 seconds, not instantaneous. Brief crossings between observations can be missed; network conditions and phone settings can delay delivery.
- This launch uses browser push, not SMS or WhatsApp.

## Remaining acceptance step: a real phone

**A real handset notification has not yet been verified.** The automated notification and browser tests use controlled/mocked delivery. This maintenance run did not enrol a real phone, change a recipient's notification permission, or send a real test notification.

On iPhone: open the existing website in Safari, use Share > Add to Home Screen, enable Open as Web App if shown, and reopen Crypto-Watch from its new icon. In Price alerts, choose Enable phone alerts, review the site's consent and allow notifications. Then choose Request test alert.

Verify that a real notification appears. Also test while the website is closed and the screen is locked. A provider acceptance response or a queued test is not proof of handset display. Threshold drafts remain inactive until explicitly saved or activated with the monitor.

The infrastructure and website connection are ready. Real-device enrolment and foreground/background delivery acceptance remain the user-side launch check.
