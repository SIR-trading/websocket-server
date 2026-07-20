# WebSocket Server - Technical Reference

## Overview

This server has two main functions:
1. **Real-time event broadcasting** - Watches SIR contract events via WebSocket and broadcasts to frontends via Socket.IO
2. **Leaderboard background worker** - Computes position PnL on an activity-gated cadence (10 min while the App is in use, 60 min idle) and writes to Redis

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  WEBSOCKET SERVER (Railway)                                 │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ Event Watchers  │    │ Leaderboard Worker              │ │
│  │ - viem WSS      │    │ - Activity-gated 10/60 min      │ │
│  │ - Socket.IO     │    │ - Subgraph → Multicall → Redis  │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/
├── server.ts                    # Main entry, Express + Socket.IO + worker startup
├── lib/
│   ├── redis.ts                 # Redis client singleton
│   └── config.ts                # Chain configuration (RPC, subgraph, contracts)
└── workers/
    └── leaderboard/
        ├── index.ts             # Worker scheduler with Redis locks
        ├── compute.ts           # PnL computation + Redis ZSET writes
        ├── prices.ts            # CoinGecko + DEX price fetching
        ├── subgraph.ts          # GraphQL queries for positions
        └── types.ts             # TypeScript interfaces
```

## Key Technical Details

### Event Watchers (server.ts)

- Creates one viem `PublicClient` per chain with WebSocket transport
- Auto-fallback: If `eth_subscribe` fails, switches to HTTP polling (30s interval)
- HTTP URL derived from WSS URL (`wss://` → `https://`)
- Events cached in-memory (last 50), new clients receive 10 most recent

### Leaderboard Worker

**Scheduling (activity-gated):**
- A 60s scheduler tick (`LEADERBOARD_SCHEDULER_TICK_MS`) starts a cycle when the elapsed time since `leaderboard:lastCycleAt` (Redis, stamped at cycle end) passes the cadence interval: `LEADERBOARD_ACTIVE_INTERVAL_MS` (10 min) if `app:lastActivity` exists in Redis (written by App API routes, EX 900), else `LEADERBOARD_IDLE_INTERVAL_MS` (60 min). Fails open to ACTIVE on Redis read errors. Boot always runs one immediate cycle.
- `leaderboard:cycleClaim` (NX, TTL = min(600s, active interval)) ensures one replica per due-slot; `prices:worker:lock` (NX, 600s) additionally guards the CoinGecko price phase
- Single-flight guard prevents overlapping runs within same process
- Redis distributed lock prevents multiple instances processing same chain

**Incremental Processing:**
- Cursor-based: processes `MAX_POSITIONS_PER_RUN` (default 500) positions per cycle
- Cursor persisted in Redis, continues where left off
- New positions (created since last full sweep) processed first each cycle

**Redis Data Structure:**
```
leaderboard:{chainId}:zset:pnl       # ZSET: score=pnlUsd, member=positionId
leaderboard:{chainId}:zset:return    # ZSET: score=pnlUsdPercentage
leaderboard:{chainId}:zset:holding   # ZSET: score=createdAt (lower=older)
leaderboard:{chainId}:zset:deposit   # ZSET: score=dollarTotal
leaderboard:{chainId}:zset:value     # ZSET: score=currentValueUsd
leaderboard:{chainId}:idx:pair:{collateral}:{debt}  # Filter index
leaderboard:{chainId}:idx:lev:{tier}                # Filter index
leaderboard:{chainId}:positions      # HASH: positionId → JSON metadata
leaderboard:{chainId}:cursor         # STRING: last processed position ID
leaderboard:{chainId}:timestamp      # STRING: last update time (ms)
leaderboard:{chainId}:lastSweep      # STRING: last full sweep time (seconds)
leaderboard:lastCycleAt              # STRING: last cycle end (ms), cadence gate
leaderboard:cycleClaim               # STRING: NX per-slot claim (one replica per cycle)
prices:worker:lock                   # STRING: NX lock around the CoinGecko price phase
app:lastActivity                     # STRING: written by App routes (EX 900); read-only here
```

