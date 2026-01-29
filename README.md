# SIR WebSocket Server

Real-time event server for the SIR protocol. Broadcasts auction events to frontends and computes leaderboard rankings in the background.

## What It Does

1. **Real-time Events** - Watches SIR contracts for auctions, bids, and dividends, then broadcasts to connected frontends via Socket.IO
2. **Leaderboard Worker** - Computes position PnL every 10 minutes and stores rankings in Redis

## Quick Start

### 1. Install

```bash
# From monorepo root (SIR/)
pnpm install
```

### 2. Configure

```bash
cd websocket-server
cp .env.example .env
```

Edit `.env` with your values. At minimum you need:

```env
CHAIN_IDS=1,999,6343
WSS_URLS=wss://eth-mainnet.g.alchemy.com/v2/KEY,...
SIR_CONTRACT_ADDRESSES=0x4Da4...,0xA06D...,0x2149...
FRONTEND_URLS=https://app.sir.trading,http://localhost:3000
```

For the leaderboard worker, also add:

```env
LEADERBOARD_WORKER_ENABLED=true
REDIS_URL=redis://...
RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/KEY,...
SUBGRAPH_URLS=https://api.goldsky.com/...,...
```

### 3. Run

```bash
# Development (hot reload)
pnpm dev

# Production
pnpm build && pnpm start
```

### 4. Verify

```bash
curl http://localhost:8080/health
```

## Events

The server broadcasts these Socket.IO events:

| Event | Description |
|-------|-------------|
| `auctionStarted` | New auction began |
| `bidReceived` | Someone placed a bid |
| `auctionSettled` | Auction ended, tokens sent to winner |
| `dividendsPaid` | Dividends distributed to stakers |

All events include `chainId` so frontends can filter by chain.

## Deploy on Railway

1. **Create service** - New → GitHub Repo → select `SIR` monorepo

2. **Build settings:**
   - Root Directory: `websocket-server`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`

3. **Environment variables** - Add all variables from `.env.example`

4. **Generate domain** - Settings → Networking → Generate Domain

5. **Health check** - Point to `/health` endpoint

## Connect from App

In the Next.js App's `.env`:

```env
NEXT_PUBLIC_WEBSOCKET_URL=https://your-railway-domain.up.railway.app
```

The App's `useRealtimeAuctions` hook connects automatically. Falls back to polling if not set.

## Leaderboard Worker

When enabled, the worker:
- Runs every 10 minutes
- Fetches positions from subgraph
- Computes PnL using on-chain data
- Writes rankings to Redis ZSETs

The App's `/api/leaderboard/active` endpoint reads directly from Redis for instant responses.

Check worker status in `/health` response under `leaderboardWorker`.

## Environment Reference

| Variable | Required | Description |
|----------|:--------:|-------------|
| `CHAIN_IDS` | ✓ | Chain IDs (e.g., `1,999,6343`) |
| `WSS_URLS` | ✓ | WebSocket RPCs for events |
| `SIR_CONTRACT_ADDRESSES` | ✓ | SIR contract per chain |
| `FRONTEND_URLS` | ✓ | CORS origins |
| `PORT` | | Default: `8080` |
| `LEADERBOARD_WORKER_ENABLED` | | Set `true` to enable |
| `REDIS_URL` | Worker | Redis connection |
| `RPC_URLS` | Worker | HTTP RPCs for multicalls |
| `SUBGRAPH_URLS` | Worker | Goldsky endpoints |
| `SUBGRAPH_API_KEY` | | Subgraph auth |
| `COINGECKO_API_KEY` | | Price fetching |
| `MAX_POSITIONS_PER_RUN` | | Default: `500` |

Vector variables (`CHAIN_IDS`, `WSS_URLS`, `RPC_URLS`, etc.) must have matching counts.
