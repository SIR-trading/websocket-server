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
import type { VaultPair } from "./subgraph.js";

// Source ranks for cross-pair partner selection (lower = higher confidence).
// Used by Step 5 to prefer CoinGecko/native/anchor partners over same-cycle
// DEX-derived ones when multiplying through a partner USD price.
const RANK_COINGECKO = 0;
const RANK_NATIVE = 0;
const RANK_ANCHOR_STUB = 1;
const RANK_DEX_PROBE = 2;

// Per-cycle CoinGecko HTTP call counter. Reset at the start of each price
// phase via resetCgCallStats() and read at the end for a single summary log
// line. Counts only the priced calls (token_price + native), not the
// key-type detection ping in coingecko.ts.
export const cgCallStats = { tokenPrice: 0, native: 0 };

export function resetCgCallStats(): void {
  cgCallStats.tokenPrice = 0;
  cgCallStats.native = 0;
}

function isUsablePairAddress(addr: string): boolean {
  try {
    getAddress(addr);
    return true;
  } catch {
    return false;
  }
}

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
export const FEE_TIERS = [100, 500, 3000, 10000] as const; // 0.01%, 0.05%, 0.3%, 1%

/** A token used as the quote side of a DEX pool probe. */
export interface QuoteToken {
  /** Lowercased token address. */
  address: string;
  /** USD price of this quote token. Tokens probed against it scale by this. */
  usdPrice: number;
  /** ERC20 decimals of this quote token. */
  decimals: number;
}

/** Identifies a specific V3 pool by its quote-token side + fee tier. */
export interface PoolHint {
  /** Lowercased quote token address (wrapped native, or a stablecoin anchor). */
  quote: string;
  /** V3 fee tier. Must be in FEE_TIERS. */
  fee: number;
}

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

  cgCallStats.tokenPrice += 1;
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
 * Fetch native-token USD prices for every configured chain in a single
 * CoinGecko /simple/price call. Collects the unique `coingeckoNativeId`
 * values (e.g. "ethereum", "hyperliquid") across configs and returns
 * { [coinId]: usd } for entries with usd > 0. Returns {} when no chain
 * has a native id or on any error.
 */
