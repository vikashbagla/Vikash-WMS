-- Migration 17: Watchlist tables
-- Run in Supabase SQL Editor

-- Table: watchlists
CREATE TABLE IF NOT EXISTS watchlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_collapsed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table: watchlist_items
CREATE TABLE IF NOT EXISTS watchlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchlist_id UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL,
    security_source TEXT NOT NULL DEFAULT 'securities_db',  -- 'securities_db' or 'securities_nfo'
    short_symbol TEXT NOT NULL,
    company_name TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),

    -- No duplicate securities within the same watchlist
    UNIQUE (watchlist_id, security_id, security_source)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist ON watchlist_items(watchlist_id);

-- Auto-update updated_at on watchlists
CREATE OR REPLACE FUNCTION update_watchlists_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_watchlists_updated_at ON watchlists;
CREATE TRIGGER trg_watchlists_updated_at
    BEFORE UPDATE ON watchlists
    FOR EACH ROW
    EXECUTE FUNCTION update_watchlists_updated_at();

-- Enable RLS (Row Level Security) - optional, depends on your Supabase setup
-- ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;
