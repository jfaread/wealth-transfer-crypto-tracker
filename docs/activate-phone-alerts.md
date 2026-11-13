# Connect the phone alert service

The website stays at **<https://jfaread.github.io/wealth-transfer-crypto-tracker/>**. Cloudflare hosts only the background price monitor and notification service. The checked-in configuration is inactive until this connection and the launch checks are complete.

## One account connection by the owner

Open [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages), sign in and select an account on **Workers Free**. Confirm the plan in the dashboard before continuing. This project uses the free allowances and pauses when its limits are reached; it does not purchase a plan or add billing.

Choose **Create application → GitHub**, authorise access to **only `jfaread/wealth-transfer-crypto-tracker`**, and select that existing repository. Use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `crypto-watch-alerts` |
| Production branch | `main` |
| Root directory | Repository root, `/` |
| Build command | Leave blank |
| Deploy command | `npm run deploy:alerts` |
| Build variable `NODE_VERSION` | `26.13.1` |
| Build variable `CRYPTO_ALERTS_FREE_PLAN_CONFIRMED` | `true`, only after confirming Workers Free |
| Non-production branch / preview builds | Disabled |

Choose **Save and Deploy**. Cloudflare's documented [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/) connects the existing repository. Its [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) supports this custom deploy command and supplies the authorised deployment credential. The script inherits that environment; no Cloudflare API token needs to be pasted into chat, written into the repository or sent to another service.

The free-plan variable records the owner's confirmation. It is not an API check of the account's billing plan. If the account is on a paid plan, do not set it to `true` for this deployment.

## What the first deployment does

With the current `ALERTS_ENABLED: "false"` configuration, `npm run deploy:alerts` deploys the dedicated Worker inactive. It then checks the names of its three push secrets. If all are absent, it creates one key pair in memory, submits it directly to the same Worker and verifies the secret names. Private key values are not printed or saved in the repository.

If all three secrets already exist, the script preserves them. A partial setup, failed metadata request or failed upload stops the process instead of replacing keys. Replacing a live key pair would disconnect subscribed devices. An active deployment requires all three secrets to exist before any upload of the Worker.

The first deployment leaves monitoring inactive. Its completion message contains the public backend address, with this shape:

```text
https://crypto-watch-alerts.<your-subdomain>.workers.dev
```

Return that **public address** to the maintainer. Passwords, private keys and API tokens are not needed in chat. Account-specific deployment and secret creation remain unverified until this build succeeds.

## Complete activation

The maintainer can then inspect the public `/v1/config` response and complete these repository-controlled steps through the existing GitHub connection:

1. Verify the dedicated address, expected website origin, free-plan choice and inactive state. Inactive configuration intentionally returns no public push key.
2. Change `ALERTS_ENABLED` in `alerts/wrangler.jsonc` to `"true"`. The connected production build deploys that reviewed change while preserving existing secrets.
3. Verify the public push key, fresh source timestamps and the five supported feed subscriptions from the running service. Keep unsupported or stale sources unavailable.
4. Put the verified backend origin in `alerts-config.json`, rebuild the website's content security policy and publish through the existing GitHub Pages workflow.
5. Test on an opted-in phone with the website open, with it closed and with the phone locked. Provider acceptance alone is not proof of display on the phone.

The first adapter covers **BTC, ETH, BNB, XRP and SOL**. **KISHU, Wiki Cat and CREPE remain inactive drafts** until their continuous price feeds have been independently validated. All eight remain available in the tracker itself.

## Keep routine builds and pauses predictable

After the first build, set **Settings → Build → Build watch paths** to include only:

```text
alerts/*, scripts/deploy-alerts.mjs, package.json, package-lock.json
```

Leave the exclusion list empty. These [watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/) avoid restarting the monitor for chart-data, news or website-only changes. They are a build optimisation, not a notification schedule.

The versioned `ALERTS_ENABLED` setting is the normal activation and pause control. To pause monitoring, commit `"false"` and wait for the connected deployment to succeed. A dashboard-only variable edit can be overwritten by a subsequent deployment. For an emergency dashboard pause, disable automatic builds first and make the repository agree before reconnecting them. The deployment helper never adds an independent `true` override.

## Phone setup after activation

On an iPhone with iOS 16.4 or later, open the tracker in Safari, use **Share → Add to Home Screen**, open the new Crypto-Watch icon and select **Price alerts**. Allow notifications when requested, finish connecting the device and save a supported coin threshold. Apple documents the Home Screen requirement and permission gesture in its [Web Push guide](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

On a supported Android browser, open the tracker, select **Price alerts**, allow notifications and finish connecting the device. Each phone is enrolled separately. Use **Request test alert** and check that it arrives before relying on an alert rule.

Monitoring runs on the server, so the website does not need to remain open. Internet access, notification permissions, phone settings, provider availability and the free service limits still affect delivery. There is no guarantee of instantaneous delivery.
