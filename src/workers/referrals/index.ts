import { randomUUID } from "crypto";
import { getRedisClient } from "../../lib/redis.js";
import { getPgPool } from "../../lib/postgres.js";
import { getChainConfigs, type ChainConfig } from "../../lib/config.js";
import { createSubgraphClient } from "../leaderboard/subgraph.js";
import {
  fetchMonthlyStatsForMonth,
  fetchReferralsByIds,
} from "./subgraph.js";
import { computeScores, upsertScores } from "./compute.js";

const INTERVAL_MS = 5 * 60 * 1000;
// 4x headroom over INTERVAL_MS so a slow subgraph cycle never expires the
// lock mid-run. Self-clears on crash via Redis EX.
const LOCK_TTL = 20 * 60;

let isRunning = false;

function currentMonthStart(): number {
  const now = new Date();
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
  );
}

export function startReferralScoringWorker(): void {
  if (process.env.REFERRAL_SCORING_WORKER_ENABLED === "false") {
    console.log(
      "[ReferralScoringWorker] Disabled via REFERRAL_SCORING_WORKER_ENABLED=false"
    );
    return;
  }
  const configs = getChainConfigs();
  if (configs.length === 0) {
    console.error("[ReferralScoringWorker] No chain configs");
    return;
  }
  console.log(
    `[ReferralScoringWorker] Starting for chains: ${configs.map((c) => c.chainId).join(", ")}`
  );
  void runCycle(configs);
}

function scheduleNextRun(configs: ChainConfig[]): void {
  setTimeout(() => void runCycle(configs), INTERVAL_MS);
}

async function runCycle(configs: ChainConfig[]): Promise<void> {
  if (isRunning) {
    scheduleNextRun(configs);
    return;
  }
  isRunning = true;
  const startTime = Date.now();

  const pg = getPgPool();
  if (!pg) {
    console.warn(
      "[ReferralScoringWorker] Postgres unavailable, skipping cycle"
    );
    isRunning = false;
    scheduleNextRun(configs);
    return;
  }

  const redis = await getRedisClient();
  if (!redis) {
    // Same posture as LeaderboardWorker: refuse to run unlocked so two
    // replicas cannot race the DELETE+INSERT writes.
    console.warn(
      "[ReferralScoringWorker] Redis unavailable, skipping cycle"
    );
    isRunning = false;
    scheduleNextRun(configs);
    return;
  }

  const monthStart = currentMonthStart();

  for (const config of configs) {
    const chainId = config.chainId;
    const lockKey = `referral:scoring:${chainId}:lock`;
    const lockToken = randomUUID();
    let acquired = false;

    try {
      const result = await redis.set(lockKey, lockToken, {
        NX: true,
        EX: LOCK_TTL,
      });
      if (!result) {
        console.log(
          `[ReferralScoringWorker] Chain ${chainId}: Lock held by another instance`
        );
        continue;
      }
      acquired = true;

      const client = createSubgraphClient(
        config.subgraphUrl,
        config.subgraphApiKey
      );

      // Fetch in three steps to avoid the unbounded all-referrals scan:
      //   1. UserMonthlyStats for the current month (paginated).
      //   2. Referral entities for active users (id_in, chunked).
      //   3. Referral entities for the direct referrers (for 2nd-degree credit).
      const monthlyStats = await fetchMonthlyStatsForMonth(client, monthStart);
      const activeUserIds = Array.from(
        new Set(monthlyStats.map((s) => s.user.toLowerCase()))
      );
      const directReferrals = await fetchReferralsByIds(client, activeUserIds);
      const directReferrerIds = Array.from(
        new Set(directReferrals.map((r) => r.referrer.toLowerCase()))
      );
      const secondReferrals = await fetchReferralsByIds(
        client,
        directReferrerIds
      );
      const referrals = directReferrals.concat(secondReferrals);

      const rows = computeScores(referrals, monthlyStats);
      await upsertScores(pg, chainId, monthStart, rows);

      console.log(
        `[ReferralScoringWorker] Chain ${chainId}: ${rows.length} scored (${monthlyStats.length} active users this month, ${directReferrals.length} direct + ${secondReferrals.length} 2nd-degree referrals fetched)`
      );
    } catch (err) {
      console.error(
        `[ReferralScoringWorker] Chain ${chainId} failed:`,
        err
      );
    } finally {
      if (acquired) {
        try {
          const current = await redis.get(lockKey);
          if (current === lockToken) {
            await redis.del(lockKey);
          }
        } catch {
          // Best-effort release; the TTL will reclaim the lock if needed.
        }
      }
    }
  }

  console.log(
    `[ReferralScoringWorker] Cycle complete in ${Date.now() - startTime}ms`
  );
  isRunning = false;
  scheduleNextRun(configs);
}
