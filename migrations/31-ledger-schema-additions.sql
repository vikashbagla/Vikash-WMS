-- Migration 31: Ledger schema additions
-- Add interest_terms (JSONB) and margin_rate to investor_broker_accounts
-- Add interest_rate and interest_terms to investors (for consolidated ledger)

-- investor_broker_accounts: interest_terms JSON (rate + frequency in one field)
-- When present, takes precedence over the existing interest_rate column.
-- If NULL, engine falls back to interest_rate with default weekly_friday frequency.
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;

-- investor_broker_accounts: margin_rate for F&O trades
-- Applied as: margin_blocked = |net_amount| * (margin_rate / 100) for futures + option sells
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS margin_rate NUMERIC(5,2) DEFAULT 0;

-- investors: interest_rate for consolidated trader ledger (across all brokers)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(5,2) DEFAULT 0;

-- investors: interest_terms for consolidated trader ledger
ALTER TABLE investors ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;
