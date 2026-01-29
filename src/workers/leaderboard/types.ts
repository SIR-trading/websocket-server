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
