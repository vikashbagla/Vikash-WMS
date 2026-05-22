-- Migration 41 — TradingView webhook integration: schema additions.
--
-- Adds the columns + indexes needed for the tv-webhook Edge Function to
-- distinguish webhook-sourced signals from chassis-sourced signals and to
-- enforce race-free idempotency across concurrent TV alert deliveries.
--
-- WHY THIS EXISTS:
--   GS strategies (silver_mini_15m, gold_mini_15m) are now signal-by-webhook
--   instead of cron-driven, because: (a) Fyers /data/history wipes expired
--   contracts immediately on expiry — confirmed 2026-05-22 probe; (b) back-
--   month bars are too thin to use for warmup (66% zero-volume bars when the
--   contract is deep back-month — same probe); (c) TV's continuous chart
--   always uses front-month-quality data, which matches the analyst's
--   backtest exactly. Cost = ₹0 since analyst already has TV Plus.
--
-- See:
--   - WMS Claude/GS-TV-WEBHOOK-INTEGRATION.md (analyst-facing setup doc)
--   - supabase/functions/tv-webhook/index.ts (the Edge Function)
--   - WMS-LESSONS §A.9 (Data API GRANT requirements — N/A here since we only
--     ALTER existing tables, no CREATE TABLE)
--
-- ADDITIONS:
--   1. auto_signals.source TEXT default 'chassis'
--      Distinguishes 'chassis' vs 'tv_webhook' signals. Default ensures all
--      existing rows + future pairs scanner rows continue to work unchanged.
--   2. auto_signals.dedupe_key TEXT (nullable)
--      Format: "{strategy}|{bar_ts}|{action}|{side}"
--      UNIQUE INDEX on this column (partial WHERE NOT NULL) so two webhook
--      deliveries with same key can't both insert — PostgREST returns the
--      existing row instead of duplicating. Pairs scanner rows have NULL
--      dedupe_key and are unaffected.
--   3. idx_auto_signals_source_fired — supports dashboard queries that filter
--      by source (e.g. "show last 24h of tv_webhook signals").
--   4. auto_strategies.metadata JSONB (only adds if column missing)
--      Used to mark webhook-driven strategies with `{"source":"tv_webhook"}`
--      so the dashboard widget knows to expect heartbeat-driven freshness
--      monitoring instead of cron-driven runs.
--   5. UPDATE auto_strategies + auto_strategies_dev for silver_mini_15m +
--      gold_mini_15m to set metadata.source = 'tv_webhook'.
--   6. All of the above mirrored on the _dev twin tables.
--
-- IDEMPOTENT — safe to re-run. Uses ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS / UPDATE (last-write-wins) throughout.
--
-- NO RLS / GRANT changes needed — both auto_signals and auto_strategies
-- already have RLS policies and grants from migration 40. We only add columns
-- and indexes to existing tables.

-- ============================================================================
-- 1. auto_signals + dev twin: source column + dedupe_key + indexes
-- ============================================================================

ALTER TABLE auto_signals
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chassis';
ALTER TABLE auto_signals
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_signals_dedupe
  ON auto_signals(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auto_signals_source_fired
  ON auto_signals(source, fired_at DESC);

ALTER TABLE auto_signals_dev
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chassis';
ALTER TABLE auto_signals_dev
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_signals_dev_dedupe
  ON auto_signals_dev(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auto_signals_dev_source_fired
  ON auto_signals_dev(source, fired_at DESC);

-- ============================================================================
-- 2. auto_strategies + dev twin: ensure metadata column + flag GS rows
-- ============================================================================

ALTER TABLE auto_strategies
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE auto_strategies_dev
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE auto_strategies
  SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"source":"tv_webhook"}'::jsonb
  WHERE name IN ('silver_mini_15m', 'gold_mini_15m');

UPDATE auto_strategies_dev
  SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"source":"tv_webhook"}'::jsonb
  WHERE name IN ('silver_mini_15m', 'gold_mini_15m');

-- ============================================================================
-- 3. Sanity check (output two result tables to confirm)
-- ============================================================================

SELECT 'auto_signals' AS tbl, column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'auto_signals' AND column_name IN ('source', 'dedupe_key')
UNION ALL
SELECT 'auto_signals_dev', column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'auto_signals_dev' AND column_name IN ('source', 'dedupe_key')
ORDER BY tbl, column_name;

SELECT name, display_name, enabled, execution_mode, metadata->>'source' AS source
  FROM auto_strategies
  WHERE name IN ('silver_mini_15m', 'gold_mini_15m')
  ORDER BY name;
