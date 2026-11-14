# Indicative pool prices for KISHU, Wiki Cat and CREPE

These alert sources calculate an indicative USD price from a specific liquidity
pool's reserves and a fresh Kraken ETH/USD or BNB/USD quote. They are separate from
the historical chart's CoinGecko aggregate. They do not represent a new trade, an
executable quote, or proceeds after fees, token taxes and slippage.

## Verified identities

Unauthenticated, read-only PublicNode calls succeeded on 14 November 2026 at
approximately 00:56 UTC. Checks included chain ID, `token0`, `token1`, token and
wrapped-token decimals, positive reserves, the pool's factory, and the official
factory's `getPair` result. This records successful source checks from the
development environment; it does not establish continuous availability or access
from a deployed Cloudflare Worker.

| Coin | Network | Exact token contract | Selected pool | Pool ordering | Token decimals |
| --- | --- | --- | --- | --- | --- |
| KISHU | Ethereum, chain 1 | `0xa2b4c0af19cc16a6cfacce81f192b024d625817d` | `0xf82d8ec196fb0d56c6b82a8b1870f09502a49f88` | KISHU / WETH | 9 |
| Wiki Cat | BNB Chain, chain 56 | `0x6ec90334d89dbdc89e08a133271be3d104128edb` | `0x933477eba23726ca95a957cb85dbb1957267ef85` | WKC / WBNB | 18 |
| CREPE | BNB Chain, chain 56 | `0xeb2b7d5691878627eff20492ca7c9a71228d931d` | `0x7d90deedb9f15c1f8fdaccc3b6bc52dc208e9c9a` | WBNB / CREPE | 9 |

WETH is `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`; WBNB is
`0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c`. Both use 18 decimals.

The KISHU factory is Uniswap V2
`0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f`. The WKC and CREPE factory is
PancakeSwap V2 `0xca143ce32fe78f1f7019d7d551a6402fc5350c73`.

Validation used Ethereum block `0x192fb2c`, timestamp
`2026-11-14T00:56:11Z`, and BNB Chain block `0x7f44ece`, timestamp
`2026-11-14T00:56:17Z`. Factory lookups returned the selected pools above.

A single check of the actual adapter at 01:16 UTC obtained genuine fresh ETH/USD
and BNB/USD Kraken WebSocket snapshots. Both initial PublicNode requests then
reached the adapter's five-second timeout. It returned no derived quotes and
invalidated the three sources. No retries or synthetic conversions were used.
The earlier identity checks succeeded with a longer request bound.

After increasing the per-batch bound to eight seconds, one further actual adapter
check at 01:20 UTC succeeded for all three coins using new, genuine Kraken
observations. All six HTTP batches returned 200, with no errors, in 7.604 seconds
overall. Time to response headers was 6.330 / 0.231 / 0.127 seconds for Ethereum
and 7.417 / 0.099 / 0.082 seconds for BNB Chain. No retries were made.

The successful check used Ethereum block 26409892 at `01:20:11Z` and BNB Chain
block 133454679 at `01:20:22Z`, both on 14 November 2026. Its Kraken conversion
observations were from `01:20:15.023Z` (ETH) and `01:20:15.030Z` (BNB). All three
results were baseline snapshots; their expiry remained bounded by the original
native quote receipt times plus 30 seconds. This verifies the real adapter's
source integration from this environment, not deployed Worker egress, continuous
monitoring or notification delivery.

## Calculation and timestamps

The calculation is:

`(wrapped-native reserve / 10^18) / (token reserve / 10^tokenDecimals) × native USD price`

All price arithmetic uses integers. The result is truncated once to at most 24
decimal places and is emitted as an ordinary decimal string. Zero reserves,
out-of-range ABI values, underflow below the supported decimal precision and
overflow beyond the supported price range are rejected.

Each poll first reads a block header, reads all state at that explicit block,
then rechecks its hash and timestamp. A previous healthy observation's block is
also checked when appropriate. A changed current block invalidates that poll; a
detected reorganisation starts a fresh baseline.

Both source components must independently be fresh: block and native quote ages
are limited to 60 seconds, and the native quote's receipt age to 30 seconds. The
derived timestamp is the later component timestamp. Its `freshUntil` is the
earliest component expiry, including a 30-second receipt window for the new
observation. Inputs are checked again when the poll completes. A recent derived
timestamp cannot extend the lifetime of an older conversion quote.

Evidence retains the block number, hash and timestamp; conversion price, source
and timestamps; and the separate last reserve-change time. Reading unchanged
reserves at a new block confirms their state at that block. It does not invent a
trade or replace the last reserve-change time.

## Polling and availability

The shared monitor schedules approximately 15-second polls while needed. The
adapter itself creates no recurring timers and never retries internally. A full
poll uses at most **six HTTP batch requests**, three per network; this is not six
individual JSON-RPC method calls. With both previous headers checked, the current
validation uses 12 Ethereum methods and 18 BNB Chain methods per complete poll.
Each HTTP batch contains at most 20 methods, has an eight-second timeout including
body reads, and accepts at most 64 KiB. Redirects are rejected. A 429 response's
valid `Retry-After` is returned to the shared scheduler without shortening it.
Three sequential batches therefore have a maximum 24-second request budget per
network; the original component freshness deadlines still apply throughout.

The Worker is responsible for daily HTTP-request quotas, back-off, stopping idle
polls, invalidating failed sources and rebaselining after a conversion feed
reconnect or expiry. A first observation, recovery, extended gap or reorganisation
must not trigger an alert from an older crossing.

Snapshot polling can miss a threshold crossing that reverses between polls.
Latest blocks can be reorganised; hash checks reduce inconsistent observations
but do not make those blocks final. Public RPC availability, source rate limits,
chain inclusion, fresh conversion data and phone delivery all affect latency.
No instantaneous or uninterrupted delivery is guaranteed.

## Primary references

- [PublicNode Ethereum endpoint](https://ethereum.publicnode.com/)
- [PublicNode BNB Chain endpoint](https://bsc.publicnode.com/)
- [PublicNode terms](https://www.publicnode.com/terms): automated production access
  and displaying returned blockchain data are permitted; rate limits can change
  and the service is provided as available.
- [Uniswap V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments)
- [PancakeSwap V2 deployments](https://developer.pancakeswap.finance/contracts/v2/addresses)
- [Ethereum JSON-RPC and block-specific calls](https://ethereum.org/developers/docs/apis/json-rpc/)
- [Geth subscriptions and reorganisation behaviour](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub)

Local automated tests use closed fixtures only. They make no provider requests,
send no notifications, and do not deploy or activate the alert service.
