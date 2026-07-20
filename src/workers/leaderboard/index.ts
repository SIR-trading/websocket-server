import { randomUUID } from "crypto";
import type { RedisClientType } from "redis";
import { getRedisClient } from "../../lib/redis.js";
import { getChainConfigs, type ChainConfig } from "../../lib/config.js";
import {
  createSubgraphClient,
  fetchPositionsBatch,
  fetchNewPositions,
  fetchTeaPositionsBatch,
  fetchNewTeaPositions,
  fetchAllVaultTokens,
  fetchAllVaultPairs,
  fetchAllApePositionIds,
  fetchAllTeaPositionIds,
} from "./subgraph.js";
import {
  fetchPrices,
  fetchNativePrices,
  cgCallStats,
  resetCgCallStats,
  FEE_TIERS,
  type PoolHint,
} from "./prices.js";
import {
  computeAndWritePositions,
  filterPositions,
  removePositionFromRedis,
  cleanupOrphanedApePositions,
} from "./compute.js";
import {
  computeAndWriteTeaPositions,
  filterTeaPositions,
  removeTeaPositionFromRedis,
  cleanupOrphanedTeaPositions,
} from "./tea-compute.js";
import { cacheVaultMetricsForChain } from "./vault-metrics.js";
import type { WorkerStatus } from "./types.js";

const LOCK_TTL = 600; // 10 minutes (longer than expected run time)
const MAX_POSITIONS_PER_RUN = parseInt(
  process.env.MAX_POSITIONS_PER_RUN ?? "500"
);

// Activity-gated cadence: the scheduler ticks on a fixed interval and starts a
// new cycle once ACTIVE_INTERVAL_MS (recent app activity) or IDLE_INTERVAL_MS
// (no activity) has elapsed since the last cycle end.
const ACTIVE_INTERVAL_MS = parseInt(
  process.env.LEADERBOARD_ACTIVE_INTERVAL_MS ?? "600000"
);
const IDLE_INTERVAL_MS = parseInt(
  process.env.LEADERBOARD_IDLE_INTERVAL_MS ?? "3600000"
);
const SCHEDULER_TICK_MS = parseInt(
  process.env.LEADERBOARD_SCHEDULER_TICK_MS ?? "60000"
);
// Cycle-claim TTL follows the active cadence: a fixed 600s claim would block
// every follow-up cycle when ACTIVE_INTERVAL_MS is tuned below 10 minutes
// (e.g. compressed-timing tests). Capped at LOCK_TTL, floored at 30s.
const CYCLE_CLAIM_TTL = Math.min(
  LOCK_TTL,
  Math.max(30, Math.floor(ACTIVE_INTERVAL_MS / 1000))
);

let isRunning = false;
let schedulerTimer: NodeJS.Timeout | null = null;
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

  // Boot cycle runs immediately; the scheduler then polls on a fixed tick and
  // starts a new cycle when the activity-gated cadence interval has elapsed.
  void runCycle(configs);
  schedulerTimer = setInterval(() => void tick(configs), SCHEDULER_TICK_MS);
}

export function stopLeaderboardWorker(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/**
 * Scheduler tick: decide whether a new cycle is due. Gated by app activity
 * (ACTIVE vs IDLE cadence), a shared last-cycle timestamp, and a per-slot
 * claim so only one replica runs the cycle.
 */
async function tick(configs: ChainConfig[]): Promise<void> {
  if (isRunning) return;

  const redis = await getRedisClient();
  if (!redis) return; // cycle would abort anyway

  // Activity gate: fail open to ACTIVE so a Redis read error never stalls the
  // leaderboard. app:lastActivity is written by the app on user activity.
  let active = true;
  try {
    active = (await redis.exists("app:lastActivity")) === 1;
  } catch {
    active = true;
  }
  const interval = active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

  // Cadence gate: only run once per interval, tracked across replicas via
  // leaderboard:lastCycleAt (stamped at every cycle end).
  let lastCycleAt = 0;
  try {
    const raw = await redis.get("leaderboard:lastCycleAt");
    const parsed = raw ? parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed)) lastCycleAt = parsed;
  } catch {
    lastCycleAt = 0;
  }
  const elapsed = Date.now() - lastCycleAt;
  if (elapsed < interval) return;

  // Slot claim: only one replica runs the cycle for this slot.
  const acquired = await redis.set("leaderboard:cycleClaim", randomUUID(), {
    NX: true,
    EX: CYCLE_CLAIM_TTL,
  });
  if (!acquired) return;

  console.log(
    `[LeaderboardWorker] Cadence=${active ? "ACTIVE" : "IDLE"} (elapsed=${Math.round(elapsed / 1000)}s) - running cycle`
  );
  void runCycle(configs);
}

