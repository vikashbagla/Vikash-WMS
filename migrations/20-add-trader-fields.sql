-- Migration 20: Add trader_id and trader_charges to transactions
-- trader_id = the executing investor (who placed the trade)
-- investor_id = the beneficiary (whose portfolio the trade belongs to)
-- Default: trader_id = investor_id (most trades are self-executed)

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS trader_id UUID REFERENCES investors(id) ON DELETE SET NULL;
UPDATE transactions SET trader_id = investor_id WHERE trader_id IS NULL;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS trader_charges NUMERIC DEFAULT 0;
UPDATE transactions SET trader_charges = total_charges WHERE trader_charges = 0;
