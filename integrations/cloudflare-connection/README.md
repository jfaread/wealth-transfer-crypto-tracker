# Private Cloudflare account connection

This private package uses the owner's registered **Crypto-Watch Cloudflare Connection** App to access Cloudflare's existing official hosted API MCP server through OAuth. It remains separate from the news browser and other projects. The tracker stays at its existing GitHub Pages address.

- Original plugin: [Crypto-Watch Cloudflare](https://chatgpt.com/plugins/plugins_6af77695a8748191915948ca3120885a).
- Registered web connection: [Crypto-Watch Cloudflare Connection](https://chatgpt.com/plugins/plugin_asdk_app_6af7aa86d9f88191aabe2560c9f126e6).

Version 0.1.1 references the verified App `asdk_app_6af7aa86d9f88191aabe2560c9f126e6` through `.app.json`. Both manifests point to that App. The original portable `mcp.json` and compatibility `.mcp.json` are removed, so the package no longer declares a second MCP connection that requires the desktop host. A saved package update is not proof that every client has refreshed its compatibility label.

## Connection status and recovery

On 14 November 2026, the registered web App's tools were visible in ChatGPT. Its read-only identity check returned `UNAUTHORIZED` and required reauthentication. No Cloudflare identity, account, Workers plan, Worker deployment or real phone delivery was verified by that check. The website configuration remains inactive until those checks pass.

Reconnect the existing registered web connection through its **Connect/Reconnect** control and complete Cloudflare's authorisation. Then make one read-only identity check. An invalid grant needs successful reauthorisation; changing unrelated plugin permission settings, adding guessed scopes or creating another duplicate connection does not establish it.

The App owns its OAuth settings. The observed setup uses CIMD, default scopes `user:read` and `account:read`, empty Base scopes and no OIDC configuration. Keep ChatGPT's generated callback and client-metadata URLs and Cloudflare's discovered endpoints. Its minimal initial permission set establishes identity and account access; the server requests additional permissions when needed. Do not treat a minimal grant as deployment permission.

Official endpoint: `https://mcp.cloudflare.com/mcp`, using Streamable HTTP and the host's OAuth discovery flow. See [Cloudflare's managed MCP server documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) and the [official server repository](https://github.com/cloudflare/mcp).

The package contains the verified App identifier and no copied API tokens, fixed OAuth client credentials or account credentials. The owner signs in and selects permissions on Cloudflare's authorisation screen. The host manages the authorised connection. Installation alone does not prove authentication or deployment access.

After connecting, discover the actual tools and schemas, identify the connected owner and intended account, and inspect the existing `crypto-watch-alerts` Worker before changing anything. Limit operations to this tracker. Cloudflare's full API tools can access other resources permitted by the OAuth grant; the package's project guidance is not a substitute for those account permissions.

Verify the account's Workers Free plan before deploying. The Workers account-settings API does not establish that plan, and the MCP server documents that some billing APIs are unavailable to OAuth. Use the dashboard's actual plan or the owner's Free-plan confirmation when an authorised subscription read is unavailable; do not infer Free from an empty or permission-limited result. Do not change plans, add billing services or alter other projects.

Use the reviewed Worker source and SQLite migration in `alerts/wrangler.jsonc`. Retain a complete existing VAPID key set and stop on partial or failed secret checks. The first deployment stays inactive. Verify its public configuration and source readiness before connecting `alerts-config.json` and testing delivery with an opted-in phone.

## Package updates

Only package the `crypto-watch-cloudflare/` directory. The icon and original prompt are preserved. Keep generated archives outside the package and do not include dependency directories, local configuration or secrets. Preserve the original plugin ID and private audience when updating.

The 0.1.0-to-0.1.1 archive update must explicitly delete both `mcp.json` and `.mcp.json`; omitted files are otherwise retained by Plugin Creator. Preserve the compatibility manifest, remove its old `mcpServers` reference, and set its `apps` reference to `./.app.json`. Read back the complete saved inventory and verify the App ID and deleted files before reporting the package update as saved. Authentication and phone delivery require separate checks.
