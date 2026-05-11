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
  CurrentTeaPositionFragment,
  ComputedTeaPositionData,
} from "./types.js";
import { getReservesResilient } from "./reserves.js";

const MIN_DOLLAR_TOTAL = 1;

const VAULT_UNCLAIMED_REWARDS_ABI = [
  {
    type: "function",
    name: "unclaimedRewards",
    inputs: [
      { name: "vaultId", type: "uint256" },
      { name: "lper", type: "address" },
    ],
    outputs: [{ name: "", type: "uint80" }],
    stateMutability: "view",
  },
] as const;

export function filterTeaPositions(
  positions: CurrentTeaPositionFragment[],
  vaultAddress: string
): CurrentTeaPositionFragment[] {
  // POL is held by the vault contract itself; donated TEA must never appear
  // as a user position on the leaderboard.
  const vaultLower = vaultAddress.toLowerCase();
  return positions.filter(
    (p) =>
      parseFloat(p.dollarTotal) >= MIN_DOLLAR_TOTAL &&
      BigInt(p.balance) > 0n &&
      p.user.toLowerCase() !== vaultLower
  );
}

const UNCLAIMED_BATCH_SIZE = 100;

export async function computeAndWriteTeaPositions(
  positions: CurrentTeaPositionFragment[],
  chainId: number,
  config: ChainConfig,
  redis: RedisClientType,
  prices: Record<string, number>
): Promise<number> {
  const filtered = filterTeaPositions(positions, config.vaultAddress);
  if (filtered.length === 0) return 0;

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, { timeout: 30_000 }),
  });

  // Build unique vault IDs for getReserves call
  const uniqueVaultIds = [
    ...new Set(
      filtered.map((pos) =>
        fromHex(pos.vault.id as `0x${string}`, "number")
      )
    ),
  ];

  // Fetch reserves with split-on-failure resilience
  const vaultReserves = await getReservesResilient(
    client,
    config.assistantAddress as `0x${string}`,
    uniqueVaultIds,
    chainId
  );

  // Fetch unclaimedRewards in batches; soft-fail per batch so a single
  // RPC timeout doesn't abort the entire TEA cycle.
  const unclaimedMap = new Map<string, bigint>();
  for (let i = 0; i < filtered.length; i += UNCLAIMED_BATCH_SIZE) {
    const batch = filtered.slice(i, i + UNCLAIMED_BATCH_SIZE);
    const contracts = batch.map((pos) => ({
      address: config.vaultAddress as `0x${string}`,
      abi: VAULT_UNCLAIMED_REWARDS_ABI,
      functionName: "unclaimedRewards" as const,
      args: [
        fromHex(pos.vault.id as `0x${string}`, "number"),
        pos.user as `0x${string}`,
      ],
    }));

    let results;
    try {
      results = await client.multicall({ contracts, allowFailure: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.warn(
        `[TeaCompute] Chain ${chainId}: unclaimedRewards batch failed (${batch.length} positions): ${msg}`
      );
      for (const pos of batch) unclaimedMap.set(pos.id, 0n);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      const unclaimed =
        result?.status === "success"
          ? BigInt(result.result as bigint)
          : 0n;
      unclaimedMap.set(batch[j].id, unclaimed);
    }
  }

  let processedCount = 0;

  for (const pos of filtered) {
    const vaultId = fromHex(pos.vault.id as `0x${string}`, "number");
    const reserves = vaultReserves.get(vaultId);
    const teaSupply = BigInt(pos.vault.teaSupply);
    const reserveLPers = reserves?.reserveLPers ?? 0n;

    if (teaSupply === 0n || reserveLPers === 0n) continue;

    const userBalance = BigInt(pos.balance);
    // Multiply first to avoid truncation
    const userCollateral = (userBalance * reserveLPers) / teaSupply;

    const collateralDecimals = pos.vault.collateralToken.decimals;
    const currentCollateralAmount = +formatUnits(
      userCollateral,
      collateralDecimals
    );

    const collateralPriceUsd =
      prices[pos.vault.collateralToken.id.toLowerCase()] ?? 0;
    const currentValueUsd = currentCollateralAmount * collateralPriceUsd;
    const dollarTotal = parseFloat(pos.dollarTotal);

    const pnlUsd = currentValueUsd - dollarTotal;
    const pnlUsdPercentage =
      dollarTotal > 0 ? (pnlUsd / dollarTotal) * 100 : 0;

    // Per-token PnL: collateral and debt
    const debtDecimals = pos.vault.debtToken.decimals;
    const initialCollateral = +formatUnits(BigInt(pos.collateralTotal), collateralDecimals);
    const initialDebt = +formatUnits(BigInt(pos.debtTokenTotal), debtDecimals);

    // Convert current collateral to debt equivalent via on-chain TWAP
    // reserves is guaranteed to exist here since reserveLPers > 0n check passed above
    const tickPriceX42 = reserves!.tickPriceX42;
    const tickDecimal = Number(tickPriceX42) / (2 ** 42);
    const rawPriceRatio = Math.pow(1.0001, tickDecimal);
    const decimalAdjustment = Math.pow(10, collateralDecimals - debtDecimals);
    const currentDebtEquivalent = currentCollateralAmount * rawPriceRatio * decimalAdjustment;

    const pnlCollateral = currentCollateralAmount - initialCollateral;
    const pnlDebt = currentDebtEquivalent - initialDebt;
    const pnlPercentCollateral = initialCollateral > 0 ? (pnlCollateral / initialCollateral) * 100 : null;
    const pnlPercentDebt = initialDebt > 0 ? (pnlDebt / initialDebt) * 100 : null;

    // SIR: claimed (from subgraph) + unclaimed (from on-chain)
    const claimedSir = +formatUnits(BigInt(pos.claimedSir), 12);
    const unclaimedSir = +formatUnits(unclaimedMap.get(pos.id) ?? 0n, 12);
    const totalSir = claimedSir + unclaimedSir;

    const computed: ComputedTeaPositionData = {
      user: pos.user,
      vaultId: pos.vault.id,
      leverageTier: pos.vault.leverageTier,
      collateralSymbol: pos.vault.collateralToken.symbol ?? "???",
      debtSymbol: pos.vault.debtToken.symbol ?? "???",
      collateralToken: pos.vault.collateralToken.id,
      debtToken: pos.vault.debtToken.id,
      currentValueUsd,
      dollarTotal,
      pnlUsd,
      pnlUsdPercentage,
      pnlCollateral,
      pnlDebt,
      pnlPercentCollateral,
      pnlPercentDebt,
      collateralDecimals,
      debtDecimals,
      lockEnd: parseInt(pos.lockEnd, 10),
      totalSir,
      createdAt: parseInt(pos.createdAt, 10),
    };

    await writeTeaPositionToRedis(pos.id, computed, chainId, redis);
    processedCount++;
  }

  return processedCount;
}

async function writeTeaPositionToRedis(
  positionId: string,
  computed: ComputedTeaPositionData,
  chainId: number,
  redis: RedisClientType
): Promise<void> {
  const pairKey = `${computed.collateralToken}:${computed.debtToken}`;
  const prefix = `leaderboard:${chainId}:lp`;

  const pipeline = redis.multi();

  // Sort ZSETs
  pipeline.zAdd(`${prefix}:zset:value`, {
    score: computed.currentValueUsd,
    value: positionId,
  });
  pipeline.zAdd(`${prefix}:zset:pnl`, {
    score: computed.pnlUsd,
    value: positionId,
  });
  pipeline.zAdd(`${prefix}:zset:return`, {
    score: computed.pnlUsdPercentage,
    value: positionId,
  });
  pipeline.zAdd(`${prefix}:zset:sir`, {
    score: computed.totalSir,
    value: positionId,
  });
  pipeline.zAdd(`${prefix}:zset:holding`, {
    score: computed.createdAt,
    value: positionId,
  });

  // Filter index ZSETs
  pipeline.zAdd(`${prefix}:idx:pair:${pairKey}`, {
    score: 0,
    value: positionId,
  });
  pipeline.zAdd(`${prefix}:idx:user:${computed.user.toLowerCase()}`, {
    score: 0,
    value: positionId,
  });

  // Full position metadata in hash
  pipeline.hSet(
    `${prefix}:positions`,
    positionId,
    JSON.stringify(computed)
  );

  await pipeline.exec();
}

export async function cleanupOrphanedTeaPositions(
  subgraphIds: Set<string>,
  chainId: number,
  redis: RedisClientType
): Promise<number> {
  const redisKeys = await redis.hKeys(`leaderboard:${chainId}:lp:positions`);
  let removed = 0;

  for (const positionId of redisKeys) {
    if (!subgraphIds.has(positionId)) {
      await removeTeaPositionFromRedis(positionId, chainId, redis);
      removed++;
    }
  }

  return removed;
}

export async function removeTeaPositionFromRedis(
  positionId: string,
  chainId: number,
  redis: RedisClientType
): Promise<void> {
  const prefix = `leaderboard:${chainId}:lp`;
  const posDataStr = await redis.hGet(`${prefix}:positions`, positionId);
  if (!posDataStr) return;

  const posData = JSON.parse(posDataStr) as ComputedTeaPositionData;
  const pairKey = `${posData.collateralToken}:${posData.debtToken}`;

  const pipeline = redis.multi();

  pipeline.zRem(`${prefix}:zset:value`, positionId);
  pipeline.zRem(`${prefix}:zset:pnl`, positionId);
  pipeline.zRem(`${prefix}:zset:return`, positionId);
  pipeline.zRem(`${prefix}:zset:sir`, positionId);
  pipeline.zRem(`${prefix}:zset:holding`, positionId);
  pipeline.zRem(`${prefix}:idx:pair:${pairKey}`, positionId);
  pipeline.zRem(`${prefix}:idx:user:${posData.user.toLowerCase()}`, positionId);
  pipeline.hDel(`${prefix}:positions`, positionId);

  await pipeline.exec();
}
