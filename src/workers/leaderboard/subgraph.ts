import { GraphQLClient, gql } from "graphql-request";
import type { CurrentApePositionFragment } from "./types.js";

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
