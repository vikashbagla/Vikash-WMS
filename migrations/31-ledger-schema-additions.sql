-- Migration 31: Ledger schema additions
-- Add interest_terms (JSONB) and margin_rate to investor_broker_accounts
-- Add interest_terms to investors (for consolidated ledger)
-- Migrate existing interest_rate data to interest_terms, then drop interest_rate column

-- investor_broker_accounts: interest_terms JSON (rate + frequency in one field)
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;

-- investor_broker_accounts: margin_rate for F&O trades
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS margin_rate NUMERIC(5,2) DEFAULT 0;

-- investors: interest_terms for consolidated trader ledger (across all brokers)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;

-- Migrate any existing interest_rate data into interest_terms before dropping
UPDATE investor_broker_accounts
SET interest_terms = jsonb_build_object('rate', interest_rate, 'frequency', 'weekly_friday', 'compound', false)
WHERE interest_rate > 0 AND interest_terms IS NULL;

-- Drop the old interest_rate column from IBA (was added in Migration 21, now fully replaced by interest_terms)
ALTER TABLE investor_broker_accounts DROP COLUMN IF EXISTS interest_rate;

-- Drop interest_rate from investors (was added by an earlier run of this migration, no longer needed)
ALTER TABLE investors DROP COLUMN IF EXISTS interest_rate;
