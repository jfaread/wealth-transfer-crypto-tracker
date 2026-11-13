# Crypto-Watch

An independent cryptocurrency tracker with a Miami sunset theme, eight genuine market-data series, scrolling news and a separate Jon George / MyDefiGuru section.

**Shared website:** <https://jfaread.github.io/wealth-transfer-crypto-tracker/>

## Phone alert pilot

The alert implementation uses opt-in Web Push for UK and US users. One background service evaluates thresholds independently of whether a visitor has the website open. The installable website receives operating-system notifications and also displays an alert inside an open page. It needs no telephone number, Telegram account, wallet connection or AI service.

**The committed configuration is inactive:** `alerts-config.json` has `apiBase: null` and the Worker has `ALERTS_ENABLED: "false"`. Local drafts are labelled inactive. The backend must be deployed and validated before live monitoring is enabled.

The first live-feed adapter covers BTC, ETH, BNB, XRP and SOL on Kraken's true USD pairs. KISHU, Wiki Cat and CREPE retain their exact contract identities but remain draft-only until dependable live feeds for those tokens are validated. The existing chart continues to cover all eight coins.

Read [the owner setup guide](docs/activate-phone-alerts.md) to connect a free Cloudflare account without copying private push keys. The [implementation guide](docs/phone-alerts.md) explains behaviour, limits, privacy, testing and remaining work.

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
