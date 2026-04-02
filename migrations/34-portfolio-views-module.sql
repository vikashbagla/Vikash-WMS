-- Add module column to portfolio_views so the same table can hold views
-- for Portfolio, F&O, Ledger, and any future pages.
-- Existing rows (created before this column) get NULL, which trading.js
-- already handles: it queries "module.eq.trading_portfolio,module.is.null".

ALTER TABLE portfolio_views ADD COLUMN IF NOT EXISTS module TEXT DEFAULT NULL;

-- Back-fill existing rows that were created by the Portfolio page
UPDATE portfolio_views SET module = 'trading_portfolio' WHERE module IS NULL;
