import { randomUUID } from "crypto";
import type { RedisClientType } from "redis";
import { getRedisClient } from "../../lib/redis.js";
import { getChainConfigs, type ChainConfig } from "../../lib/config.js";
import {
  createSubgraphClient,
  fetchPositionsBatch,
  fetchNewPositions,
  fetchAllVaultTokens,
} from "./subgraph.js";
import { fetchPrices } from "./prices.js";
import {
  computeAndWritePositions,
  filterPositions,
  removePositionFromRedis,
} from "./compute.js";
import type { WorkerStatus } from "./types.js";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const LOCK_TTL = 600; // 10 minutes (longer than expected run time)
const MAX_POSITIONS_PER_RUN = parseInt(
  process.env.MAX_POSITIONS_PER_RUN ?? "500"
);

let isRunning = false;
let workerStatus: WorkerStatus = {
  enabled: false,
  lastRun: null,
  lastDurationMs: null,
  chainStatus: {},
};

export function getWorkerStatus(): WorkerStatus {
  return workerStatus;
}

export function startLeaderboardWorker(): void {
  const enabled = process.env.LEADERBOARD_WORKER_ENABLED === "true";
  workerStatus.enabled = enabled;

  if (!enabled) {
    console.log("[LeaderboardWorker] Disabled via LEADERBOARD_WORKER_ENABLED");
    return;
  }

  const configs = getChainConfigs();
  if (configs.length === 0) {
    console.error("[LeaderboardWorker] No chain configs available");
    return;
  }

  console.log(
    `[LeaderboardWorker] Starting for chains: ${configs.map((c) => c.chainId).join(", ")}`
  );

  // Run immediately on start, then schedule next run
  void runCycle(configs);
}

function scheduleNextRun(configs: ChainConfig[]): void {
  setTimeout(() => {
    void runCycle(configs);
  }, INTERVAL_MS);
}

