import {
  createPublicClient,
  http,
  formatUnits,
  fromHex,
} from "viem";
import { mainnet } from "viem/chains";
import type { RedisClientType } from "redis";
import type { ChainConfig } from "../../lib/config.js";
import type {
  CurrentApePositionFragment,
  ComputedPositionData,
} from "./types.js";
import type { PublicClient } from "viem";
import { getReservesResilient } from "./reserves.js";

const MIN_DOLLAR_TOTAL = 1; // Minimum $1 deposit to filter dust/test positions

// Three-tier anchor hierarchy — must stay in sync with
// App/src/lib/utils/stablecoin.ts. A pair counts as a "short" when the
// collateral is a stronger anchor than the debt:
//   Tier 1 (strongest): USD stablecoins (any chain)
//   Tier 2:             WETH (any chain)
//   Tier 3:             CL8Y-cb on MegaETH only
// On short rows we display collateral-per-debt (the debt asset priced in the
// collateral), which reads naturally as "the asset you shorted moved from X
// to Y".
const USD_STABLECOINS: ReadonlySet<string> = new Set([
  "USDC", "USDT", "DAI", "USDS", "USDE", "USD1", "PYUSD", "RLUSD",
  "USDTB", "USDD", "GHO", "USD0", "FRAX", "FDUSD", "TUSD", "USDG",
  "USDF", "PEPEUSD", "SUSDS",
  "FEUSD", "USR", "USDH", "USDP", "USDXL", "USD₮0",
  "USDM",
]);

const MEGAETH_CHAIN_ID = 4326;
const CL8Y_CB_ADDRESS = "0xfbaa45a537cf07dc768c469ffac4e88208b0098d";

type TokenRef = { symbol?: string | null; id?: string | null };

// Higher value = stronger anchor. -1 means "not an anchor".
function anchorTier(token: TokenRef, chainId: number): number {
  const sym = token.symbol?.trim().toUpperCase() ?? "";
  if (sym && USD_STABLECOINS.has(sym)) return 3;
  if (sym === "WETH") return 2;
  const id = token.id?.toLowerCase() ?? "";
  if (chainId === MEGAETH_CHAIN_ID && id === CL8Y_CB_ADDRESS) return 1;
  return -1;
}

function isShortPair(collateral: TokenRef, debt: TokenRef, chainId: number): boolean {
  const collTier = anchorTier(collateral, chainId);
  if (collTier < 0) return false;
  const debtTier = anchorTier(debt, chainId);
  return debtTier < collTier;
}

// Bound multicall size + concurrency so a flaky RPC kills only one chunk.
const TOTAL_SUPPLY_CHUNK_SIZE = 50;
const TOTAL_SUPPLY_MAX_CONCURRENCY = 3;

