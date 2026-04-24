-- Migration 39 — link ledger_entries to their source portfolio_view.
--
-- Establishes the canonical scope for a ledger entry: the view whose filter was
-- active when the entry was saved. Goes hand-in-hand with the app-side change
-- that (a) prompts the user to save/update their view before any ledger POST,
-- and (b) filter-locks a view as soon as any ledger_entry references it, so
-- past reconciliations can't have their meaning silently changed by editing
-- the view's filter later.
--
-- See WMS-SCHEMA §14 + LESSONS §E.17.8 for the full semantics.
--
-- Safe to re-run (idempotent guards on column, index, and backfill).
-- Run once in Supabase SQL Editor.
--
-- ============================================================================
-- 1. Add view_id column to ledger_entries + ledger_entries_dev
-- ============================================================================

ALTER TABLE ledger_entries
    ADD COLUMN IF NOT EXISTS view_id UUID
    REFERENCES portfolio_views(id) ON DELETE SET NULL;

ALTER TABLE ledger_entries_dev
    ADD COLUMN IF NOT EXISTS view_id UUID
    REFERENCES portfolio_views(id) ON DELETE SET NULL;

-- Partial index: only indexes rows that actually reference a view. Much
-- smaller than a full-column index, same query selectivity.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_view_id
    ON ledger_entries(view_id) WHERE view_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_dev_view_id
    ON ledger_entries_dev(view_id) WHERE view_id IS NOT NULL;

-- ============================================================================
-- 2. Backfill view_id for existing rows
-- ============================================================================
-- For each entry, find the most-specific portfolio_views row whose filter
-- would include this entry (module='ledger'):
--   • investorIds: empty → any-investor; else must contain entry.investor_id
--   • traderIds:   empty → any-trader;   else must contain COALESCE(entry.trader_id, entry.investor_id)
--   • brokerIds:   empty → any-broker;   else entry.broker_id must be set AND in the list
--   • tagNames:    IGNORED for ledger entries (tags are a trade-level concern;
--                  ledger entries don't have tags for scoping purposes).
--
-- Tie-breaking: prefer views with more filter constraints (most specific).
-- If multiple views tie on specificity, prefer the oldest one (assumed to
-- be the user's original view for that slice).
--
-- Rows that don't match any view (ad-hoc filter at save time, or entry
-- created before any matching view existed) keep view_id NULL. The app's
-- scope-match logic falls back to the legacy investor_id/trader_id/broker_id
-- columns in that case, so they remain fully functional.

WITH match AS (
    SELECT DISTINCT ON (le.id)
        le.id AS entry_id,
        pv.id AS view_id
    FROM ledger_entries le
    JOIN portfolio_views pv ON pv.module = 'ledger'
    WHERE
        (jsonb_array_length(COALESCE(pv.filters->'investorIds', '[]'::jsonb)) = 0
         OR (pv.filters->'investorIds') ? le.investor_id::text)
        AND
        (jsonb_array_length(COALESCE(pv.filters->'traderIds', '[]'::jsonb)) = 0
         OR (pv.filters->'traderIds') ? COALESCE(le.trader_id, le.investor_id)::text)
        AND
        (jsonb_array_length(COALESCE(pv.filters->'brokerIds', '[]'::jsonb)) = 0
         OR (le.broker_id IS NOT NULL AND (pv.filters->'brokerIds') ? le.broker_id::text))
    ORDER BY
        le.id,
        -- Specificity: more non-empty filter arrays wins.
        jsonb_array_length(COALESCE(pv.filters->'investorIds', '[]'::jsonb)) +
        jsonb_array_length(COALESCE(pv.filters->'traderIds', '[]'::jsonb)) +
        jsonb_array_length(COALESCE(pv.filters->'brokerIds', '[]'::jsonb)) DESC,
        pv.created_at ASC NULLS LAST
)
UPDATE ledger_entries le
SET view_id = match.view_id
FROM match
WHERE le.id = match.entry_id AND le.view_id IS NULL;

WITH match AS (
    SELECT DISTINCT ON (le.id)
        le.id AS entry_id,
        pv.id AS view_id
    FROM ledger_entries_dev le
    JOIN portfolio_views pv ON pv.module = 'ledger'
    WHERE
        (jsonb_array_length(COALESCE(pv.filters->'investorIds', '[]'::jsonb)) = 0
         OR (pv.filters->'investorIds') ? le.investor_id::text)
        AND
        (jsonb_array_length(COALESCE(pv.filters->'traderIds', '[]'::jsonb)) = 0
         OR (pv.filters->'traderIds') ? COALESCE(le.trader_id, le.investor_id)::text)
        AND
        (jsonb_array_length(COALESCE(pv.filters->'brokerIds', '[]'::jsonb)) = 0
         OR (le.broker_id IS NOT NULL AND (pv.filters->'brokerIds') ? le.broker_id::text))
    ORDER BY
        le.id,
        jsonb_array_length(COALESCE(pv.filters->'investorIds', '[]'::jsonb)) +
        jsonb_array_length(COALESCE(pv.filters->'traderIds', '[]'::jsonb)) +
        jsonb_array_length(COALESCE(pv.filters->'brokerIds', '[]'::jsonb)) DESC,
        pv.created_at ASC NULLS LAST
)
UPDATE ledger_entries_dev le
SET view_id = match.view_id
FROM match
WHERE le.id = match.entry_id AND le.view_id IS NULL;

-- ============================================================================
-- 3. Sanity report — how many rows got a view_id vs remained NULL.
-- Rows with view_id=NULL will use the legacy investor_id/trader_id/broker_id
-- scope-match fallback. If the unassigned count is surprisingly high, inspect
-- the individual rows and either update them manually or (temporarily) relax
-- your views' filter specificity so the backfill catches them.
-- ============================================================================

SELECT 'ledger_entries' AS tbl,
       entry_type,
       count(*) FILTER (WHERE view_id IS NOT NULL) AS assigned,
       count(*) FILTER (WHERE view_id IS NULL) AS unassigned_legacy
FROM ledger_entries
GROUP BY entry_type
UNION ALL
SELECT 'ledger_entries_dev' AS tbl,
       entry_type,
       count(*) FILTER (WHERE view_id IS NOT NULL) AS assigned,
       count(*) FILTER (WHERE view_id IS NULL) AS unassigned_legacy
FROM ledger_entries_dev
GROUP BY entry_type
ORDER BY tbl, entry_type;

-- ============================================================================
-- 4. Per-view breakdown — see which views acquired entries (and thus will
-- become filter-locked in the Statements module).
-- ============================================================================

SELECT
    pv.id, pv.name, pv.module,
    count(le.id) FILTER (WHERE le.id IS NOT NULL) AS entry_count_prod,
    count(led.id) FILTER (WHERE led.id IS NOT NULL) AS entry_count_dev
FROM portfolio_views pv
LEFT JOIN ledger_entries le ON le.view_id = pv.id
LEFT JOIN ledger_entries_dev led ON led.view_id = pv.id
WHERE pv.module = 'ledger'
GROUP BY pv.id, pv.name, pv.module
ORDER BY pv.name;
