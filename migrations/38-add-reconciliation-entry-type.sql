-- Migration 38: allow RECONCILIATION entries in ledger_entries
--
-- Reconciliation is a balance-snapshot marker: "at date D, the cash balance
-- was audited and confirmed to be X". Semantically it behaves like
-- OPENING_BALANCE (hard-set of the running balance on re-render), but stays
-- on record so the history of reconciliations is visible.
--
-- Design (see WMS-LESSONS §E.17, added 2026-04-24):
--   - entry_type = 'RECONCILIATION'
--   - entry_date = the date BEING reconciled (closing-of-day balance)
--   - amount    = the reconciled balance at that date
--   - notes     = optional user note
--   - created_at = when the recon was performed (used to detect "dirty"
--                  transactions edited after this recon — txn.updated_at
--                  > recon.created_at for pre-recon txns)
--
-- Running-balance semantics (rendered in trading-ledger.js):
--   When a RECONCILIATION row is encountered in the balance loop, the loop
--   SETS the running balance to `amount` (exactly like OPENING_BALANCE).
--   All subsequent rows continue from that anchor. This is what makes the
--   reconciliation meaningful — the snapshot value is TRUSTED even if
--   pre-recon trades get edited afterwards.
--
-- Run once in Supabase SQL Editor. Idempotent (DROP + ADD).

BEGIN;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
    CHECK (entry_type IN (
        'CASH_RECEIVED',
        'CASH_PAID',
        'INTEREST_BOOKED',
        'ADJUSTMENT',
        'OPENING_BALANCE',
        'RECONCILIATION'
    ));

-- Mirror on the dev copy (per B.20.2).
ALTER TABLE ledger_entries_dev DROP CONSTRAINT IF EXISTS ledger_entries_dev_entry_type_check;
ALTER TABLE ledger_entries_dev ADD CONSTRAINT ledger_entries_dev_entry_type_check
    CHECK (entry_type IN (
        'CASH_RECEIVED',
        'CASH_PAID',
        'INTEREST_BOOKED',
        'ADJUSTMENT',
        'OPENING_BALANCE',
        'RECONCILIATION'
    ));

COMMIT;

-- Verification
SELECT 'ledger_entries' AS table_name,
       COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE entry_type = 'RECONCILIATION') AS recon_rows
FROM ledger_entries
UNION ALL
SELECT 'ledger_entries_dev',
       COUNT(*),
       COUNT(*) FILTER (WHERE entry_type = 'RECONCILIATION')
FROM ledger_entries_dev;
