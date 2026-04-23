-- ============================================================================
-- SYNC DEV TABLES FROM PRODUCTION
-- ============================================================================
-- Refreshes transactions_dev and ledger_entries_dev with current production data.
-- Run periodically in Supabase SQL Editor to keep dev testing on real data.
--
-- WHAT THIS DOES:
--   1. Truncates both dev tables (wipes all dev data)
--   2. Copies all rows from production tables into dev tables
--   3. Reports row counts for confirmation
--
-- SAFE TO RUN: Only affects _dev tables. Production tables are READ-ONLY here.
-- WARNING: Any dev-only data (test transactions, test ledger entries) will be lost.
-- ============================================================================

BEGIN;

-- 1. Clear dev tables
TRUNCATE transactions_dev CASCADE;
TRUNCATE ledger_entries_dev CASCADE;

-- 2. Copy production → dev
INSERT INTO transactions_dev
SELECT * FROM transactions;

INSERT INTO ledger_entries_dev
SELECT * FROM ledger_entries;

COMMIT;

-- 3. Report counts for verification
SELECT
    'transactions' AS table_name,
    (SELECT COUNT(*) FROM transactions) AS production_rows,
    (SELECT COUNT(*) FROM transactions_dev) AS dev_rows
UNION ALL
SELECT
    'ledger_entries',
    (SELECT COUNT(*) FROM ledger_entries),
    (SELECT COUNT(*) FROM ledger_entries_dev);
