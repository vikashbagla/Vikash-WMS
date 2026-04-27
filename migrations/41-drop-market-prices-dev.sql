-- Migration 41 — Drop market_prices_dev.
--
-- Migration 40 created market_prices_dev as a dev twin of market_prices,
-- following the dev-twin pattern used for transactional data (transactions_dev,
-- ledger_entries_dev, auto_signals_dev, etc.).
--
-- This was a mistake. EOD prices are master/reference data — the closing
-- price of HDFCBANK on 2026-04-25 is an objective fact, identical in dev
-- and prod environments. Same classification as securities_db, investors,
-- brokers, securities_nfo, investor_broker_accounts (per LESSONS Rule B.20.3:
-- shared master tables, no dev twin).
--
-- The dev/prod split exists for experimental data the user creates (test
-- trades, test signals), not for facts.
--
-- Fix: drop market_prices_dev. Both prod and dev runtime modes will read
-- from the single shared market_prices table. The fetch interceptor must NOT
-- route market_prices through a _dev suffix (would 404 once this runs).
--
-- The dev table is currently empty (created in migration 40 today, no data
-- has been ingested yet) — zero data-loss risk.
--
-- Safe to re-run (IF EXISTS guard).
-- Run once in Supabase SQL Editor.

-- ============================================================================
-- 1.  Drop the dev twin
-- ============================================================================
-- CASCADE handles the auto-created RLS policy and any indexes copied via LIKE.

DROP TABLE IF EXISTS market_prices_dev CASCADE;

-- ============================================================================
-- 2.  Sanity report — confirm gone, and the prod table is untouched
-- ============================================================================

SELECT
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_name = 'market_prices_dev') AS dev_twin_still_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_name = 'market_prices')      AS prod_table_intact,
    (SELECT count(*) FROM market_prices)              AS prod_row_count;
