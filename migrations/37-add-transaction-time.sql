-- Migration 37: add transaction_time column to transactions + transactions_dev
--
-- Captures the HH:MM:SS portion of a trade separately from transaction_date
-- (which remains a DATE column — not touched). Nullable because many existing
-- rows and several non-trading paths (CN import for now, Excel import,
-- corporate actions, historical P&L) don't carry a time.
--
-- Sort convention: treat NULL time as '00:00:00' for chronological ordering;
-- within a (date, time) tuple, id (insertion order) remains the tiebreaker.
-- See WMS-LESSONS §A.2.15 for write-path rules and §E.16 for sort semantics.
--
-- Run once in Supabase SQL Editor.

ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS transaction_time TIME;
ALTER TABLE transactions_dev ADD COLUMN IF NOT EXISTS transaction_time TIME;

-- Verification
SELECT 'transactions' AS table_name,
       COUNT(*) AS total_rows,
       COUNT(transaction_time) AS rows_with_time
FROM transactions
UNION ALL
SELECT 'transactions_dev',
       COUNT(*),
       COUNT(transaction_time)
FROM transactions_dev;
