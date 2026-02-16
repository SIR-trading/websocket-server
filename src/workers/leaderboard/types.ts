// Types for leaderboard worker

export interface CurrentApePositionFragment {
  id: string;
  user: string;
  collateralTotal: string;
  dollarTotal: string;
  debtTokenTotal: string;
  balance: string;
  createdAt: string;
  vault: {
    id: string;
    leverageTier: number;
    collateralToken: {
      id: string;
      symbol: string | null;
      decimals: number;
    };
    debtToken: {
      id: string;
      symbol: string | null;
      decimals: number;
    };
    ape: {
      id: string;
      symbol: string | null;
      decimals: number;
    };
  };
}

export interface ComputedPositionData {
  user: string;
  vaultId: string;
  leverageTier: number;
  collateralSymbol: string;
  debtSymbol: string;
  collateralToken: string;
  debtToken: string;
  pnlUsd: number;
  pnlUsdPercentage: number;
  dollarTotal: number;
  currentValueUsd: number;
  entryPrice: number; // Price of collateral in quote token terms at entry
  currentPrice: number; // Current price of collateral in quote token terms
  createdAt: number;
}

export interface ActiveLeaderboardPosition {
  rank: number;
  user: string;
  vaultId: string;
  leverageTier: number;
  collateralSymbol: string;
  debtSymbol: string;
  collateralToken: string;
  debtToken: string;
  pnlUsd: number;
  pnlUsdPercentage: number;
  dollarTotal: number;
  createdAt: number;
}

export interface ActiveLeaderboardResponse {
  positions: ActiveLeaderboardPosition[];
  hasMore: boolean;
  updatedAt: number | null;
}

export type SortField = "pnl" | "return" | "holding" | "deposit" | "value";

export interface CurrentTeaPositionFragment {
  id: string;
  user: string;
  collateralTotal: string;
  dollarTotal: string;
  debtTokenTotal: string;
  balance: string;
  lockEnd: string;
  claimedSir: string;
  createdAt: string;
  vault: {
    id: string;
    leverageTier: number;
    teaSupply: string;
    collateralToken: {
      id: string;
      symbol: string | null;
      decimals: number;
    };
    debtToken: {
      id: string;
      symbol: string | null;
      decimals: number;
    };
  };
}

export interface ComputedTeaPositionData {
  user: string;
  vaultId: string;
  leverageTier: number;
  collateralSymbol: string;
  debtSymbol: string;
  collateralToken: string;
  debtToken: string;
  currentValueUsd: number;
  dollarTotal: number;
  pnlUsd: number;
  pnlUsdPercentage: number;
  lockEnd: number;
  totalSir: number;
  createdAt: number;
}

export type LpSortField = "value" | "pnl" | "return" | "sir" | "holding";

export interface WorkerStatus {
  enabled: boolean;
  lastRun: number | null;
  lastDurationMs: number | null;
  chainStatus: Record<
    number,
    {
      status: "success" | "error" | "running";
      positionsProcessed?: number;
      error?: string;
    }
  >;
}
