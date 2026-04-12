-- Migration 35: Drop unused ledger_views table
-- This table was created in migration 33 but never used by the app.
-- The Statements module uses portfolio_views (module='ledger') instead.

DROP POLICY IF EXISTS "anon_all" ON ledger_views;
DROP TABLE IF EXISTS ledger_views;
