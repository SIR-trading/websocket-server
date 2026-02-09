export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  subgraphUrl: string;
  subgraphApiKey?: string;
  assistantAddress: string;
  baseFee: number; // In decimal form (e.g., 0.1 = 10%)
  coingeckoPlatform?: string;
  coingeckoNativeId?: string; // CoinGecko coin ID for native token (e.g., "ethereum")
  wrappedNative: string;
  wrappedNativeSymbol: string;
  v3Factory?: string;
  v3PoolInitCodeHash?: string;
  sirTokenAddress?: string; // SIR token address on this chain
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
  },
  999: {
    wrappedNative: "0x5555555555555555555555555555555555555555",
    wrappedNativeSymbol: "WHYPE",
    v3Factory: "0xB1c0fa0B789320044A6F623cFe5eBda9562602E3",
    v3PoolInitCodeHash:
      "0xe3572921be1688dba92df30c6781b8770499ff274d20ae9b325f4242634774fb",
    coingeckoPlatform: "hyperevm",
    coingeckoNativeId: "hyperliquid", // HYPE token
  }, 4326: {
    wrappedNative: "0x4200000000000000000000000000000000000006",
    wrappedNativeSymbol: "WETH",
    v3Factory: "0x68b34591f662508076927803c567Cc8006988a09",
    v3PoolInitCodeHash: "0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7",
    coingeckoPlatform: "megaeth",
    coingeckoNativeId: "ethereum",
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
