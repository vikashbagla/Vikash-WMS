-- Migration 48 — WMS LIVE foundation: order command queue + kill switch.
--
-- Phase 13 production architecture. Generic enough that any signal source
-- (Katalysthive analyst, Pairs scanner, in-house GS rebuild, manual trades)
-- inserts into the same queue. The wms-live order-placer service on the
-- Droplet polls the queue via an HMAC-authenticated Edge Function, places
-- orders on the routed broker from the whitelisted IP, and writes results
-- back. Broker-agnostic schema — Fyers today, Zerodha / Angel One / Aliceblue
-- tomorrow, without a migration.
--
-- Key design choices (recorded so future sessions don't second-guess):
--
-- 1. ONE generic queue (not per-source or per-broker queues). Source identity
--    lives in signal_source TEXT; broker routing lives in iba_id FK. Simpler
--    operations + simpler kill-switch semantics + multi-broker by design.
--
-- 2. JSONB payload (not normalized columns). Each source/broker has different
--    field needs. JSONB lets each carry its own shape; the broker adapter
--    on the Droplet reads the relevant fields.
--
-- 3. TWO independent state machines:
--    - `status`        — OUR command-processing state
--                        pending → claimed → placed | rejected | error | cancelled
--    - `broker_status` — THE BROKER'S order-lifecycle state (normalized)
--                        PENDING → OPEN → FILLED | PARTIAL | CANCELLED | REJECTED | EXPIRED
--    These are independent. A row can be status='placed' + broker_status='OPEN'
--    while the broker holds an unfilled order. After fill: status='placed' +
--    broker_status='FILLED' + filled_qty + avg_fill_price + filled_at populated.
--    If the broker rejects at placement: status='rejected' + broker_status='REJECTED'
--    + error_message=broker's specific reason. If the broker rejects after initial
--    acceptance (exchange-level reject): status='placed' + broker_status='REJECTED'
--    later, error_message updated.
--
-- 4. app_state is a SINGLETON (single row, enforced by CHECK constraint on
--    id = 1). Holds the global kill switch + per-source pause + per-broker pause.
--    Edge Functions check before enqueueing. Droplet also checks at claim
--    time as defense-in-depth.
--
-- 5. iba_id NOT NULL with ON DELETE RESTRICT — every order MUST go to a
--    specific broker account, and you can't delete an IBA with historical
--    orders pointing at it. Force the user to soft-mark IBAs inactive.
--
-- 6. claimed_at + claimed_by support the atomic-claim pattern:
--      UPDATE wms_live_commands SET status='claimed', claimed_at=now(), claimed_by=$1
--      WHERE id = (SELECT id FROM wms_live_commands WHERE status='pending'
--                  ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
--      RETURNING *
--    This makes multi-Droplet scaling possible later without a schema change.
--
-- Per WMS-LESSONS §A.9: every new public table needs explicit GRANTs +
-- RLS + updated_at trigger.

-- ============================================================================
-- 1. wms_live_commands — the queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wms_live_commands (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Provenance — where did this command come from?
    signal_source            TEXT NOT NULL,                           -- 'katalysthive','pairs','gs_silvermini','gs_goldmini','manual'
    signal_ref               TEXT,                                    -- upstream identifier — analyst's trade_id, auto_signals.id, free-text for manual
    strategy_name            TEXT,                                    -- optional: matches auto_strategies.name when applicable
    leg_index                INT  NOT NULL DEFAULT 0,                 -- 0-based within a multi-leg signal (Katalysthive can send 2+ legs per signal)

    -- Routing — which broker account places this order?
    -- The broker code is derived via JOIN: investor_broker_accounts.broker_id → brokers.broker_code
    -- That keeps the queue itself broker-agnostic.
    iba_id                   UUID NOT NULL REFERENCES public.investor_broker_accounts(id) ON DELETE RESTRICT,

    -- Order spec — generic JSONB, broker adapter on the Droplet maps to broker's API
    -- For Fyers v3 /api/v3/orders/sync the payload SHOULD have:
    --   symbol         TEXT       e.g., 'MCX:SILVERM26JUNFUT' or 'NSE:NIFTY23JUN23850PE'
    --   side           INT        1=BUY, -1=SELL (Fyers v3 spec — Zerodha uses 'BUY'/'SELL' strings; adapter handles)
    --   qty            INT        contract count
    --   type           INT        1=LIMIT, 2=MARKET, 3=STOP, 4=STOPLIMIT
    --   productType    TEXT       'MARGIN' for F&O, 'CNC' for delivery equity, 'INTRADAY' for MIS
    --   limitPrice     NUMERIC    only for type=1 or 4
    --   stopPrice      NUMERIC    only for type=3 or 4
    --   validity       TEXT       'DAY' or 'IOC'
    --   offlineOrder   BOOLEAN    true = AMO, false = NOW
    -- Plus source-specific extensions like Katalysthive's sl_protection, hedge, leg_id.
    payload                  JSONB NOT NULL,

    -- ── State machine A: OUR command processing ──────────────────────────────
    status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','claimed','placed','rejected','error','cancelled')),

    -- Claim — set when the Droplet's wms-live service takes ownership
    claimed_at               TIMESTAMPTZ,
    claimed_by               TEXT,                                    -- e.g., 'wms-live-1' (Droplet hostname)

    -- Placement result — set when broker responds to our place-order call
    placed_at                TIMESTAMPTZ,
    broker_order_id          TEXT,                                    -- broker's order ID (Fyers: norenordno_..., Zerodha: 25-digit, etc.)
    broker_response          JSONB,                                   -- full raw broker response for audit + forensics

    -- ── State machine B: BROKER'S order lifecycle ────────────────────────────
    -- Updated post-placement by either polling the broker's order-status endpoint
    -- or via broker push (if the broker supports webhooks for order updates).
    -- NULL until we've heard back from the broker about the order state.
    broker_status            TEXT
                             CHECK (broker_status IS NULL OR broker_status IN
                                   ('PENDING','OPEN','FILLED','PARTIAL','CANCELLED','REJECTED','EXPIRED')),
    filled_qty               INTEGER,                                 -- number of contracts/shares filled
    avg_fill_price           NUMERIC(20,4),                           -- weighted average fill price
    filled_at                TIMESTAMPTZ,                             -- when broker_status reached a TERMINAL state (FILLED/CANCELLED/REJECTED/EXPIRED)
    last_status_check_at     TIMESTAMPTZ,                             -- when we last asked the broker about this order

    -- ── Error tracking (for OUR-side errors — network, HMAC, etc.) ───────────
    error_code               TEXT,                                    -- our normalized: 'BROKER_REJECT','TIMEOUT','HMAC_FAIL','KILL_SWITCH','SOURCE_PAUSED','BROKER_PAUSED'
    error_message            TEXT,                                    -- broker's specific reason text for BROKER_REJECT; our internal detail otherwise

    -- Retry tracking
    attempts                 INT NOT NULL DEFAULT 0,

    -- Standard audit
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.wms_live_commands IS 'Phase 13 order command queue. Any signal source inserts here; the Droplet wms-live service polls + places orders on the routed broker from the whitelisted IP. Two state machines: status (our processing) + broker_status (broker order lifecycle).';
COMMENT ON COLUMN public.wms_live_commands.signal_source IS 'Origin of the command. Affects kill-switch + audit. Values: katalysthive, pairs, gs_silvermini, gs_goldmini, manual.';
COMMENT ON COLUMN public.wms_live_commands.iba_id IS 'investor_broker_accounts FK — which account places the order. Broker code derived via JOIN. ON DELETE RESTRICT preserves order history.';
COMMENT ON COLUMN public.wms_live_commands.payload IS 'Generic broker-agnostic order body. JSONB so sources + brokers can extend without migration.';
COMMENT ON COLUMN public.wms_live_commands.status IS 'OUR command processing state: pending → claimed → placed | rejected | error | cancelled.';
COMMENT ON COLUMN public.wms_live_commands.broker_status IS 'BROKER order lifecycle (normalized): PENDING → OPEN → FILLED | PARTIAL | CANCELLED | REJECTED | EXPIRED. NULL until we hear back from the broker.';
COMMENT ON COLUMN public.wms_live_commands.broker_order_id IS 'Broker-assigned order ID. Format varies by broker. Indexed for reconciliation when broker fires fill webhooks.';
COMMENT ON COLUMN public.wms_live_commands.filled_at IS 'When broker_status reached a TERMINAL state (FILLED, CANCELLED, REJECTED, EXPIRED). Used for P&L attribution + audit. NULL while order is still working.';

-- Indexes — covering the hot queries
-- Poll query: WHERE status='pending' ORDER BY created_at ASC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_pending
    ON public.wms_live_commands (created_at ASC)
    WHERE status = 'pending';

-- Audit queries by source
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_source_created
    ON public.wms_live_commands (signal_source, created_at DESC);

-- Audit + ops queries by broker account
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_iba_created
    ON public.wms_live_commands (iba_id, created_at DESC);

-- Lookup by broker order id (for callbacks / reconciliation)
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_broker_order_id
    ON public.wms_live_commands (broker_order_id)
    WHERE broker_order_id IS NOT NULL;

-- Open-orders monitoring (status='placed' but broker_status not yet terminal)
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_working
    ON public.wms_live_commands (last_status_check_at NULLS FIRST)
    WHERE status = 'placed' AND broker_status IN ('PENDING','OPEN','PARTIAL');

-- updated_at trigger (per WMS-LESSONS §A.9.1)
DROP TRIGGER IF EXISTS trg_wms_live_commands_updated_at ON public.wms_live_commands;
CREATE TRIGGER trg_wms_live_commands_updated_at
    BEFORE UPDATE ON public.wms_live_commands
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. app_state — singleton config (kill switch + paused sources + paused brokers)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_state (
    id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),       -- enforces single row
    kill_switch       BOOLEAN NOT NULL DEFAULT false,
    paused_sources    TEXT[]  NOT NULL DEFAULT '{}',                  -- pause specific sources, e.g., ARRAY['katalysthive']
    paused_brokers    TEXT[]  NOT NULL DEFAULT '{}',                  -- pause specific brokers, e.g., ARRAY['fyers'] during a broker outage
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by        TEXT,                                           -- 'vikash@email', 'edge:analyst-webhook', etc.
    updated_reason    TEXT
);

COMMENT ON TABLE  public.app_state IS 'Singleton row holding global trading kill switch + per-source + per-broker pause lists. Checked by every signal source before enqueueing AND by the Droplet at claim time.';
COMMENT ON COLUMN public.app_state.kill_switch IS 'When true, NO orders are placed regardless of source or broker. Toggling this is the emergency stop.';
COMMENT ON COLUMN public.app_state.paused_sources IS 'Per-source pause. Element values match wms_live_commands.signal_source.';
COMMENT ON COLUMN public.app_state.paused_brokers IS 'Per-broker pause. Element values match brokers.broker_code (e.g., fyers, zerodha). Halts all orders routed through paused brokers regardless of source.';

-- Seed the singleton row
INSERT INTO public.app_state (id, kill_switch, paused_sources, paused_brokers, updated_by, updated_reason)
VALUES (1, false, '{}', '{}', 'migration_48', 'Initial seed')
ON CONFLICT (id) DO NOTHING;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_app_state_updated_at ON public.app_state;
CREATE TRIGGER trg_app_state_updated_at
    BEFORE UPDATE ON public.app_state
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. wms_live_risk_limits — per-source / per-strategy / per-account boundaries
-- ============================================================================
--
-- Encodes the contractual + operational risk boundaries the analyst agreed to
-- (max qty per order, daily limits, allowed underlyings, etc.) — plus our own
-- limits for in-house strategies. Validated at signal receipt time BEFORE the
-- command is enqueued. Reject with error_code='RISK_LIMIT_BREACHED' if any
-- applicable limit fails.
--
-- Resolution hierarchy (most-specific wins). For a signal with
-- (signal_source=X, strategy_name=Y, iba_id=Z) and a given limit_type:
--   1. row with (signal_source=X, strategy_name=Y, iba_id=Z) — exact
--   2. row with (signal_source=X, strategy_name=Y, iba_id IS NULL)
--   3. row with (signal_source=X, strategy_name IS NULL, iba_id=Z)
--   4. row with (signal_source=X, strategy_name IS NULL, iba_id IS NULL)
--   5. row with (signal_source IS NULL, strategy_name=Y, iba_id IS NULL)
--   6. row with (signal_source IS NULL, strategy_name IS NULL, iba_id IS NULL)  — global default
-- The risk-check helper queries all matching rows once, picks the most
-- specific per limit_type, applies it.

CREATE TABLE IF NOT EXISTS public.wms_live_risk_limits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Scope — NULL columns mean "applies to all". Triple (NULL,NULL,NULL) = global default.
    signal_source       TEXT,
    strategy_name       TEXT,
    iba_id              UUID REFERENCES public.investor_broker_accounts(id) ON DELETE CASCADE,

    -- The limit itself
    limit_type          TEXT NOT NULL,                       -- 'max_qty_per_order','max_notional_per_order','max_trades_per_day','max_trades_per_minute','max_loss_per_day','max_open_positions','allowed_underlyings','allowed_instrument_types','market_hours_only','block_action'
    limit_value         JSONB NOT NULL,                      -- shape depends on limit_type — see comments below

    -- Operational
    enabled             BOOLEAN NOT NULL DEFAULT true,        -- quick disable without delete
    breach_action       TEXT NOT NULL DEFAULT 'reject'
                        CHECK (breach_action IN ('reject','alert','log_only')),
    notes               TEXT,                                 -- why this limit exists (links to contract version, incident, etc.)

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wms_live_risk_limits IS 'Risk boundaries per (signal_source, strategy_name, iba_id) tuple. Validated before commands are enqueued. Hierarchical resolution: most-specific wins.';
COMMENT ON COLUMN public.wms_live_risk_limits.limit_type IS 'Discriminator. Validator looks up applicable rows by this. Adding new limit types is a config insert, NOT a schema migration.';
COMMENT ON COLUMN public.wms_live_risk_limits.limit_value IS 'Value shape depends on limit_type. Numeric limits: {"value":N}. Allowlists: {"values":[...]}. Booleans: {"value":true|false}. Validator dispatches on limit_type.';
COMMENT ON COLUMN public.wms_live_risk_limits.breach_action IS 'reject = block the signal with RISK_LIMIT_BREACHED. alert = enqueue anyway but send email notification. log_only = enqueue silently, just log.';

-- Limit type value shapes (informational — enforced by app validator, not DB):
--   max_qty_per_order        {"value": N}              N = single-leg qty cap (contract count)
--   max_notional_per_order   {"value": INR}            INR = qty * reference_price cap
--   max_trades_per_day       {"value": N}              N = max enqueued orders per IST day (00:00-23:59 IST)
--   max_trades_per_minute    {"value": N}              N = max enqueued orders in trailing 60s window
--   max_loss_per_day         {"value": INR}            INR = realized loss cap; checked via P&L aggregate
--   max_open_positions       {"value": N}              N = max concurrent rows where broker_status IN ('OPEN','PARTIAL')
--   allowed_underlyings      {"values": [...]}         array of strings (e.g., ["NIFTY","BANKNIFTY"])
--   allowed_instrument_types {"values": [...]}         array (e.g., ["OPT_IDX","FUT_IDX"])
--   market_hours_only        {"value": true}           if true, reject offlineOrder=true and out-of-hours signals
--   block_action             {"value": "BUY"|"SELL"}   block one direction (e.g., disable shorts for a period)

-- Indexes — scope lookup
CREATE INDEX IF NOT EXISTS idx_wms_live_risk_limits_source_strategy_iba
    ON public.wms_live_risk_limits (signal_source, strategy_name, iba_id, limit_type)
    WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_wms_live_risk_limits_type
    ON public.wms_live_risk_limits (limit_type)
    WHERE enabled = true;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_wms_live_risk_limits_updated_at ON public.wms_live_risk_limits;
CREATE TRIGGER trg_wms_live_risk_limits_updated_at
    BEFORE UPDATE ON public.wms_live_risk_limits
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 4. RLS — owner-only on all three tables (per WMS-LESSONS §A.10)
-- ============================================================================

ALTER TABLE public.wms_live_commands     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wms_live_risk_limits  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_all ON public.wms_live_commands;
CREATE POLICY owner_all ON public.wms_live_commands
    FOR ALL
    USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON public.app_state;
CREATE POLICY owner_all ON public.app_state
    FOR ALL
    USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON public.wms_live_risk_limits;
CREATE POLICY owner_all ON public.wms_live_risk_limits
    FOR ALL
    USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

-- ============================================================================
-- 5. GRANTs — per WMS-LESSONS §A.9.1
-- ============================================================================

-- service_role bypasses RLS by design; explicit grants are still required so
-- PostgREST surfaces the tables to the Edge Function REST calls.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_commands    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_risk_limits TO service_role;

-- authenticated role (Vikash via the browser app) — RLS still scopes
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_commands    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_risk_limits TO authenticated;

-- anon role: NO access. The Droplet talks via HMAC-authenticated Edge Functions
-- that internally use service_role, never via direct REST under anon.

-- ============================================================================
-- 6. Verification queries (run manually after applying)
-- ============================================================================

-- -- Commands with broker context
-- SELECT c.id, c.signal_source, c.status, c.broker_status,
--        c.filled_qty, c.avg_fill_price, c.filled_at,
--        iba.account_number, b.broker_code, b.name AS broker_name,
--        c.broker_order_id, c.error_code, c.error_message
-- FROM public.wms_live_commands c
-- JOIN public.investor_broker_accounts iba ON iba.id = c.iba_id
-- JOIN public.brokers b ON b.id = iba.broker_id
-- ORDER BY c.created_at DESC LIMIT 10;

-- -- Global kill switch + pause state
-- SELECT id, kill_switch, paused_sources, paused_brokers,
--        updated_at, updated_by, updated_reason
-- FROM public.app_state;

-- -- Active risk limits per source
-- SELECT signal_source, strategy_name, iba_id, limit_type, limit_value,
--        breach_action, enabled, notes
-- FROM public.wms_live_risk_limits
-- WHERE enabled = true
-- ORDER BY signal_source NULLS LAST, strategy_name NULLS LAST, limit_type;
