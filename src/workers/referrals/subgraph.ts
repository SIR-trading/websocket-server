import { GraphQLClient, gql } from "graphql-request";

export interface ReferralRow {
  /** Referee address (lowercased hex, includes "0x"). */
  id: string;
  /** Referrer address (lowercased hex, includes "0x"). */
  referrer: string;
}

export interface MonthlyStatsRow {
  /** UserMonthlyStats.id (Bytes! = user || monthStart). Used as the pagination cursor. */
  id: string;
  /** User address (lowercased hex). */
  user: string;
  /** BigDecimal serialized as a string. Null on entities indexed before the field was added; treat as "0". */
  feesPaidUsd: string | null;
}

const PAGE = 1000;

const REFERRALS_BY_IDS = gql`
  query ReferralsByIds($ids: [Bytes!]!) {
    referrals(first: 1000, where: { id_in: $ids }) {
      id
      referrer
    }
  }
`;

// The Graph names the plural query `_collection` when the entity type already
// ends in "s" (UserMonthlyStats). Bare `userMonthlyStats` is the singular form
// and requires an `id` argument; using it for paginated reads errors out.
const MONTHLY_STATS_PAGE = gql`
  query MonthlyStatsPage($first: Int!, $lastId: String!, $monthStart: BigInt!) {
    userMonthlyStats_collection(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId, monthStartTimestamp: $monthStart }
    ) {
      id
      user
      feesPaidUsd
    }
  }
`;

/**
 * Fetch only the Referral entities whose id (referee address) appears in the
 * given list. Avoids the unbounded full-table scan when the referral graph
 * grows large but only a small slice is relevant for the current month.
 * The subgraph's `id_in` filter is capped at 1000 per query, so we chunk.
 */
export async function fetchReferralsByIds(
  client: GraphQLClient,
  ids: string[]
): Promise<ReferralRow[]> {
  if (ids.length === 0) return [];
  const out: ReferralRow[] = [];
  const BATCH = 1000;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const res = await client.request<{ referrals: ReferralRow[] }>(
      REFERRALS_BY_IDS,
      { ids: slice }
    );
    out.push(...res.referrals);
  }
  return out;
}

export async function fetchMonthlyStatsForMonth(
  client: GraphQLClient,
  monthStart: number
): Promise<MonthlyStatsRow[]> {
  const out: MonthlyStatsRow[] = [];
  let cursor = "";
  while (true) {
    const res = await client.request<{ userMonthlyStats_collection: MonthlyStatsRow[] }>(
      MONTHLY_STATS_PAGE,
      { first: PAGE, lastId: cursor, monthStart: monthStart.toString() }
    );
    const rows = res.userMonthlyStats_collection;
    out.push(...rows);
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].id;
  }
  return out;
}
