import pkg from "pg";

const { Pool } = pkg;

// Schema is inlined (rather than read from db-schema.sql at runtime) so that
// `tsc` builds work without a separate copy-static-files step. The .sql file
// in this directory is the source of truth for humans reading the schema;
// keep them in sync.
// The referrer→referee mapping lives in the subgraph (Referral entity),
// populated by calldata-stamping on the user's first mint. Postgres only
// stores the cached monthly scores that the scoring worker computes.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS referral_scores (
  wallet         BYTEA NOT NULL,
  month_start    BIGINT NOT NULL,
  chain_id       INTEGER NOT NULL,
  own_fees_usd   NUMERIC(38, 6) NOT NULL,
  referred_score NUMERIC(38, 6) NOT NULL,
  total_score    NUMERIC(38, 6) NOT NULL,
  PRIMARY KEY (wallet, month_start, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_scores_lb
  ON referral_scores(chain_id, month_start, total_score DESC);
`;

let pool: pkg.Pool | null = null;

/**
 * Returns the shared pg pool, or null if DATABASE_URL is unset.
 * Caller is responsible for handling the null case (no Postgres-dependent feature available).
 */
export function getPgPool(): pkg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (!pool) {
    // Railway-managed Postgres requires SSL. Local dev (localhost/127.0.0.1) doesn't.
    const isLocal = /(?:localhost|127\.0\.0\.1)/.test(url);
    pool = new Pool({
      connectionString: url,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => {
      console.error("[Postgres] Idle client error:", err);
    });
    console.log("[Postgres] Pool initialized");
  }
  return pool;
}

/**
 * Apply the embedded schema. Idempotent (CREATE IF NOT EXISTS). Safe on every boot.
 */
export async function applyPgSchema(): Promise<void> {
  const p = getPgPool();
  if (!p) {
    console.warn("[Postgres] DATABASE_URL not set, skipping schema apply");
    return;
  }
  await p.query(SCHEMA_SQL);
  console.log("[Postgres] Schema applied");
}

export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[Postgres] Pool closed");
  }
}
