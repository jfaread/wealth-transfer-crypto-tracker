# Private Cloudflare account connection

This package connects the maintainer to Cloudflare's existing official hosted API MCP server through OAuth. It does not host another server, change the tracker URL or contain credentials. The private plugin is separate from the news browser and other projects.

Official endpoint: `https://mcp.cloudflare.com/mcp`, using Streamable HTTP and the host's OAuth discovery flow. See [Cloudflare's managed MCP server documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) and the [official server repository](https://github.com/cloudflare/mcp).

The package intentionally contains no copied API tokens, fixed OAuth client IDs, guessed OAuth scopes or account-specific URLs. The owner signs in and selects permissions on Cloudflare's authorisation screen. The host manages the authorised connection. Installation alone does not prove authentication or deployment access.

After connecting, discover the actual tools and schemas, identify the connected owner and intended account, and inspect the existing `crypto-watch-alerts` Worker before changing anything. Limit operations to this tracker. Cloudflare's full API tools can access other resources permitted by the OAuth grant; the package's project guidance is not a substitute for those account permissions.

Verify the account's Workers Free plan before deploying. The Workers account-settings API does not establish that plan. If an authorised subscription read is unavailable, obtain the owner's Free-plan confirmation; do not infer Free from an empty or permission-limited result. Do not change plans, add billing services or alter other projects.

Use the reviewed Worker source and SQLite migration in `alerts/wrangler.jsonc`. Retain a complete existing VAPID key set and stop on partial or failed secret checks. The first deployment stays inactive. Verify its public configuration and source readiness before connecting `alerts-config.json` and testing delivery with an opted-in phone.

Only package the `crypto-watch-cloudflare/` directory. The icon is the existing Crypto-Watch icon. Keep generated archives outside the package and do not include dependency directories, local configuration or secrets.
