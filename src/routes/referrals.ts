import { Router, type Router as RouterType } from "express";
import { GraphQLClient } from "graphql-request";
import { isAddress, getAddress, type Address } from "viem";
import { getPgPool } from "../lib/postgres.js";
import { getChainConfig, getChainConfigs } from "../lib/config.js";

const router: RouterType = Router();

const LEADERBOARD_PAGE_SIZE = 25;

type AsyncHandler = (
  req: Parameters<Parameters<RouterType["get"]>[1]>[0],
  res: Parameters<Parameters<RouterType["get"]>[1]>[1],
  next: Parameters<Parameters<RouterType["get"]>[1]>[1] extends infer R ? R : never
) => Promise<unknown>;

function asyncHandler(fn: (req: any, res: any, next: any) => Promise<unknown>) {
  return (req: any, res: any, next: any) => {
    fn(req, res, next).catch(next);
  };
}

function addressToBytea(addr: string): Buffer {
  return Buffer.from(addr.slice(2).toLowerCase(), "hex");
}

function byteaToAddress(buf: Buffer): Address {
  return getAddress("0x" + buf.toString("hex")) as Address;
}

function currentMonthStart(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

// -------------------------------------------------------------------------
// GET /api/referrals/me?wallet=...&chainId=...
// Returns the user's referrer, direct + 2nd-degree referees on the given
// chain (queried from the subgraph), plus per-chain current-month scores
// from Postgres (populated by the scoring worker).
// -------------------------------------------------------------------------

interface ReferralRow {
  id: string;       // referee address (lowercased hex)
  referrer: string; // referrer address (lowercased hex)
  createdAt: string;
}

const ME_QUERY = `
  query MeReferrals($wallet: Bytes!) {
    self: referral(id: $wallet) {
      id
      referrer
      createdAt
    }
    direct: referrals(where: { referrer: $wallet }, first: 1000) {
      id
      referrer
      createdAt
    }
  }
`;

const SECOND_DEGREE_QUERY = `
  query SecondDegree($referrers: [Bytes!]!) {
    referrals(where: { referrer_in: $referrers }, first: 1000) {
      id
      referrer
      createdAt
    }
  }
`;

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const walletRaw = typeof req.query.wallet === "string" ? req.query.wallet : "";
    if (!isAddress(walletRaw)) {
      return res.status(400).json({ error: "invalid wallet" });
    }
    const chainId = Number(req.query.chainId);
    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: "chainId required" });
    }
    const chain = getChainConfig(chainId);
    if (!chain) {
      return res.status(400).json({ error: "chain not supported" });
    }

    const wallet = getAddress(walletRaw);
    const walletLower = wallet.toLowerCase();
    const monthStart = currentMonthStart();

    // Subgraph query: own referrer + direct referees.
    const client = new GraphQLClient(chain.subgraphUrl, {
      headers: chain.subgraphApiKey
        ? { Authorization: `Bearer ${chain.subgraphApiKey}` }
        : {},
    });

    let meData: { self: ReferralRow | null; direct: ReferralRow[] };
    try {
      meData = await client.request<typeof meData>(ME_QUERY, { wallet: walletLower });
    } catch (err) {
      console.error("[referrals/me] subgraph query failed:", err);
      return res.status(502).json({ error: "subgraph query failed" });
    }

    // Second-degree: referees of each direct referee.
    let secondDegree: ReferralRow[] = [];
    if (meData.direct.length > 0) {
      const directIds = meData.direct.map((r) => r.id);
      try {
        const sd = await client.request<{ referrals: ReferralRow[] }>(SECOND_DEGREE_QUERY, {
          referrers: directIds,
        });
        secondDegree = sd.referrals;
      } catch (err) {
        console.error("[referrals/me] 2nd-degree query failed:", err);
        // Non-fatal — return what we have.
      }
    }

    // Postgres: per-chain current-month scores for this wallet.
    const pg = getPgPool();
    let perChain: Array<{
      chainId: number;
      ownFeesUsd: string;
      referredScore: string;
      totalScore: string;
    }> = [];
    if (pg) {
      try {
        const rows = await pg.query<{
          chain_id: number;
          own_fees_usd: string;
          referred_score: string;
          total_score: string;
        }>(
          `SELECT chain_id, own_fees_usd, referred_score, total_score
           FROM referral_scores
           WHERE wallet = $1 AND month_start = $2`,
          [addressToBytea(wallet), monthStart]
        );
        perChain = rows.rows.map((r) => ({
          chainId: r.chain_id,
          ownFeesUsd: r.own_fees_usd,
          referredScore: r.referred_score,
          totalScore: r.total_score,
        }));
      } catch (err) {
        console.error("[referrals/me] score query failed:", err);
        // Non-fatal — return empty scores.
      }
    }

    return res.json({
      wallet,
      referrer: meData.self ? getAddress(meData.self.referrer) : null,
      referredAt: meData.self ? Number(meData.self.createdAt) : null,
      direct: meData.direct.map((r) => ({
        wallet: getAddress(r.id),
        joinedAt: Number(r.createdAt),
      })),
      secondDegree: secondDegree.map((r) => ({
        wallet: getAddress(r.id),
        joinedAt: Number(r.createdAt),
        via: getAddress(r.referrer),
      })),
      currentMonth: {
        monthStart,
        perChain,
      },
    });
  })
);

// -------------------------------------------------------------------------
// GET /api/referrals/leaderboard?chainId=...&monthStart=...&page=N
// Returns the top contributors for a chain+month, paginated. Reads from
// the referral_scores table populated by the scoring worker.
// -------------------------------------------------------------------------

router.get(
  "/leaderboard",
  asyncHandler(async (req, res) => {
    const chainId = Number(req.query.chainId);
    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: "chainId required" });
    }
    const supportedChainIds = getChainConfigs().map((c) => c.chainId);
    if (!supportedChainIds.includes(chainId)) {
      return res.status(400).json({ error: "chain not supported" });
    }
    const monthStart = req.query.monthStart
      ? Number(req.query.monthStart)
      : currentMonthStart();
    if (!Number.isFinite(monthStart)) {
      return res.status(400).json({ error: "invalid monthStart" });
    }
    const page = Math.max(1, Number(req.query.page ?? 1));
    if (!Number.isFinite(page) || page < 1) {
      return res.status(400).json({ error: "invalid page" });
    }
    const offset = (page - 1) * LEADERBOARD_PAGE_SIZE;

    const pg = getPgPool();
    if (!pg) {
      return res.status(503).json({ error: "postgres unavailable" });
    }

    const result = await pg.query<{
      wallet: Buffer;
      own_fees_usd: string;
      referred_score: string;
      total_score: string;
    }>(
      `SELECT wallet, own_fees_usd, referred_score, total_score
       FROM referral_scores
       WHERE chain_id = $1 AND month_start = $2
       ORDER BY total_score DESC
       LIMIT $3 OFFSET $4`,
      [chainId, monthStart, LEADERBOARD_PAGE_SIZE + 1, offset]
    );

    const hasMore = (result.rowCount ?? 0) > LEADERBOARD_PAGE_SIZE;
    const slice = result.rows.slice(0, LEADERBOARD_PAGE_SIZE);

    return res.json({
      chainId,
      monthStart,
      page,
      pageSize: LEADERBOARD_PAGE_SIZE,
      hasMore,
      users: slice.map((r, i) => ({
        rank: offset + i + 1,
        wallet: byteaToAddress(r.wallet),
        ownFeesUsd: r.own_fees_usd,
        referredScore: r.referred_score,
        totalScore: r.total_score,
      })),
    });
  })
);

export default router;
