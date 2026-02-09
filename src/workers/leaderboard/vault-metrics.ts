import { gql } from "graphql-request";
import type { GraphQLClient } from "graphql-request";
import type { RedisClientType } from "redis";
import type { ChainConfig } from "../../lib/config.js";

// GraphQL queries - fetch ALL vaults (not filtered)
const VAULTS_APY_QUERY = gql`
  query VaultsApy {
    vaults(first: 1000, orderBy: id, orderDirection: asc) {
      id
      lpApyEwma
      lpApyLastTimestamp
      volatilityAnnual
      volatility {
        lastTimestamp
      }
    }
  }
`;

const VAULTS_FOR_METRICS_QUERY = gql`
  query VaultsForMetrics {
    vaults(first: 1000, orderBy: id, orderDirection: asc) {
      id
      rate
      reserveLPers
      teaSupply
      lockedLiquidity
      collateralToken {
        id
        decimals
      }
    }
  }
`;

interface VaultsApyResult {
  vaults: Array<{
    id: string;
    lpApyEwma: string;
    lpApyLastTimestamp: string;
    volatilityAnnual: string;
    volatility: {
      lastTimestamp: string;
    } | null;
  }>;
}

interface VaultsForMetricsResult {
  vaults: Array<{
    id: string;
    rate: string;
    reserveLPers: string;
    teaSupply: string;
    lockedLiquidity: string;
    collateralToken: {
      id: string;
      decimals: number;
    };
  }>;
}

interface VaultMetrics {
  apy: number;
  feesApy: number;
  sirRewardsApy: number;
  sirPerDay: number;
  volatilityAnnual: number | null;
  feesCount: number;
}

// Constants
const SIR_DECIMALS = 12;
const SECONDS_IN_YEAR = 365.25 * 24 * 60 * 60;
const SECONDS_PER_DAY = 86400;
const EWMA_DECAY_LAMBDA = Math.log(2) * 365.25 / 30;

function applyEwmaDecay(ewma: number, lastTimestamp: number): number {
  if (ewma <= 0 || lastTimestamp <= 0) return ewma;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const dtSeconds = nowSeconds - lastTimestamp;
  if (dtSeconds <= 0) return ewma;
  const dtYears = dtSeconds / SECONDS_IN_YEAR;
  const decayFactor = Math.exp(-EWMA_DECAY_LAMBDA * dtYears);
  return ewma * decayFactor;
}

function continuousRateToApy(rHat: number): number {
  if (rHat <= 0) return 0;
  const apy = (Math.exp(rHat) - 1) * 100;
  return Math.min(apy, 9999);
}

function calculateSirRewardsApy(
  vault: VaultsForMetricsResult["vaults"][0],
  sirAddress: string | null,
  prices: Record<string, number>
): number {
  if (!vault.rate || parseFloat(vault.rate) === 0) {
    return 0;
  }

  const ratePerSecond = parseFloat(vault.rate) / 1e12;
  const annualSirRewards = ratePerSecond * SECONDS_IN_YEAR;

  const totalLpCollateral =
    parseFloat(vault.reserveLPers) /
    Math.pow(10, vault.collateralToken.decimals);

  const teaSupply = parseFloat(vault.teaSupply);
  const lockedLiquidity = parseFloat(vault.lockedLiquidity);

  let vaultCollateral = totalLpCollateral;

  if (teaSupply > 0) {
    const externalLpRatio = Math.max(
      0,
      (teaSupply - lockedLiquidity) / teaSupply
    );
    vaultCollateral = totalLpCollateral * externalLpRatio;
  } else if (totalLpCollateral > 0) {
    vaultCollateral = 0;
  }

  if (vaultCollateral === 0) {
    return 0;
  }

  const collateralAddress = vault.collateralToken.id.toLowerCase();

  if (sirAddress && collateralAddress === sirAddress) {
    return (annualSirRewards / vaultCollateral) * 100;
  }

  const sirPrice = sirAddress ? prices[sirAddress] : 0;
  const collateralPrice = prices[collateralAddress];

  if (!sirPrice || sirPrice <= 0 || !collateralPrice || collateralPrice <= 0) {
    return 0;
  }

  return (
    ((annualSirRewards * sirPrice) / (vaultCollateral * collateralPrice)) * 100
  );
}

