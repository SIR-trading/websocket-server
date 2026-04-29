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

// DEX-fallback chunking: keep each multicall small enough to survive flaky
// RPCs (e.g. MegaETH) and let unrelated chunks succeed when one times out.
const DEX_TOKENS_PER_CHUNK = 1; // 1 token × 4 fees × 3 fns = 12 sub-calls
const DEX_MAX_CONCURRENCY = 3;

interface DexProbeOutput {
  /** USD price keyed by lowercased token address. */
  prices: Record<string, number>;
  /** Winning fee tier per token, lowercased. Only set when liquidity > 0. */
  winningFeeTiers: Map<string, number>;
}

/**
 * Probe a token at one or more fee tiers in a single multicall and pick the
 * pool with highest liquidity. Returns null on RPC error or no positive-liquidity pool.
 */
async function probeTokenFeeTiers(
  tokenAddress: string,
  feeTiers: readonly number[],
  decimals: Record<string, number>,
  config: ChainConfig,
  client: PublicClient,
  chainId: number
): Promise<{ priceInWrappedNative: number; fee: number } | null> {
  const contracts: Array<{
    address: `0x${string}`;
    abi: typeof UniswapV3PoolABI;
    functionName: "slot0" | "liquidity" | "token0";
  }> = [];

  for (const fee of feeTiers) {
    const poolAddress = computePoolAddress(
      tokenAddress,
      config.wrappedNative,
      fee,
      config.v3Factory!,
      config.v3PoolInitCodeHash!
    ) as `0x${string}`;
    for (const fn of ["slot0", "liquidity", "token0"] as const) {
      contracts.push({ address: poolAddress, abi: UniswapV3PoolABI, functionName: fn });
    }
  }

  let results;
  try {
    results = await client.multicall({ contracts, allowFailure: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(
      `[Prices] Chain ${chainId}: DEX probe failed for ${tokenAddress} (${feeTiers.length} tiers): ${msg}`
    );
    return null;
  }

  let bestLiquidity = 0n;
  let bestPrice: number | null = null;
  let winningFee: number | null = null;

  for (let i = 0; i < feeTiers.length; i++) {
    const slot0Result = results[i * 3];
    const liquidityResult = results[i * 3 + 1];
    const token0Result = results[i * 3 + 2];

    if (
      slot0Result?.status === "success" &&
      liquidityResult?.status === "success" &&
      token0Result?.status === "success"
    ) {
      const liquidity = liquidityResult.result as bigint;
      if (liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        winningFee = feeTiers[i];
        const slot0 = slot0Result.result as readonly [bigint, number, number, number, number, number, boolean];
        const sqrtPriceX96 = slot0[0];
        const token0 = (token0Result.result as string).toLowerCase();
        const isToken0 = token0 === tokenAddress.toLowerCase();
        const decimalsA =
          decimals[tokenAddress.toLowerCase()] ?? decimals[tokenAddress] ?? 18;
        const decimalsB = 18;
        bestPrice = sqrtPriceX96ToPrice(
          sqrtPriceX96,
          isToken0 ? decimalsA : decimalsB,
          isToken0 ? decimalsB : decimalsA,
          isToken0
        );
      }
    }
  }

  if (bestPrice === null || winningFee === null) return null;
  return { priceInWrappedNative: bestPrice, fee: winningFee };
}

/**
 * Price a single token. Tries the cached fee tier first (3 sub-calls); on miss,
 * falls back to a full 4-tier probe (12 sub-calls).
 */
async function priceTokenChunk(
  tokenAddress: string,
  decimals: Record<string, number>,
  config: ChainConfig,
  client: PublicClient,
  wrappedNativeUsdPrice: number,
  chainId: number,
  hint: number | undefined
): Promise<{ priceUsd: number | null; winningFee: number | null }> {
  // 1. Try the hinted fee tier (3 sub-calls).
  if (hint !== undefined) {
    const hinted = await probeTokenFeeTiers(
      tokenAddress, [hint], decimals, config, client, chainId
    );
    if (hinted) {
      return {
        priceUsd: hinted.priceInWrappedNative * wrappedNativeUsdPrice,
        winningFee: hinted.fee,
      };
    }
    // Fall through: hinted pool gone or RPC error — re-probe all tiers.
  }

  // 2. Full 4-tier probe.
  const full = await probeTokenFeeTiers(
    tokenAddress, FEE_TIERS, decimals, config, client, chainId
  );
  if (!full) return { priceUsd: null, winningFee: null };
  return {
    priceUsd: full.priceInWrappedNative * wrappedNativeUsdPrice,
    winningFee: full.fee,
  };
}

/**
 * Fetch DEX prices for tokens not found on CoinGecko.
 * Chunked + bounded-concurrency: a flaky RPC kills only its chunk, not the cycle.
 * Uses per-token fee-tier hints (when provided) to skip exhaustive probing.
 */
async function fetchDexPrices(
  tokens: string[],
  decimals: Record<string, number>,
  config: ChainConfig,
  client: PublicClient,
  wrappedNativeUsdPrice: number,
  chainId: number,
  hints: Map<string, number>
): Promise<DexProbeOutput> {
  const out: DexProbeOutput = { prices: {}, winningFeeTiers: new Map() };
  if (tokens.length === 0 || !config.v3Factory || !config.v3PoolInitCodeHash) {
    return out;
  }

  const wrappedNative = config.wrappedNative.toLowerCase();
  const dexTokens: string[] = [];
  for (const t of tokens) {
    if (t.toLowerCase() === wrappedNative) {
      out.prices[wrappedNative] = wrappedNativeUsdPrice;
    } else {
      dexTokens.push(t);
    }
  }

  for (let i = 0; i < dexTokens.length; i += DEX_MAX_CONCURRENCY) {
    const wave = dexTokens.slice(i, i + DEX_MAX_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((token) =>
        priceTokenChunk(
          token,
          decimals,
          config,
          client,
          wrappedNativeUsdPrice,
          chainId,
          hints.get(token.toLowerCase())
        ).then((r) => ({ token, ...r }))
      )
    );
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const { token, priceUsd, winningFee } = r.value;
      if (priceUsd !== null) out.prices[token.toLowerCase()] = priceUsd;
      if (winningFee !== null) out.winningFeeTiers.set(token.toLowerCase(), winningFee);
    }
  }

  return out;
}

export interface FetchPricesResult {
  prices: Record<string, number>;
  /** Winning V3 fee tier per lowercased token address. Caller persists for next-cycle hints. */
  winningFeeTiers: Map<string, number>;
}

/**
 * Fetch prices for tokens using CoinGecko (primary) + DEX (fallback).
 * Optional `hints` map (lowercased token → fee tier) skips exhaustive 4-tier
 * probing on the DEX path; on a hint miss the function falls back to a full probe.
 */
export async function fetchPrices(
  config: ChainConfig,
  tokens: Map<string, { decimals: number }>,
  hints: Map<string, number> = new Map()
): Promise<FetchPricesResult> {
  if (tokens.size === 0) return { prices: {}, winningFeeTiers: new Map() };

  const tokenAddresses = Array.from(tokens.keys());
  const decimalsMap: Record<string, number> = {};
  tokens.forEach((v, k) => {
    decimalsMap[k] = v.decimals;
  });

  const priceMap: Record<string, number> = {};
  const winningFeeTiers = new Map<string, number>();
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

      const dex = await fetchDexPrices(
        missingTokens,
        decimalsMap,
        config,
        client,
        wrappedNativeUsdPrice,
        config.chainId,
        hints
      );
      Object.assign(priceMap, dex.prices);
      for (const [k, v] of dex.winningFeeTiers) winningFeeTiers.set(k, v);
    }
  }

  return { prices: priceMap, winningFeeTiers };
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
