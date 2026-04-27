-- Migration 40 — Automated Trading module schema.
--
-- Creates the three core tables for the strategy-pluggable Automated Trading
-- module (auto_strategies, auto_signals, auto_runs) plus dev twins, indexes,
-- the open-trades view, and RLS policies.
--
-- Also creates market_prices_dev (LIKE market_prices INCLUDING ALL) — the
-- prod table already exists with UNIQUE (security_id, price_date) and the
-- needed indexes; we just need a dev twin for the runtime-mode interceptor.
--
-- Retention cleanup for auto_runs is NOT done here (pg_cron is not available
-- on Supabase free tier — see migration 20260325 for the same constraint).
-- Cleanup will run inside automation-runner once per day, or as a separate
-- cron-job.org → Edge Function later if it becomes necessary.
--
-- See AUTOMATION-SCHEMA.md (v4) for column-by-column rationale, AUTOMATION-PLAN.md
-- for how the runner consumes these, and WMS-LESSONS §B.20 for the dev-twin
-- pattern this follows.
--
-- KNOWN GOTCHA (see migration 38a): CHECK constraints copied via LIKE INCLUDING
-- ALL retain the SOURCE table's constraint name. So `auto_signals_dev` ends up
-- with constraints named `auto_signals_event_type_check` (not `_dev_`-suffixed).
-- Doesn't break anything — the constraints work — but if we ever DROP/REPLACE
-- them later we have to use the source-suffixed name.
--
-- Safe to re-run (IF NOT EXISTS / DROP IF EXISTS / ON CONFLICT throughout).
-- Run once in Supabase SQL Editor. There's a single Supabase DB; this migration
-- creates BOTH the prod tables (auto_strategies, …) and the dev twins
-- (auto_strategies_dev, …) in one shot. The dev/prod split is the table-name
-- suffix; the runtime fetch interceptor routes by mode.
--
-- ============================================================================
-- 1.  market_prices_dev — twin of the existing market_prices table
-- ============================================================================
-- The prod market_prices table already has UNIQUE uq_security_date on
-- (security_id, price_date) and supporting indexes. INCLUDING ALL copies
-- constraints, indexes, and defaults onto the dev twin.

CREATE TABLE IF NOT EXISTS market_prices_dev (LIKE market_prices INCLUDING ALL);

ALTER TABLE market_prices_dev ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_all ON market_prices_dev;
CREATE POLICY owner_all ON market_prices_dev
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

-- ============================================================================
-- 2.  auto_strategies — master list of strategy plugins
-- ============================================================================

CREATE TABLE IF NOT EXISTS auto_strategies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    version         TEXT,
    owner           TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    execution_mode  TEXT NOT NULL DEFAULT 'PAPER'
                    CHECK (execution_mode IN ('PAPER','LIVE')),
    recipients      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_strategies_dev (LIKE auto_strategies INCLUDING ALL);

