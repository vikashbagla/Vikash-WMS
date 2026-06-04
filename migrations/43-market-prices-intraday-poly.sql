-- Migration 43 — Extend market_prices to support intraday OHLCV + non-securities_db instruments.
--
-- Why: The Pairs scanner uses market_prices for equity end-of-day bars (security_id → securities_db,
-- price_date DATE). The GS strategy family (silver_mini_15m + gold_mini_15m) now needs MCX 15-min
-- bars for warmup + future server-side LIVE evaluation, but:
--   1. MCX futures live in securities_nfo (SERIAL id, can't fit market_prices.security_id UUID).
--   2. Daily-only granularity (price_date DATE) can't store 15-min bars.
-- Migration 43 makes market_prices polymorphic across instrument classes AND resolutions.
--
-- Design (full rationale in WMS-SCHEMA.md Table 7):
--   - Add `bar_ts TIMESTAMPTZ NULL` for intraday bars (NULL for daily).
--   - Add `resolution TEXT NOT NULL DEFAULT '1D'` so adding a new timeframe is a data change, not schema.
--   - Add `external_symbol TEXT NULL` for instruments not tracked in securities_db (e.g. 'MCX:SILVERM26JUNFUT').
--   - Relax `security_id` to NULLABLE — equity rows still use it (FK preserved via NULL semantics).
--   - CHECK constraints prevent ambiguous middle states.
--   - Two raw-column UNIQUE constraints (uq_market_prices_equity + uq_market_prices_external) cover
--     each "lane" without requiring expression indexes — PostgREST on_conflict needs raw columns.
--
-- Coupled with patches to three readers (eod-prices-ingest, pairs_strategy.ts, automation.js) that
-- now filter on `resolution='1D'`. Forward-compat: these patches are no-ops until MCX rows land.
--
-- See WMS-SCHEMA.md Table 7 and AUTOMATION-LESSONS §D.30 (when written) for full context.

BEGIN;

-- ─── 1. New columns ──────────────────────────────────────────────────────────

ALTER TABLE market_prices
    ADD COLUMN IF NOT EXISTS bar_ts TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS resolution TEXT NOT NULL DEFAULT '1D',
    ADD COLUMN IF NOT EXISTS external_symbol TEXT NULL;

-- ─── 2. Relax security_id (was NOT NULL pre-migration-43) ────────────────────

ALTER TABLE market_prices ALTER COLUMN security_id DROP NOT NULL;

-- ─── 3. Drop the legacy UNIQUE (uq_security_date) — name-tolerant lookup ─────
--
-- The schema doc said the UNIQUE was named `uq_security_date` but flagged as
-- "TBD; verify in Studio". Find any UNIQUE on (security_id, security_type, price_date)
-- regardless of name and drop it.

DO $$
DECLARE
    legacy_constraint_name TEXT;
BEGIN
    SELECT con.conname INTO legacy_constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE rel.relname = 'market_prices'
      AND ns.nspname = 'public'
      AND con.contype = 'u'  -- unique constraint
      AND con.conkey = ARRAY(
          SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.market_prices'::regclass
            AND attname IN ('security_id', 'security_type', 'price_date')
          ORDER BY array_position(ARRAY['security_id','security_type','price_date'], attname)
      )::int2[]
    LIMIT 1;

    IF legacy_constraint_name IS NOT NULL THEN
        RAISE NOTICE 'Dropping legacy UNIQUE constraint: %', legacy_constraint_name;
        EXECUTE format('ALTER TABLE public.market_prices DROP CONSTRAINT %I', legacy_constraint_name);
    ELSE
        RAISE NOTICE 'No legacy UNIQUE on (security_id, security_type, price_date) found — skipping drop';
    END IF;
END $$;

-- Belt-and-suspenders: drop common alternative naming as unique INDEXES too
DROP INDEX IF EXISTS uq_security_date;
DROP INDEX IF EXISTS market_prices_security_id_security_type_price_date_key;

-- ─── 4. New UNIQUE constraints (raw columns, PostgREST-on_conflict-friendly) ─

ALTER TABLE market_prices
    ADD CONSTRAINT uq_market_prices_equity
    UNIQUE (security_id, security_type, resolution, price_date);

ALTER TABLE market_prices
    ADD CONSTRAINT uq_market_prices_external
    UNIQUE (external_symbol, security_type, resolution, bar_ts);

-- ─── 5. CHECK constraints ────────────────────────────────────────────────────

ALTER TABLE market_prices
    ADD CONSTRAINT chk_identifier_present
    CHECK (security_id IS NOT NULL OR external_symbol IS NOT NULL);

-- Pre-migration rows: all have resolution='1D' (via DEFAULT) and bar_ts IS NULL
-- (column just added). So the CHECK passes for every existing row.
ALTER TABLE market_prices
    ADD CONSTRAINT chk_bar_ts_matches_resolution
    CHECK (
      (resolution = '1D' AND bar_ts IS NULL)
      OR (resolution <> '1D' AND bar_ts IS NOT NULL)
    );

-- ─── 6. Read indexes (partial — non-NULL identifier in each lane) ────────────

DROP INDEX IF EXISTS idx_market_prices_secid_date;

CREATE INDEX idx_market_prices_secid_date_v43
    ON market_prices (security_id, price_date DESC)
    WHERE security_id IS NOT NULL;

CREATE INDEX idx_market_prices_extsym_barts
    ON market_prices (external_symbol, bar_ts DESC)
    WHERE external_symbol IS NOT NULL;

-- ─── 7. Sanity verification ──────────────────────────────────────────────────

SELECT
    count(*)                                                AS total_rows,
    count(*) FILTER (WHERE resolution = '1D')               AS daily_rows,
    count(*) FILTER (WHERE resolution <> '1D')              AS intraday_rows,
    count(*) FILTER (WHERE security_id IS NOT NULL)         AS rows_with_security_id,
    count(*) FILTER (WHERE external_symbol IS NOT NULL)     AS rows_with_external_symbol
FROM market_prices;

-- Expected after migration on a fresh apply:
--   total_rows         = N (whatever pairs scanner has accumulated)
--   daily_rows         = N  (all existing rows backfilled to '1D')
--   intraday_rows      = 0
--   rows_with_security_id = N
--   rows_with_external_symbol = 0

COMMIT;
