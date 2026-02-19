-- Migration 18: Change watchlist_items.security_id from INTEGER to TEXT
-- This allows storing both SERIAL integer IDs and UUID strings
-- Run in Supabase SQL Editor

-- Drop the unique constraint first (it references security_id)
ALTER TABLE watchlist_items DROP CONSTRAINT IF EXISTS watchlist_items_watchlist_id_security_id_security_source_key;

-- Change column type from INTEGER to TEXT (existing integer values become text)
ALTER TABLE watchlist_items ALTER COLUMN security_id TYPE TEXT USING security_id::TEXT;

-- Re-create the unique constraint
ALTER TABLE watchlist_items ADD CONSTRAINT watchlist_items_watchlist_id_security_id_security_source_key
    UNIQUE (watchlist_id, security_id, security_source);