-- ============================================================================
-- 3.  auto_signals — append-only event log (one row per ENTRY / EXIT / etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS auto_signals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id          UUID NOT NULL,
    strategy_name     TEXT NOT NULL REFERENCES auto_strategies(name),
    fired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type        TEXT NOT NULL
                      CHECK (event_type IN ('ENTRY','PARTIAL_EXIT','TARGET_HIT',
                                            'STOP_HIT','TIME_STOP','MANUAL_EXIT')),
    execution_mode    TEXT NOT NULL
                      CHECK (execution_mode IN ('PAPER','LIVE')),
    legs              JSONB NOT NULL,
    direction         TEXT,
    score             NUMERIC,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes             TEXT,
    -- email tracking (per signal)
    email_status      TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (email_status IN ('PENDING','SENT','FAILED','SKIPPED')),
    email_sent_at     TIMESTAMPTZ,
    email_subject     TEXT,
    email_recipients  JSONB,
    email_error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_auto_signals_trade_id
    ON auto_signals (trade_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_auto_signals_strategy_fired
    ON auto_signals (strategy_name, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_signals_event_type
    ON auto_signals (strategy_name, event_type);
CREATE INDEX IF NOT EXISTS idx_auto_signals_email_status
    ON auto_signals (email_status) WHERE email_status IN ('PENDING','FAILED');
CREATE INDEX IF NOT EXISTS idx_auto_signals_legs_gin
    ON auto_signals USING GIN (legs jsonb_path_ops);

CREATE TABLE IF NOT EXISTS auto_signals_dev (LIKE auto_signals INCLUDING ALL);
-- LIKE INCLUDING ALL copies columns/defaults/CHECK/indexes but NOT foreign keys.
-- Re-add the dev FK pointing at auto_strategies_dev:
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'auto_signals_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'auto_signals_dev_strategy_name_fkey'
    ) THEN
        ALTER TABLE auto_signals_dev
            ADD CONSTRAINT auto_signals_dev_strategy_name_fkey
            FOREIGN KEY (strategy_name) REFERENCES auto_strategies_dev(name);
    END IF;
END $$;

-- ============================================================================
-- 4.  auto_runs — cron audit (one row per cron-triggered run)
-- ============================================================================

CREATE TABLE IF NOT EXISTS auto_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_name      TEXT NOT NULL REFERENCES auto_strategies(name),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ,
    duration_ms        INTEGER,
    signals_generated  INTEGER DEFAULT 0,
    emails_sent        INTEGER DEFAULT 0,
    emails_failed      INTEGER DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'RUNNING'
                       CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
    error              TEXT,
    log_excerpt        TEXT,
    metadata           JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_auto_runs_strategy_started
    ON auto_runs (strategy_name, started_at DESC);

CREATE TABLE IF NOT EXISTS auto_runs_dev (LIKE auto_runs INCLUDING ALL);
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'auto_runs_dev' AND constraint_type = 'FOREIGN KEY'
          AND constraint_name = 'auto_runs_dev_strategy_name_fkey'
    ) THEN
        ALTER TABLE auto_runs_dev
            ADD CONSTRAINT auto_runs_dev_strategy_name_fkey
            FOREIGN KEY (strategy_name) REFERENCES auto_strategies_dev(name);
    END IF;
END $$;

-- ============================================================================
-- 5.  v_auto_open_trades — derive open positions from the event log
-- ============================================================================
-- Net qty per (trade_id × symbol). A trade is "open" iff at least one symbol
-- has non-zero net qty. The runner reads this view to feed open_trades into
-- the strategy on each scan tick — strategy code applies its own exit logic
-- (z-revert, trailing, time stop, etc.) using its own parameters.

CREATE OR REPLACE VIEW v_auto_open_trades AS
WITH leg_flow AS (
    SELECT s.trade_id,
           s.strategy_name,
           leg->>'symbol'        AS symbol,
           leg->>'short_symbol'  AS short_symbol,
           SUM(CASE WHEN leg->>'side' = 'BUY'
                    THEN (leg->>'qty')::numeric
                    ELSE -(leg->>'qty')::numeric
               END) AS net_qty
    FROM auto_signals s,
         jsonb_array_elements(s.legs) AS leg
    GROUP BY s.trade_id, s.strategy_name, leg->>'symbol', leg->>'short_symbol'
)
SELECT trade_id,
       strategy_name,
       jsonb_object_agg(symbol, net_qty) AS net_position
FROM leg_flow
GROUP BY trade_id, strategy_name
HAVING NOT bool_and(net_qty = 0);

CREATE OR REPLACE VIEW v_auto_open_trades_dev AS
WITH leg_flow AS (
    SELECT s.trade_id,
           s.strategy_name,
           leg->>'symbol'        AS symbol,
           leg->>'short_symbol'  AS short_symbol,
           SUM(CASE WHEN leg->>'side' = 'BUY'
                    THEN (leg->>'qty')::numeric
                    ELSE -(leg->>'qty')::numeric
               END) AS net_qty
    FROM auto_signals_dev s,
         jsonb_array_elements(s.legs) AS leg
    GROUP BY s.trade_id, s.strategy_name, leg->>'symbol', leg->>'short_symbol'
)
SELECT trade_id,
       strategy_name,
       jsonb_object_agg(symbol, net_qty) AS net_position
FROM leg_flow
GROUP BY trade_id, strategy_name
HAVING NOT bool_and(net_qty = 0);

-- ============================================================================
-- 6.  RLS — owner_all on all six new tables
-- ============================================================================

ALTER TABLE auto_strategies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_strategies_dev  ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_signals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_signals_dev     ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_runs_dev        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_all ON auto_strategies;
CREATE POLICY owner_all ON auto_strategies
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON auto_strategies_dev;
CREATE POLICY owner_all ON auto_strategies_dev
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON auto_signals;
CREATE POLICY owner_all ON auto_signals
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON auto_signals_dev;
CREATE POLICY owner_all ON auto_signals_dev
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON auto_runs;
CREATE POLICY owner_all ON auto_runs
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON auto_runs_dev;
CREATE POLICY owner_all ON auto_runs_dev
    FOR ALL USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

-- ============================================================================
-- 7.  Seed — pairs strategy in both prod and dev
-- ============================================================================
-- (Section 7 was previously a pg_cron retention job. pg_cron is not available
--  on the Supabase free tier — same constraint as fyers-auto-login. Cleanup
--  will run inside automation-runner instead. See migration 20260325 for the
--  precedent.)

INSERT INTO auto_strategies (name, display_name, version, owner, recipients) VALUES
    ('pairs', 'Pairs Trading', '11.0', 'Vikash',
     '[{"name":"Vikash","email":"vikash.bagla@gmail.com"}]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO auto_strategies_dev (name, display_name, version, owner, recipients) VALUES
    ('pairs', 'Pairs Trading', '11.0', 'Vikash',
     '[{"name":"Vikash","email":"vikash.bagla@gmail.com"}]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- 8.  Sanity report — what got created
-- ============================================================================

SELECT 'auto_strategies'      AS tbl, count(*) AS rows FROM auto_strategies
UNION ALL
SELECT 'auto_strategies_dev'  AS tbl, count(*) FROM auto_strategies_dev
UNION ALL
SELECT 'auto_signals'         AS tbl, count(*) FROM auto_signals
UNION ALL
SELECT 'auto_signals_dev'     AS tbl, count(*) FROM auto_signals_dev
UNION ALL
SELECT 'auto_runs'            AS tbl, count(*) FROM auto_runs
UNION ALL
SELECT 'auto_runs_dev'        AS tbl, count(*) FROM auto_runs_dev
UNION ALL
SELECT 'market_prices_dev'    AS tbl, count(*) FROM market_prices_dev;

