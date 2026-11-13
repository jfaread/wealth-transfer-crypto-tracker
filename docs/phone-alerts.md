# Phone alerts: implementation and activation

## Current status

This is a free-pilot implementation, not an activated public alert service. The existing shared website remains:

<https://jfaread.github.io/wealth-transfer-crypto-tracker/>

The deployment defaults are deliberately inactive. `alerts-config.json` contains `apiBase: null`; `alerts/wrangler.jsonc` contains `ALERTS_ENABLED: "false"`. No telephone numbers, subscriptions or live credentials are committed. No paid service or ChatGPT automation is required by the implementation.

The interface must never equate a saved local draft, browser permission, registration response or provider acceptance with a delivered notification. These are separate states.

## Operation with the website open or closed

One Cloudflare Durable Object receives a shared live price stream and compares it with all enabled device rules. It runs on the server. No visitor's browser timer, open tab, GitHub Actions run or historical chart build is responsible for monitoring.

After a user grants permission and connects their device, a fresh crossing creates a durable event and an encrypted Web Push request. The project's service worker displays the phone/computer notification. If the project is open, it also sends the event to that page for an accessible in-page banner. The event identifier prevents repeated processing of the same event from creating repeated foreground notices; the same identifier is used as the operating-system notification tag.

On iPhone or iPad, the user needs iOS/iPadOS 16.4 or later and must add the website to the Home Screen, open that app and give notification permission. Android users can give permission in a supported browser; installation is optional. The UI requests permission only following a button press. Apple documents Home Screen push and its user-gesture requirements in [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

Delivery is best effort. An offline phone, Focus/Do Not Disturb, revoked permission, browser restrictions, a source outage or an exhausted free quota can delay or prevent a notification. A provider's successful HTTP response is recorded as **accepted**, not delivered. This is unsuitable as an execution guarantee for a trade.

## Price sources and exact token identities

| Coin | First adapter | Live-alert eligibility after activation |
| --- | --- | --- |
| BTC | Kraken BTC/USD ticker | Enabled only with a fresh source observation |
| ETH | Kraken ETH/USD ticker | Enabled only with a fresh source observation |
| BNB | Kraken BNB/USD ticker | Enabled only with a fresh source observation |
| XRP | Kraken XRP/USD ticker | Enabled only with a fresh source observation |
| SOL | Kraken SOL/USD ticker | Enabled only with a fresh source observation |
| KISHU | No validated continuous adapter yet | Inactive draft only |
| Wiki Cat (WKC) | No validated continuous adapter yet | Inactive draft only |
| CREPE | No validated continuous adapter yet | Inactive draft only |

The Kraken adapter uses the [public v2 ticker stream](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), trade-triggered updates, exact USD instrument names and source timestamps. These are exchange-specific last-trade observations. They can differ from the chart's CoinGecko aggregate; the alert identifies the venue and pair. USDT observations are never relabelled USD.

The three additional tokens are fixed in `alerts/core.mjs`:

| Token | Network | Contract | CoinGecko ID |
| --- | --- | --- | --- |
| KISHU | Ethereum | `0xA2b4C0Af19cC16a6CfAcCe81F192B024d625817D` | `kishu-inu` |
| Wiki Cat | BNB Chain | `0x6ec90334d89dbdc89e08a133271be3d104128edb` | `wiki-cat` |
| CREPE | BNB Chain | `0xeb2b7d5691878627eff20492ca7c9a71228d931d` | `crepe-2` |

A future DEX adapter must independently verify chain ID, exact pool token addresses, decimals, current reserves/liquidity, trade/block timestamps and an actual continuous event connection. It must handle reconnect gaps and reorganisations and label any wrapped-native/USD conversion as an indicative pool price. Candidate pool discovery alone does not establish that these checks pass. The implementation does not present cached DEX pages, invented observations or the chart's older snapshots as live triggers.

## Threshold rules

Each device may save at most 16 rules. A rule has a stable UUID, coin, `above`/`below`, a positive USD decimal string, a repeat flag and an enabled flag. Up to 18 integer digits and 24 decimal places are supported. Comparison uses integer arithmetic, avoiding binary floating-point rounding of the user's threshold.

For an above rule, the last safe observation is at or below the threshold, and the next observation must be strictly above. Below rules use the reverse comparison. The first fresh observation establishes a baseline. If the price is already beyond the chosen threshold, it must return to the safe side and cross again before an alert fires.

One-shot alerts are the default and are disabled when their event is committed. Repeating alerts require a return to the safe side and a new crossing, with a minimum interval of 60 seconds. A crossing suppressed by that interval is not replayed later. A source change, an edited rule, a restart or a monitoring gap establishes a new baseline instead of inventing the path taken while the monitor was unavailable.

Quotes older than 60 seconds by provider time or 30 seconds by receipt time are rejected, as are invalid/future/out-of-order observations. A gap exceeding two minutes cannot generate a historical crossing. These limits prevent stale false alerts but may miss a brief crossing during a gap; the system does not claim every market movement is observed.

The outbox and rule completion are committed before dispatch. Transient failures use a bounded retry with the same event identifier and honour the provider's Retry-After. Up to three attempts are made within the short event lifetime. Exactly-once delivery to a handset is not provable; a request can succeed before its response is lost. Stable notification tags limit duplicate presentation. A structurally valid push received after expiry displays a generic expired-alert notice without its stale price.

## Free-pilot boundaries

Use a **Workers Free** account and SQLite-backed Durable Objects. This implementation creates one monitor, not one continuous process per user. Cloudflare currently includes 100,000 Durable Object requests and 13,000 GB-seconds per day; free-limit exhaustion causes operations to fail rather than providing unlimited execution. These limits and their reset time are documented in [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

A continuously resident 128 MiB object uses approximately 10,800 GB-seconds per 24 hours (0.125 GiB × 86,400 seconds). Outgoing WebSocket connections cannot use server-side socket hibernation, so do not budget this monitor as a sleeping object. See [Cloudflare's WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

The pilot enforces:

- At most 50 registered devices, with a lower configurable cap.
- At most 16 rules per device.
- At most 20 push attempts per device and 200 globally per UTC day, including test messages and retries.
- At most one test request per device per minute and 10 new registrations per IP bucket per UTC day.
- A maximum of 1,000,000 incoming feed frames per UTC day, with a lower configurable cap. Small frame allowances are reserved durably before use, preventing restarts from resetting the count. At the cap, monitoring visibly pauses until the next UTC day.
- A five-minute capability probe when there are no enabled rules, then idle shutdown.

The daily frame maximum corresponds to approximately 50,000 request equivalents at Cloudflare's documented 20:1 incoming WebSocket message ratio, leaving some room for alarms and API activity. Other workloads share the account's allowances. These application limits reduce exposure; they do not measure every platform resource or guarantee uninterrupted monitoring. An account already on a paid plan could incur its normal charges, so verify the selected plan before deployment. Do not upgrade or add a billing service as part of activation.

## Device privacy and recovery

The service stores the push endpoint and browser encryption keys, the chosen rules, recent event statuses, consent version, usage counters and a hash of a random 256-bit access secret. No telephone number, wallet address, trading credentials or messaging account is requested. Push payloads are encrypted with the standard Web Push scheme; the VAPID private key remains a server secret.

The browser stores its own access token under `wtct-alerts-v1`; it is sent only in the Authorization header to the configured dedicated backend. It is never placed in a URL. The backend validates ownership, exact allowed origin, bounded requests and supported push-service endpoints. Rules are saved with a revision check so two tabs cannot silently overwrite each other.

The service worker is restricted to `/wealth-transfer-crypto-tracker/`, has no fetch handler, does not cache market data and does not intercept other projects. GitHub Pages projects under the same owner share an origin: path scopes and storage prefixes provide functional separation, not a security boundary from another compromised same-origin page. Keep this owner's pages and their scripts trusted.

Disconnect removes server rules and pending events first, then unsubscribes the browser. Browser cleanup failure must not claim that the deleted server registration is still active. Users should disconnect before clearing browser storage. If a registration succeeded but its access token was lost, an unfinished setup can be reset locally; the old server registration cannot be recovered without that token and expires according to retention policy. At present registrations are retained for up to 90 days since their last rule change or threshold event; this is a device pilot, not a cross-device account system.

## Activation without changing the public address

For a dashboard setup that creates the private push keys inside the authorised Cloudflare build, use the [owner connection guide](activate-phone-alerts.md). The helper preserves complete existing keys, stops on partial or failed secret checks, and honours the versioned activation setting. Its free-plan confirmation is an owner attestation, not an automated billing-plan check. The owner's Cloudflare account still needs to be connected before this route can be verified.

The original authorised-CLI route is also available. Required steps are:

1. Connect an authorised Cloudflare account and confirm **Workers Free**, available quotas and ownership of the intended Worker namespace. There is no Cloudflare deployment connection configured in this repository. No token needs to be pasted into chat or committed.
2. Run `npm ci --ignore-scripts`, `npm run check:worker` and `npm test`. The runtime smoke test needs the freshly built `.worker-build/worker.js` artifact. It uses ephemeral keys and completely mocked outbound connections.
3. Use `node scripts/create-alert-keys.mjs` to create the dedicated key pair in ignored `alerts/.secrets.json` with owner-only permissions. The script refuses to overwrite an existing file and prints no key values. Store that pair securely for later deployments; rotating it disconnects existing browser subscriptions.
4. Upload those values as Worker secrets using the authorised Wrangler session, keeping `ALERTS_ENABLED` false initially. `wrangler secret bulk` supports a private JSON input file. Deploy with `npx wrangler deploy --config alerts/wrangler.jsonc` only to the verified free account.
5. Verify the deployed `/v1/config` response, correct origin restrictions, all five source subscriptions, actual source timestamps and stable reconnect behaviour. Enable the Worker for a controlled pilot and confirm its public configuration honestly reports each feed's status.
6. Set `alerts-config.json` to the exact returned `https://crypto-watch-alerts.<account>.workers.dev` origin. Build the static site so its content security policy admits that origin only, and publish through the existing GitHub Pages workflow to the existing address.
7. With an opted-in test device, verify a requested test message with the site open, with it closed and with the phone locked. Test one fresh threshold crossing in a controlled test environment, pause, unsubscribe and reconnect. Record observation, dispatch, provider acceptance and actual display times separately. Do not advertise a guaranteed latency from a provider acceptance timestamp.

The Worker and static site are separate deployments. Publishing static assets alone cannot activate background monitoring. Changing the alert configuration does not require moving the chart, adding a custom domain or using a paid messaging gateway. No phone alert should depend on the hourly market-data workflow, whose scheduled execution remains unverified.

## Verification and next work

Unit and integration checks cover exact decimals, both crossing directions, first-sample baseline, one-shot and repeating rules, stale/source/gap handling, device ownership, duplicate registration, per-device event identifiers, atomic outbox commits, deletion, revision conflicts, daily budgets, streamed body limits and retry expiry. Encryption tests independently decrypt the actual payload and verify its VAPID signature. The local Workerd smoke test exercises the compiled Worker with real Durable Object storage and a mocked provider.

Browser checks cover four widths (320, 390, 768 and 1440 pixels), inactive drafts without permission prompts, permission and enrolment, normalised decimals, unsupported-token drafts, revision conflicts, test-request wording and failed/successful disconnection. The existing chart suite retains its all-eight-coin, Price USD, small-number and immediate-retry regression checks. GitHub Actions uses Node 26.13.1, and the market-data deployment workflow is restricted to main-branch pushes. The new verification workflow cannot deploy to Pages.

Outstanding launch work is the authorised free backend deployment, real-device delivery testing and validation of the three extra token feeds. For a wider public launch, assess public enrolment abuse protection and account-based recovery before increasing the device cap. The current cap and IP limit are a pilot safeguard, not a complete defence against deliberate registration abuse.

## Why this version uses Web Push

The original request named SMS and/or WhatsApp for UK and US users. This implementation follows the subsequently proposed phone-notification alternative. Twilio explicitly lists cryptocurrency price alerts among prohibited US A2P 10DLC campaign content in [error 30947](https://www.twilio.com/docs/api/errors/30947). An approved, free, dependable WhatsApp route has not been established for this use case. Neither channel is represented as working or silently substituted with a personal SIM or an unofficial gateway.

Web Push delivers through the browser/operating system and needs no Telegram account. It also allows the website to show the same event while open. It is a practical pilot route, with the setup and delivery limitations stated above.
