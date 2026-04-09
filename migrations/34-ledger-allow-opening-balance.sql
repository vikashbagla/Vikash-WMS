-- 34-ledger-allow-opening-balance.sql
--
-- The ledger engine and app code support OPENING_BALANCE entries (FY carry-
-- forward) but the original CHECK constraint in 32-ledger-entries.sql did not
-- include it, so any attempt to insert an opening balance from the UI fails
-- with: violates check constraint "ledger_entries_entry_type_check".
--
-- Drop the old constraint and recreate it with OPENING_BALANCE included.

ALTER TABLE ledger_entries
    DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;

ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_entries_entry_type_check
    CHECK (entry_type IN (
        'CASH_RECEIVED',
        'CASH_PAID',
        'INTEREST_BOOKED',
        'ADJUSTMENT',
        'OPENING_BALANCE'
    ));
