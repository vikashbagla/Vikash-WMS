-- Migration 34: Add unique constraint on ledger_views.name
-- Prevents duplicate view names at the DB level

-- First clean up any remaining duplicates (keep the earliest created)
DELETE FROM ledger_views a
USING ledger_views b
WHERE a.created_at > b.created_at
  AND a.name = b.name;

-- Add unique constraint
ALTER TABLE ledger_views ADD CONSTRAINT ledger_views_name_unique UNIQUE (name);
