import {
  createPublicClient,
  http,
  formatUnits,
  fromHex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import type { RedisClientType } from "redis";
import type { ChainConfig } from "../../lib/config.js";
import type {
  CurrentApePositionFragment,
  ComputedPositionData,
} from "./types.js";

const MIN_DOLLAR_TOTAL = 1; // Minimum $1 deposit to filter dust/test positions

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

const ASSISTANT_GET_RESERVES_ABI = [
  {
    type: "function",
    name: "getReserves",
    inputs: [{ name: "vaultIds", type: "uint48[]" }],
    outputs: [
      {
        name: "reserves",
        type: "tuple[]",
        components: [
          { name: "reserveApes", type: "uint144" },
          { name: "reserveLPers", type: "uint144" },
          { name: "tickPriceX42", type: "int64" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

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
    transport: http(config.rpcUrl),
  });

  // Build totalSupply multicall contracts
  const totalSupplyContracts = filtered.map((pos) => ({
    address: pos.vault.ape.id as `0x${string}`,
    abi: ERC20_TOTAL_SUPPLY_ABI,
    functionName: "totalSupply" as const,
  }));

  // Build vault IDs for getReserves call
  const vaultIds = filtered.map((pos) =>
    fromHex(pos.vault.id as `0x${string}`, "number")
  );

  // Execute multicall and getReserves in parallel
  const [totalSupplyResults, reservesResult] = await Promise.all([
    client.multicall({
      contracts: totalSupplyContracts,
      allowFailure: true,
    }),
    client.readContract({
      address: config.assistantAddress as `0x${string}`,
      abi: ASSISTANT_GET_RESERVES_ABI,
      functionName: "getReserves",
      args: [vaultIds],
    }),
  ]);

  const baseFeeInBasisPoints = Math.round(config.baseFee * 10000);
  let processedCount = 0;

  // Process each position
  for (let i = 0; i < filtered.length; i++) {
    const pos = filtered[i];
    const totalSupplyResult = totalSupplyResults[i];
    const reserves = reservesResult[i];

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

    // Calculate entry price in USD from original deposit / original collateral amount
    const originalCollateralAmount = +formatUnits(
      BigInt(pos.collateralTotal),
      pos.vault.collateralToken.decimals
    );
    const entryPriceUsd =
      originalCollateralAmount > 0
        ? originalDepositValueUsd / originalCollateralAmount
        : 0;

    // Convert prices to quote terms (collateral per debt token)
    // For stablecoin quotes (USDT, USDC), debtPriceUsd ≈ 1, so this is nearly the same as USD
    const currentPrice = debtPriceUsd > 0 ? collateralPriceUsd / debtPriceUsd : 0;
    const entryPrice = debtPriceUsd > 0 ? entryPriceUsd / debtPriceUsd : 0;

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
