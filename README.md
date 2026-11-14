# Crypto-Watch

An independent cryptocurrency tracker with a Miami sunset theme, nine genuine market-data series, scrolling news and a separate Jon George / MyDefiGuru section. The chart includes Shiba Inu (SHIB).

**Shared website:** <https://jfaread.github.io/wealth-transfer-crypto-tracker/>

## Phone alert pilot

The alert implementation uses opt-in Web Push for UK and US users. One background service evaluates thresholds independently of whether a visitor has the website open. The installable website receives operating-system notifications and also displays an alert inside an open page. It needs no telephone number, Telegram account, wallet connection or AI service.

**The committed configuration is inactive:** `alerts-config.json` has `apiBase: null` and the Worker has `ALERTS_ENABLED: "false"`. Local drafts are labelled inactive. The backend must be deployed and validated before live monitoring is enabled.

The phone alert source adapters cover eight coins; SHIB currently has chart coverage only. BTC, ETH, BNB, XRP and SOL use Kraken's true USD pairs. KISHU, Wiki Cat and CREPE use verified, exact-contract trading pools with fresh ETH/USD or BNB/USD conversion. These are **indicative pool prices**, checked about every 15 seconds while needed, and can differ from the chart or a trade quote. Brief crossings between checks can be missed. Each source must pass freshness and identity checks before its rules can be activated; a deployment and real-phone test are still required.

Read [the owner setup guide](docs/activate-phone-alerts.md) to connect a free Cloudflare account without copying private push keys. The [implementation guide](docs/phone-alerts.md) explains behaviour, limits, privacy, testing and remaining work.

The [pool source notes](docs/pool-price-sources.md) record exact pools, the USD calculation, timestamp checks and the limits of sampling.

## Development

GitHub Actions uses Node **26.13.1**. Local development requires Node 24 or later.

```sh
npm ci --ignore-scripts
npm run check:worker
npm test
npm run build
npm run test:charts
npm run test:alerts-browser
```

Browser checks use installed Chrome or Chromium. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an installed browser. Runtime tests use the actual Worker bundle with outbound traffic fully mocked; they do not send real notifications.

The current public market-data workflow has a `23 * * * *` schedule. The schedule's presence does **not** establish that hourly executions are taking place; that remains unverified. Manual price refresh operates independently of the alert service and the historical-data build.

Code-push releases reuse the genuine committed historical snapshot and keep its original dates. Scheduled and manually dispatched builds attempt new history. Every publication still checks the separate current-quote cache and validates the snapshot before deploying; historical-provider retries do not delay a website-only release.
