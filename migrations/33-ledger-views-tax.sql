-- Migration 33: Ledger views table + tax_rate fields
-- Date: 02-Apr-2026

-- Ledger views (same pattern as portfolio_views)
CREATE TABLE IF NOT EXISTS ledger_views (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    sort_order INT DEFAULT 0,
    is_default BOOLEAN DEFAULT false,
    show_in_tabs BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE ledger_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON ledger_views FOR ALL USING (true) WITH CHECK (true);

-- Tax rate on investors (percentage, e.g., 12.5 for 12.5%)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;

-- Tax rate per broker account (overrides investor-level when > 0)
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;
