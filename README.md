# SIR WebSocket Server

Multi-chain real-time WebSocket server that watches SIR contract events (auctions, bids, dividends) across all configured chains from a single process and broadcasts them to connected frontends via Socket.IO.

## Setup

### 1. Install dependencies

From the **monorepo root** (`SIR/`):

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|----------|-------------|
| `CHAIN_IDS` | Comma-separated chain IDs (e.g. `1,999,6343`) |
| `WSS_URLS` | WebSocket RPC URLs, one per chain (e.g. Alchemy WSS endpoints) |
| `SIR_CONTRACT_ADDRESSES` | SIR token/staking/auction contract per chain (the single contract that handles the SIR token, staking, dividends, and auctions — found in `App/public/build-data.json` → `contractAddresses.sir`) |
| `FRONTEND_URLS` | Allowed CORS origins (e.g. `https://sir.trading,http://localhost:3000`) |
| `PORT` | Server port (default: `8080`) |

All vector variables (`CHAIN_IDS`, `WSS_URLS`, `SIR_CONTRACT_ADDRESSES`) must have the same number of comma-separated values.

### 3. Run locally

**Development** (with hot reload):

```bash
# From monorepo root
pnpm ws:dev

# Or from this directory
pnpm dev
```

**Production build:**

```bash
pnpm ws:build
pnpm ws:start
```

**Run both WS server + App together:**

```bash
# From monorepo root — starts WS on :8080 and App on :3000
pnpm dev
```

### 4. Verify

```bash
curl http://localhost:8080/health
```

Returns per-chain watcher status:

```json
{
  "status": "ok",
  "connections": 0,
  "uptime": 12.34,
  "chains": [
    { "chainId": 1, "transport": "webSocket", "status": "watching" },
    { "chainId": 999, "transport": "webSocket", "status": "watching" },
    { "chainId": 6343, "transport": "http", "status": "watching" }
  ]
}
```

## Architecture

- One **viem client per chain**, each watching the SIR contract for events
- **Auto-fallback**: every chain starts with a WebSocket (`eth_subscribe`). If the RPC doesn't support subscriptions (e.g. MegaETH / chain 6343), the server automatically tears down the WSS watcher and re-creates it with HTTP polling (`eth_getLogs`, 30 s interval). The HTTP URL is derived from the WSS URL (`wss://` → `https://`) — no extra env vars needed.
- Single **Socket.IO server** broadcasts events to all connected frontends
- Every event payload includes `chainId` so the frontend can scope invalidation
- In-memory cache of the last 50 events — new clients receive the 10 most recent on connect
- `/health` endpoint exposes `transport` (`"webSocket"` or `"http"`) per chain

## Events

| Socket.IO Event | Contract Event | Payload |
|-----------------|---------------|---------|
| `auctionStarted` | `AuctionStarted` | `chainId`, `token`, `amount`, `txHash`, `blockNumber` |
| `bidReceived` | `BidReceived` | `chainId`, `token`, `bidder`, `bid`, `txHash`, `blockNumber` |
| `auctionSettled` | `AuctionedTokensSentToWinner` | `chainId`, `token`, `winner`, `amount`, `txHash`, `blockNumber` |
| `dividendsPaid` | `DividendsPaid` | `chainId`, `amountETH`, `amountStakedSIR`, `txHash`, `blockNumber` |

## Frontend Integration

The App's `useRealtimeAuctions` hook connects automatically when `NEXT_PUBLIC_WEBSOCKET_URL` is set in the App's `.env`:

```
NEXT_PUBLIC_WEBSOCKET_URL=http://localhost:8080
```

When not set, the hook falls back to 5-minute polling.
