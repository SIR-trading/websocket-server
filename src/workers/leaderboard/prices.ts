import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import type { ChainConfig } from "../../lib/config.js";
import { getCoingeckoConfig } from "../../lib/coingecko.js";

// Uniswap V3 Pool ABI (minimal for price queries)
const UniswapV3PoolABI = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Fee tiers for V3-style DEXes
const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

function computePoolAddress(
  tokenA: string,
  tokenB: string,
  fee: number,
  factory: string,
  initCodeHash: string
): string {
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];

  const salt = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24"), [
      getAddress(token0),
      getAddress(token1),
      fee,
    ])
  );

  const data = keccak256(
    `0xff${factory.slice(2)}${salt.slice(2)}${initCodeHash.slice(2)}` as `0x${string}`
  );

  return getAddress(`0x${data.slice(-40)}`);
}

function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
  token0IsInput: boolean
): number {
  const price = Number(sqrtPriceX96) ** 2 / 2 ** 192;
  const adjustedPrice = (price * 10 ** decimals0) / 10 ** decimals1;
  return token0IsInput ? adjustedPrice : 1 / adjustedPrice;
}

/**
 * Fetch prices from CoinGecko (batch all tokens in one call)
 */
async function fetchCoinGeckoPrices(
  tokens: string[],
  platform: string
): Promise<Record<string, number>> {
  if (tokens.length === 0 || !platform) return {};

  const cg = await getCoingeckoConfig();
  const headers: HeadersInit = { accept: "application/json" };
  if (cg.headerKey && cg.apiKey) {
    headers[cg.headerKey] = cg.apiKey;
  }

  try {
    const addresses = tokens.map((t) => t.toLowerCase()).join(",");
    const response = await fetch(
      `${cg.baseUrl}/simple/token_price/${platform}?contract_addresses=${addresses}&vs_currencies=usd`,
      { headers }
    );

    if (!response.ok) {
      console.warn(`[Prices] CoinGecko returned ${response.status}`);
      return {};
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    const prices: Record<string, number> = {};

    for (const [addr, priceData] of Object.entries(data)) {
      if (priceData?.usd && priceData.usd > 0) {
        prices[addr.toLowerCase()] = priceData.usd;
      }
    }

    return prices;
  } catch (error) {
    console.error("[Prices] CoinGecko fetch failed:", error);
    return {};
  }
}

/**
 * Fetch native token price using CoinGecko coin ID (e.g., "ethereum", "matic-network")
 */
async function fetchNativePrice(coinId: string): Promise<number> {
  if (!coinId) return 0;

  const cg = await getCoingeckoConfig();
  const headers: HeadersInit = { accept: "application/json" };
  if (cg.headerKey && cg.apiKey) {
    headers[cg.headerKey] = cg.apiKey;
  }

  try {
    const response = await fetch(
      `${cg.baseUrl}/simple/price?ids=${coinId}&vs_currencies=usd`,
      { headers }
    );

    if (!response.ok) {
      console.warn(`[Prices] CoinGecko native price returned ${response.status}`);
      return 0;
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    return data[coinId]?.usd ?? 0;
  } catch (error) {
    console.error("[Prices] CoinGecko native price fetch failed:", error);
    return 0;
  }
}

/**
 * Fetch DEX prices for tokens not found on CoinGecko.
 * Gets token price in wrapped native, then converts to USD.
 */
async function fetchDexPrices(
  tokens: string[],
  decimals: Record<string, number>,
  config: ChainConfig,
  client: PublicClient,
  wrappedNativeUsdPrice: number
): Promise<Record<string, number>> {
  if (
    tokens.length === 0 ||
    !config.v3Factory ||
    !config.v3PoolInitCodeHash
  ) {
    return {};
  }

  const wrappedNative = config.wrappedNative.toLowerCase();
  const priceMap: Record<string, number> = {};

  // Build multicall contracts for all tokens × all fee tiers
  const multicallContracts: Array<{
    address: `0x${string}`;
    abi: typeof UniswapV3PoolABI;
    functionName: "slot0" | "liquidity" | "token0";
  }> = [];

  const contractMeta: Array<{
    tokenAddress: string;
    fee: number;
    queryType: "slot0" | "liquidity" | "token0";
  }> = [];

  for (const tokenAddress of tokens) {
    // Wrapped native token has 1:1 price with itself
    if (tokenAddress.toLowerCase() === wrappedNative) {
      priceMap[wrappedNative] = wrappedNativeUsdPrice;
      continue;
    }

    for (const fee of FEE_TIERS) {
      const poolAddress = computePoolAddress(
        tokenAddress,
        config.wrappedNative,
        fee,
        config.v3Factory!,
        config.v3PoolInitCodeHash!
      ) as `0x${string}`;

      for (const fn of ["slot0", "liquidity", "token0"] as const) {
        multicallContracts.push({
          address: poolAddress,
          abi: UniswapV3PoolABI,
          functionName: fn,
        });
        contractMeta.push({ tokenAddress, fee, queryType: fn });
      }
    }
  }

  if (multicallContracts.length === 0) return priceMap;

  // Execute multicall
  const results = await client.multicall({
    contracts: multicallContracts,
    allowFailure: true,
  });

  // Process results to find best price per token (highest liquidity pool)
  for (const tokenAddress of tokens) {
    if (tokenAddress.toLowerCase() === wrappedNative) continue;

    let bestLiquidity = 0n;
    let bestPrice: number | null = null;

    for (const fee of FEE_TIERS) {
      const slot0Index = contractMeta.findIndex(
        (m) =>
          m.tokenAddress === tokenAddress &&
          m.fee === fee &&
          m.queryType === "slot0"
      );

      if (slot0Index === -1) continue;

      const slot0Result = results[slot0Index];
      const liquidityResult = results[slot0Index + 1];
      const token0Result = results[slot0Index + 2];

      if (
        slot0Result?.status === "success" &&
        liquidityResult?.status === "success" &&
        token0Result?.status === "success"
      ) {
        const liquidity = liquidityResult.result as bigint;

        if (liquidity > bestLiquidity) {
          bestLiquidity = liquidity;

          const slot0 = slot0Result.result as readonly [
            bigint,
            number,
            number,
            number,
            number,
            number,
            boolean,
          ];
          const sqrtPriceX96 = slot0[0];
          const token0 = (token0Result.result as string).toLowerCase();

          const isToken0 = token0 === tokenAddress.toLowerCase();
          const decimalsA =
            decimals[tokenAddress.toLowerCase()] ??
            decimals[tokenAddress] ??
            18;
          const decimalsB = 18; // Wrapped native is always 18 decimals

          bestPrice = sqrtPriceX96ToPrice(
            sqrtPriceX96,
            isToken0 ? decimalsA : decimalsB,
            isToken0 ? decimalsB : decimalsA,
            isToken0
          );
        }
      }
    }

    if (bestPrice !== null && wrappedNativeUsdPrice > 0) {
      priceMap[tokenAddress.toLowerCase()] = bestPrice * wrappedNativeUsdPrice;
    }
  }

  return priceMap;
}

/**
 * Fetch prices for tokens using CoinGecko (primary) + DEX (fallback)
 */
export async function fetchPrices(
  config: ChainConfig,
  tokens: Map<string, { decimals: number }>
): Promise<Record<string, number>> {
  if (tokens.size === 0) return {};

  const tokenAddresses = Array.from(tokens.keys());
  const decimalsMap: Record<string, number> = {};
  tokens.forEach((v, k) => {
    decimalsMap[k] = v.decimals;
  });

  const priceMap: Record<string, number> = {};
  const wrappedNativeLower = config.wrappedNative.toLowerCase();

  // Step 1: Try CoinGecko first for all tokens
  if (config.coingeckoPlatform) {
    const cgPrices = await fetchCoinGeckoPrices(
      tokenAddresses,
      config.coingeckoPlatform
    );
    Object.assign(priceMap, cgPrices);
  }

  // Step 2: Ensure wrapped native has a price (use coin ID if contract lookup failed)
  if (!priceMap[wrappedNativeLower] && config.coingeckoNativeId) {
    const nativePrice = await fetchNativePrice(config.coingeckoNativeId);
    if (nativePrice > 0) {
      priceMap[wrappedNativeLower] = nativePrice;
    }
  }

  // Find tokens still missing prices
  const missingTokens = tokenAddresses.filter(
    (t) => priceMap[t.toLowerCase()] === undefined
  );

  // Step 3: Fallback to DEX for missing tokens
  if (missingTokens.length > 0 && config.v3Factory) {
    const wrappedNativeUsdPrice = priceMap[wrappedNativeLower] ?? 0;

    if (wrappedNativeUsdPrice > 0) {
      const client = createPublicClient({
        chain: mainnet, // Chain doesn't affect RPC URL, just types
        transport: http(config.rpcUrl, { timeout: 30_000 }),
      });

      const dexPrices = await fetchDexPrices(
        missingTokens,
        decimalsMap,
        config,
        client,
        wrappedNativeUsdPrice
      );
      Object.assign(priceMap, dexPrices);
    }
  }

  return priceMap;
}

/**
 * Extract unique collateral AND debt tokens from positions
 * (debt tokens needed for quote-denominated price calculations)
 */
export function getUniqueTokens(
  positions: Array<{
    vault: {
      collateralToken: { id: string; decimals: number };
      debtToken: { id: string; decimals: number };
    };
  }>
): Map<string, { decimals: number }> {
  const tokens = new Map<string, { decimals: number }>();
  for (const pos of positions) {
    // Add collateral token
    const collateralAddr = pos.vault.collateralToken.id.toLowerCase();
    if (!tokens.has(collateralAddr)) {
      tokens.set(collateralAddr, { decimals: pos.vault.collateralToken.decimals });
    }
    // Add debt token (needed for quote-denominated prices)
    const debtAddr = pos.vault.debtToken.id.toLowerCase();
    if (!tokens.has(debtAddr)) {
      tokens.set(debtAddr, { decimals: pos.vault.debtToken.decimals });
    }
  }
  return tokens;
}