export async function cacheVaultMetricsForChain(
  config: ChainConfig,
  client: GraphQLClient,
  redis: RedisClientType
): Promise<void> {
  const chainId = config.chainId;

  // Fetch APY/volatility and vault data in parallel
  const [apyResult, vaultsResult] = await Promise.all([
    client
      .request<VaultsApyResult>(VAULTS_APY_QUERY)
      .catch((error) => {
        console.warn(
          `[VaultMetrics] Chain ${chainId}: Failed to fetch APY data:`,
          error.message || error
        );
        return { vaults: [] } as VaultsApyResult;
      }),
    client
      .request<VaultsForMetricsResult>(VAULTS_FOR_METRICS_QUERY)
      .catch((error) => {
        console.warn(
          `[VaultMetrics] Chain ${chainId}: Failed to fetch vault data:`,
          error.message || error
        );
        return { vaults: [] } as VaultsForMetricsResult;
      }),
  ]);

  console.log(
    `[VaultMetrics] Chain ${chainId}: Subgraph returned ${apyResult.vaults.length} APY vaults, ${vaultsResult.vaults.length} metrics vaults`
  );

  // Read prices from Redis (cached by earlier phase)
  let prices: Record<string, number> = {};
  try {
    const cached = await redis.get(`prices:${chainId}`);
    if (cached) {
      prices = JSON.parse(cached) as Record<string, number>;
      console.log(
        `[VaultMetrics] Chain ${chainId}: Loaded ${Object.keys(prices).length} token prices from Redis`
      );
    } else {
      console.warn(`[VaultMetrics] Chain ${chainId}: No prices found in Redis`);
    }
  } catch {
    console.warn(
      `[VaultMetrics] Chain ${chainId}: Failed to read prices from Redis`
    );
  }

  // SIR address from config
  const sirAddress = config.sirTokenAddress?.toLowerCase() ?? null;
  if (!sirAddress) {
    console.warn(
      `[VaultMetrics] Chain ${chainId}: No SIR token address configured`
    );
  }

  // Build APY and volatility maps
  const apyMap = new Map<string, number>();
  const volatilityMap = new Map<string, number>();

  for (const vault of apyResult.vaults) {
    const vaultIdLower = vault.id.toLowerCase();
    const rawEwma = parseFloat(vault.lpApyEwma || "0");
    const lastTimestamp = parseInt(vault.lpApyLastTimestamp || "0", 10);
    const decayedEwma = applyEwmaDecay(rawEwma, lastTimestamp);
    apyMap.set(vaultIdLower, continuousRateToApy(decayedEwma));

    const volatilityLastTimestamp = vault.volatility?.lastTimestamp
      ? parseInt(vault.volatility.lastTimestamp, 10)
      : 0;
    if (vault.volatilityAnnual && volatilityLastTimestamp > 0) {
      volatilityMap.set(vaultIdLower, parseFloat(vault.volatilityAnnual));
    }
  }

  // Build vault data map
  const vaultDataMap = new Map<
    string,
    VaultsForMetricsResult["vaults"][0]
  >();
  for (const vault of vaultsResult.vaults) {
    vaultDataMap.set(vault.id.toLowerCase(), vault);
  }

  // Collect all vault IDs from both queries
  const allVaultIds = new Set<string>();
  for (const vault of apyResult.vaults) {
    allVaultIds.add(vault.id.toLowerCase());
  }
  for (const vault of vaultsResult.vaults) {
    allVaultIds.add(vault.id.toLowerCase());
  }

  // Compute metrics for every vault
  let vaultsWithFeesApy = 0;
  let vaultsWithSirRewards = 0;
  let vaultsWithVolatility = 0;
  const allMetrics: Record<string, VaultMetrics> = {};

  for (const vaultId of allVaultIds) {
    const feesApy = apyMap.get(vaultId) ?? 0;
    const volatility = volatilityMap.get(vaultId);

    const vaultData = vaultDataMap.get(vaultId);
    const sirRewardsApy = vaultData
      ? calculateSirRewardsApy(vaultData, sirAddress, prices)
      : 0;

    const sirPerDay =
      vaultData && vaultData.rate
        ? (parseFloat(vaultData.rate) / 1e12) * SECONDS_PER_DAY
        : 0;

    const totalApy = feesApy + sirRewardsApy;

    if (feesApy > 0) vaultsWithFeesApy++;
    if (sirRewardsApy > 0) vaultsWithSirRewards++;
    if (volatility !== undefined) vaultsWithVolatility++;

    allMetrics[vaultId] = {
      apy: totalApy,
      feesApy,
      sirRewardsApy,
      sirPerDay,
      volatilityAnnual: volatility ?? null,
      feesCount: 0,
    };
  }

  console.log(
    `[VaultMetrics] Chain ${chainId}: Computed ${allVaultIds.size} vaults — ` +
    `${vaultsWithFeesApy} with feesApy, ${vaultsWithSirRewards} with sirRewards, ${vaultsWithVolatility} with volatility`
  );

  // Atomic Redis write using tmp key + rename
  const tmpKey = `vault-metrics:${chainId}:tmp`;
  const finalKey = `vault-metrics:${chainId}`;

  await redis.del(tmpKey);

  const hashEntries: Record<string, string> = {};
  for (const [vaultId, metrics] of Object.entries(allMetrics)) {
    hashEntries[vaultId] = JSON.stringify(metrics);
  }

  if (Object.keys(hashEntries).length > 0) {
    await redis.hSet(tmpKey, hashEntries);
    await redis.rename(tmpKey, finalKey);
  }

  await redis.set(
    `vault-metrics:${chainId}:updatedAt`,
    Math.floor(Date.now() / 1000).toString()
  );

  const durationMs = Date.now() - startTime;
  console.log(
    `[VaultMetrics] Chain ${chainId}: Cached metrics for ${Object.keys(allMetrics).length} vaults in ${durationMs}ms`
  );
}
