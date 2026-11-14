# Phone alert deployment checkpoint

Checked on **14 November 2026**. This is an operational checkpoint, not a claim that phone alerts are live.

## Completed and verified

- The existing Crypto-Watch Cloudflare Connection authenticates successfully. Reading the selected owner's Workers list succeeds; the earlier Workers permissions error is no longer the immediate blocker.
- Before the change below, the selected account returned no Workers and no `workers.dev` subdomain (error 10007).
- Created the missing account subdomain through the official `PUT /accounts/{account_id}/workers/subdomain` endpoint, then read it back successfully through the corresponding GET endpoint: **`jfaread-crypto-watch.workers.dev`**.
- This operation created only the account service hostname. It did not create a Worker, select a paid plan, modify a subscription or activate notifications.
- The intended Worker name remains `crypto-watch-alerts`. Its expected endpoint after a successful deployment is `https://crypto-watch-alerts.jfaread-crypto-watch.workers.dev`. That endpoint is **not yet a deployed service**.
- The existing shared website remains `https://jfaread.github.io/wealth-transfer-crypto-tracker/`.

## Repository and test evidence

The inspected main revision was `5d0df2080bca631f5714918d92e8c49590274ef7`.

[Verification run 43541310014](https://github.com/jfaread/wealth-transfer-crypto-tracker/actions/runs/43541310014), for alert-code revision `e90ffaa8f31588760162cfd3a12008ef34373f2d`, completed successfully on 14 November 2026. A GitHub comparison from that tested revision to the inspected main revision returned changes only to the eight `data/<coin>.json` files, `data/manifest.json` and `data/quotes.json`. The alert code and its tests have not changed between those two revisions. No new test run was executed during this checkpoint.

The inspected configuration remains inactive:

- `alerts-config.json`: `apiBase` is `null`.
- `alerts/wrangler.jsonc`: `ALERTS_ENABLED` is `"false"`.
- SQLite Durable Object migration, existing site origin, preview-URL prohibition and free-pilot limits are unchanged.

## Remaining prerequisite before deployment

**Workers Free has not been verified for this account.** The subscription endpoint was previously confirmed unavailable to this OAuth connection. An additional read of the account entitlements endpoint succeeded but returned an empty list, both before and after subdomain creation. That empty response is not being treated as proof of a free subscription.

Obtain an actual dashboard indication of **Workers Free**, or the owner's explicit confirmation after checking the current Workers plan. Do not substitute the account's generic `standard` usage setting, a website's Free plan, the absence of existing Workers, or an empty entitlement list for that confirmation. Do not create a paid subscription or ask the owner to paste credentials into chat.

Browser access in this Chat session still failed before listing tabs because the originating browser context was unavailable. The direct Cloudflare connection is working and can be used for the subsequent deployment once the plan prerequisite is satisfied. The owner no longer needs to create the subdomain or repeat the plugin installation.

## Resume from here

1. Confirm Workers Free, re-read the current repository and account state, and retain the verified subdomain rather than recreating it.
2. Deploy the reviewed `crypto-watch-alerts` implementation initially inactive, using the existing SQLite migration. Inspect and preserve any existing complete VAPID secret set; stop on partial or failed secret checks.
3. Complete the existing activation procedure in [activate-phone-alerts.md](activate-phone-alerts.md), verifying each running price source before admitting its active alert rules.
4. Only then connect the verified endpoint in the website configuration and rebuild its content security policy through the existing Pages workflow.
5. Complete an opted-in real-phone test with the website open, closed and the screen locked. Automated tests and provider acceptance do not establish handset display or instantaneous receipt.

No phone subscription was registered and no real notification was sent during this checkpoint.
