import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createPublicClient,
  webSocket,
  http,
  type Address,
  type PublicClient,
  type Transport,
  parseAbiItem,
} from "viem";
import {
  startLeaderboardWorker,
  getWorkerStatus,
} from "./workers/leaderboard/index.js";
import { closeRedisClient } from "./lib/redis.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? 8080;
const FRONTEND_URLS =
  process.env.FRONTEND_URLS?.split(",") ?? ["http://localhost:3000"];

const CHAIN_IDS = process.env.CHAIN_IDS?.split(",").map(Number) ?? [];
const WSS_URLS = process.env.WSS_URLS?.split(",") ?? [];
const SIR_CONTRACT_ADDRESSES = (process.env.SIR_CONTRACT_ADDRESSES?.split(
  ","
) ?? []) as Address[];

if (
  CHAIN_IDS.length === 0 ||
  CHAIN_IDS.length !== WSS_URLS.length ||
  CHAIN_IDS.length !== SIR_CONTRACT_ADDRESSES.length
) {
  console.error(
    "CHAIN_IDS, WSS_URLS, and SIR_CONTRACT_ADDRESSES must all be provided with the same number of comma-separated values"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contract event ABIs
// ---------------------------------------------------------------------------

const EVENTS = {
  AuctionStarted: parseAbiItem(
    "event AuctionStarted(address indexed token, uint256 amount)"
  ),
  BidReceived: parseAbiItem(
    "event BidReceived(address indexed token, address indexed bidder, uint96 bid)"
  ),
  AuctionedTokensSentToWinner: parseAbiItem(
    "event AuctionedTokensSentToWinner(address indexed token, address indexed winner, uint256 amount)"
  ),
  DividendsPaid: parseAbiItem(
    "event DividendsPaid(uint96 amountETH, uint80 amountStakedSIR)"
  ),
};

// ---------------------------------------------------------------------------
// Express + Socket.IO
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: FRONTEND_URLS }));
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URLS,
    methods: ["GET", "POST"],
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ---------------------------------------------------------------------------
// Shared event cache
// ---------------------------------------------------------------------------

interface CachedEvent {
  id: string;
  type: string;
  chainId: number;
  timestamp: number;
  data: Record<string, unknown>;
}

const recentEvents: CachedEvent[] = [];
const MAX_CACHED_EVENTS = 50;

function addEvent(event: CachedEvent) {
  if (recentEvents.some((e) => e.id === event.id)) return;

  recentEvents.unshift(event);
  if (recentEvents.length > MAX_CACHED_EVENTS) {
    recentEvents.pop();
  }

  io.emit(event.type, event.data);
  console.log(`[Chain ${event.chainId}] ${event.type}:`, event.data);
}

// ---------------------------------------------------------------------------
// Per-chain watcher
// ---------------------------------------------------------------------------

interface ChainWatcher {
  chainId: number;
  transportType: "webSocket" | "http";
  status: "connecting" | "watching" | "error";
  error?: string;
  unwatchFns: (() => void)[];
  wsRetryTimer?: ReturnType<typeof setTimeout>;
}

const watchers: ChainWatcher[] = [];

