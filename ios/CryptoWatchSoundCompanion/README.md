# Native XRP sound companion (development preview)

This isolated source tree demonstrates iOS system notification sound playback using the existing original `xrp-alert.wav` from Crypto-Watch. It does not replace or modify the public website, live Cloudflare monitor, existing Web Push registrations or price rules.

**Not yet a working native background XRP alert.** The app schedules a 5-second local notification solely to test the custom sound with the screen locked. A secure native registration API, APNs credentials and a signed installation are required to deliver genuine price events.

All native notification sounds are subject to iOS notification permission, Silent Mode and Focus. Apple does not permit a Home Screen web app to play this WAV from a closed browser background push.

The corresponding GitHub Actions workflow compiles an unsigned simulator app without accessing Apple accounts or charging paid services.

To develop further, connect the separately prepared `Server/apns-gateway.mjs` transport only after implementing a secure consent-based native registration, device revocation and sound-enabled threshold delivery. Never commit APNs signing keys or overwrite the Web Push VAPID keys.

See Apple: https://developer.apple.com/documentation/usernotifications/unnotificationsound