async function runCycle(configs: ChainConfig[]): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  const redis = await getRedisClient();
  if (!redis) {
    console.warn("[LeaderboardWorker] Redis unavailable, skipping cycle");
    isRunning = false;
    return;
  }

  console.log("[LeaderboardWorker] Starting cycle...");

  // Phase 1: Cache prices for all chains (used by both Next.js app and
  // leaderboard). Guarded by a single global lock so only one replica runs the
  // price phase per cycle; other replicas skip straight to Phase 1.5+.
  const priceLockKey = "prices:worker:lock";
  const priceLockToken = randomUUID();
  const priceLockAcquired = await redis.set(priceLockKey, priceLockToken, {
    NX: true,
    EX: LOCK_TTL,
  });

  if (!priceLockAcquired) {
    console.log(
      "[PriceCache] Price lock held by another instance, skipping price phase"
    );
  } else {
    try {
      resetCgCallStats();
      // One combined native-price call for all chains, reused by every chain's
      // fetchPrices below instead of a per-chain /simple/price request.
      const nativePrices = await fetchNativePrices(configs);
      for (const config of configs) {
        try {
          await cachePricesForChain(config, redis, nativePrices);
        } catch (error) {
          console.error(
            `[PriceCache] Chain ${config.chainId} price caching failed:`,
            error
          );
          // Continue - stale Redis data is better than no data
        }
      }
      const totalCgCalls = cgCallStats.tokenPrice + cgCallStats.native;
      console.log(
        `[Prices] Cycle CoinGecko calls: ${totalCgCalls} (token_price=${cgCallStats.tokenPrice}, native=${cgCallStats.native})`
      );
    } finally {
      // Safe release: only delete if we still own the lock
      try {
        const currentToken = await redis.get(priceLockKey);
        if (currentToken === priceLockToken) {
          await redis.del(priceLockKey);
        }
      } catch {
        // Ignore lock release errors
      }
    }
  }

  // Phase 1.5: Cache vault metrics for all chains
  for (const config of configs) {
    try {
      const client = createSubgraphClient(config.subgraphUrl, config.subgraphApiKey);
      await cacheVaultMetricsForChain(config, client, redis);
    } catch (error) {
      console.error(`[VaultMetrics] Chain ${config.chainId} failed:`, error);
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

  // Phase 3: Process TEA/LP positions per chain
  for (const config of configs) {
    const chainId = config.chainId;
    const lpLockKey = `leaderboard:${chainId}:lp:worker:lock`;
    const lpLockToken = randomUUID();

    try {
      const acquired = await redis.set(lpLockKey, lpLockToken, {
        NX: true,
        EX: LOCK_TTL,
      });

      if (!acquired) {
        console.log(
          `[LeaderboardWorker] Chain ${chainId}: LP lock held by another instance`
        );
        continue;
      }

      const teaProcessed = await computeTeaLeaderboardForChain(config, redis);
      console.log(
        `[LeaderboardWorker] Chain ${chainId}: Processed ${teaProcessed} TEA positions`
      );
    } catch (error) {
      console.error(
        `[LeaderboardWorker] Chain ${chainId} TEA failed:`,
        error
      );
    } finally {
      try {
        const currentToken = await redis.get(lpLockKey);
        if (currentToken === lpLockToken) {
          await redis.del(lpLockKey);
        }
      } catch {
        // Ignore lock release errors
      }
    }
  }

  const duration = Date.now() - startTime;
  workerStatus.lastRun = Date.now();
  workerStatus.lastDurationMs = duration;

  // Stamp cycle-end time so the activity-gated scheduler waits one full
  // interval before the next cycle. Unconditional (same semantics as lastRun):
  // a failed cycle still waits one interval.
  try {
    await redis.set("leaderboard:lastCycleAt", Date.now().toString());
  } catch (error) {
    console.warn("[LeaderboardWorker] Failed to stamp lastCycleAt:", error);
  }

  console.log(`[LeaderboardWorker] Cycle complete in ${duration}ms`);

  isRunning = false;
}

/**
 * Fetch all vault tokens from the subgraph, add SIR + wrapped native,
 * fetch prices via CoinGecko/DEX, and write the full price map to Redis.
 * The Next.js app reads from this cache instead of calling CoinGecko directly.
 */
async function cachePricesForChain(
  config: ChainConfig,
  redis: RedisClientType,
  nativePrices: Record<string, number>
): Promise<void> {
  const chainId = config.chainId;
  const client = createSubgraphClient(config.subgraphUrl, config.subgraphApiKey);

  // 1. Fetch all unique vault tokens + the (collateral, debt) pairs from the
  // subgraph. Pairs feed the Step-5 cross-pair fallback in fetchPrices.
  const [vaultTokens, vaultPairs] = await Promise.all([
    fetchAllVaultTokens(client),
    fetchAllVaultPairs(client),
  ]);
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

  // 4. Read fee-tier hints (skips exhaustive 4-tier probe on the DEX fallback)
  const hints = await readFeeTierHints(chainId, [...tokens.keys()], redis);

  // 5. Fetch prices (CoinGecko → anchor DEX → cross-pair DEX)
  const { prices, winningPools, derivedCount } = await fetchPrices(
    config,
    tokens,
    hints,
    vaultPairs,
    nativePrices
  );

  // 6. Guard: only write if at least one price came from a real source
  // (CoinGecko, native fallback, or DEX). Anchor seeds alone don't count —
  // they would otherwise overwrite a previously-fresh cache with $1 stubs
  // during a combined CG + bootstrap outage.
  if (derivedCount === 0) {
    console.warn(
      `[PriceCache] Chain ${chainId}: No derived prices this cycle, keeping existing cache`
    );
    return;
  }

  // 7. Write prices to Redis (no TTL - stale reads are better than no reads)
  await redis.set(`prices:${chainId}`, JSON.stringify(prices));
  await redis.set(`prices:${chainId}:updatedAt`, Date.now().toString());

  // 8. Refresh hints for tokens that produced a winning pool this cycle
  if (winningPools.size > 0) {
    await writeFeeTierHints(chainId, winningPools, redis);
  }

  console.log(
    `[PriceCache] Chain ${chainId}: Cached ${Object.keys(prices).length} token prices (${winningPools.size} hints refreshed)`
  );
}

const FEE_TIER_HINT_TTL_SECONDS = 86_400; // 24h — daily re-probe in case liquidity moves

// Hint values are stored as "<lowercased-quote-address>:<feeTier>" (e.g.
// "0xfafd...:3000"). Legacy bare-integer entries from the WETH-only era are
// rejected by this regex and re-probed on the next cycle.
const HINT_VALUE_PATTERN = /^(0x[0-9a-f]{40}):(\d+)$/;
const FEE_TIER_SET: ReadonlySet<number> = new Set<number>(FEE_TIERS);

async function readFeeTierHints(
  chainId: number,
  tokens: string[],
  redis: RedisClientType
): Promise<Map<string, PoolHint>> {
  const out = new Map<string, PoolHint>();
  if (tokens.length === 0) return out;
  const keys = tokens.map((t) => `priceFeeTier:${chainId}:${t.toLowerCase()}`);
  try {
    const values = await redis.mGet(keys);
    for (let i = 0; i < tokens.length; i++) {
      const v = values[i];
      if (!v) continue;
      const match = HINT_VALUE_PATTERN.exec(v);
      if (!match) continue;
      const fee = parseInt(match[2], 10);
      if (!FEE_TIER_SET.has(fee)) continue;
      out.set(tokens[i].toLowerCase(), { quote: match[1], fee });
    }
  } catch (error) {
    console.warn(`[PriceCache] Chain ${chainId}: hint read failed:`, error);
  }
  return out;
}

async function writeFeeTierHints(
  chainId: number,
  hints: Map<string, PoolHint>,
  redis: RedisClientType
): Promise<void> {
  const pipeline = redis.multi();
  for (const [token, hint] of hints) {
    pipeline.set(
      `priceFeeTier:${chainId}:${token.toLowerCase()}`,
      `${hint.quote.toLowerCase()}:${hint.fee}`,
      { EX: FEE_TIER_HINT_TTL_SECONDS }
    );
  }
  try {
    await pipeline.exec();
  } catch (error) {
    console.warn(`[PriceCache] Chain ${chainId}: hint write failed:`, error);
  }
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

  // 3. Update cursor; if sweep complete, record timestamp and clean orphans
  if (positions.length < MAX_POSITIONS_PER_RUN) {
    // Sweep complete - reset cursor and record timestamp
    await redis.del(`leaderboard:${chainId}:cursor`);
    await redis.set(
      `leaderboard:${chainId}:lastSweep`,
      Math.floor(Date.now() / 1000).toString()
    );
    console.log(`[LeaderboardWorker] Chain ${chainId}: Full sweep complete`);

    // Clean up orphaned positions (removed from subgraph via store.remove())
    const subgraphIds = await fetchAllApePositionIds(client);
    const orphansRemoved = await cleanupOrphanedApePositions(subgraphIds, chainId, redis);
    if (orphansRemoved > 0) {
      console.log(`[LeaderboardWorker] Chain ${chainId}: Removed ${orphansRemoved} orphaned APE positions`);
    }
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

async function computeTeaLeaderboardForChain(
  config: ChainConfig,
  redis: RedisClientType
): Promise<number> {
  const chainId = config.chainId;
  const client = createSubgraphClient(
    config.subgraphUrl,
    config.subgraphApiKey
  );
  let totalProcessed = 0;

  const prices = await getCachedPrices(chainId, redis);

  // 1. Process NEW TEA positions since last sweep
  const lastSweepStr = await redis.get(
    `leaderboard:${chainId}:lp:lastSweep`
  );
  if (lastSweepStr) {
    const lastSweepTime = parseInt(lastSweepStr, 10);
    const newPositions = await fetchNewTeaPositions(client, lastSweepTime);

    if (newPositions.length > 0) {
      console.log(
        `[LeaderboardWorker] Chain ${chainId}: Processing ${newPositions.length} new TEA positions`
      );
      // Active-remove phantom TeaPositions owned by the vault itself (POL).
      // The subgraph creates these on POL donations; the leaderboard must
      // not surface them. See websocket-server fix paired with subgraph fix
      // in tea.ts handleTeaTransfer.
      const vaultLower = config.vaultAddress.toLowerCase();
      const polPositions = newPositions.filter(
        (p) => p.user.toLowerCase() === vaultLower
      );
      for (const pos of polPositions) {
        await removeTeaPositionFromRedis(pos.id, chainId, redis);
      }
      const filtered = filterTeaPositions(newPositions, config.vaultAddress);
      if (filtered.length > 0) {
        const processed = await computeAndWriteTeaPositions(
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
    (await redis.get(`leaderboard:${chainId}:lp:cursor`)) ?? "";

  const positions = await fetchTeaPositionsBatch(
    client,
    cursor,
    MAX_POSITIONS_PER_RUN
  );

  if (positions.length > 0) {
    // Active-remove vault-owned (POL) positions from Redis. Passive filtering
    // alone would leave the stale row in the leaderboard cache.
    const vaultLower = config.vaultAddress.toLowerCase();
    const polPositions = positions.filter(
      (p) => p.user.toLowerCase() === vaultLower
    );
    for (const pos of polPositions) {
      await removeTeaPositionFromRedis(pos.id, chainId, redis);
    }

    const filtered = filterTeaPositions(positions, config.vaultAddress);

    // Remove closed positions (balance = 0)
    const closedPositions = positions.filter(
      (p) => BigInt(p.balance) === 0n
    );
    for (const pos of closedPositions) {
      await removeTeaPositionFromRedis(pos.id, chainId, redis);
    }

    if (filtered.length > 0) {
      const processed = await computeAndWriteTeaPositions(
        filtered,
        chainId,
        config,
        redis,
        prices
      );
      totalProcessed += processed;
    }
  }

  // 3. Update cursor; if sweep complete, record timestamp and clean orphans
  if (positions.length < MAX_POSITIONS_PER_RUN) {
    await redis.del(`leaderboard:${chainId}:lp:cursor`);
    await redis.set(
      `leaderboard:${chainId}:lp:lastSweep`,
      Math.floor(Date.now() / 1000).toString()
    );
    console.log(
      `[LeaderboardWorker] Chain ${chainId}: TEA full sweep complete`
    );

    // Clean up orphaned TEA positions (removed from subgraph via store.remove())
    const subgraphIds = await fetchAllTeaPositionIds(client);
    const orphansRemoved = await cleanupOrphanedTeaPositions(subgraphIds, chainId, redis);
    if (orphansRemoved > 0) {
      console.log(`[LeaderboardWorker] Chain ${chainId}: Removed ${orphansRemoved} orphaned TEA positions`);
    }
  } else {
    await redis.set(
      `leaderboard:${chainId}:lp:cursor`,
      positions[positions.length - 1].id
    );
  }

  // 4. Update timestamp
  await redis.set(
    `leaderboard:${chainId}:lp:timestamp`,
    Date.now().toString()
  );

  return totalProcessed;
}
