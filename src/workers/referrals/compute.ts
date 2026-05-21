import type { Pool } from "pg";
import type { ReferralRow, MonthlyStatsRow } from "./subgraph.js";

// Score weights for the referral leaderboard.
// own = 100% of the user's own fees
// direct referees contribute 20% of their fees to their referrer
// 2nd-degree referees contribute 4% of their fees to the grandparent referrer
const DIRECT_NUM = 20n;
const SECOND_NUM = 4n;
const PCT_DENOM = 100n;
const MICROS_PER_USD = 1_000_000n;

export interface ScoreRow {
  walletLower: string;
  ownMicros: bigint;
  referredMicros: bigint;
  totalMicros: bigint;
}

/**
 * Parse a BigDecimal USD amount (string from the subgraph) into micro-USD.
 * Truncates anything beyond 6 fractional digits. Negative inputs and parse
 * failures return 0n. Fees aren't supposed to be negative, and a malformed
 * row should not poison the whole month's aggregation.
 */
export function parseUsdToMicros(raw: string | null): bigint {
  if (!raw) return 0n;
  const s = raw.trim();
  if (s === "" || s.startsWith("-")) return 0n;
  const [intPart, fracPart = ""] = s.split(".");
  const fracPadded = (fracPart + "000000").slice(0, 6);
  try {
    return BigInt(intPart) * MICROS_PER_USD + BigInt(fracPadded);
  } catch {
    return 0n;
  }
}

/** Format a micro-USD bigint as a NUMERIC(38, 6) string ("1234.567890"). */
export function microsToDecimalString(micros: bigint): string {
  const intPart = micros / MICROS_PER_USD;
  const frac = micros % MICROS_PER_USD;
  return `${intPart}.${frac.toString().padStart(6, "0")}`;
}

export function computeScores(
  referrals: ReferralRow[],
  monthlyStats: MonthlyStatsRow[]
): ScoreRow[] {
  // Build the referee → referrer map. Self-referrals are skipped.
  const referrerOf = new Map<string, string>();
  for (const r of referrals) {
    const referee = r.id.toLowerCase();
    const referrer = r.referrer.toLowerCase();
    if (referee === referrer) continue;
    referrerOf.set(referee, referrer);
  }

  const own = new Map<string, bigint>();
  const referred = new Map<string, bigint>();

  for (const s of monthlyStats) {
    const u = s.user.toLowerCase();
    const fees = parseUsdToMicros(s.feesPaidUsd);
    if (fees <= 0n) continue;

    own.set(u, (own.get(u) ?? 0n) + fees);

    const r = referrerOf.get(u);
    if (r) {
      const directCredit = (fees * DIRECT_NUM) / PCT_DENOM;
      referred.set(r, (referred.get(r) ?? 0n) + directCredit);
      const r2 = referrerOf.get(r);
      // Cycle guard: never credit the originating user via a 2-hop loop.
      if (r2 && r2 !== u) {
        const secondCredit = (fees * SECOND_NUM) / PCT_DENOM;
        referred.set(r2, (referred.get(r2) ?? 0n) + secondCredit);
      }
    }
  }

  const wallets = new Set<string>([...own.keys(), ...referred.keys()]);
  const rows: ScoreRow[] = [];
  for (const w of wallets) {
    const o = own.get(w) ?? 0n;
    const r = referred.get(w) ?? 0n;
    const t = o + r;
    if (t <= 0n) continue;
    rows.push({
      walletLower: w,
      ownMicros: o,
      referredMicros: r,
      totalMicros: t,
    });
  }
  return rows;
}

export async function upsertScores(
  pool: Pool,
  chainId: number,
  monthStart: number,
  rows: ScoreRow[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM referral_scores WHERE chain_id = $1 AND month_start = $2`,
      [chainId, monthStart]
    );
    if (rows.length > 0) {
      // 500 rows × 6 params = 3000 params per statement; well under PG's 65535 cap.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const values: string[] = [];
        const params: unknown[] = [];
        slice.forEach((r, k) => {
          const base = k * 6;
          values.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
          );
          params.push(
            Buffer.from(r.walletLower.slice(2), "hex"),
            monthStart,
            chainId,
            microsToDecimalString(r.ownMicros),
            microsToDecimalString(r.referredMicros),
            microsToDecimalString(r.totalMicros)
          );
        });
        await client.query(
          `INSERT INTO referral_scores
             (wallet, month_start, chain_id, own_fees_usd, referred_score, total_score)
           VALUES ${values.join(", ")}`,
          params
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    // Best-effort rollback so a failing ROLLBACK does not mask the original
    // error from the caller's logs.
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}
