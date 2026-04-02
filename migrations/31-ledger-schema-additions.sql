-- Migration 31: Ledger schema additions
-- Add interest_terms (JSONB) and margin_rate to investor_broker_accounts
-- Add interest_terms to investors (for consolidated ledger)
-- NOTE: investor_broker_accounts.interest_rate (NUMERIC) already exists from Migration 21 — now DEPRECATED.
-- All interest config is in interest_terms JSONB. The old column is kept but ignored by the app.

-- investor_broker_accounts: interest_terms JSON (rate + frequency in one field)
-- This is the single source of truth for interest settings. Replaces the old interest_rate column.
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;

-- investor_broker_accounts: margin_rate for F&O trades
-- Applied as: margin_blocked = |net_amount| * (margin_rate / 100) for futures + option sells
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS margin_rate NUMERIC(5,2) DEFAULT 0;

-- investors: interest_terms for consolidated trader ledger (across all brokers)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS interest_terms JSONB DEFAULT NULL;
