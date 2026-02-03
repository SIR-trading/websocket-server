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
  type WatchContractEventReturnType,
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

// LP Staking environment variables
const STAKER_ADDRESSES = process.env.UNISWAP_V3_STAKER_ADDRESSES?.split(",") ?? [];
const NFT_MANAGER_ADDRESSES = process.env.NFT_POSITION_MANAGER_ADDRESSES?.split(",") ?? [];
// SIR paired with wrapped native token (WETH on Ethereum, WHYPE on HyperEVM, etc.)
const POOL_ADDRESSES = process.env.SIR_NATIVE_POOL_ADDRESSES?.split(",") ?? [];

// Validate LP staking config
if (
  STAKER_ADDRESSES.length !== CHAIN_IDS.length ||
  NFT_MANAGER_ADDRESSES.length !== CHAIN_IDS.length ||
  POOL_ADDRESSES.length !== CHAIN_IDS.length
) {
  console.warn(
    "[LP Staking] Config arrays must match CHAIN_IDS length - LP staking disabled"
  );
}

// Build per-chain LP config (only chains with all 3 addresses)
interface LpStakingConfig {
  chainId: number;
  stakerAddress: Address | null;
  nftManager: Address | null;
  pool: Address | null;
}

const lpStakingConfigs: LpStakingConfig[] = CHAIN_IDS.map((chainId, i) => ({
  chainId,
  stakerAddress: (STAKER_ADDRESSES[i]?.trim() || null) as Address | null,
  nftManager: (NFT_MANAGER_ADDRESSES[i]?.trim() || null) as Address | null,
  pool: (POOL_ADDRESSES[i]?.trim() || null) as Address | null,
})).filter((c) => c.stakerAddress && c.nftManager && c.pool);

const lpStakingEnabledChains = new Set(lpStakingConfigs.map((c) => c.chainId));

if (lpStakingConfigs.length > 0) {
  console.log(
    `[LP Staking] Enabled for chains: ${lpStakingConfigs.map((c) => c.chainId).join(", ")}`
  );
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
// LP Staking event ABIs and contract ABIs
// ---------------------------------------------------------------------------

const LP_STAKING_EVENTS = {
  TokenStaked: parseAbiItem(
    "event TokenStaked(uint256 indexed tokenId, bytes32 indexed incentiveId, uint128 liquidity)"
  ),
  TokenUnstaked: parseAbiItem(
    "event TokenUnstaked(uint256 indexed tokenId, bytes32 indexed incentiveId)"
  ),
};

const POSITION_MANAGER_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "tokenOfOwnerByIndex",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const POOL_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const STAKER_ABI = [
  {
    name: "deposits",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "numberOfStakes", type: "uint48" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// LP Staking state types and storage
// ---------------------------------------------------------------------------

interface StakedPosition {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  activeIncentiveCount: number;
}

interface LpStakingStats {
  totalLiquidity: bigint;
  inRangeLiquidity: bigint;
  totalValueStakedUsd: number;
  inRangeValueStakedUsd: number;
  lastTick: number;
  lastUpdate: number;
}

interface ChainLpState {
  positions: Map<string, StakedPosition>;
  stats: LpStakingStats;
  isReady: boolean;
  sirPrice: number;
  wethPrice: number;
}

const lpStateByChain = new Map<number, ChainLpState>();
const chainLpLocks = new Map<number, boolean>();

// Initialize state for each LP-enabled chain
for (const config of lpStakingConfigs) {
  lpStateByChain.set(config.chainId, {
    positions: new Map(),
    stats: {
      totalLiquidity: 0n,
      inRangeLiquidity: 0n,
      totalValueStakedUsd: 0,
      inRangeValueStakedUsd: 0,
      lastTick: 0,
      lastUpdate: 0,
    },
    isReady: false,
    sirPrice: 0,
    wethPrice: 0,
  });
}

// Store LP staking watcher cleanup functions
const lpWatcherUnwatchFns: WatchContractEventReturnType[] = [];

// Store clients for LP staking operations
const lpClients = new Map<number, PublicClient<Transport>>();

// ---------------------------------------------------------------------------
// Uniswap V3 math helpers
// ---------------------------------------------------------------------------

function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0)
    ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0)
    ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0)
    ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0)
    ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0)
    ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0)
    ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0)
    ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0)
    ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0)
    ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0)
    ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0)
    ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0)
    ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0)
    ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0)
    ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0)
    ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0)
    ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0)
    ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0)
    ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0)
    ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0)
    ratio =
      0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn /
      ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function getTokenAmountsFromLiquidity(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number
): { amount0: bigint; amount1: bigint } {
  const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);
  const Q96 = 1n << 96n;

  let amount0 = 0n;
  let amount1 = 0n;

  if (currentTick < tickLower) {
    amount0 =
      (liquidity * Q96 * (sqrtPriceUpper - sqrtPriceLower)) /
      (sqrtPriceLower * sqrtPriceUpper);
  } else if (currentTick >= tickUpper) {
    amount1 = (liquidity * (sqrtPriceUpper - sqrtPriceLower)) / Q96;
  } else {
    amount0 =
      (liquidity * Q96 * (sqrtPriceUpper - sqrtPriceX96)) /
      (sqrtPriceX96 * sqrtPriceUpper);
    amount1 = (liquidity * (sqrtPriceX96 - sqrtPriceLower)) / Q96;
  }

  return { amount0, amount1 };
}

