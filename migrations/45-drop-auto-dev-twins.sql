-- Migration 45 — Drop unused auto_* dev twin tables and view.
--
-- Migration 40 created _dev twins for the auto-trading module
-- (auto_strategies_dev, auto_signals_dev, auto_runs_dev, v_auto_open_trades_dev)
-- following the dev/prod twin pattern used by transactions_dev / ledger_entries_dev.
--
-- However: app.html's fetch interceptor (lines 146-147) only routes
-- `transactions` → `transactions_dev` and `ledger_entries` → `ledger_entries_dev`.
-- It was never extended to route auto_*. The Edge Functions
-- (automation-runner, tv-webhook, eod-prices-ingest, mcx-candles-ingest) write
-- exclusively to the PROD tables on both dev and prod sites. So the _dev twins
-- have always been empty and unread.
--
-- Same rationale as migration 41 (which dropped market_prices_dev): the
-- dev/prod twin pattern doesn't fit price/signal data. Dev and prod modes
-- share the single production auto_* tables, with execution_mode='PAPER'
-- providing all the isolation we actually need.
--
-- This migration:
--   1. Drops v_auto_open_trades_dev (depends on auto_signals_dev)
--   2. Drops auto_runs_dev, auto_signals_dev, auto_strategies_dev (in FK order)
--   3. CASCADE handles any RLS policies and FK constraints
--
-- IDEMPOTENT — DROP IF EXISTS throughout. Safe to re-run.
--
-- Forward-compat: if we ever genuinely need dev twins (we don't), they can
-- be recreated via `LIKE auto_strategies INCLUDING ALL` like migration 40 did.

BEGIN;

-- ─── 1. Drop the view first (depends on auto_signals_dev) ────────────────────

DROP VIEW IF EXISTS v_auto_open_trades_dev CASCADE;

-- ─── 2. Drop the dev twins in FK order: signals/runs FK → strategies ─────────

DROP TABLE IF EXISTS auto_runs_dev    CASCADE;   -- FK → auto_strategies_dev
DROP TABLE IF EXISTS auto_signals_dev CASCADE;   -- FK → auto_strategies_dev
DROP TABLE IF EXISTS auto_strategies_dev CASCADE;

-- ─── 3. Verification ─────────────────────────────────────────────────────────

SELECT
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_strategies_dev') AS strategies_dev_remaining,
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_signals_dev')    AS signals_dev_remaining,
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_runs_dev')       AS runs_dev_remaining,
    (SELECT count(*) FROM information_schema.views
        WHERE table_name = 'v_auto_open_trades_dev') AS view_dev_remaining,
    -- Sanity: prod tables MUST still be there
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_strategies')     AS strategies_prod_intact,
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_signals')        AS signals_prod_intact,
    (SELECT count(*) FROM information_schema.tables
        WHERE table_name = 'auto_runs')           AS runs_prod_intact,
    (SELECT count(*) FROM information_schema.views
        WHERE table_name = 'v_auto_open_trades')  AS view_prod_intact;

-- Expected:
--   *_dev_remaining = 0 for all four
--   *_prod_intact   = 1 for all four

COMMIT;