// How often to retry WebSocket when in HTTP fallback mode (1 hour)
const WS_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** Convert a WSS URL to an HTTPS URL for HTTP polling fallback. */
function deriveHttpUrl(wssUrl: string): string {
  return wssUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

/** Returns true if the error looks like an eth_subscribe / method-not-found rejection. */
function isSubscribeError(error: unknown): boolean {
  const msg = getErrorMessage(error);
  const lower = msg.toLowerCase();
  return lower.includes("eth_subscribe") || lower.includes("method not found");
}

/** Returns true if the error indicates the WebSocket connection was closed. */
function isSocketClosedError(error: unknown): boolean {
  const msg = getErrorMessage(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("socket") &&
    (lower.includes("closed") || lower.includes("disconnected"))
  );
}

/** Extract error message from various error types. */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

/**
 * Attach the 4 watchContractEvent listeners to a viem client.
 * Returns the array of unwatch functions.
 *
 * If `onFallbackNeeded` is provided, it will be called once when:
 * - eth_subscribe is not supported, OR
 * - the WebSocket connection is closed
 */
function setupWatchers(
  client: PublicClient<Transport>,
  chainId: number,
  contractAddress: Address,
  watcher: ChainWatcher,
  onFallbackNeeded?: () => void
): (() => void)[] {
  let fallbackTriggered = false;

  function handleError(eventName: string) {
    return (error: Error) => {
      // Check if we need to fall back to HTTP
      if (isSubscribeError(error) || isSocketClosedError(error)) {
        if (onFallbackNeeded && !fallbackTriggered) {
          fallbackTriggered = true;
          const reason = isSocketClosedError(error) ? "socket closed" : "eth_subscribe not supported";
          console.warn(`[Chain ${chainId}] ${eventName}: ${reason}, switching to HTTP polling`);
          onFallbackNeeded();
        }
        return;
      }
      console.error(`[Chain ${chainId}] ${eventName} watch error:`, error);
      watcher.status = "error";
      watcher.error = String(error);
    };
  }

  const fns: (() => void)[] = [];

  // Watch AuctionStarted
  fns.push(
    client.watchContractEvent({
      address: contractAddress,
      abi: [EVENTS.AuctionStarted],
      eventName: "AuctionStarted",
      onLogs: (logs) => {
        logs.forEach((log) => {
          addEvent({
            id: `${chainId}-${log.transactionHash}-${log.logIndex}`,
            type: "auctionStarted",
            chainId,
            timestamp: Date.now(),
            data: {
              chainId,
              token: log.args.token,
              amount: log.args.amount?.toString(),
              txHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
            },
          });
        });
      },
      onError: handleError("AuctionStarted"),
    })
  );

  // Watch BidReceived
  fns.push(
    client.watchContractEvent({
      address: contractAddress,
      abi: [EVENTS.BidReceived],
      eventName: "BidReceived",
      onLogs: (logs) => {
        logs.forEach((log) => {
          addEvent({
            id: `${chainId}-${log.transactionHash}-${log.logIndex}`,
            type: "bidReceived",
            chainId,
            timestamp: Date.now(),
            data: {
              chainId,
              token: log.args.token,
              bidder: log.args.bidder,
              bid: log.args.bid?.toString(),
              txHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
            },
          });
        });
      },
      onError: handleError("BidReceived"),
    })
  );

  // Watch AuctionedTokensSentToWinner
  fns.push(
    client.watchContractEvent({
      address: contractAddress,
      abi: [EVENTS.AuctionedTokensSentToWinner],
      eventName: "AuctionedTokensSentToWinner",
      onLogs: (logs) => {
        logs.forEach((log) => {
          addEvent({
            id: `${chainId}-${log.transactionHash}-${log.logIndex}`,
            type: "auctionSettled",
            chainId,
            timestamp: Date.now(),
            data: {
              chainId,
              token: log.args.token,
              winner: log.args.winner,
              amount: log.args.amount?.toString(),
              txHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
            },
          });
        });
      },
      onError: handleError("AuctionedTokensSentToWinner"),
    })
  );

  // Watch DividendsPaid
  fns.push(
    client.watchContractEvent({
      address: contractAddress,
      abi: [EVENTS.DividendsPaid],
      eventName: "DividendsPaid",
      onLogs: (logs) => {
        logs.forEach((log) => {
          addEvent({
            id: `${chainId}-${log.transactionHash}-${log.logIndex}`,
            type: "dividendsPaid",
            chainId,
            timestamp: Date.now(),
            data: {
              chainId,
              amountETH: log.args.amountETH?.toString(),
              amountStakedSIR: log.args.amountStakedSIR?.toString(),
              txHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
            },
          });
        });
      },
      onError: handleError("DividendsPaid"),
    })
  );

  return fns;
}

/**
 * Switch a watcher to HTTP polling mode.
 */
function switchToHttpPolling(
  watcher: ChainWatcher,
  wssUrl: string,
  contractAddress: Address
): void {
  const { chainId } = watcher;
  const httpUrl = deriveHttpUrl(wssUrl);

  try {
    const httpClient = createPublicClient({
      transport: http(httpUrl, { batch: true }),
      pollingInterval: 30_000,
    });

    watcher.unwatchFns = setupWatchers(
      httpClient,
      chainId,
      contractAddress,
      watcher
      // no onFallbackNeeded — HTTP polling uses eth_getLogs, not eth_subscribe
    );

    watcher.transportType = "http";
    watcher.status = "watching";
    watcher.error = undefined;
    console.log(`[Chain ${chainId}] Watching contract ${contractAddress} (http poll)`);

    // Schedule periodic WebSocket retry
    scheduleWsRetry(watcher, wssUrl, contractAddress);
  } catch (httpError) {
    watcher.status = "error";
    watcher.error = String(httpError);
    console.error(`[Chain ${chainId}] HTTP fallback failed:`, httpError);
  }
}

/**
 * Try to reconnect via WebSocket. If successful, cancel HTTP polling.
 * If WebSocket fails again, stay on HTTP and schedule another retry.
 */
function tryWebSocketReconnect(
  watcher: ChainWatcher,
  wssUrl: string,
  contractAddress: Address
): void {
  const { chainId } = watcher;
  console.log(`[Chain ${chainId}] Attempting WebSocket reconnect...`);

  try {
    const wsClient = createPublicClient({
      transport: webSocket(wssUrl, {
        reconnect: { attempts: 3, delay: 1000 },
        keepAlive: { interval: 30_000 },
      }),
    });

    // Set up a test — if we get a fallback callback quickly, WS still doesn't work
    let wsFailed = false;
    const testUnwatchFns = setupWatchers(
      wsClient,
      chainId,
      contractAddress,
      watcher,
      () => {
        wsFailed = true;
      }
    );

    // Give it a moment to fail if it's going to
    setTimeout(() => {
      if (wsFailed) {
        // Clean up test watchers
        testUnwatchFns.forEach((fn) => fn());
        console.log(`[Chain ${chainId}] WebSocket still unavailable, staying on HTTP`);
        // Schedule another retry
        scheduleWsRetry(watcher, wssUrl, contractAddress);
      } else {
        // WebSocket is working! Tear down HTTP and use WS
        console.log(`[Chain ${chainId}] WebSocket reconnected successfully`);
        watcher.unwatchFns.forEach((fn) => fn());
        watcher.unwatchFns = testUnwatchFns;
        watcher.transportType = "webSocket";
        watcher.status = "watching";
        watcher.error = undefined;

        // Re-setup with proper fallback handler
        watcher.unwatchFns.forEach((fn) => fn());
        watcher.unwatchFns = setupWatchers(
          wsClient,
          chainId,
          contractAddress,
          watcher,
          () => {
            watcher.unwatchFns.forEach((fn) => fn());
            watcher.unwatchFns = [];
            switchToHttpPolling(watcher, wssUrl, contractAddress);
          }
        );
      }
    }, 5000);
  } catch (error) {
    console.log(`[Chain ${chainId}] WebSocket reconnect failed:`, error);
    scheduleWsRetry(watcher, wssUrl, contractAddress);
  }
}

/**
 * Schedule a WebSocket retry attempt.
 */
function scheduleWsRetry(
  watcher: ChainWatcher,
  wssUrl: string,
  contractAddress: Address
): void {
  // Clear any existing timer
  if (watcher.wsRetryTimer) {
    clearTimeout(watcher.wsRetryTimer);
  }

  watcher.wsRetryTimer = setTimeout(() => {
    if (watcher.transportType === "http") {
      tryWebSocketReconnect(watcher, wssUrl, contractAddress);
    }
  }, WS_RETRY_INTERVAL_MS);
}

function setupChainWatcher(
  chainId: number,
  wssUrl: string,
  contractAddress: Address
): ChainWatcher {
  const watcher: ChainWatcher = {
    chainId,
    transportType: "webSocket",
    status: "connecting",
    unwatchFns: [],
  };

  console.log(`[Chain ${chainId}] Connecting via WebSocket...`);

  try {
    const wsClient = createPublicClient({
      transport: webSocket(wssUrl, {
        reconnect: { attempts: 10, delay: 1000 },
        keepAlive: { interval: 30_000 },
      }),
    });

    watcher.unwatchFns = setupWatchers(
      wsClient,
      chainId,
      contractAddress,
      watcher,
      () => {
        // ── Fallback: tear down WSS, switch to HTTP polling ──
        watcher.unwatchFns.forEach((fn) => fn());
        watcher.unwatchFns = [];
        switchToHttpPolling(watcher, wssUrl, contractAddress);
      }
    );

    watcher.status = "watching";
    console.log(`[Chain ${chainId}] Watching contract ${contractAddress} (ws)`);
  } catch (error) {
    watcher.status = "error";
    watcher.error = String(error);
    console.error(`[Chain ${chainId}] Failed to set up watcher:`, error);

    // Try HTTP fallback on initial connection failure too
    switchToHttpPolling(watcher, wssUrl, contractAddress);
  }

  return watcher;
}

// ---------------------------------------------------------------------------
// Health endpoint — per-chain status
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  const workerStatus = getWorkerStatus();
  res.json({
    status: "ok",
    connections: io.engine.clientsCount,
    uptime: process.uptime(),
    chains: watchers.map((w) => ({
      chainId: w.chainId,
      transport: w.transportType,
      status: w.status,
      ...(w.error ? { error: w.error } : {}),
    })),
    leaderboardWorker: workerStatus,
  });
});

