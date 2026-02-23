import { GraphQLClient, gql } from "graphql-request";
import type { CurrentApePositionFragment, CurrentTeaPositionFragment } from "./types.js";

const CURRENT_APE_POSITION_FIELDS = gql`
  fragment CurrentApePositionFields on ApePosition {
    id
    user
    collateralTotal
    dollarTotal
    debtTokenTotal
    balance
    createdAt
    vault {
      id
      leverageTier
      collateralToken {
        id
        symbol
        decimals
      }
      debtToken {
        id
        symbol
        decimals
      }
      ape {
        id
        symbol
        decimals
      }
    }
  }
`;

// Cursor-based paginated query for positions (ordered by ID ascending)
const ACTIVE_APE_POSITIONS_QUERY = gql`
  ${CURRENT_APE_POSITION_FIELDS}

  query ActiveApePositions($first: Int!, $lastId: String!) {
    apePositions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
    ) {
      ...CurrentApePositionFields
    }
  }
`;

// Query for positions created after a specific timestamp
const NEW_POSITIONS_QUERY = gql`
  ${CURRENT_APE_POSITION_FIELDS}

  query NewApePositions($createdAfter: Int!, $first: Int!) {
    apePositions(
      first: $first
      orderBy: createdAt
      orderDirection: asc
      where: { createdAt_gt: $createdAfter }
    ) {
      ...CurrentApePositionFields
    }
  }
`;

export function createSubgraphClient(
  url: string,
  apiKey?: string
): GraphQLClient {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return new GraphQLClient(url, { headers });
}

export async function fetchPositionsBatch(
  client: GraphQLClient,
  cursor: string,
  limit: number
): Promise<CurrentApePositionFragment[]> {
  const result = await client.request<{
    apePositions: CurrentApePositionFragment[];
  }>(ACTIVE_APE_POSITIONS_QUERY, {
    first: limit,
    lastId: cursor,
  });

  return result.apePositions;
}

export async function fetchNewPositions(
  client: GraphQLClient,
  createdAfterTimestamp: number,
  limit: number = 500
): Promise<CurrentApePositionFragment[]> {
  const result = await client.request<{
    apePositions: CurrentApePositionFragment[];
  }>(NEW_POSITIONS_QUERY, {
    createdAfter: createdAfterTimestamp,
    first: limit,
  });

  return result.apePositions;
}

// TEA position queries

const CURRENT_TEA_POSITION_FIELDS = gql`
  fragment CurrentTeaPositionFields on TeaPosition {
    id
    user
    collateralTotal
    dollarTotal
    debtTokenTotal
    balance
    lockEnd
    claimedSir
    createdAt
    vault {
      id
      leverageTier
      teaSupply
      collateralToken {
        id
        symbol
        decimals
      }
      debtToken {
        id
        symbol
        decimals
      }
    }
  }
`;

const ACTIVE_TEA_POSITIONS_QUERY = gql`
  ${CURRENT_TEA_POSITION_FIELDS}
  query ActiveTeaPositions($first: Int!, $lastId: String!) {
    teaPositions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
    ) {
      ...CurrentTeaPositionFields
    }
  }
`;

const NEW_TEA_POSITIONS_QUERY = gql`
  ${CURRENT_TEA_POSITION_FIELDS}
  query NewTeaPositions($createdAfter: Int!, $first: Int!) {
    teaPositions(
      first: $first
      orderBy: createdAt
      orderDirection: asc
      where: { createdAt_gt: $createdAfter }
    ) {
      ...CurrentTeaPositionFields
    }
  }
`;

export async function fetchTeaPositionsBatch(
  client: GraphQLClient,
  cursor: string,
  limit: number
): Promise<CurrentTeaPositionFragment[]> {
  const result = await client.request<{
    teaPositions: CurrentTeaPositionFragment[];
  }>(ACTIVE_TEA_POSITIONS_QUERY, {
    first: limit,
    lastId: cursor,
  });
  return result.teaPositions;
}

export async function fetchNewTeaPositions(
  client: GraphQLClient,
  createdAfterTimestamp: number,
  limit: number = 500
): Promise<CurrentTeaPositionFragment[]> {
  const result = await client.request<{
    teaPositions: CurrentTeaPositionFragment[];
  }>(NEW_TEA_POSITIONS_QUERY, {
    createdAfter: createdAfterTimestamp,
    first: limit,
  });
  return result.teaPositions;
}

// ID-only queries for orphan cleanup

const ALL_APE_POSITION_IDS_QUERY = gql`
  query AllApePositionIds($first: Int!, $lastId: String!) {
    apePositions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
    ) {
      id
    }
  }
`;

const ALL_TEA_POSITION_IDS_QUERY = gql`
  query AllTeaPositionIds($first: Int!, $lastId: String!) {
    teaPositions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
    ) {
      id
    }
  }
`;

export async function fetchAllApePositionIds(
  client: GraphQLClient
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor = "";
  const pageSize = 1000;

  while (true) {
    const result = await client.request<{
      apePositions: Array<{ id: string }>;
    }>(ALL_APE_POSITION_IDS_QUERY, { first: pageSize, lastId: cursor });

    for (const pos of result.apePositions) {
      ids.add(pos.id);
    }

    if (result.apePositions.length < pageSize) break;
    cursor = result.apePositions[result.apePositions.length - 1].id;
  }

  return ids;
}

export async function fetchAllTeaPositionIds(
  client: GraphQLClient
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor = "";
  const pageSize = 1000;

  while (true) {
    const result = await client.request<{
      teaPositions: Array<{ id: string }>;
    }>(ALL_TEA_POSITION_IDS_QUERY, { first: pageSize, lastId: cursor });

    for (const pos of result.teaPositions) {
      ids.add(pos.id);
    }

    if (result.teaPositions.length < pageSize) break;
    cursor = result.teaPositions[result.teaPositions.length - 1].id;
  }

  return ids;
}

// Query all unique tokens across all vaults (for centralized price caching)
const VAULT_TOKENS_QUERY = gql`
  query VaultTokens {
    tokens(first: 1000, orderBy: vaultCount, orderDirection: desc) {
      id
      symbol
      decimals
    }
  }
`;

export interface VaultToken {
  id: string;
  symbol: string;
  decimals: number;
}

export async function fetchAllVaultTokens(
  client: GraphQLClient
): Promise<VaultToken[]> {
  const result = await client.request<{ tokens: VaultToken[] }>(
    VAULT_TOKENS_QUERY
  );
  return result.tokens;
}

// Query all vault IDs (for reserve caching)
const VAULT_IDS_QUERY = gql`
  query VaultIds {
    vaults(first: 1000, orderBy: id, orderDirection: asc) {
      id
    }
  }
`;

export async function fetchAllVaultIds(
  client: GraphQLClient
): Promise<number[]> {
  const result = await client.request<{
    vaults: Array<{ id: string }>;
  }>(VAULT_IDS_QUERY);
  return result.vaults.map((v) => parseInt(v.id, 16));
}
