export interface StablecoinAnchor {
  /** Token address. Stored as configured; normalized to lowercase at use sites. */
  address: string;
  /** Seeded USD price used as a fallback when CoinGecko has no entry for this token. */
  usdPrice: number;
  /** ERC20 decimals. Wrong value silently scales every price quoted off this anchor. */
  decimals: number;
}

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  subgraphUrl: string;
  subgraphApiKey?: string;
  assistantAddress: string;
  vaultAddress: string;
  baseFee: number; // In decimal form (e.g., 0.1 = 10%)
  coingeckoPlatform?: string;
  coingeckoNativeId?: string; // CoinGecko coin ID for native token (e.g., "ethereum")
  wrappedNative: string;
  wrappedNativeSymbol: string;
  v3Factory?: string;
  v3PoolInitCodeHash?: string;
  sirTokenAddress?: string; // SIR token address on this chain
  /**
   * Stablecoin tokens used as quote-side anchors in the DEX price fallback.
   * Seeded into the price map when CoinGecko has no entry, and probed as quote
   * tokens alongside wrapped native so tokens paired only against a stable
   * (e.g. DIRTY/USDM on MegaETH) still get priced.
   */
  stablecoinAnchors?: StablecoinAnchor[];
}

// Chain-specific constants (from App's prices API)
const CHAIN_CONSTANTS: Record<
  number,
  {
    wrappedNative: string;
    wrappedNativeSymbol: string;
    v3Factory?: string;
    v3PoolInitCodeHash?: string;
    coingeckoPlatform?: string;
    coingeckoNativeId?: string;
    stablecoinAnchors?: StablecoinAnchor[];
  }
> = {
  1: {
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    wrappedNativeSymbol: "WETH",
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v3PoolInitCodeHash:
      "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
    coingeckoPlatform: "ethereum",
    coingeckoNativeId: "ethereum",
    // Quote-side anchors used by the DEX fallback when CoinGecko is
    // unavailable. Without these, a CG outage drops the entire cache for
    // chain 1 because Step 4 has no priced quote token to probe against.
    stablecoinAnchors: [
      {
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
        usdPrice: 1,
        decimals: 6,
      },
      {
        address: "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48", // USDC
        usdPrice: 1,
        decimals: 6,
      },
    ],
  },
  999: {
    wrappedNative: "0x5555555555555555555555555555555555555555",
    wrappedNativeSymbol: "WHYPE",
    v3Factory: "0xB1c0fa0B789320044A6F623cFe5eBda9562602E3",
    v3PoolInitCodeHash:
      "0xe3572921be1688dba92df30c6781b8770499ff274d20ae9b325f4242634774fb",
    coingeckoPlatform: "hyperevm",
    coingeckoNativeId: "hyperliquid", // HYPE token
    stablecoinAnchors: [
      {
        // USD₮0 — LayerZero OFT-bridged USDT on HyperEVM, 6 decimals.
        address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
        usdPrice: 1,
        decimals: 6,
      },
    ],
  }, 4326: {
    wrappedNative: "0x4200000000000000000000000000000000000006",
    wrappedNativeSymbol: "WETH",
    v3Factory: "0x68b34591f662508076927803c567Cc8006988a09",
    v3PoolInitCodeHash: "0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7",
    coingeckoPlatform: "megaeth",
    coingeckoNativeId: "ethereum",
    stablecoinAnchors: [
      {
        // USDM (MegaUSD). CoinGecko has no listing on the `megaeth` platform,
        // so without this seed every USDM-quoted vault renders "no price".
        address: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        usdPrice: 1,
        decimals: 18,
      },
    ],
  },
  6343: {
    wrappedNative: "0x4200000000000000000000000000000000000006",
    wrappedNativeSymbol: "WETH",
    v3Factory: "0x94996d371622304F2eB85df1eb7f328F7B317C3E",
    v3PoolInitCodeHash:
      "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
    coingeckoNativeId: "ethereum", // MegaETH uses ETH
    // No CoinGecko platform for MegaETH testnet
  },
};

// Default assistant addresses (from build-data.json)
const DEFAULT_ASSISTANT_ADDRESSES: Record<number, string> = {
  1: "0xff14f91285580AEd3733c0B1F3C8b6d04804c5ec",
  999: "0x7d987b986FbA5e0A4247649A2334Bb2D4029656c",
  4326: "0xB91AE2c8365FD45030abA84a4666C4dB074E53E7",
  6343: "0x1642ceF4498B811f5F765b4FE5D3263fE26a1F9A",
};

// Default vault addresses (from build-data.json)
const DEFAULT_VAULT_ADDRESSES: Record<number, string> = {
  1: "0x20950a5e47C958109dA40F1a6C046F498e9B2e02",
  999: "0xf86e3C72e28962dEE945f6152483338c93e3483E",
  4326: "0x8d694D1b369BdE5B274Ad643fEdD74f836E88543",
  6343: "0xa9c54405849aFEC80976cD4eBC52540Bec5E476c",
};

// Default base fees (from build-data.json)
const DEFAULT_BASE_FEES: Record<number, number> = {
  1: 0.1,
  999: 0.1,
  4326: 0.1,
  6343: 0.1,
};

let chainConfigs: ChainConfig[] | null = null;

export function getChainConfigs(): ChainConfig[] {
  if (chainConfigs) return chainConfigs;

  const chainIds = process.env.CHAIN_IDS?.split(",").map(Number) ?? [];
  const rpcUrls = process.env.RPC_URLS?.split(",") ?? [];
  const subgraphUrls = process.env.SUBGRAPH_URLS?.split(",") ?? [];
  const subgraphApiKey = process.env.SUBGRAPH_API_KEY;
  const assistantAddresses = process.env.ASSISTANT_ADDRESSES?.split(",");
  const vaultAddresses = process.env.VAULT_ADDRESSES?.split(",");
  const baseFees = process.env.BASE_FEES?.split(",").map(Number);
  const sirTokenAddresses = process.env.SIR_CONTRACT_ADDRESSES?.split(",");

  if (chainIds.length === 0) {
    console.error("[Config] CHAIN_IDS not set");
    return [];
  }

  if (rpcUrls.length !== chainIds.length) {
    console.error(
      "[Config] RPC_URLS count must match CHAIN_IDS count"
    );
    return [];
  }

  if (subgraphUrls.length !== chainIds.length) {
    console.error(
      "[Config] SUBGRAPH_URLS count must match CHAIN_IDS count"
    );
    return [];
  }

  chainConfigs = chainIds.map((chainId, i) => {
    const constants = CHAIN_CONSTANTS[chainId] ?? {
      wrappedNative: "0x0000000000000000000000000000000000000000",
      wrappedNativeSymbol: "WETH",
    };

    return {
      chainId,
      rpcUrl: rpcUrls[i].trim(),
      subgraphUrl: subgraphUrls[i].trim(),
      subgraphApiKey: subgraphApiKey || undefined,
      assistantAddress:
        assistantAddresses?.[i]?.trim() ||
        DEFAULT_ASSISTANT_ADDRESSES[chainId] ||
        "",
      vaultAddress:
        vaultAddresses?.[i]?.trim() ||
        DEFAULT_VAULT_ADDRESSES[chainId] ||
        "",
      baseFee:
        baseFees?.[i] ?? DEFAULT_BASE_FEES[chainId] ?? 0.1,
      sirTokenAddress: sirTokenAddresses?.[i]?.trim() || undefined,
      ...constants,
    };
  });

  return chainConfigs;
}

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return getChainConfigs().find((c) => c.chainId === chainId);
}