// Minimal ABIs
const ERC20_TOTAL_SUPPLY_ABI = [
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

type TotalSupplyContract = {
  address: `0x${string}`;
  abi: typeof ERC20_TOTAL_SUPPLY_ABI;
  functionName: "totalSupply";
};

type TotalSupplyResult =
  | { status: "success"; result: bigint }
  | { status: "failure"; error: Error };

async function fetchTotalSuppliesResilient(
  client: PublicClient,
  contracts: TotalSupplyContract[],
  chainId: number
): Promise<TotalSupplyResult[]> {
  const results: TotalSupplyResult[] = new Array(contracts.length);
  const chunks: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < contracts.length; i += TOTAL_SUPPLY_CHUNK_SIZE) {
    chunks.push({ start: i, end: Math.min(i + TOTAL_SUPPLY_CHUNK_SIZE, contracts.length) });
  }

  for (let i = 0; i < chunks.length; i += TOTAL_SUPPLY_MAX_CONCURRENCY) {
    const wave = chunks.slice(i, i + TOTAL_SUPPLY_MAX_CONCURRENCY);
    await Promise.all(
      wave.map(async ({ start, end }) => {
        const slice = contracts.slice(start, end);
        try {
          const out = await client.multicall({ contracts: slice, allowFailure: true });
          for (let j = 0; j < out.length; j++) {
            results[start + j] = out[j] as TotalSupplyResult;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
          console.warn(
            `[Compute] Chain ${chainId}: totalSupply chunk failed (${slice.length} positions): ${msg}`
          );
          const err = error instanceof Error ? error : new Error(String(error));
          for (let j = 0; j < slice.length; j++) {
            results[start + j] = { status: "failure", error: err };
          }
        }
      })
    );
  }

  return results;
}

/**
 * Filter positions: remove dust (<$1) and zero-balance (closed) positions
 */
export function filterPositions(
  positions: CurrentApePositionFragment[]
): CurrentApePositionFragment[] {
  return positions.filter(
    (p) =>
      parseFloat(p.dollarTotal) >= MIN_DOLLAR_TOTAL &&
      BigInt(p.balance) > 0n
  );
}

/**
 * Compute PnL for a batch of positions and write to Redis
 */
export async function computeAndWritePositions(
  positions: CurrentApePositionFragment[],
  chainId: number,
  config: ChainConfig,
  redis: RedisClientType,
  prices: Record<string, number>
): Promise<number> {
  const filtered = filterPositions(positions);
  if (filtered.length === 0) return 0;

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, { timeout: 30_000 }),
  });

  // Build totalSupply multicall contracts
  const totalSupplyContracts = filtered.map((pos) => ({
    address: pos.vault.ape.id as `0x${string}`,
    abi: ERC20_TOTAL_SUPPLY_ABI,
    functionName: "totalSupply" as const,
  }));

  // Build unique vault IDs for getReserves call
  const uniqueVaultIds = [
    ...new Set(
      filtered.map((pos) =>
        fromHex(pos.vault.id as `0x${string}`, "number")
      )
    ),
  ];

  // Run totalSupply (chunked + soft-fail) and getReserves (split-on-failure) in parallel
  const [totalSupplyResults, vaultReserves] = await Promise.all([
    fetchTotalSuppliesResilient(client, totalSupplyContracts, chainId),
    getReservesResilient(
      client,
      config.assistantAddress as `0x${string}`,
      uniqueVaultIds,
      chainId
    ),
  ]);

  const baseFeeInBasisPoints = Math.round(config.baseFee * 10000);
  let processedCount = 0;

  // Process each position
  for (let i = 0; i < filtered.length; i++) {
    const pos = filtered[i];
    const totalSupplyResult = totalSupplyResults[i];
    const vaultId = fromHex(pos.vault.id as `0x${string}`, "number");
    const reserves = vaultReserves.get(vaultId);

    const apeTotalSupply = BigInt(
      totalSupplyResult?.status === "success"
        ? (totalSupplyResult.result as bigint)
        : 0n
    );
    const vaultCollateralReserves = reserves?.reserveApes ?? 0n;

    // Skip if data is invalid
    if (apeTotalSupply === 0n || vaultCollateralReserves === 0n) continue;

    const userApeBalance = BigInt(pos.balance);
    const userShareOfVaultCollateral =
      (userApeBalance * vaultCollateralReserves) / apeTotalSupply;

    // Apply leverage fee
    const leverageFeeMultiplier = BigInt(
      Math.round(10000 + 2 ** pos.vault.leverageTier * baseFeeInBasisPoints)
    );
    const netCollateralAfterFees =
      (userShareOfVaultCollateral * 10000n) / leverageFeeMultiplier;

    const currentCollateralAmount = +formatUnits(
      netCollateralAfterFees,
      pos.vault.collateralToken.decimals
    );

    const collateralPriceUsd =
      prices[pos.vault.collateralToken.id.toLowerCase()] ?? 0;
    const debtPriceUsd =
      prices[pos.vault.debtToken.id.toLowerCase()] ?? 0;

    const currentPositionValueUsd = currentCollateralAmount * collateralPriceUsd;
    const originalDepositValueUsd = parseFloat(pos.dollarTotal);

    const originalCollateralAmount = +formatUnits(
      BigInt(pos.collateralTotal),
      pos.vault.collateralToken.decimals
    );
    const originalDebtAmount = +formatUnits(
      BigInt(pos.debtTokenTotal),
      pos.vault.debtToken.decimals
    );

    // Entry from on-chain mint snapshot; current from live prices. Same units
    // on both sides so the arrow is meaningful. For longs we display
    // debt-per-collateral (the collateral asset priced in the debt token). For
    // shorts we invert and display collateral-per-debt (the shorted asset
    // priced in the collateral) — far more intuitive than "1 USDm = N RBT"
    // when what users care about is RBT's USDm price.
    //
    // Both fields are gated on the SAME inputs (mint amounts present + both
    // live USD prices present). If any input is missing we zero both so the
    // PriceChange renderer dashes the cell instead of rendering "entry → 0".
    // - debtTokenTotal can be 0n when the subgraph couldn't price the pair
    //   at mint (no direct V3 pool).
    // - debtPriceUsd / collateralPriceUsd can be 0 for tokens not indexed by
    //   CoinGecko and not findable via the DEX fallback.
    const isShort = isShortPair(
      pos.vault.collateralToken,
      pos.vault.debtToken,
      chainId
    );
    const canPrice =
      originalCollateralAmount > 0 &&
      originalDebtAmount > 0 &&
      collateralPriceUsd > 0 &&
      debtPriceUsd > 0;
    const entryPrice = !canPrice
      ? 0
      : isShort
        ? originalCollateralAmount / originalDebtAmount
        : originalDebtAmount / originalCollateralAmount;
    const currentPrice = !canPrice
      ? 0
      : isShort
        ? debtPriceUsd / collateralPriceUsd
        : collateralPriceUsd / debtPriceUsd;

    const pnlUsd = currentPositionValueUsd - originalDepositValueUsd;
    const pnlUsdPercentage =
      originalDepositValueUsd > 0
        ? (pnlUsd / originalDepositValueUsd) * 100
        : 0;

    const computed: ComputedPositionData = {
      user: pos.user,
      vaultId: pos.vault.id,
      leverageTier: pos.vault.leverageTier,
      collateralSymbol: pos.vault.collateralToken.symbol ?? "???",
      debtSymbol: pos.vault.debtToken.symbol ?? "???",
      collateralToken: pos.vault.collateralToken.id,
      debtToken: pos.vault.debtToken.id,
      pnlUsd,
      pnlUsdPercentage,
      dollarTotal: originalDepositValueUsd,
      currentValueUsd: currentPositionValueUsd,
      entryPrice,
      currentPrice,
      createdAt: parseInt(pos.createdAt, 10),
    };

    // Write to Redis
    await writePositionToRedis(pos.id, computed, chainId, redis);
    processedCount++;
  }

  return processedCount;
}

