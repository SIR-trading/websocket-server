-- Referral program tables. Idempotent: safe to apply on every boot.
-- Migrations to existing columns require a separate change (drop/recreate not OK).
--
-- The referrer→referee mapping lives in the subgraph (Referral entity),
-- populated by calldata-stamping on the user's first mint. Postgres only
-- stores cached monthly scores computed by the scoring worker.

CREATE TABLE IF NOT EXISTS referral_scores (
  wallet         BYTEA NOT NULL,
  month_start    BIGINT NOT NULL,               -- unix seconds, first of month UTC
  chain_id       INTEGER NOT NULL,
  own_fees_usd   NUMERIC(38, 6) NOT NULL,       -- 1.00 * user's own feesPaidUsd
  referred_score NUMERIC(38, 6) NOT NULL,       -- 0.20 * direct + 0.04 * 2nd-degree fees
  total_score    NUMERIC(38, 6) NOT NULL,       -- own_fees_usd + referred_score
  PRIMARY KEY (wallet, month_start, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_scores_lb
  ON referral_scores(chain_id, month_start, total_score DESC);
