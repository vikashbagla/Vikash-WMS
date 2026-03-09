-- Migration 27: Add 52-week high/low columns to securities_db
-- Source: Yahoo Finance v7 quote API (fiftyTwoWeekHigh, fiftyTwoWeekLow)
-- Populated via "52wk Sync" button in Master Data > Securities DB

ALTER TABLE securities_db ADD COLUMN IF NOT EXISTS week_52_high NUMERIC(12,2);
ALTER TABLE securities_db ADD COLUMN IF NOT EXISTS week_52_low  NUMERIC(12,2);
ALTER TABLE securities_db ADD COLUMN IF NOT EXISTS week_52_updated_at TIMESTAMPTZ;
