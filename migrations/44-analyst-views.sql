-- Migration 44 — Analyst-facing read-only views over the auto-trading module.
--
-- Purpose: allow an external analyst (the MS007 author) to view the same GS +
-- Pairs strategy dashboard at a public URL (no login) without ever seeing any
-- sensitive WMS data — transactions, ledger entries, broker tokens, investor
-- info, recipient emails, etc.
--
-- Design philosophy (chosen over RLS-policy approach because views give us
-- column-level boundaries, schema-evolution safety, and SELECT-only by
-- definition — see analyst access ADR):
--
--   1. NO RLS changes on base tables. Owner-only policies stay exactly as-is.
--   2. Seven security_invoker = false views with structural column matching
--      against base tables — every column the existing automation.js queries
--      is present in the view; sensitive ones are BLANKED, not omitted, so
--      automation.js works unchanged.
--   3. GRANT SELECT on each view to anon (the public Supabase role).
--   4. The analyst's page sets window.__WMS_ANALYST_MODE=true, and a fetch
--      interceptor rewrites every /rest/v1/<base_table> URL to
--      /rest/v1/v_analyst_<base_table>. Vikash's normal login path is
--      unchanged — flag isn't set, queries go to base tables, RLS gates.
--
-- Sensitive fields blanked (not omitted) to preserve schema parity:
--   auto_strategies.recipients     → empty JSONB array
--   auto_signals.email_recipients  → empty JSONB array
--   securities_db.broker_tokens    → NULL (column kept for `select=*` parity)
--   securities_nfo.broker_tokens   → NULL
--
-- Strategy allowlist (in views 1, 2, 4): silver_mini_15m, gold_mini_15m, pairs.
-- Add more later by editing the WHERE clauses.

BEGIN;

-- ─── View 1: auto_signals ────────────────────────────────────────────────────
-- Filtered to analyst strategies + PAPER-only (Phase 9 LIVE safety).
-- email_recipients BLANKED (preserved as column for select=* parity).

CREATE OR REPLACE VIEW v_analyst_signals
WITH (security_invoker = false) AS
SELECT
    id, trade_id, strategy_name, fired_at, event_type, execution_mode,
    legs, direction, score, notes, metadata,
    email_status, email_sent_at, email_subject, email_error,
    '[]'::jsonb AS email_recipients,            -- BLANKED (had analyst+owner emails)
    dedupe_key, source
    -- Note: auto_signals has no created_at — fired_at is the canonical timestamp.
FROM auto_signals
WHERE strategy_name IN ('silver_mini_15m', 'gold_mini_15m', 'pairs')
  AND execution_mode = 'PAPER';

GRANT SELECT ON v_analyst_signals TO anon;

-- ─── View 2: auto_strategies ─────────────────────────────────────────────────
-- recipients BLANKED to empty array — automation.js queries this column
-- explicitly at line 586 and renders a count, so we preserve schema parity
-- but hide the actual email addresses.

CREATE OR REPLACE VIEW v_analyst_strategies
WITH (security_invoker = false) AS
SELECT
    id, name, display_name, version, owner, enabled, execution_mode,
    '[]'::jsonb AS recipients,                   -- BLANKED (had Vikash+Nikhar emails)
    metadata, created_at, updated_at
FROM auto_strategies
WHERE name IN ('silver_mini_15m', 'gold_mini_15m', 'pairs');

GRANT SELECT ON v_analyst_strategies TO anon;

-- ─── View 3: auto_runs ───────────────────────────────────────────────────────
-- Full visibility on all runs (incl. _eod_ingest, _mcx_candles_ingest sentinels)
-- — analyst benefits from seeing system operational health, no sensitive data.

CREATE OR REPLACE VIEW v_analyst_runs
WITH (security_invoker = false) AS
SELECT
    id, strategy_name, started_at, finished_at, duration_ms,
    signals_generated, emails_sent, emails_failed, status, error,
    log_excerpt, metadata
FROM auto_runs;

GRANT SELECT ON v_analyst_runs TO anon;

-- ─── View 4: v_auto_open_trades ──────────────────────────────────────────────
-- Filtered to analyst strategies. v_auto_open_trades is itself a view
-- aggregating from auto_signals; security_invoker=false here bypasses the
-- anon RLS denial on the auto_signals chain.

CREATE OR REPLACE VIEW v_analyst_open_trades
WITH (security_invoker = false) AS
SELECT *
FROM v_auto_open_trades
WHERE strategy_name IN ('silver_mini_15m', 'gold_mini_15m', 'pairs');

GRANT SELECT ON v_analyst_open_trades TO anon;

-- ─── View 5: market_prices ───────────────────────────────────────────────────
-- All OHLCV columns. No sensitive data — reference market info.

CREATE OR REPLACE VIEW v_analyst_market_prices
WITH (security_invoker = false) AS
SELECT
    id, security_id, external_symbol, security_type, resolution,
    price_date, bar_ts, open, high, low, close, volume, created_at
FROM market_prices;

GRANT SELECT ON v_analyst_market_prices TO anon;

-- ─── View 6: securities_db lookup ────────────────────────────────────────────
-- ALL columns from securities_db EXCEPT broker_tokens (which holds Fyers
-- symbol mapping). automation.js queries by `symbol` (line 1153) — must keep
-- that column. Keeping all other columns simplifies any future ad-hoc lookups.

CREATE OR REPLACE VIEW v_analyst_securities_lookup
WITH (security_invoker = false) AS
SELECT
    id, symbol, company_name, isin, nse_symbol, nse_script_code,
    bse_symbol, bse_script_code, lot_size, security_type, asset_class,
    nse_series, bse_series, fyers_instr_type, size, sector,
    week_52_high, week_52_low, week_52_updated_at, is_active,
    NULL::jsonb AS broker_tokens,                -- BLANKED (Fyers ID mapping)
    merged_into_id, merged_at, created_at, updated_at
FROM securities_db;

GRANT SELECT ON v_analyst_securities_lookup TO anon;

-- ─── View 7: securities_nfo lookup ───────────────────────────────────────────
-- ALL columns from securities_nfo EXCEPT broker_tokens.

CREATE OR REPLACE VIEW v_analyst_securities_nfo_lookup
WITH (security_invoker = false) AS
SELECT
    id, symbol, instrument_name, exchange, instrument_type,
    underlying_symbol, expiry_date, strike_price, option_type,
    lot_size, trading_session, is_active,
    NULL::jsonb AS broker_tokens,                -- BLANKED (Fyers ID mapping)
    created_at, updated_at
FROM securities_nfo;

GRANT SELECT ON v_analyst_securities_nfo_lookup TO anon;

-- ─── Sanity verification ─────────────────────────────────────────────────────

SELECT 'v_analyst_signals'                 AS view_name, count(*) AS row_count FROM v_analyst_signals UNION ALL
SELECT 'v_analyst_strategies',             count(*) FROM v_analyst_strategies UNION ALL
SELECT 'v_analyst_runs',                   count(*) FROM v_analyst_runs UNION ALL
SELECT 'v_analyst_open_trades',            count(*) FROM v_analyst_open_trades UNION ALL
SELECT 'v_analyst_market_prices',          count(*) FROM v_analyst_market_prices UNION ALL
SELECT 'v_analyst_securities_lookup',      count(*) FROM v_analyst_securities_lookup UNION ALL
SELECT 'v_analyst_securities_nfo_lookup',  count(*) FROM v_analyst_securities_nfo_lookup;

COMMIT;
