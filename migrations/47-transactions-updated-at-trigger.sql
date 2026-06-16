-- ============================================================================
-- Migration 47: Guarantee updated_at auto-maintenance on transactions
-- ============================================================================
-- WHY:
--   WMS-SCHEMA.md has long described transactions.updated_at as
--   "Auto-trigger on update", and the live DB behaves that way — but the
--   trigger itself was a Studio-applied object never captured in a migration.
--   It is therefore invisible to version control and was NOT inherited by
--   transactions_dev (created via `LIKE transactions INCLUDING ALL`, which in
--   Postgres does NOT copy triggers).
--
--   The incremental-load scheme (probe on module entry: row COUNT + MAX(updated_at)
--   to decide whether the in-memory transactions cache is still current) depends
--   on updated_at being bumped on EVERY edit, enforced below the application so
--   no future module can bypass it. This migration formalises that guarantee and
--   records it in version control.
--
-- SAFE TO RE-RUN: fully idempotent. If the trigger already exists it is simply
--   redefined; if it was missing (e.g. on transactions_dev or prod) it is added.
--   Sets no data — only attaches a BEFORE UPDATE trigger.
-- ============================================================================

-- Generic, reusable helper: stamp updated_at = now() on any row being updated.
-- Reusable by future tables (see WMS-SCHEMA.md "New-table conventions").
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- transactions (production table)
DROP TRIGGER IF EXISTS trg_transactions_updated_at ON transactions;
CREATE TRIGGER trg_transactions_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- transactions_dev (dev twin — did NOT inherit the trigger via LIKE INCLUDING ALL)
DROP TRIGGER IF EXISTS trg_transactions_dev_updated_at ON transactions_dev;
CREATE TRIGGER trg_transactions_dev_updated_at
    BEFORE UPDATE ON transactions_dev
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- VERIFY (run manually after applying):
--   SELECT tgrelid::regclass AS tbl, tgname
--   FROM pg_trigger
--   WHERE tgrelid IN ('transactions'::regclass, 'transactions_dev'::regclass)
--     AND NOT tgisinternal;
-- Expect: trg_transactions_updated_at, trg_transactions_dev_updated_at
-- ----------------------------------------------------------------------------
