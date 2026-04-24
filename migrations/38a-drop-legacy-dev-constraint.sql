-- Migration 38a: drop the legacy entry_type CHECK constraint on
-- ledger_entries_dev that survived migration 38.
--
-- BACKGROUND
-- Migration 36 created ledger_entries_dev via `CREATE TABLE (LIKE
-- ledger_entries INCLUDING ALL)`. When PostgreSQL copies CHECK
-- constraints via LIKE INCLUDING ALL it keeps the SOURCE constraint
-- name rather than generating a new one, so the dev table ended up
-- with a constraint named `ledger_entries_entry_type_check` (not
-- `ledger_entries_dev_entry_type_check` as one might expect).
--
-- Migration 38 tried to DROP the `_dev_`-suffixed name (didn't exist
-- → silent no-op) and ADD a new `_dev_entry_type_check`. Result: the
-- dev table ended up with BOTH the original strict constraint AND the
-- new permissive one. The stricter one wins, so RECONCILIATION inserts
-- were still being rejected even though migration 38 had run.
--
-- Fix: drop the legacy-named constraint.
--
-- Run once in Supabase SQL Editor. Idempotent. Safe to re-run.

ALTER TABLE ledger_entries_dev DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;

-- Verification — ledger_entries_dev should now have exactly one
-- entry_type CHECK constraint, and it should include 'RECONCILIATION'.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'ledger_entries_dev'::regclass
  AND contype = 'c';