function calculatePositionValueUsd(
  position: StakedPosition,
  currentTick: number,
  sqrtPriceX96: bigint,
  sirPrice: number,
  wethPrice: number
): { totalUsd: number; isInRange: boolean } {
  const isInRange =
    currentTick >= position.tickLower && currentTick < position.tickUpper;
  const { amount0, amount1 } = getTokenAmountsFromLiquidity(
    position.liquidity,
    sqrtPriceX96,
    position.tickLower,
    position.tickUpper,
    currentTick
  );

  // SIR is token0, WETH is token1 (assuming standard ordering)
  const sirAmount = Number(amount0) / 1e18;
  const wethAmount = Number(amount1) / 1e18;
  const totalUsd = sirAmount * sirPrice + wethAmount * wethPrice;

  return { totalUsd, isInRange };
}

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
// LP Staking Functions
// ---------------------------------------------------------------------------

/**
 * Fetch position details from the NFT Position Manager
 */
async function fetchPositionDetails(
  client: PublicClient<Transport>,
  nftManager: Address,
  tokenId: bigint,
  maxRetries = 3
): Promise<{ tickLower: number; tickUpper: number; liquidity: bigint } | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const position = await client.readContract({
        address: nftManager,
        abi: POSITION_MANAGER_ABI,
        functionName: "positions",
        args: [tokenId],
      });

      return {
        tickLower: position[5],
        tickUpper: position[6],
        liquidity: position[7],
      };
    } catch (err) {
      if (attempt === maxRetries - 1) {
        console.error(`[LP] Failed to fetch position ${tokenId}:`, err);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * Recalculate LP staking stats and broadcast to all clients
 */
async function recalcLpStatsAndBroadcast(chainId: number): Promise<void> {
  const state = lpStateByChain.get(chainId);
  const config = lpStakingConfigs.find((c) => c.chainId === chainId);
  if (!state || !config || chainLpLocks.get(chainId)) return;

  chainLpLocks.set(chainId, true);

  try {
    const client = lpClients.get(chainId);
    if (!client || !config.pool) return;

    // Fetch current pool state
    const slot0 = await client.readContract({
      address: config.pool,
      abi: POOL_ABI,
      functionName: "slot0",
    });

    const currentTick = slot0[1];
    const sqrtPriceX96 = slot0[0];

    // Calculate totals
    let totalValueStakedUsd = 0;
    let inRangeValueStakedUsd = 0;
    let totalLiquidity = 0n;
    let inRangeLiquidity = 0n;

    for (const position of state.positions.values()) {
      if (position.liquidity === 0n) continue;

      totalLiquidity += position.liquidity;

      const { totalUsd, isInRange } = calculatePositionValueUsd(
        position,
        currentTick,
        sqrtPriceX96,
        state.sirPrice,
        state.wethPrice
      );

      totalValueStakedUsd += totalUsd;
      if (isInRange) {
        inRangeValueStakedUsd += totalUsd;
        inRangeLiquidity += position.liquidity;
      }
    }

    state.stats = {
      totalLiquidity,
      inRangeLiquidity,
      totalValueStakedUsd,
      inRangeValueStakedUsd,
      lastTick: currentTick,
      lastUpdate: Date.now(),
    };

    // Broadcast to all clients
    io.emit("lpStakingStatsUpdated", {
      chainId,
      totalValueStakedUsd,
      inRangeValueStakedUsd,
      lastTick: currentTick,
      timestamp: Date.now(),
    });

    console.log(
      `[LP Stats] Chain ${chainId}: $${totalValueStakedUsd.toFixed(2)} total, $${inRangeValueStakedUsd.toFixed(2)} in-range`
    );
  } catch (error) {
    console.error(`[LP Stats] Error recalculating for chain ${chainId}:`, error);
  } finally {
    chainLpLocks.set(chainId, false);
  }
}

/**
 * Sync all existing LP positions from the staker contract
 */
async function syncLpPositions(chainId: number): Promise<void> {
  const state = lpStateByChain.get(chainId);
  const config = lpStakingConfigs.find((c) => c.chainId === chainId);
  if (!state || !config || !config.stakerAddress || !config.nftManager) return;

  const client = lpClients.get(chainId);
  if (!client) return;

  console.log(`[LP Sync] Starting sync for chain ${chainId}...`);
  state.isReady = false;
  state.positions.clear();

  try {
    // Get current block for consistency
    const currentBlock = await client.getBlockNumber();

    // Fetch staker's NFT balance
    const stakerBalance = await client.readContract({
      address: config.nftManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "balanceOf",
      args: [config.stakerAddress],
      blockNumber: currentBlock,
    });

    console.log(
      `[LP Sync] Chain ${chainId}: ${stakerBalance} NFTs in staker contract`
    );

    // Fetch each token and check if actually staked
    for (let i = 0n; i < stakerBalance; i++) {
      try {
        const tokenId = await client.readContract({
          address: config.nftManager,
          abi: POSITION_MANAGER_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [config.stakerAddress, i],
          blockNumber: currentBlock,
        });

        // Check if deposited (has stakes)
        const deposit = await client.readContract({
          address: config.stakerAddress,
          abi: STAKER_ABI,
          functionName: "deposits",
          args: [tokenId],
          blockNumber: currentBlock,
        });

        const numberOfStakes = Number(deposit[1]);
        if (numberOfStakes > 0) {
          const positionDetails = await fetchPositionDetails(
            client,
            config.nftManager,
            tokenId
          );
          if (positionDetails && positionDetails.liquidity > 0n) {
            state.positions.set(tokenId.toString(), {
              tokenId,
              ...positionDetails,
              activeIncentiveCount: numberOfStakes,
            });
          }
        }
      } catch (err) {
        console.error(`[LP Sync] Error fetching token at index ${i}:`, err);
      }
    }

    console.log(
      `[LP Sync] Chain ${chainId}: ${state.positions.size} staked positions loaded`
    );
    state.isReady = true;

    // Initial stats calculation
    await recalcLpStatsAndBroadcast(chainId);
  } catch (error) {
    console.error(`[LP Sync] Failed to sync chain ${chainId}:`, error);
    state.isReady = false;
  }
}

/**
 * Set up event watchers for LP staking events
 */
function setupLpStakingWatchers(chainId: number): void {
  const config = lpStakingConfigs.find((c) => c.chainId === chainId);
  if (!config || !config.stakerAddress || !config.nftManager) return;

  const client = lpClients.get(chainId);
  if (!client) return;

  const state = lpStateByChain.get(chainId);
  if (!state) return;

  // Watch TokenStaked events
  const unwatchStaked = client.watchContractEvent({
    address: config.stakerAddress,
    abi: [LP_STAKING_EVENTS.TokenStaked],
    eventName: "TokenStaked",
    onLogs: async (logs) => {
      for (const log of logs) {
        const tokenId = log.args.tokenId!;
        const liquidity = log.args.liquidity!;

        console.log(
          `[LP Event] TokenStaked: ${tokenId} with liquidity ${liquidity} on chain ${chainId}`
        );

        const existing = state.positions.get(tokenId.toString());
        if (existing) {
          // Already tracked, increment incentive count
          existing.activeIncentiveCount++;
        } else {
          // New position, fetch details
          const details = await fetchPositionDetails(
            client,
            config.nftManager!,
            tokenId
          );
          if (details) {
            state.positions.set(tokenId.toString(), {
              tokenId,
              ...details,
              activeIncentiveCount: 1,
            });
          }
        }

        await recalcLpStatsAndBroadcast(chainId);
      }
    },
    onError: (error) => {
      console.error(`[LP] TokenStaked watch error on chain ${chainId}:`, error);
    },
  });
  lpWatcherUnwatchFns.push(unwatchStaked);

  // Watch TokenUnstaked events
  const unwatchUnstaked = client.watchContractEvent({
    address: config.stakerAddress,
    abi: [LP_STAKING_EVENTS.TokenUnstaked],
    eventName: "TokenUnstaked",
    onLogs: async (logs) => {
      for (const log of logs) {
        const tokenId = log.args.tokenId!;

        console.log(`[LP Event] TokenUnstaked: ${tokenId} on chain ${chainId}`);

        const existing = state.positions.get(tokenId.toString());
        if (existing) {
          existing.activeIncentiveCount--;
          if (existing.activeIncentiveCount <= 0) {
            state.positions.delete(tokenId.toString());
          }
        }

        await recalcLpStatsAndBroadcast(chainId);
      }
    },
    onError: (error) => {
      console.error(
        `[LP] TokenUnstaked watch error on chain ${chainId}:`,
        error
      );
    },
  });
  lpWatcherUnwatchFns.push(unwatchUnstaked);

  console.log(`[LP] Event watchers set up for chain ${chainId}`);
}

/**
 * Initialize LP staking for all enabled chains
 */
async function initializeLpStaking(): Promise<void> {
  if (lpStakingConfigs.length === 0) {
    console.log("[LP Staking] No chains configured, skipping initialization");
    return;
  }

  // Create HTTP clients for LP staking (more reliable for reads)
  for (let i = 0; i < CHAIN_IDS.length; i++) {
    const chainId = CHAIN_IDS[i];
    if (lpStakingEnabledChains.has(chainId)) {
      const httpUrl = deriveHttpUrl(WSS_URLS[i]);
      const client = createPublicClient({
        transport: http(httpUrl, { batch: true }),
        pollingInterval: 30_000,
      });
      lpClients.set(chainId, client);
    }
  }

  // Initialize each LP-enabled chain
  for (const config of lpStakingConfigs) {
    try {
      await syncLpPositions(config.chainId);
      setupLpStakingWatchers(config.chainId);
    } catch (error) {
      console.error(
        `[LP Staking] Failed to initialize chain ${config.chainId}:`,
        error
      );
    }
  }

  // Set up periodic USD recalculation (every 5 minutes)
  setInterval(
    async () => {
      for (const chainId of lpStakingEnabledChains) {
        const state = lpStateByChain.get(chainId);
        if (state?.isReady && state.sirPrice > 0 && state.wethPrice > 0) {
          await recalcLpStatsAndBroadcast(chainId);
        }
      }
    },
    5 * 60 * 1000
  );
}

// ---------------------------------------------------------------------------
// Health endpoint — per-chain status
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  const workerStatus = getWorkerStatus();

  // Build LP staking status for enabled chains
  const lpStakingStatus = Array.from(lpStakingEnabledChains).map((chainId) => {
    const state = lpStateByChain.get(chainId);
    return {
      chainId,
      isReady: state?.isReady ?? false,
      positionCount: state?.positions.size ?? 0,
      totalValueStakedUsd: state?.stats.totalValueStakedUsd ?? 0,
      inRangeValueStakedUsd: state?.stats.inRangeValueStakedUsd ?? 0,
      lastUpdate: state?.stats.lastUpdate ?? 0,
    };
  });

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
    lpStaking: {
      enabledChains: Array.from(lpStakingEnabledChains),
      status: lpStakingStatus,
    },
  });
});