/**
 * Write a single position's data to Redis ZSETs and hash
 */
async function writePositionToRedis(
  positionId: string,
  computed: ComputedPositionData,
  chainId: number,
  redis: RedisClientType
): Promise<void> {
  // Build pair key (collateral:debt)
  const pairKey = `${computed.collateralToken}:${computed.debtToken}`;

  // Pipeline all Redis writes for efficiency
  const pipeline = redis.multi();

  // Sort ZSETs (score = metric, member = position ID)
  pipeline.zAdd(`leaderboard:${chainId}:zset:pnl`, {
    score: computed.pnlUsd,
    value: positionId,
  });
  pipeline.zAdd(`leaderboard:${chainId}:zset:return`, {
    score: computed.pnlUsdPercentage,
    value: positionId,
  });
  pipeline.zAdd(`leaderboard:${chainId}:zset:holding`, {
    score: computed.createdAt,
    value: positionId,
  });
  pipeline.zAdd(`leaderboard:${chainId}:zset:deposit`, {
    score: computed.dollarTotal,
    value: positionId,
  });
  pipeline.zAdd(`leaderboard:${chainId}:zset:value`, {
    score: computed.currentValueUsd,
    value: positionId,
  });

  // Filter index ZSETs (score = 0, for membership)
  pipeline.zAdd(`leaderboard:${chainId}:idx:pair:${pairKey}`, {
    score: 0,
    value: positionId,
  });
  pipeline.zAdd(`leaderboard:${chainId}:idx:lev:${computed.leverageTier}`, {
    score: 0,
    value: positionId,
  });
  pipeline.zAdd(
    `leaderboard:${chainId}:idx:pairlev:${pairKey}:${computed.leverageTier}`,
    { score: 0, value: positionId }
  );
  pipeline.zAdd(
    `leaderboard:${chainId}:idx:user:${computed.user.toLowerCase()}`,
    { score: 0, value: positionId }
  );

  // Full position metadata in hash
  const posData = {
    user: computed.user,
    vaultId: computed.vaultId,
    leverageTier: computed.leverageTier,
    collateralSymbol: computed.collateralSymbol,
    debtSymbol: computed.debtSymbol,
    collateralToken: computed.collateralToken,
    debtToken: computed.debtToken,
    pnlUsd: computed.pnlUsd,
    pnlUsdPercentage: computed.pnlUsdPercentage,
    dollarTotal: computed.dollarTotal,
    currentValueUsd: computed.currentValueUsd,
    entryPrice: computed.entryPrice,
    currentPrice: computed.currentPrice,
    createdAt: computed.createdAt,
  };
  pipeline.hSet(
    `leaderboard:${chainId}:positions`,
    positionId,
    JSON.stringify(posData)
  );

  try {
    await pipeline.exec();
  } catch (error: unknown) {
    // Handle WRONGTYPE errors from stale keys with wrong data type.
    // When a key exists as a non-ZSET (e.g. from a previous deployment),
    // zAdd fails with WRONGTYPE. Delete the bad key(s) and retry.
    if (
      error &&
      typeof error === "object" &&
      "errorIndexes" in error &&
      "replies" in error
    ) {
      const { replies, errorIndexes } = error as {
        replies: unknown[];
        errorIndexes: number[];
      };

      // Collect keys that need deletion
      const keysToDelete: string[] = [];
      // Map pipeline command index → Redis key (must match order above)
      const pipelineKeys = [
        `leaderboard:${chainId}:zset:pnl`,
        `leaderboard:${chainId}:zset:return`,
        `leaderboard:${chainId}:zset:holding`,
        `leaderboard:${chainId}:zset:deposit`,
        `leaderboard:${chainId}:zset:value`,
        `leaderboard:${chainId}:idx:pair:${pairKey}`,
        `leaderboard:${chainId}:idx:lev:${computed.leverageTier}`,
        `leaderboard:${chainId}:idx:pairlev:${pairKey}:${computed.leverageTier}`,
        `leaderboard:${chainId}:idx:user:${computed.user.toLowerCase()}`,
        `leaderboard:${chainId}:positions`,
      ];

      for (const idx of errorIndexes) {
        const reply = replies[idx];
        if (
          reply &&
          typeof reply === "object" &&
          "message" in reply &&
          typeof (reply as { message: string }).message === "string" &&
          (reply as { message: string }).message.includes("WRONGTYPE")
        ) {
          if (idx < pipelineKeys.length) {
            keysToDelete.push(pipelineKeys[idx]);
          }
        }
      }

      if (keysToDelete.length > 0) {
        console.warn(
          `[LeaderboardWorker] WRONGTYPE on keys: ${keysToDelete.join(", ")} — deleting and retrying`
        );
        for (const key of keysToDelete) {
          await redis.del(key);
        }
        // Retry the full pipeline
        const retry = redis.multi();
        retry.zAdd(`leaderboard:${chainId}:zset:pnl`, { score: computed.pnlUsd, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:zset:return`, { score: computed.pnlUsdPercentage, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:zset:holding`, { score: computed.createdAt, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:zset:deposit`, { score: computed.dollarTotal, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:zset:value`, { score: computed.currentValueUsd, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:idx:pair:${pairKey}`, { score: 0, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:idx:lev:${computed.leverageTier}`, { score: 0, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:idx:pairlev:${pairKey}:${computed.leverageTier}`, { score: 0, value: positionId });
        retry.zAdd(`leaderboard:${chainId}:idx:user:${computed.user.toLowerCase()}`, { score: 0, value: positionId });
        retry.hSet(`leaderboard:${chainId}:positions`, positionId, JSON.stringify(posData));
        await retry.exec();
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
}

export async function cleanupOrphanedApePositions(
  subgraphIds: Set<string>,
  chainId: number,
  redis: RedisClientType
): Promise<number> {
  const redisKeys = await redis.hKeys(`leaderboard:${chainId}:positions`);
  let removed = 0;

  for (const positionId of redisKeys) {
    if (!subgraphIds.has(positionId)) {
      await removePositionFromRedis(positionId, chainId, redis);
      removed++;
    }
  }

  return removed;
}

/**
 * Remove a position from all Redis structures (for closed positions)
 */
export async function removePositionFromRedis(
  positionId: string,
  chainId: number,
  redis: RedisClientType
): Promise<void> {
  // Get position metadata to find which indexes to clean up
  const posDataStr = await redis.hGet(
    `leaderboard:${chainId}:positions`,
    positionId
  );
  if (!posDataStr) return;

  const posData = JSON.parse(posDataStr) as ComputedPositionData;
  const pairKey = `${posData.collateralToken}:${posData.debtToken}`;

  const pipeline = redis.multi();

  // Remove from sort ZSETs
  pipeline.zRem(`leaderboard:${chainId}:zset:pnl`, positionId);
  pipeline.zRem(`leaderboard:${chainId}:zset:return`, positionId);
  pipeline.zRem(`leaderboard:${chainId}:zset:holding`, positionId);
  pipeline.zRem(`leaderboard:${chainId}:zset:deposit`, positionId);
  pipeline.zRem(`leaderboard:${chainId}:zset:value`, positionId);

  // Remove from filter index ZSETs
  pipeline.zRem(`leaderboard:${chainId}:idx:pair:${pairKey}`, positionId);
  pipeline.zRem(
    `leaderboard:${chainId}:idx:lev:${posData.leverageTier}`,
    positionId
  );
  pipeline.zRem(
    `leaderboard:${chainId}:idx:pairlev:${pairKey}:${posData.leverageTier}`,
    positionId
  );
  pipeline.zRem(
    `leaderboard:${chainId}:idx:user:${posData.user.toLowerCase()}`,
    positionId
  );

  // Remove from hash
  pipeline.hDel(`leaderboard:${chainId}:positions`, positionId);

  try {
    await pipeline.exec();
  } catch (error: unknown) {
    // Swallow WRONGTYPE errors during removal — stale keys with wrong type
    // will be cleaned up by writePositionToRedis on the next write cycle
    if (
      error &&
      typeof error === "object" &&
      "errorIndexes" in error
    ) {
      console.warn(
        `[LeaderboardWorker] WRONGTYPE during position removal for ${positionId} — ignoring`
      );
    } else {
      throw error;
    }
  }
}
