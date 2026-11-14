# Price-feed hardening - 14 November 2026

## Verified release

The existing public site remains https://jfaread.github.io/wealth-transfer-crypto-tracker/. No paid service, subscription upgrade, alternative venue, or alert-backend change was introduced.

- Reviewed starting revision: `02b199eaa469861842c40bcb680ffa10f3fde208`.
- Tested application release: `03b604b3d4357d34bff3dd84f78e0551d6a4fc4f`.
- Normal publishing-workflow hardening: `dac744c9cd303a94f0d06fce170efabec4f542fe`.
- Subsequent verified data publication: `25e483a622df87f38dd5ee543e60329d33c222bc`.
- Successful full hardening verification and Pages deployment: https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43627642311
- Successful normal workflow with the new publication safeguards: https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43628187367
- Build runtime remains Node `26.13.1`.

The first full verification correctly blocked publication because two older synthetic fixtures omitted provider/token identities now required by validation. The fixtures were made explicit without removing their assertions. The next complete verification passed. The temporary hardening workflow and staging packet were removed after the successful release.

## Additional safeguards

### Shared updater timing and bounded failure recovery

`scripts/market-client.mjs` shares validated public provider timing metadata through `data/provider-state.json` between quote and history updater commands and subsequent committed runs. Request slots are saved before network traffic. Corrupt timing state or failed state persistence stops outbound requests rather than bypassing throttling.

Requests within one client are serialised, paced and restricted to the fixed HTTPS provider. A complete attempt, including a stalled body, has a 15-second deadline. Tests cover requests that ignore cancellation, streamed-body cancellation, parallel callers and failed reservation writes. Responses exceeding the two-million-byte limit, redirects, unexpected content types and malformed JSON are rejected.

Only transient failures receive a bounded retry. Repeated transient failures open a persisted cooldown circuit. Valid `Retry-After` delays are respected rather than shortened. The workflow also attempts to preserve verified timing metadata after a failed publication gate, without committing price changes or overwriting concurrent repository work. Abrupt runner termination or a conflicting repository change can still prevent that final persistence step.

### Per-coin quote recovery and rollback protection

The browser retains valid primary quotes when another selected coin is missing and fills the missing observations from the validated same-origin cache. Older fallback observations cannot replace newer primary ones. A complete primary response avoids an unnecessary fallback request. If a selected coin remains unavailable or stale, the existing verified chart is retained; incomplete responses are not presented as a complete current selection.

Every prepared chart range is validated before any of that response enters the browser cache. A newer file-save time alone cannot roll back an individual selected coin's latest observation. These checks also cover asynchronous initial-load responses.

### Publication safety on every run

Build validation requires the exact nine asset identities, valid USD observations, ordered timestamps, consistent returns and gap counts, and complete series across the six supported prepared periods: 1D, 5D, 1M, 6M, YTD and 1Y. Long-period charts use their own daily-history observation clocks, not the short-history update time. The embedded first chart must match the shared prepared chart.

The normal workflow now builds, validates and runs the targeted data-safety tests before committing market data on scheduled, manual and push runs. Code-release runs additionally compile the Worker in dry-run mode and run the full automated and browser suites. It no longer rebases newer source into an already tested working tree. Explicit branch-head checks and non-force pushes reject obsolete publication attempts.

## Production evidence

At **18:44:11 UTC**, the deployed `data/feed-health.json` reported nine assets, status `healthy`, available timestamped quotes for all nine, no delayed one-day histories and zero one-day chart gaps. This is a point-in-time check; the JSON is a dated publication report, not a continuously recalculated uptime promise.

At **18:44:59 UTC**, a mobile-width production browser check confirmed all nine chart currencies, a chart snapshot ending at approximately **18:39 UK time**, no visible delayed-history warning, five Jon George update cards, the phone-alert controls, test-alert help and the exact existing alert-service origin in the site policy.

The complete release checks passed for chart refresh/recovery, tiny decimals, SHIB selection, mobile layouts, notifications with controlled delivery, and creator-update recovery. No real notification was sent by this maintenance task and no recipient's settings were reset.

## Limits and resumption notes

- The chart source remains CoinGecko aggregate USD. This release improves failure handling and integrity; it does not provide an independent substitute for an upstream outage.
- The existing fifteen-minute scheduled attempts remain `8,23,38,53 * * * *`. Precise execution is not guaranteed, and a sustained sequence of scheduled executions was not verified during this release.
- Genuine missing intervals remain gaps. No prices are interpolated or invented to conceal an outage.
- The independent phone-alert backend, stored device registrations and thresholds, VAPID secrets and Durable Object namespace were not modified.
- No reinstall or clearing of browser data is required. Reload the page to receive the updated browser code.
