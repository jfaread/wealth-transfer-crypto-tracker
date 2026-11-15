# Browser price-refresh recovery

## Report and diagnosis

The reported XRP price view on 14 November 2026 at 23:55 UK time showed a verified observation from 23:53 alongside a failed subsequent price check. The browser restored the previous chart's green `Quotes updated` status before displaying the new request failure, making two different events appear contradictory.

The same-origin quote file was also older than the permitted 30-minute quote age. A check at 23:58 UTC found its XRP observation dated 21:41:15 UTC. The public-data workflow was active and its latest recorded run had succeeded, but no subsequent scheduled attempt was present. This was a delayed publication, not evidence of a disabled workflow or a browser-only HTTP cache issue.

A fresh XRP request succeeded in the production browser during diagnosis. The exact cause of the earlier iPhone transport failure could not be established from the screenshot. The repair therefore addresses bounded transient recovery and accurate retained-price status without weakening data validation.

## Behaviour to preserve

- Quotes remain CoinGecko aggregate USD observations with their original provider timestamps and exact asset mapping.
- A transient request can receive one bounded retry after the published quote fallback has been checked. Cancellation and provider cooldowns take precedence.
- A previously verified, still-fresh selected observation can fill a missing quote. Retaining it does not make it a newly checked observation.
- A new file-save time cannot replace a newer observation with an older one or make an expired quote current.
- Saved, partially retained and unsuccessful checks are identified distinctly from a completed fresh check, including after changing the display time zone or restoring browser storage.
- The last verified chart remains usable during a source interruption. Genuine history gaps remain gaps.

## Coordination

This browser repair uses the existing website and publishing workflow. It does not change the independent phone-alert backend, device registrations, thresholds or secrets. The newer phone-alert deployment checkpoint records support for all nine coins, including SHIB; earlier chart-only SHIB notes are superseded by that checkpoint.

The existing GitHub schedule is an attempt schedule, not an exact publication-time guarantee. The standard code publication also refreshes and validates the shared quote/history files before deployment.