**PnL Computation (compute.ts:75-120):**
1. Multicall `totalSupply()` for each position's APE token
2. Single `getReserves(vaultIds[])` call to Assistant contract
3. Calculate: `userShare = (balance * reserves) / totalSupply`
4. Apply leverage fee: `net = (userShare * 10000) / (10000 + 2^tier * baseFee)`
5. `pnlUsd = (net * price) - originalDeposit`

**Price Fetching (prices.ts):**
- Primary: CoinGecko API (batch all tokens in one `simple/token_price` call per chain)
- Native fallback: one combined `simple/price` call per cycle for all chains' `coingeckoNativeId`s (not per-chain), threaded into `fetchPrices` as a map
- Fallback: On-chain DEX pool prices (V3 pools with wrapped native)
- Uses separate HTTP clients for RPC calls (NOT the WebSocket connections)
- Each cycle logs `[Prices] Cycle CoinGecko calls: N (token_price=A, native=B)` - the production signal for API quota usage
- Key-type detection: set `COINGECKO_API_TYPE=pro|demo` to skip the `/ping` auto-detect; when unset, a confirmed detection is cached for the process lifetime and inconclusive results back off exponentially (5 min doubling, capped 1h)

### Chain Configuration (config.ts)

Vector env vars must align by index:
- `CHAIN_IDS[0]` ↔ `WSS_URLS[0]` ↔ `RPC_URLS[0]` ↔ `SUBGRAPH_URLS[0]`

Hardcoded defaults for:
- Assistant contract addresses (from build-data.json)
- Base fees (0.1 = 10%)
- DEX factory addresses and init code hashes
- CoinGecko platform IDs

### Health Endpoint

`GET /health` returns:
```json
{
  "status": "ok",
  "connections": 5,
  "uptime": 3600,
  "chains": [
    { "chainId": 1, "transport": "webSocket", "status": "watching" }
  ],
  "leaderboardWorker": {
    "enabled": true,
    "lastRun": 1706400000000,
    "lastDurationMs": 4500,
    "chainStatus": {
      "1": { "status": "success", "positionsProcessed": 150 }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CHAIN_IDS` | Yes | Comma-separated chain IDs |
| `WSS_URLS` | Yes | WebSocket RPC URLs (for event watching) |
| `SIR_CONTRACT_ADDRESSES` | Yes | SIR contract per chain |
| `FRONTEND_URLS` | Yes | CORS allowed origins |
| `LEADERBOARD_WORKER_ENABLED` | No | Set `true` to enable worker |
| `REDIS_URL` | Worker | Redis connection string |
| `RPC_URLS` | Worker | HTTP RPC URLs (for multicalls) |
| `SUBGRAPH_URLS` | Worker | Goldsky subgraph endpoints |
| `SUBGRAPH_API_KEY` | No | Bearer token for subgraph |
| `COINGECKO_API_KEY` | No | For price fetching |
| `COINGECKO_API_TYPE` | No | `pro`\|`demo`; skips ping auto-detection |
| `LEADERBOARD_ACTIVE_INTERVAL_MS` | No | Cycle cadence with app activity (default 600000) |
| `LEADERBOARD_IDLE_INTERVAL_MS` | No | Cycle cadence when idle (default 3600000) |
| `LEADERBOARD_SCHEDULER_TICK_MS` | No | Scheduler tick (default 60000) |
| `MAX_POSITIONS_PER_RUN` | No | Default: 500 |

## Integration with App

The Next.js App at `App/src/app/api/leaderboard/active/route.ts`:
- Reads from same Redis instance
- Supports query params: `sort`, `pair`, `leverage`
- Uses `ZRANGE` for unfiltered, `ZINTERSTORE` for filtered queries

## Common Issues

**Worker not running:**
- Check `LEADERBOARD_WORKER_ENABLED=true`
- Verify `REDIS_URL` is accessible
- Check `/health` endpoint for worker status

**Positions not appearing:**
- Worker processes incrementally; full sweep takes multiple cycles
- Check `leaderboard:{chainId}:cursor` in Redis for progress
- Positions need `dollarTotal >= $1` and `balance > 0`

**Price fetching failures:**
- CoinGecko rate limits without API key
- DEX fallback needs `v3Factory` configured for chain
- Check wrapped native price is available (needed for DEX conversion)
