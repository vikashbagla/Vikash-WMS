-- Migration 32: Create ledger_entries table
-- Stores manual cash entries, interest bookings, and adjustments.
-- Trade data and margin come from the transactions table — NOT stored here.
-- This table exists because cash transfers (T0 pays broker, trader pays T0)
-- and interest bookings are not security transactions and have no home in transactions.

CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('CASH_RECEIVED', 'CASH_PAID', 'INTEREST_BOOKED', 'ADJUSTMENT')),
    investor_id UUID NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    trader_id UUID REFERENCES investors(id) ON DELETE SET NULL,
    broker_id UUID REFERENCES brokers(id) ON DELETE SET NULL,
    amount NUMERIC NOT NULL,
    entry_date DATE NOT NULL,
    reference TEXT,
    notes TEXT,
    tags TEXT[] DEFAULT '{blank}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: allow all for anon (single-user system, same as other tables)
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON ledger_entries FOR ALL USING (true) WITH CHECK (true);

-- Index for common queries: by date, by investor+trader combo
CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_investor_trader ON ledger_entries (investor_id, trader_id);
