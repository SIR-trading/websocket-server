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
}

const watchers: ChainWatcher[] = [];

/** Convert a WSS URL to an HTTPS URL for HTTP polling fallback. */
function deriveHttpUrl(wssUrl: string): string {
  return wssUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

/** Returns true if the error looks like an eth_subscribe / method-not-found rejection. */
function isSubscribeError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
  const lower = msg.toLowerCase();
  return lower.includes("eth_subscribe") || lower.includes("method not found");
}

/**
 * Attach the 4 watchContractEvent listeners to a viem client.
 * Returns the array of unwatch functions.
 *
 * If `onSubscribeError` is provided, the first eth_subscribe-related error from
 * any watcher will invoke it exactly once so the caller can switch transports.
 */
function setupWatchers(
  client: PublicClient<Transport>,
  chainId: number,
  contractAddress: Address,
  watcher: ChainWatcher,
  onSubscribeError?: () => void
): (() => void)[] {
  let subscribeFailed = false;

  function handleError(eventName: string) {
    return (error: Error) => {
      if (isSubscribeError(error)) {
        if (onSubscribeError && !subscribeFailed) {
          subscribeFailed = true;
          onSubscribeError();
        }
        // Whether first or subsequent, silently ignore subscribe errors
        // (the fallback handles the first; the rest are expected duplicates)
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
        console.warn(
          `[Chain ${chainId}] \u26A0 eth_subscribe not supported, switching to HTTP polling`
        );

        // Unwatch all WSS listeners
        watcher.unwatchFns.forEach((fn) => fn());
        watcher.unwatchFns = [];

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
            // no onSubscribeError — HTTP polling uses eth_getLogs, not eth_subscribe
          );

          watcher.transportType = "http";
          watcher.status = "watching";
          watcher.error = undefined;
          console.log(
            `[Chain ${chainId}] Watching contract ${contractAddress} (http poll)`
          );
        } catch (httpError) {
          watcher.status = "error";
          watcher.error = String(httpError);
          console.error(
            `[Chain ${chainId}] HTTP fallback failed:`,
            httpError
          );
        }
      }
    );

    watcher.status = "watching";
    console.log(
      `[Chain ${chainId}] Watching contract ${contractAddress} (ws)`
    );
  } catch (error) {
    watcher.status = "error";
    watcher.error = String(error);
    console.error(`[Chain ${chainId}] Failed to set up watcher:`, error);
  }

  return watcher;
}

// ---------------------------------------------------------------------------
// Health endpoint — per-chain status
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
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

function shutdown() {
  console.log("[Server] Shutting down...");

  // Unwatch all events across all chains
  watchers.forEach((w) => w.unwatchFns.forEach((fn) => fn()));

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

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
    });
  } catch (error) {
    console.error("[Server] Failed to start:", error);
    process.exit(1);
  }
}

void main();
