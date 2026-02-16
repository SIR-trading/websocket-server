import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createPublicClient,
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
  process.env.FRONTEND_URLS?.split(",").map((s) => s.trim()) ?? ["http://localhost:3000"];

const CHAIN_IDS = process.env.CHAIN_IDS?.split(",").map(Number) ?? [];
const RPC_URLS = process.env.RPC_URLS?.split(",") ?? [];
const SIR_CONTRACT_ADDRESSES = (process.env.SIR_CONTRACT_ADDRESSES?.split(
  ","
) ?? []) as Address[];

if (
  CHAIN_IDS.length === 0 ||
  CHAIN_IDS.length !== RPC_URLS.length ||
  CHAIN_IDS.length !== SIR_CONTRACT_ADDRESSES.length
) {
  console.error(
    "CHAIN_IDS, RPC_URLS, and SIR_CONTRACT_ADDRESSES must all be provided with the same number of comma-separated values"
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
    "event BidReceived(address indexed bidder, address indexed token, uint96 previousBid, uint96 newBid)"
  ),
  AuctionedTokensSentToWinner: parseAbiItem(
    "event AuctionedTokensSentToWinner(address indexed winner, address indexed beneficiary, address indexed token, uint256 reward)"
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
  totalSirAmount: bigint;
  totalNativeAmount: bigint;
  inRangeSirAmount: bigint;
  inRangeNativeAmount: bigint;
  currentTick: number;
  lastTickUpdate: number;
}

interface ChainLpState {
  positions: Map<string, StakedPosition>;
  stats: LpStakingStats;
  isReady: boolean;
}

const lpStateByChain = new Map<number, ChainLpState>();
const chainLpLocks = new Map<number, boolean>();

// Initialize state for each LP-enabled chain
for (const config of lpStakingConfigs) {
  lpStateByChain.set(config.chainId, {
    positions: new Map(),
    stats: {
      totalSirAmount: 0n,
      totalNativeAmount: 0n,
      inRangeSirAmount: 0n,
      inRangeNativeAmount: 0n,
      currentTick: 0,
      lastTickUpdate: 0,
    },
    isReady: false,
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
  status: "connecting" | "watching" | "error";
  error?: string;
  pollTimer?: ReturnType<typeof setInterval>;
}

const watchers: ChainWatcher[] = [];

const POLL_INTERVAL_MS = 30_000;

const CONTRACT_ABI = [
  EVENTS.AuctionStarted,
  EVENTS.BidReceived,
  EVENTS.AuctionedTokensSentToWinner,
  EVENTS.DividendsPaid,
] as const;

/**
 * Process a log from the contract and emit it via Socket.IO.
 */
function processLog(
  chainId: number,
  log: { transactionHash: string | null; logIndex: number | null; blockNumber: bigint | null; eventName: string | undefined; args: Record<string, unknown> }
) {
  const id = `${chainId}-${log.transactionHash}-${log.logIndex}`;
  const blockNumber = log.blockNumber ? Number(log.blockNumber) : 0;

  switch (log.eventName) {
    case "AuctionStarted":
      addEvent({
        id,
        type: "auctionStarted",
        chainId,
        timestamp: Date.now(),
        data: {
          chainId,
          token: log.args.token,
          amount: log.args.amount?.toString(),
          txHash: log.transactionHash,
          blockNumber,
        },
      });
      break;
    case "BidReceived":
      addEvent({
        id,
        type: "bidReceived",
        chainId,
        timestamp: Date.now(),
        data: {
          chainId,
          token: log.args.token,
          bidder: log.args.bidder,
          bid: log.args.newBid?.toString(),
          txHash: log.transactionHash,
          blockNumber,
        },
      });
      break;
    case "AuctionedTokensSentToWinner":
      addEvent({
        id,
        type: "auctionSettled",
        chainId,
        timestamp: Date.now(),
        data: {
          chainId,
          token: log.args.token,
          winner: log.args.winner,
          amount: log.args.reward?.toString(),
          txHash: log.transactionHash,
          blockNumber,
        },
      });
      break;
    case "DividendsPaid":
      addEvent({
        id,
        type: "dividendsPaid",
        chainId,
        timestamp: Date.now(),
        data: {
          chainId,
          amountETH: log.args.amountETH?.toString(),
          amountStakedSIR: log.args.amountStakedSIR?.toString(),
          txHash: log.transactionHash,
          blockNumber,
        },
      });
      break;
  }
}

function setupChainWatcher(
  chainId: number,
  rpcUrl: string,
  contractAddress: Address
): ChainWatcher {
  const watcher: ChainWatcher = {
    chainId,
    status: "connecting",
  };

  const client = createPublicClient({
    transport: http(rpcUrl, { batch: true }),
  });

  let lastBlock = 0n;

  async function poll() {
    try {
      const currentBlock = await client.getBlockNumber();

      // First poll: just record the block, don't fetch historical logs
      if (lastBlock === 0n) {
        lastBlock = currentBlock;
        watcher.status = "watching";
        console.log(`[Chain ${chainId}] Watching contract ${contractAddress} from block ${currentBlock}`);
        return;
      }

      // No new blocks since last poll
      if (currentBlock <= lastBlock) return;

      const fromBlock = lastBlock + 1n;
      const logs = await client.getContractEvents({
        address: contractAddress,
        abi: CONTRACT_ABI,
        fromBlock,
        toBlock: currentBlock,
      });

      if (logs.length > 0) {
        console.log(`[Chain ${chainId}] Found ${logs.length} event(s) in blocks ${fromBlock}-${currentBlock}`);
      }

      for (const log of logs) {
        processLog(chainId, log as never);
      }

      lastBlock = currentBlock;

      // Clear error state on successful poll
      if (watcher.status === "error") {
        watcher.status = "watching";
        watcher.error = undefined;
        console.log(`[Chain ${chainId}] Recovered, watching again`);
      }
    } catch (error) {
      console.error(`[Chain ${chainId}] Poll error:`, error);
      watcher.status = "error";
      watcher.error = String(error);
    }
  }

  // Initial poll, then repeat on interval
  void poll();
  watcher.pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

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
 * Returns token amounts (not USD) - client calculates USD using current prices
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

    // Calculate token amounts (not USD)
    let totalSirAmount = 0n;
    let totalNativeAmount = 0n;
    let inRangeSirAmount = 0n;
    let inRangeNativeAmount = 0n;

    for (const position of state.positions.values()) {
      if (position.liquidity === 0n) continue;

      const { amount0, amount1 } = getTokenAmountsFromLiquidity(
        position.liquidity,
        sqrtPriceX96,
        position.tickLower,
        position.tickUpper,
        currentTick
      );

      // SIR is token0, native (WETH/WHYPE) is token1
      totalSirAmount += amount0;
      totalNativeAmount += amount1;

      const isInRange =
        currentTick >= position.tickLower && currentTick < position.tickUpper;
      if (isInRange) {
        inRangeSirAmount += amount0;
        inRangeNativeAmount += amount1;
      }
    }

    const now = Date.now();
    state.stats = {
      totalSirAmount,
      totalNativeAmount,
      inRangeSirAmount,
      inRangeNativeAmount,
      currentTick,
      lastTickUpdate: now,
    };

    // Broadcast token amounts to all clients
    io.emit("lpStakingStatsUpdated", {
      chainId,
      totalSirAmount: totalSirAmount.toString(),
      totalNativeAmount: totalNativeAmount.toString(),
      inRangeSirAmount: inRangeSirAmount.toString(),
      inRangeNativeAmount: inRangeNativeAmount.toString(),
      currentTick,
      lastTickUpdate: now,
    });

    console.log(
      `[LP Stats] Chain ${chainId}: SIR=${totalSirAmount.toString()}, native=${totalNativeAmount.toString()}`
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
      const client = createPublicClient({
        transport: http(RPC_URLS[i], { batch: true }),
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

  // Set up periodic tick refresh (every 5 minutes)
  // This ensures token amounts are recalculated with current tick even if no stake/unstake events
  setInterval(
    async () => {
      for (const chainId of lpStakingEnabledChains) {
        const state = lpStateByChain.get(chainId);
        if (state?.isReady) {
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
      currentTick: state?.stats.currentTick ?? 0,
      lastTickUpdate: state?.stats.lastTickUpdate ?? 0,
    };
  });

  res.json({
    status: "ok",
    connections: io.engine.clientsCount,
    uptime: process.uptime(),
    chains: watchers.map((w) => ({
      chainId: w.chainId,
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

  // Handler for LP staking stats request - returns token amounts (not USD)
  socket.on("getLpStakingStats", ({ chainId }: { chainId: number }) => {
    if (!lpStakingEnabledChains.has(chainId)) {
      socket.emit("lpStakingStats", {
        chainId,
        supported: false,
        loading: false,
        totalSirAmount: "0",
        totalNativeAmount: "0",
        inRangeSirAmount: "0",
        inRangeNativeAmount: "0",
        currentTick: 0,
        lastTickUpdate: 0,
      });
      return;
    }

    const state = lpStateByChain.get(chainId);
    if (!state?.isReady) {
      socket.emit("lpStakingStats", { chainId, loading: true, supported: true });
      return;
    }

    socket.emit("lpStakingStats", {
      chainId,
      supported: true,
      loading: false,
      totalSirAmount: state.stats.totalSirAmount.toString(),
      totalNativeAmount: state.stats.totalNativeAmount.toString(),
      inRangeSirAmount: state.stats.inRangeSirAmount.toString(),
      inRangeNativeAmount: state.stats.inRangeNativeAmount.toString(),
      currentTick: state.stats.currentTick,
      lastTickUpdate: state.stats.lastTickUpdate,
    });
  });

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

  // Stop all poll timers
  watchers.forEach((w) => {
    if (w.pollTimer) clearInterval(w.pollTimer);
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
        RPC_URLS[i],
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
