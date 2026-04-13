-- Migration 36: Create dev copies of transactions & ledger_entries tables
-- Used by the dev environment (Netlify) to isolate test data from production.
-- The fetch interceptor in app.html rewrites REST URLs when WMS_ENV='dev'.
-- Master tables (investors, brokers, securities, IBAs, etc.) are shared.
--
-- Run once in the Supabase SQL Editor. Safe to re-run (IF NOT EXISTS).

-- ============================================================================
-- 1. transactions_dev — same schema as transactions
-- ============================================================================

CREATE TABLE IF NOT EXISTS transactions_dev (LIKE transactions INCLUDING ALL);

-- LIKE…INCLUDING ALL copies columns, defaults, constraints, and indexes,
-- but does NOT copy RLS policies or foreign key constraints.
-- Re-add the essential foreign keys:
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'transactions_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'transactions_dev_investor_id_fkey'
    ) THEN
        ALTER TABLE transactions_dev
            ADD CONSTRAINT transactions_dev_investor_id_fkey
            FOREIGN KEY (investor_id) REFERENCES investors(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'transactions_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'transactions_dev_broker_id_fkey'
    ) THEN
        ALTER TABLE transactions_dev
            ADD CONSTRAINT transactions_dev_broker_id_fkey
            FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE SET NULL;
    END IF;
END $$;

-- RLS: same open policy as production (single-user system)
ALTER TABLE transactions_dev ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'transactions_dev' AND policyname = 'anon_all'
    ) THEN
        CREATE POLICY "anon_all" ON transactions_dev FOR ALL USING (true) WITH CHECK (true);
    END IF;
END $$;

-- ============================================================================
-- 2. ledger_entries_dev — same schema as ledger_entries
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger_entries_dev (LIKE ledger_entries INCLUDING ALL);

-- Re-add foreign keys
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'ledger_entries_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'ledger_entries_dev_investor_id_fkey'
    ) THEN
        ALTER TABLE ledger_entries_dev
            ADD CONSTRAINT ledger_entries_dev_investor_id_fkey
            FOREIGN KEY (investor_id) REFERENCES investors(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'ledger_entries_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'ledger_entries_dev_broker_id_fkey'
    ) THEN
        ALTER TABLE ledger_entries_dev
            ADD CONSTRAINT ledger_entries_dev_broker_id_fkey
            FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE SET NULL;
    END IF;
END $$;

-- RLS
ALTER TABLE ledger_entries_dev ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'ledger_entries_dev' AND policyname = 'anon_all'
    ) THEN
        CREATE POLICY "anon_all" ON ledger_entries_dev FOR ALL USING (true) WITH CHECK (true);
    END IF;
END $$;

-- ============================================================================
-- 3. Copy current production data into dev tables
-- ============================================================================
-- Only inserts if dev tables are empty (first run). Re-running is safe.

INSERT INTO transactions_dev
SELECT * FROM transactions
WHERE NOT EXISTS (SELECT 1 FROM transactions_dev LIMIT 1);

INSERT INTO ledger_entries_dev
SELECT * FROM ledger_entries
WHERE NOT EXISTS (SELECT 1 FROM ledger_entries_dev LIMIT 1);

-- ============================================================================
-- Done. The dev site (Netlify) will now read/write these tables instead of
-- the production ones. Master data (investors, brokers, securities, IBAs,
-- portfolio_views, regulatory_charges_config) is shared across both envs.
-- ============================================================================