async function runCycle(configs: ChainConfig[]): Promise<void> {
  if (isRunning) {
    scheduleNextRun(configs);
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  const redis = await getRedisClient();
  if (!redis) {
    console.warn("[LeaderboardWorker] Redis unavailable, skipping cycle");
    isRunning = false;
    scheduleNextRun(configs);
    return;
  }

  console.log("[LeaderboardWorker] Starting cycle...");

  // Phase 1: Cache prices for all chains (used by both Next.js app and leaderboard)
  for (const config of configs) {
    try {
      await cachePricesForChain(config, redis);
    } catch (error) {
      console.error(
        `[PriceCache] Chain ${config.chainId} price caching failed:`,
        error
      );
      // Continue - stale Redis data is better than no data
    }
  }

  // Phase 2: Process leaderboard positions per chain
  for (const config of configs) {
    const chainId = config.chainId;
    workerStatus.chainStatus[chainId] = { status: "running" };

    const lockKey = `leaderboard:${chainId}:worker:lock`;
    const lockToken = randomUUID();

    try {
      // Try to acquire lock with unique token
      const acquired = await redis.set(lockKey, lockToken, {
        NX: true,
        EX: LOCK_TTL,
      });

      if (!acquired) {
        console.log(`[LeaderboardWorker] Chain ${chainId}: Lock held by another instance`);
        workerStatus.chainStatus[chainId] = {
          status: "error",
          error: "Lock held by another instance",
        };
        continue;
      }

      const positionsProcessed = await computeLeaderboardForChain(
        config,
        redis
      );

      workerStatus.chainStatus[chainId] = {
        status: "success",
        positionsProcessed,
      };

      console.log(
        `[LeaderboardWorker] Chain ${chainId}: Processed ${positionsProcessed} positions`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[LeaderboardWorker] Chain ${chainId} failed:`, error);
      workerStatus.chainStatus[chainId] = {
        status: "error",
        error: errorMsg,
      };
      // Don't wipe cache on failure - stale data is better than no data
    } finally {
      // Safe release: only delete if we still own the lock
      try {
        const currentToken = await redis.get(lockKey);
        if (currentToken === lockToken) {
          await redis.del(lockKey);
        }
      } catch {
        // Ignore lock release errors
      }
    }
  }

  const duration = Date.now() - startTime;
  workerStatus.lastRun = Date.now();
  workerStatus.lastDurationMs = duration;

  console.log(`[LeaderboardWorker] Cycle complete in ${duration}ms`);

  isRunning = false;
  scheduleNextRun(configs);
}

/**
 * Fetch all vault tokens from the subgraph, add SIR + wrapped native,
 * fetch prices via CoinGecko/DEX, and write the full price map to Redis.
 * The Next.js app reads from this cache instead of calling CoinGecko directly.
 */
async function cachePricesForChain(
  config: ChainConfig,
  redis: RedisClientType
): Promise<void> {
  const chainId = config.chainId;
  const client = createSubgraphClient(config.subgraphUrl, config.subgraphApiKey);

  // 1. Fetch all unique vault tokens from the subgraph
  const vaultTokens = await fetchAllVaultTokens(client);
  const tokens = new Map<string, { decimals: number }>();

  for (const token of vaultTokens) {
    tokens.set(token.id.toLowerCase(), { decimals: token.decimals });
  }

  // 2. Ensure SIR token is included
  if (config.sirTokenAddress) {
    const sirAddr = config.sirTokenAddress.toLowerCase();
    if (!tokens.has(sirAddr)) {
      tokens.set(sirAddr, { decimals: 12 }); // SIR has 12 decimals
    }
  }

  // 3. Ensure wrapped native is included
  const wrappedNativeLower = config.wrappedNative.toLowerCase();
  if (!tokens.has(wrappedNativeLower)) {
    tokens.set(wrappedNativeLower, { decimals: 18 });
  }

  if (tokens.size === 0) {
    console.log(`[PriceCache] Chain ${chainId}: No tokens to price`);
    return;
  }

  // 4. Fetch prices (CoinGecko → DEX fallback)
  const prices = await fetchPrices(config, tokens);

  // 5. Guard: only write if we got at least some prices
  if (Object.keys(prices).length === 0) {
    console.warn(
      `[PriceCache] Chain ${chainId}: Got empty prices, keeping existing cache`
    );
    return;
  }

  // 6. Write to Redis (no TTL - stale reads are better than no reads)
  await redis.set(`prices:${chainId}`, JSON.stringify(prices));
  await redis.set(`prices:${chainId}:updatedAt`, Date.now().toString());

  console.log(
    `[PriceCache] Chain ${chainId}: Cached ${Object.keys(prices).length} token prices`
  );
}

/**
 * Read cached prices from Redis for a given chain.
 * Returns empty map if not available.
 */
async function getCachedPrices(
  chainId: number,
  redis: RedisClientType
): Promise<Record<string, number>> {
  try {
    const cached = await redis.get(`prices:${chainId}`);
    if (cached) {
      return JSON.parse(cached) as Record<string, number>;
    }
  } catch (error) {
    console.warn(`[PriceCache] Chain ${chainId}: Failed to read cache:`, error);
  }
  return {};
}

async function computeLeaderboardForChain(
  config: ChainConfig,
  redis: RedisClientType
): Promise<number> {
  const chainId = config.chainId;
  const client = createSubgraphClient(config.subgraphUrl, config.subgraphApiKey);

  let totalProcessed = 0;

  // Read cached prices (written by cachePricesForChain earlier in the cycle)
  const prices = await getCachedPrices(chainId, redis);

  // 1. First, process any NEW positions (created since last full sweep)
  const lastSweepStr = await redis.get(`leaderboard:${chainId}:lastSweep`);
  if (lastSweepStr) {
    const lastSweepTime = parseInt(lastSweepStr, 10);
    const newPositions = await fetchNewPositions(client, lastSweepTime);

    if (newPositions.length > 0) {
      console.log(
        `[LeaderboardWorker] Chain ${chainId}: Processing ${newPositions.length} new positions`
      );

      const filtered = filterPositions(newPositions);
      if (filtered.length > 0) {
        const processed = await computeAndWritePositions(
          filtered,
          chainId,
          config,
          redis,
          prices
        );
        totalProcessed += processed;
      }
    }
  }

  // 2. Continue incremental sweep from cursor
  const cursor =
    (await redis.get(`leaderboard:${chainId}:cursor`)) ?? "";

  const positions = await fetchPositionsBatch(
    client,
    cursor,
    MAX_POSITIONS_PER_RUN
  );

  if (positions.length > 0) {
    // Filter and process
    const filtered = filterPositions(positions);

    // Check for closed positions (balance = 0) and remove them
    const closedPositions = positions.filter(
      (p) => BigInt(p.balance) === 0n
    );
    for (const pos of closedPositions) {
      await removePositionFromRedis(pos.id, chainId, redis);
    }

    if (filtered.length > 0) {
      // Process positions using cached prices
      const processed = await computeAndWritePositions(
        filtered,
        chainId,
        config,
        redis,
        prices
      );
      totalProcessed += processed;
    }
  }

  // 3. Update cursor; if sweep complete, record timestamp
  if (positions.length < MAX_POSITIONS_PER_RUN) {
    // Sweep complete - reset cursor and record timestamp
    await redis.del(`leaderboard:${chainId}:cursor`);
    await redis.set(
      `leaderboard:${chainId}:lastSweep`,
      Math.floor(Date.now() / 1000).toString()
    );
    console.log(`[LeaderboardWorker] Chain ${chainId}: Full sweep complete`);
  } else {
    // More positions to process - save cursor
    await redis.set(
      `leaderboard:${chainId}:cursor`,
      positions[positions.length - 1].id
    );
  }

  // 4. Update timestamp
  await redis.set(
    `leaderboard:${chainId}:timestamp`,
    Date.now().toString()
  );

  return totalProcessed;
}
