-- Migration 23: Add tab display and default view support to portfolio_views
-- Run after migration 21

ALTER TABLE portfolio_views ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;
ALTER TABLE portfolio_views ADD COLUMN IF NOT EXISTS show_in_tabs BOOLEAN DEFAULT true;