// ---------------------------------------------------------------------------
// Socket.IO connection handling
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Send recent events to newly connected client
  socket.emit("recentEvents", recentEvents.slice(0, 10));

  // Handler for LP staking stats request
  socket.on("getLpStakingStats", ({ chainId }: { chainId: number }) => {
    if (!lpStakingEnabledChains.has(chainId)) {
      socket.emit("lpStakingStats", {
        chainId,
        supported: false,
        totalValueStakedUsd: 0,
        inRangeValueStakedUsd: 0,
      });
      return;
    }

    const state = lpStateByChain.get(chainId);
    if (!state?.isReady) {
      socket.emit("lpStakingStats", { chainId, loading: true });
      return;
    }

    socket.emit("lpStakingStats", {
      chainId,
      supported: true,
      totalValueStakedUsd: state.stats.totalValueStakedUsd,
      inRangeValueStakedUsd: state.stats.inRangeValueStakedUsd,
      lastTick: state.stats.lastTick,
      timestamp: state.stats.lastUpdate,
    });
  });

  // Handler to update prices (client sends prices, we store and recalc)
  socket.on(
    "updateLpPrices",
    async ({
      chainId,
      sirPrice,
      wethPrice,
    }: {
      chainId: number;
      sirPrice: number;
      wethPrice: number;
    }) => {
      const state = lpStateByChain.get(chainId);
      if (state && sirPrice > 0 && wethPrice > 0) {
        state.sirPrice = sirPrice;
        state.wethPrice = wethPrice;
        await recalcLpStatsAndBroadcast(chainId);
      }
    }
  );

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

  // Clean up LP staking watchers
  lpWatcherUnwatchFns.forEach((fn) => fn());
  console.log("[LP Staking] Watchers cleaned up");

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

      // Initialize LP staking (async, non-blocking)
      initializeLpStaking().catch((error) => {
        console.error("[LP Staking] Initialization failed:", error);
      });
    });
  } catch (error) {
    console.error("[Server] Failed to start:", error);
    process.exit(1);
  }
}

void main();