export async function fetchNativePrices(
  configs: ChainConfig[]
): Promise<Record<string, number>> {
  const ids = [
    ...new Set(
      configs
        .map((c) => c.coingeckoNativeId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  if (ids.length === 0) return {};

  const cg = await getCoingeckoConfig();
  const headers: HeadersInit = { accept: "application/json" };
  if (cg.headerKey && cg.apiKey) {
    headers[cg.headerKey] = cg.apiKey;
  }

  cgCallStats.native += 1;
  try {
    const response = await fetch(
      `${cg.baseUrl}/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
      { headers }
    );

    if (!response.ok) {
      console.warn(`[Prices] CoinGecko native price returned ${response.status}`);
      return {};
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    const prices: Record<string, number> = {};
    for (const [id, priceData] of Object.entries(data)) {
      if (priceData?.usd && priceData.usd > 0) {
        prices[id] = priceData.usd;
      }
    }
    return prices;
  } catch (error) {
    console.error("[Prices] CoinGecko native price fetch failed:", error);
    return {};
  }
}

// DEX-fallback chunking: keep each multicall small enough to survive flaky
// RPCs (e.g. MegaETH) and let unrelated chunks succeed when one times out.
const DEX_TOKENS_PER_CHUNK = 1; // 1 token × 4 fees × 3 fns = 12 sub-calls
const DEX_MAX_CONCURRENCY = 3;

interface DexProbeOutput {
  /** USD price keyed by lowercased token address. */
  prices: Record<string, number>;
  /** Winning (quote, fee) per token, lowercased. Only set when liquidity > 0. */
  winningPools: Map<string, PoolHint>;
}

/**
 * Probe a token across (quoteToken × feeTier) combinations in a single multicall
 * and pick the pool with highest liquidity. Returns null on RPC error or when
 * no probed pool has positive liquidity.
 */
async function probeTokenFeeTiers(
  tokenAddress: string,
  tokenDecimals: number,
  quoteTokens: readonly QuoteToken[],
  feeTiers: readonly number[],
  config: ChainConfig,
  client: PublicClient,
  chainId: number
): Promise<{ priceUsd: number; quote: string; fee: number } | null> {
  if (quoteTokens.length === 0 || feeTiers.length === 0) return null;

  const contracts: Array<{
    address: `0x${string}`;
    abi: typeof UniswapV3PoolABI;
    functionName: "slot0" | "liquidity" | "token0";
  }> = [];

  for (const quote of quoteTokens) {
    for (const fee of feeTiers) {
      const poolAddress = computePoolAddress(
        tokenAddress,
        quote.address,
        fee,
        config.v3Factory!,
        config.v3PoolInitCodeHash!
      ) as `0x${string}`;
      for (const fn of ["slot0", "liquidity", "token0"] as const) {
        contracts.push({ address: poolAddress, abi: UniswapV3PoolABI, functionName: fn });
      }
    }
  }

  let results;
  try {
    results = await client.multicall({ contracts, allowFailure: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(
      `[Prices] Chain ${chainId}: DEX probe failed for ${tokenAddress} (${quoteTokens.length} quotes × ${feeTiers.length} tiers): ${msg}`
    );
    return null;
  }

  let bestLiquidity = 0n;
  let bestPriceUsd: number | null = null;
  let winningQuote: string | null = null;
  let winningFee: number | null = null;

  let resultIdx = 0;
  for (const quote of quoteTokens) {
    for (const fee of feeTiers) {
      const slot0Result = results[resultIdx];
      const liquidityResult = results[resultIdx + 1];
      const token0Result = results[resultIdx + 2];
      resultIdx += 3;

      if (
        slot0Result?.status !== "success" ||
        liquidityResult?.status !== "success" ||
        token0Result?.status !== "success"
      ) {
        continue;
      }

      const liquidity = liquidityResult.result as bigint;
      if (liquidity <= bestLiquidity) continue;

      const slot0 = slot0Result.result as readonly [bigint, number, number, number, number, number, boolean];
      const sqrtPriceX96 = slot0[0];
      const token0 = (token0Result.result as string).toLowerCase();
      const isToken0 = token0 === tokenAddress.toLowerCase();
      const priceInQuote = sqrtPriceX96ToPrice(
        sqrtPriceX96,
        isToken0 ? tokenDecimals : quote.decimals,
        isToken0 ? quote.decimals : tokenDecimals,
        isToken0
      );

      bestLiquidity = liquidity;
      bestPriceUsd = priceInQuote * quote.usdPrice;
      winningQuote = quote.address;
      winningFee = fee;
    }
  }

  if (bestPriceUsd === null || winningQuote === null || winningFee === null) return null;
  return { priceUsd: bestPriceUsd, quote: winningQuote, fee: winningFee };
}

/**
 * Price a single token. Tries the hinted (quote, fee) pool first (3 sub-calls);
 * on miss, falls back to a full probe across all quote tokens × all fee tiers.
 */
async function priceTokenChunk(
  tokenAddress: string,
  tokenDecimals: number,
  quoteTokens: readonly QuoteToken[],
  config: ChainConfig,
  client: PublicClient,
  chainId: number,
  hint: PoolHint | undefined
): Promise<{ priceUsd: number | null; winningPool: PoolHint | null }> {
  // 1. Try the hinted (quote, fee) pool (3 sub-calls).
  if (hint !== undefined) {
    const hintedQuote = quoteTokens.find((q) => q.address === hint.quote);
    if (hintedQuote) {
      const hinted = await probeTokenFeeTiers(
        tokenAddress, tokenDecimals, [hintedQuote], [hint.fee], config, client, chainId
      );
      if (hinted) {
        return {
          priceUsd: hinted.priceUsd,
          winningPool: { quote: hinted.quote, fee: hinted.fee },
        };
      }
    }
    // Fall through: hinted pool gone, quote no longer configured, or RPC error.
  }

  // 2. Full probe across all quote tokens × all fee tiers.
  const full = await probeTokenFeeTiers(
    tokenAddress, tokenDecimals, quoteTokens, FEE_TIERS, config, client, chainId
  );
  if (!full) return { priceUsd: null, winningPool: null };
  return {
    priceUsd: full.priceUsd,
    winningPool: { quote: full.quote, fee: full.fee },
  };
}

/**
 * Fetch DEX prices for tokens not found on CoinGecko.
 * Chunked + bounded-concurrency: a flaky RPC kills only its chunk, not the cycle.
 * Probes against every configured quote token (wrapped native + stablecoin anchors)
 * and picks the highest-liquidity pool.
 */
async function fetchDexPrices(
  tokens: string[],
  decimals: Record<string, number>,
  quoteTokens: readonly QuoteToken[],
  config: ChainConfig,
  client: PublicClient,
  chainId: number,
  hints: Map<string, PoolHint>
): Promise<DexProbeOutput> {
  const out: DexProbeOutput = { prices: {}, winningPools: new Map() };
  if (
    tokens.length === 0 ||
    quoteTokens.length === 0 ||
    !config.v3Factory ||
    !config.v3PoolInitCodeHash
  ) {
    return out;
  }

  // Skip self-pricing for tokens that are themselves quote tokens: they're
  // already seeded into the price map upstream and have no meaningful pool
  // against themselves.
  const quoteSet = new Set(quoteTokens.map((q) => q.address));
  const dexTokens: string[] = [];
  for (const t of tokens) {
    if (!quoteSet.has(t.toLowerCase())) dexTokens.push(t);
  }

  for (let i = 0; i < dexTokens.length; i += DEX_MAX_CONCURRENCY) {
    const wave = dexTokens.slice(i, i + DEX_MAX_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((token) => {
        const tokenLower = token.toLowerCase();
        const tokenDecimals = decimals[tokenLower] ?? decimals[token] ?? 18;
        return priceTokenChunk(
          token,
          tokenDecimals,
          quoteTokens,
          config,
          client,
          chainId,
          hints.get(tokenLower)
        ).then((r) => ({ token, ...r }));
      })
    );
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const { token, priceUsd, winningPool } = r.value;
      if (priceUsd !== null) out.prices[token.toLowerCase()] = priceUsd;
      if (winningPool !== null) out.winningPools.set(token.toLowerCase(), winningPool);
    }
  }

  return out;
}

export interface FetchPricesResult {
  prices: Record<string, number>;
  /** Winning (quote, fee) per lowercased token address. Caller persists for next-cycle hints. */
  winningPools: Map<string, PoolHint>;
  /**
   * Count of prices obtained from real sources (CoinGecko, native fallback,
   * DEX probes). Excludes anchor seeds — a map containing *only* anchor
   * stubs has `derivedCount === 0` and the caller must treat that as empty,
   * to avoid overwriting a previously-fresh cache with $1 placeholders.
   */
  derivedCount: number;
}

/**
 * Fetch prices for tokens using CoinGecko (primary) + DEX (fallback).
 * Optional `hints` map (lowercased token → winning pool) skips exhaustive
 * probing on the DEX path; on a hint miss the function falls back to a full
 * probe across all configured quote tokens × fee tiers.
 */
export async function fetchPrices(
  config: ChainConfig,
  tokens: Map<string, { decimals: number }>,
  hints: Map<string, PoolHint> = new Map(),
  pairs: VaultPair[] = [],
  nativePrices: Record<string, number> = {}
): Promise<FetchPricesResult> {
  if (tokens.size === 0)
    return { prices: {}, winningPools: new Map(), derivedCount: 0 };

  const tokenAddresses = Array.from(tokens.keys());
  const decimalsMap: Record<string, number> = {};
  tokens.forEach((v, k) => {
    decimalsMap[k] = v.decimals;
  });

  const priceMap: Record<string, number> = {};
  const winningPools = new Map<string, PoolHint>();
  // Tracks where each price came from. Step 5 reads this to prefer
  // high-confidence partners (CoinGecko/native/anchor) over same-cycle
  // DEX-derived ones when multiplying through a partner USD price.
  const sourceRank = new Map<string, number>();
  const wrappedNativeLower = config.wrappedNative.toLowerCase();
  let derivedCount = 0;

  // Step 1: Try CoinGecko first for all tokens
  if (config.coingeckoPlatform) {
    const cgPrices = await fetchCoinGeckoPrices(
      tokenAddresses,
      config.coingeckoPlatform
    );
    Object.assign(priceMap, cgPrices);
    for (const addr of Object.keys(cgPrices)) sourceRank.set(addr, RANK_COINGECKO);
    derivedCount += Object.keys(cgPrices).length;
  }

  // Step 2: Ensure wrapped native has a price (use the native coin-id price
  // fetched once per cycle for all chains if the contract lookup failed).
  if (!priceMap[wrappedNativeLower] && config.coingeckoNativeId) {
    const nativePrice = nativePrices[config.coingeckoNativeId] ?? 0;
    if (nativePrice > 0) {
      priceMap[wrappedNativeLower] = nativePrice;
      sourceRank.set(wrappedNativeLower, RANK_NATIVE);
      derivedCount += 1;
    }
  }

  // Step 3: Seed stablecoin anchors as a fallback for tokens CoinGecko didn't
  // price. CoinGecko wins when present so a real depeg is respected instead of
  // being overridden by the hardcoded $1 assumption. Anchor seeds intentionally
  // do NOT bump `derivedCount` — they are stubs, not real prices, and we don't
  // want an anchor-only result to overwrite a previously-fresh Redis cache.
  const anchorQuotes: QuoteToken[] = [];
  if (config.stablecoinAnchors) {
    for (const anchor of config.stablecoinAnchors) {
      const addrLower = anchor.address.toLowerCase();
      if (priceMap[addrLower] === undefined && anchor.usdPrice > 0) {
        priceMap[addrLower] = anchor.usdPrice;
        sourceRank.set(addrLower, RANK_ANCHOR_STUB);
      }
      const usdPrice = priceMap[addrLower] ?? 0;
      if (usdPrice > 0) {
        anchorQuotes.push({
          address: addrLower,
          usdPrice,
          decimals: anchor.decimals,
        });
      }
    }
  }

  // Build a single DEX client reused by Step 3.5 and Step 4 (lazy: not all
  // chains have a V3 factory configured, e.g. some testnets).
  const dexClient =
    config.v3Factory && config.v3PoolInitCodeHash
      ? createPublicClient({
          chain: mainnet, // Chain doesn't affect RPC URL, just types
          transport: http(config.rpcUrl, { timeout: 30_000 }),
        })
      : null;

  // Step 3.5: Bootstrap wrapped-native USD price via a WETH/anchor DEX pool
  // when CoinGecko didn't supply one. Without this, Step 4 below builds
  // `quoteTokens` from anchors only — so any token with liquidity solely
  // against WETH (e.g. SIR/WETH on MegaETH) silently drops out of the cache
  // during a CG outage, even though its pool is fine on-chain.
  if (
    priceMap[wrappedNativeLower] === undefined &&
    anchorQuotes.length > 0 &&
    dexClient
  ) {
    const wethProbe = await fetchDexPrices(
      [wrappedNativeLower],
      { [wrappedNativeLower]: 18 },
      anchorQuotes,
      config,
      dexClient,
      config.chainId,
      hints
    );
    const wethPrice = wethProbe.prices[wrappedNativeLower];
    const winningPool = wethProbe.winningPools.get(wrappedNativeLower);
    if (wethPrice !== undefined && wethPrice > 0) {
      priceMap[wrappedNativeLower] = wethPrice;
      sourceRank.set(wrappedNativeLower, RANK_DEX_PROBE);
      derivedCount += 1;
      if (winningPool) winningPools.set(wrappedNativeLower, winningPool);
      console.log(
        `[Prices] Chain ${config.chainId}: Bootstrapped ${config.wrappedNativeSymbol} @ $${wethPrice.toPrecision(6)} via anchor ${winningPool?.quote} (fee ${winningPool?.fee})`
      );
    } else {
      console.warn(
        `[Prices] Chain ${config.chainId}: ${config.wrappedNativeSymbol} bootstrap failed against ${anchorQuotes.length} anchor(s); tokens priced only against ${config.wrappedNativeSymbol} will be skipped this cycle`
      );
    }
  }

  // Find tokens still missing prices
  const missingTokens = tokenAddresses.filter(
    (t) => priceMap[t.toLowerCase()] === undefined
  );

  // Step 4: Fallback to DEX for missing tokens. Quote tokens = wrapped native
  // (when priced) + every anchor with a positive USD price. The DEX path runs
  // whenever at least one quote is usable, not just when WETH is priced.
  if (missingTokens.length > 0 && dexClient) {
    const wrappedNativeUsdPrice = priceMap[wrappedNativeLower] ?? 0;
    const quoteTokens: QuoteToken[] = [];
    if (wrappedNativeUsdPrice > 0) {
      quoteTokens.push({
        address: wrappedNativeLower,
        usdPrice: wrappedNativeUsdPrice,
        decimals: 18, // All wrapped native tokens we support are 18 decimals.
      });
    }
    quoteTokens.push(...anchorQuotes);

    if (quoteTokens.length > 0) {
      const dex = await fetchDexPrices(
        missingTokens,
        decimalsMap,
        quoteTokens,
        config,
        dexClient,
        config.chainId,
        hints
      );
      Object.assign(priceMap, dex.prices);
      for (const addr of Object.keys(dex.prices)) sourceRank.set(addr, RANK_DEX_PROBE);
      derivedCount += Object.keys(dex.prices).length;
      for (const [k, v] of dex.winningPools) winningPools.set(k, v);
    }
  }

  // Step 5: Cross-pair fallback. For tokens still missing after CoinGecko + anchor
  // DEX, probe V3 pools against SIR-pair partners that ARE already priced. The
  // pool exists on-chain (SIR created the vault) and gives us priceInPartner;
  // multiply by partner USD to get the missing token's USD price.
  //
  // Single pass: only prices known BEFORE Step 5 are usable as synthetic quotes
  // (snapshotted in `pricedBefore`). This prevents same-cycle chains where one
  // derived price would unlock another, compounding error through thin pools.
  const pricedBefore = new Set(Object.keys(priceMap));
  const stillMissing = tokenAddresses
    .map((t) => t.toLowerCase())
    .filter((t) => !pricedBefore.has(t));

  if (stillMissing.length > 0 && dexClient && pairs.length > 0) {
    // Build adjacency: token -> Set<partner>. Self-pairs and malformed
    // addresses are filtered here so Step 5's contract-list build never throws
    // out of probeTokenFeeTiers' try/catch (computePoolAddress calls getAddress
    // before the multicall).
    const adjacency = new Map<string, Set<string>>();
    for (const { collateralId, debtId } of pairs) {
      if (collateralId === debtId) continue;
      if (!isUsablePairAddress(collateralId) || !isUsablePairAddress(debtId)) continue;
      if (!adjacency.has(collateralId)) adjacency.set(collateralId, new Set());
      if (!adjacency.has(debtId)) adjacency.set(debtId, new Set());
      adjacency.get(collateralId)!.add(debtId);
      adjacency.get(debtId)!.add(collateralId);
    }

    const MAX_PARTNERS_PER_TOKEN = 3;
    const rank = (addr: string): number => sourceRank.get(addr) ?? 99;

    const probes = stillMissing
      .map((token) => {
        const partners = [...(adjacency.get(token) ?? [])]
          .filter((p) => pricedBefore.has(p) && tokens.has(p))
          .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
          .slice(0, MAX_PARTNERS_PER_TOKEN)
          .map<QuoteToken>((p) => ({
            address: p,
            usdPrice: priceMap[p],
            decimals: tokens.get(p)!.decimals,
          }));
        return partners.length > 0 ? { token, partners } : null;
      })
      .filter((x): x is { token: string; partners: QuoteToken[] } => x !== null);

    for (let i = 0; i < probes.length; i += DEX_MAX_CONCURRENCY) {
      const wave = probes.slice(i, i + DEX_MAX_CONCURRENCY);
      const settled = await Promise.allSettled(
        wave.map(({ token, partners }) =>
          priceTokenChunk(
            token,
            tokens.get(token)?.decimals ?? 18,
            partners,
            config,
            dexClient,
            config.chainId,
            hints.get(token)
          ).then((r) => ({ token, ...r }))
        )
      );
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        const { token, priceUsd, winningPool } = r.value;
        if (priceUsd !== null) {
          priceMap[token] = priceUsd;
          sourceRank.set(token, RANK_DEX_PROBE);
          derivedCount += 1;
          if (winningPool) {
            console.log(
              `[Prices] Chain ${config.chainId}: Derived ${token} @ $${priceUsd.toPrecision(6)} via partner ${winningPool.quote} (fee ${winningPool.fee})`
            );
          }
        }
        if (winningPool !== null) winningPools.set(token, winningPool);
      }
    }
  }

  return { prices: priceMap, winningPools, derivedCount };
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