// ---------------------------------------------------------------------------
// Socket.IO connection handling
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Send recent events to newly connected client
  socket.emit("recentEvents", recentEvents.slice(0, 10));

  socket.on("disconnect", (reason) => {
    console.log(
      `[Socket.IO] Client disconnected: ${socket.id} | Reason: ${reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log("[Server] Shutting down...");

  // Unwatch all events and clear retry timers
  watchers.forEach((w) => {
    w.unwatchFns.forEach((fn) => fn());
    if (w.wsRetryTimer) clearTimeout(w.wsRetryTimer);
  });

  // Close Redis connection
  await closeRedisClient();

  // Close Socket.IO
  void io.close(() => {
    console.log("[Socket.IO] Closed");
  });

  // Close HTTP server
  server.close(() => {
    console.log("[Server] HTTP server closed");
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  try {
    for (let i = 0; i < CHAIN_IDS.length; i++) {
      const watcher = setupChainWatcher(
        CHAIN_IDS[i],
        WSS_URLS[i],
        SIR_CONTRACT_ADDRESSES[i]
      );
      watchers.push(watcher);
    }

    server.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
      console.log(`[Server] Allowed origins: ${FRONTEND_URLS.join(", ")}`);
      console.log(
        `[Server] Watching ${CHAIN_IDS.length} chain(s): ${CHAIN_IDS.join(", ")}`
      );

      // Start leaderboard background worker
      startLeaderboardWorker();
    });
  } catch (error) {
    console.error("[Server] Failed to start:", error);
    process.exit(1);
  }
}

void main();
